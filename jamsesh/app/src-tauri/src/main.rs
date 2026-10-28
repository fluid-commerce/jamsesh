// JamSesh for Mac: host a session on this Mac, or join one.
//
// Host mode runs the hub as a child process and shows the big screen and your own window.
// Join mode shows the host's client view through a local relay (see proxy.rs), so the microphone
// works without HTTPS, and keeps this Mac's token in the Keychain.
mod discover;
mod host;
mod perms;
mod proxy;

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tokio::sync::Mutex;

const RELAY_PORT: u16 = 4790;
const KEYCHAIN_SERVICE: &str = "JamSesh";

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    /// "host", "join", or none (show the start window).
    role: Option<String>,
    /// The host this Mac joined, as typed or found.
    host_url: Option<String>,
    host_name: Option<String>,
    /// Asked once per Mac whether to connect Claude Code and Codex.
    #[serde(default)]
    agents_asked: bool,
    /// The host permission checklist was finished (or skipped).
    #[serde(default)]
    host_setup_done: bool,
}

#[derive(Default)]
struct Inner {
    cfg: Config,
    hub: Option<host::Hub>,
    relay: Option<proxy::Proxy>,
}

struct App {
    inner: Mutex<Inner>,
    hosts: discover::Hosts,
    dir: PathBuf,
}

impl App {
    fn save(&self, cfg: &Config) {
        let _ = std::fs::create_dir_all(&self.dir);
        if let Ok(json) = serde_json::to_vec_pretty(cfg) {
            let _ = std::fs::write(self.dir.join("app.json"), json);
        }
    }
}

fn keychain(origin: &str) -> Option<keyring::Entry> {
    keyring::Entry::new(KEYCHAIN_SERVICE, origin).ok()
}

// ---- windows ----

fn open_window(app: &AppHandle, label: &str, url: &str, title: &str) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    let parsed: url::Url = url.parse().map_err(|e: url::ParseError| e.to_string())?;
    WebviewWindowBuilder::new(app, label, WebviewUrl::External(parsed))
        .title(title)
        .inner_size(1280.0, 820.0)
        .min_inner_size(420.0, 560.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn open_start(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("start") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, "start", WebviewUrl::App("index.html".into()))
        .title("JamSesh")
        .inner_size(560.0, 640.0)
        .resizable(false)
        .build();
}

fn close_start(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("start") {
        let _ = w.close();
    }
}

/// The big screen goes full screen on the display that isn't this Mac's main one, when there is one.
fn open_big_screen(app: &AppHandle, origin: &str, next_display: bool) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("bigscreen") {
        if !next_display {
            let _ = w.show();
            let _ = w.set_focus();
            return Ok(());
        }
        let _ = w.close();
    }
    let parsed: url::Url = format!("{origin}/host").parse().map_err(|e: url::ParseError| e.to_string())?;
    let w = WebviewWindowBuilder::new(app, "bigscreen", WebviewUrl::External(parsed)).title("JamSesh big screen").inner_size(1440.0, 900.0).build().map_err(|e| e.to_string())?;
    let monitors = w.available_monitors().unwrap_or_default();
    if monitors.len() > 1 {
        let primary = w.primary_monitor().ok().flatten().map(|m| *m.position());
        let current = w.current_monitor().ok().flatten().map(|m| *m.position());
        let others: Vec<_> = monitors.iter().filter(|m| Some(*m.position()) != primary).collect();
        let pick = if next_display { monitors.iter().find(|m| Some(*m.position()) != current) } else { others.first().copied() };
        if let Some(m) = pick {
            let _ = w.set_position(*m.position());
        }
    }
    // Full screen in the same Space, so app windows the brain arranges on this display can sit on top.
    let _ = w.set_simple_fullscreen(true);
    Ok(())
}

// ---- sessions ----

async fn start_hosting(app: &AppHandle, state: &App) -> Result<(), String> {
    let mut inner = state.inner.lock().await;
    let resources = app.path().resource_dir().ok().map(|r| r.join("jamsesh"));
    let hub = host::Hub::start(&state.dir.join("logs"), resources.as_deref()).await?;
    let origin = hub.origin();
    inner.hub = Some(hub);
    // Agents on this Mac reach the session through the same local address as on any joined Mac.
    if let Some(old) = inner.relay.take() {
        old.stop();
    }
    inner.relay = proxy::start(proxy::Upstream::parse(&origin)?, None, RELAY_PORT, |_| {}).await.ok();
    inner.cfg.role = Some("host".into());
    state.save(&inner.cfg);
    let setup_done = inner.cfg.host_setup_done;
    drop(inner);
    open_big_screen(app, &origin, false)?;
    open_window(app, "client", &format!("{origin}/client"), "JamSesh")?;
    close_start(app);
    refresh_tray(app).await;
    if !setup_done {
        open_setup(app);
    }
    offer_agents(app.clone());
    Ok(())
}

async fn start_joining(app: &AppHandle, state: &App, input: &str, name: Option<String>) -> Result<(), String> {
    let up = proxy::Upstream::parse(input)?;
    if !proxy::healthy(&up.origin).await {
        return Err(format!("No JamSesh host answered at {}. Check the address, and that this Mac is on the same network or the host has remote access set up.", up.origin));
    }
    let origin = up.origin.clone();
    let token = keychain(&origin).and_then(|k| k.get_password().ok());
    let paired = token.is_some();
    let keep = origin.clone();
    let handle = app.clone();
    let mut inner = state.inner.lock().await;
    if let Some(old) = inner.relay.take() {
        old.stop();
    }
    let relay = proxy::start(up, token, RELAY_PORT, move |tok| {
        if let Some(k) = keychain(&keep) {
            let _ = k.set_password(&tok);
        }
        // Just paired: the moment to offer connecting this Mac's agents.
        offer_agents(handle.clone());
    })
    .await?;
    let url = relay.url(if paired { "/client" } else { "/connect?next=%2Fclient" });
    inner.relay = Some(relay);
    inner.cfg.role = Some("join".into());
    inner.cfg.host_url = Some(origin);
    if name.is_some() {
        inner.cfg.host_name = name;
    }
    state.save(&inner.cfg);
    drop(inner);
    if let Some(w) = app.get_webview_window("client") {
        let _ = w.close();
    }
    open_window(app, "client", &url, "JamSesh")?;
    close_start(app);
    refresh_tray(app).await;
    if paired {
        offer_agents(app.clone());
    }
    Ok(())
}

fn has_agent_cli() -> bool {
    host::path_env().split(':').any(|d| ["claude", "codex"].iter().any(|b| std::path::Path::new(d).join(b).is_file()))
}

/// Once per Mac: offer to connect Claude Code and Codex. After that, saying "connect to jamsesh"
/// to either one is enough, whichever host this Mac is on.
fn offer_agents(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<Arc<App>>().inner().clone();
        {
            let mut inner = state.inner.lock().await;
            if inner.cfg.agents_asked || !has_agent_cli() {
                return;
            }
            inner.cfg.agents_asked = true;
            state.save(&inner.cfg);
        }
        let handle = app.clone();
        app.dialog()
            .message("Connect Claude Code and Codex on this Mac to JamSesh? After this, telling either one \"connect to jamsesh\" is all it takes, in any repository.")
            .title("Connect your agents")
            .buttons(MessageDialogButtons::OkCancelCustom("Connect".into(), "Not now".into()))
            .show(move |yes| {
                if yes {
                    on_menu(&handle, "agents");
                }
            });
    });
}

fn open_setup(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("setup") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, "setup", WebviewUrl::App("setup.html".into())).title("Set up this Mac").inner_size(620.0, 720.0).resizable(false).build();
}

async fn leave(app: &AppHandle, state: &App) {
    let mut inner = state.inner.lock().await;
    if let Some(r) = inner.relay.take() {
        r.stop();
    }
    if let Some(mut h) = inner.hub.take() {
        tauri::async_runtime::spawn_blocking(move || h.stop());
    }
    inner.cfg.role = None;
    state.save(&inner.cfg);
    drop(inner);
    for label in ["client", "bigscreen"] {
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.close();
        }
    }
    open_start(app);
    refresh_tray(app).await;
}

/// Installs the jamsesh MCP server, skill, command and hooks for Claude Code and Codex on this Mac.
async fn set_up_agents(app: &AppHandle, state: &App) -> Result<String, String> {
    let port = state.inner.lock().await.relay.as_ref().map(|r| r.port).ok_or("Host or join a session first.")?;
    let (_, me) = proxy::get(port, "/api/me").await?;
    let me: serde_json::Value = serde_json::from_str(&me).unwrap_or_default();
    let name = me.pointer("/person/name").and_then(|v| v.as_str()).map(str::to_string).unwrap_or_default();
    let (status, script) = proxy::get(port, &format!("/agent/setup.sh?relay={port}")).await?;
    if !status.is_success() || !script.starts_with("#!") {
        return Err("The host didn't hand out the setup. Connect this Mac again with a fresh code.".into());
    }
    let mut child = tokio::process::Command::new("/bin/bash")
        .arg("-s")
        .env("PATH", host::path_env())
        .env("JAMSESH_NAME", &name)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    if let Some(mut stdin) = child.stdin.take() {
        use tokio::io::AsyncWriteExt;
        stdin.write_all(script.as_bytes()).await.map_err(|e| e.to_string())?;
    }
    let out = child.wait_with_output().await.map_err(|e| e.to_string())?;
    let _ = app;
    if out.status.success() {
        Ok("Claude Code and Codex on this Mac are connected. Restart them, then say \"connect to jamsesh\" in each repository you're working in.".to_string())
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        Err(format!("Setup didn't finish: {}", err.lines().last().unwrap_or("unknown error")))
    }
}

// ---- menu bar ----

async fn refresh_tray(app: &AppHandle) {
    let state = app.state::<Arc<App>>();
    let (role, label, hub_port) = {
        let inner = state.inner.lock().await;
        let label = inner.cfg.host_name.clone().or(inner.cfg.host_url.clone()).unwrap_or_default();
        (inner.cfg.role.clone(), label, inner.hub.as_ref().map(|h| h.port))
    };
    let code = match hub_port {
        Some(p) => proxy::get(p, "/api/pair/code").await.ok().and_then(|(_, b)| serde_json::from_str::<serde_json::Value>(&b).ok()).and_then(|v| v.get("code").and_then(|c| c.as_str()).map(str::to_string)),
        None => None,
    };
    let Some(tray) = app.tray_by_id("main") else { return };
    let build = || -> tauri::Result<Menu<tauri::Wry>> {
        let menu = Menu::new(app)?;
        match role.as_deref() {
            Some("host") => {
                menu.append(&MenuItem::with_id(app, "status", "Hosting a session", false, None::<&str>)?)?;
                menu.append(&MenuItem::with_id(app, "code", format!("Join code: {}", code.as_deref().unwrap_or("…")), false, None::<&str>)?)?;
                menu.append(&PredefinedMenuItem::separator(app)?)?;
                menu.append(&MenuItem::with_id(app, "open", "Open my window", true, None::<&str>)?)?;
                menu.append(&MenuItem::with_id(app, "bigscreen", "Show the big screen", true, None::<&str>)?)?;
                menu.append(&MenuItem::with_id(app, "nextdisplay", "Move the big screen to the next display", true, None::<&str>)?)?;
                menu.append(&PredefinedMenuItem::separator(app)?)?;
                menu.append(&MenuItem::with_id(app, "agents", "Connect my agents", true, None::<&str>)?)?;
                menu.append(&MenuItem::with_id(app, "setup", "Set up this Mac…", true, None::<&str>)?)?;
                menu.append(&PredefinedMenuItem::separator(app)?)?;
                menu.append(&MenuItem::with_id(app, "leave", "Stop hosting", true, None::<&str>)?)?;
            }
            Some("join") => {
                menu.append(&MenuItem::with_id(app, "status", format!("Joined {label}"), false, None::<&str>)?)?;
                menu.append(&PredefinedMenuItem::separator(app)?)?;
                menu.append(&MenuItem::with_id(app, "open", "Open my window", true, None::<&str>)?)?;
                menu.append(&MenuItem::with_id(app, "agents", "Connect my agents", true, None::<&str>)?)?;
                menu.append(&PredefinedMenuItem::separator(app)?)?;
                menu.append(&MenuItem::with_id(app, "leave", "Leave the session", true, None::<&str>)?)?;
            }
            _ => {
                menu.append(&MenuItem::with_id(app, "open", "Host or join a session…", true, None::<&str>)?)?;
            }
        }
        menu.append(&PredefinedMenuItem::separator(app)?)?;
        menu.append(&MenuItem::with_id(app, "quit", "Quit JamSesh", true, None::<&str>)?)?;
        Ok(menu)
    };
    if let Ok(menu) = build() {
        let _ = tray.set_menu(Some(menu));
    }
}

fn on_menu(app: &AppHandle, id: &str) {
    let app = app.clone();
    let id = id.to_string();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<Arc<App>>().inner().clone();
        let (role, hub_origin, relay_url) = {
            let inner = state.inner.lock().await;
            (inner.cfg.role.clone(), inner.hub.as_ref().map(|h| h.origin()), inner.relay.as_ref().map(|r| r.url("/client")))
        };
        match id.as_str() {
            "open" => match (role.as_deref(), hub_origin, relay_url) {
                (Some("host"), Some(o), _) => drop(open_window(&app, "client", &format!("{o}/client"), "JamSesh")),
                (Some("join"), _, Some(u)) => drop(open_window(&app, "client", &u, "JamSesh")),
                _ => open_start(&app),
            },
            "bigscreen" | "nextdisplay" => {
                if let Some(o) = hub_origin {
                    let _ = open_big_screen(&app, &o, id == "nextdisplay");
                }
            }
            "agents" => {
                let result = set_up_agents(&app, &state).await;
                let (kind, title, text) = match result {
                    Ok(t) => (MessageDialogKind::Info, "Agents connected", t),
                    Err(t) => (MessageDialogKind::Warning, "Couldn't set up your agents", t),
                };
                app.dialog().message(text).title(title).kind(kind).show(|_| {});
            }
            "setup" => open_setup(&app),
            "reopen" => match (role.as_deref(), hub_origin) {
                (Some("host"), Some(o)) => drop(open_big_screen(&app, &o, false)),
                _ => on_menu(&app, "open"),
            },
            "leave" => leave(&app, &state).await,
            "quit" => app.exit(0),
            _ => {}
        }
    });
}

// ---- commands for the start window ----

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StartInfo {
    can_host: bool,
    host_problem: Option<String>,
    last_host: Option<String>,
    last_host_name: Option<String>,
}

#[tauri::command]
async fn start_info(app: AppHandle, state: State<'_, Arc<App>>) -> Result<StartInfo, String> {
    let inner = state.inner.lock().await;
    let resources = app.path().resource_dir().ok().map(|r| r.join("jamsesh"));
    let problem = host::runtime(resources.as_deref()).err();
    Ok(StartInfo { can_host: problem.is_none(), host_problem: problem, last_host: inner.cfg.host_url.clone(), last_host_name: inner.cfg.host_name.clone() })
}

#[tauri::command]
fn nearby_hosts(state: State<'_, Arc<App>>) -> Vec<discover::Found> {
    state.hosts.list()
}

#[tauri::command]
async fn host_here(app: AppHandle, state: State<'_, Arc<App>>) -> Result<(), String> {
    start_hosting(&app, &state).await
}

#[tauri::command]
async fn join(app: AppHandle, state: State<'_, Arc<App>>, url: String, name: Option<String>) -> Result<(), String> {
    start_joining(&app, &state, &url, name).await
}

#[tauri::command]
async fn perm_status() -> perms::Status {
    tauri::async_runtime::spawn_blocking(perms::status).await.unwrap_or_else(|_| perms::status())
}

#[tauri::command]
async fn perm_request(kind: String) {
    let _ = tauri::async_runtime::spawn_blocking(move || perms::request(&kind)).await;
}

#[tauri::command]
fn perm_settings(kind: String) {
    if let Some(url) = perms::settings_url(&kind) {
        let _ = std::process::Command::new("/usr/bin/open").arg(url).status();
    }
}

#[tauri::command]
async fn finish_setup(app: AppHandle, state: State<'_, Arc<App>>) -> Result<(), String> {
    let mut inner = state.inner.lock().await;
    inner.cfg.host_setup_done = true;
    state.save(&inner.cfg);
    drop(inner);
    if let Some(w) = app.get_webview_window("setup") {
        let _ = w.close();
    }
    Ok(())
}

/// Screen Recording takes effect after a relaunch.
#[tauri::command]
fn relaunch(app: AppHandle) {
    app.restart();
}

fn main() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![start_info, nearby_hosts, host_here, join, perm_status, perm_request, perm_settings, finish_setup, relaunch])
        .setup(|app| {
            let dir = app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from("/tmp/jamsesh-app"));
            let cfg: Config = std::fs::read(dir.join("app.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
            let state = Arc::new(App { inner: Mutex::new(Inner { cfg: cfg.clone(), ..Default::default() }), hosts: discover::start(), dir });
            app.manage(state.clone());

            let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;
            TrayIconBuilder::with_id("main").icon(icon).icon_as_template(true).show_menu_on_left_click(true).on_menu_event(|app, e| on_menu(app, e.id().as_ref())).build(app)?;

            // Pick up where this Mac left off: keep hosting, or rejoin the same host.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let resumed = match (cfg.role.as_deref(), cfg.host_url.clone()) {
                    (Some("host"), _) => start_hosting(&handle, &state).await,
                    (Some("join"), Some(url)) => start_joining(&handle, &state, &url, None).await,
                    _ => Err(String::new()),
                };
                if resumed.is_err() {
                    open_start(&handle);
                }
                refresh_tray(&handle).await;
                // The join code changes every 30 seconds; keep the menu's copy current.
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    refresh_tray(&handle).await;
                }
            });
            Ok(())
        });

    let Ok(app) = builder.build(tauri::generate_context!()) else {
        eprintln!("JamSesh couldn't start.");
        return;
    };
    app.run(|app, event| match event {
        // Closing the windows keeps JamSesh in the menu bar; Quit stops it.
        RunEvent::ExitRequested { api, code: None, .. } => api.prevent_exit(),
        RunEvent::Exit => {
            let state = app.state::<Arc<App>>().inner().clone();
            if let Ok(mut inner) = state.inner.try_lock() {
                if let Some(mut h) = inner.hub.take() {
                    h.stop();
                }
            }
        }
        RunEvent::Reopen { .. } => on_menu(app, "reopen"),
        _ => {}
    });
}
