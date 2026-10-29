// JamSesh for Mac: host a session on this Mac, or join one.
//
// Host mode runs the hub as a child process and shows the big screen and your own window.
// Join mode shows the host's client view through a local relay (see proxy.rs), so the microphone
// works without HTTPS, and keeps this Mac's token in the Keychain.
mod discover;
mod fonts;
mod host;
mod perms;
mod projects;
mod proxy;
mod screens;
mod watchdog;

use std::path::PathBuf;
use std::sync::Arc;

use projects::Launch;
use serde::{Deserialize, Serialize};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
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
    /// User-less host: nobody uses this Mac, so every display is a big screen and no personal
    /// window opens.
    #[serde(default)]
    userless: bool,
    /// Web Inspector in this app's windows (right-click, Inspect Element; or Safari's Develop
    /// menu). Off unless this is set or `JAMSESH_DEVTOOLS=1`: it's for finding out why a page froze.
    #[serde(default)]
    devtools: bool,
    /// The project this Mac hosted last (its slug), so relaunching continues it.
    #[serde(default)]
    project: Option<String>,
    /// Hosting, but only the Projects picker is up (no session has begun): relaunching opens the
    /// picker again rather than the last project.
    #[serde(default)]
    lobby: bool,
}

#[derive(Default)]
struct Inner {
    cfg: Config,
    hub: Option<host::Hub>,
    relay: Option<proxy::Proxy>,
    /// Join mode: the host's dev-server ports, mirrored on this Mac (see `Proxy::mirror`).
    mirrors: std::collections::HashMap<u16, proxy::Proxy>,
    /// Why picking up where this Mac left off failed at launch, for the start window to say.
    resume_error: Option<String>,
}

struct App {
    inner: Mutex<Inner>,
    /// The displays as last seen, and the arrangement's own moves (see screens.rs).
    screens: screens::Runtime,
    /// What the menu bar menu shows now; it's only rebuilt when this changes (an open menu stays open).
    tray_shown: std::sync::Mutex<String>,
    hosts: discover::Hosts,
    dir: PathBuf,
    /// Heartbeats from the windows' pages (see watchdog.rs).
    beats: Arc<std::sync::Mutex<watchdog::Beats>>,
    /// Held for the whole of a change of session (hosting, a project switch, joining, leaving), so two never overlap.
    switching: Mutex<()>,
}

/// Whether windows get Web Inspector; set once at launch from the saved config or the environment.
static DEVTOOLS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn devtools() -> bool {
    DEVTOOLS.load(std::sync::atomic::Ordering::Relaxed)
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

/// `url` is a one-time window link (`Proxy::window_url` or `host::window_url`), which gives the
/// window this launch's window key in an HttpOnly cookie and with it the person's credential.
/// No page script ever sees the key (there is no initialization script).
fn open_window(app: &AppHandle, label: &str, url: &str, title: &str) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    let parsed: url::Url = url.parse().map_err(|e: url::ParseError| e.to_string())?;
    WebviewWindowBuilder::new(app, label, WebviewUrl::External(parsed))
        .devtools(devtools())
        .title(title)
        // No separate title bar: the window controls sit in the page's own header (centered in
        // its 56 px), with the logo to their right; the header is the drag area.
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(18.0, 30.0))
        // A window behind another keeps its microphone and timers (WebKit would otherwise throttle
        // it, and the room mic would go quiet whenever someone's window covers the big screen).
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        .inner_size(1280.0, 820.0)
        .min_inner_size(420.0, 560.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Shows a window at `url`: a new one, or an existing one carried over to it (a session's windows
/// stay where they are when the project changes).
fn show_window(app: &AppHandle, label: &str, url: &str, title: &str) -> Result<(), String> {
    let Some(w) = app.get_webview_window(label) else { return open_window(app, label, url, title) };
    let parsed: url::Url = url.parse().map_err(|e: url::ParseError| e.to_string())?;
    w.navigate(parsed).map_err(|e| e.to_string())?;
    let _ = w.show();
    let _ = w.set_focus();
    Ok(())
}

fn open_start(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("start") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, "start", WebviewUrl::App("index.html".into()))
        .devtools(devtools())
        .title("JamSesh")
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .inner_size(560.0, 640.0)
        .resizable(false)
        .build();
}

fn close_start(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("start") {
        let _ = w.close();
    }
}

// ---- sessions ----

async fn start_hosting(app: &AppHandle, state: &App, launch: Launch) -> Result<(), String> {
    let mut inner = state.inner.lock().await;
    let resources = app.path().resource_dir().ok().map(|r| r.join("jamsesh"));
    let hub = host::Hub::start(&state.dir.join("logs"), resources.as_deref(), &launch).await?;
    let origin = hub.origin();
    let port = hub.port;
    inner.hub = Some(hub);
    // Hosting begins at the Projects picker: one window, no session until a project is chosen.
    if let Launch::Lobby { new_project } = launch {
        inner.cfg.lobby = true;
        inner.cfg.role = Some("host".into());
        state.save(&inner.cfg);
        drop(inner);
        let path = if new_project { "/projects?new=1" } else { "/projects" };
        show_window(app, "client", &host::window_url(&origin, path), "JamSesh")?;
        close_start(app);
        refresh_tray(app).await;
        return Ok(());
    }
    inner.cfg.lobby = false;
    // Remember which project this was, for the menu bar and for relaunching into it.
    let current = proxy::get_as_window(port, "/api/projects").await.ok().and_then(|(_, b)| serde_json::from_str::<serde_json::Value>(&b).ok());
    if let Some(slug) = current.as_ref().and_then(|v| v["current"].as_str()) {
        inner.cfg.project = Some(slug.to_string());
    }
    // Agents on this Mac reach the session through the same local address as on any joined Mac.
    if let Some(old) = inner.relay.take() {
        old.stop();
    }
    // As this app's window: only the app (holding the window key) issues the host's agents credential.
    let agents = proxy::post_as_window(&origin, "/api/pair/agents")
        .await
        .ok()
        .and_then(|b| serde_json::from_str::<serde_json::Value>(&b).ok())
        .and_then(|v| v["token"].as_str().map(str::to_string));
    inner.relay = proxy::start(proxy::Upstream::parse(&origin)?, None, agents, RELAY_PORT, |_| {}).await.ok();
    inner.cfg.role = Some("host".into());
    state.save(&inner.cfg);
    let setup_done = inner.cfg.host_setup_done;
    let userless = inner.cfg.userless;
    drop(inner);
    if userless {
        // Nobody uses this Mac: a picker window left from before the project was chosen goes.
        if let Some(w) = app.get_webview_window("client") {
            let _ = w.close();
        }
    }
    screens::arrange_and_offer(app, &origin).await?;
    if !userless {
        show_window(app, "client", &host::window_url(&origin, "/client"), "JamSesh")?;
    }
    close_start(app);
    refresh_tray(app).await;
    if !setup_done {
        open_setup(app);
    }
    offer_agents(app.clone());
    Ok(())
}

async fn start_joining(app: &AppHandle, state: &App, input: &str, name: Option<String>) -> Result<(), String> {
    // A typed name like team.duckdns.org is a remote host's HTTPS address; an IP or a .local name
    // is a host on this network.
    let raw = input.trim();
    let bare = raw.split(['/', ':']).next().unwrap_or("");
    let lan = bare.ends_with(".local") || bare.parse::<std::net::IpAddr>().is_ok() || !bare.contains('.');
    let https_first = !raw.contains("://") && !lan;
    let first = if https_first { format!("https://{raw}") } else { raw.to_string() };
    let mut up = proxy::Upstream::parse(&first)?;
    if https_first && !proxy::healthy(&up.origin).await {
        up = proxy::Upstream::parse(raw)?;
    }
    if !proxy::healthy(&up.origin).await {
        return Err(format!(
            "No JamSesh host answered at {}. Check the address, and that this Mac is on the same network or the host has remote access set up.",
            up.origin
        ));
    }
    let origin = up.origin.clone();
    let origin_for_agents = origin.clone();
    let token = keychain(&origin).and_then(|k| k.get_password().ok());
    let agents = keychain(&format!("{origin}#agents")).and_then(|k| k.get_password().ok());
    let paired = token.is_some();
    let keep = origin.clone();
    let handle = app.clone();
    let mut inner = state.inner.lock().await;
    if let Some(old) = inner.relay.take() {
        old.stop();
    }
    for (_, m) in inner.mirrors.drain() {
        m.stop();
    }
    let relay = proxy::start(up, token.clone(), agents.clone(), RELAY_PORT, move |tok| {
        if let Some(k) = keychain(&keep) {
            let _ = k.set_password(&tok);
        }
        // Just paired: get this Mac's agents their own credential, then offer to connect them.
        let (handle, origin, tok) = (handle.clone(), keep.clone(), tok.clone());
        tauri::async_runtime::spawn(async move {
            fetch_agents_token(&handle, &origin, &tok).await;
            offer_agents(handle);
        });
    })
    .await?;
    let url = relay.window_url(if paired { "/client" } else { "/connect?next=%2Fclient" });
    let needs_agents = paired && agents.is_none();
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
    if needs_agents && let Some(tok) = token {
        fetch_agents_token(app, &origin_for_agents, &tok).await;
    }
    if paired {
        offer_agents(app.clone());
    }
    Ok(())
}

/// Asks the host for this Mac's agents' credential (with the person's), keeps it in the Keychain,
/// and hands it to the relay.
async fn fetch_agents_token(app: &AppHandle, origin: &str, person_token: &str) {
    let Ok(body) = proxy::post(origin, "/api/pair/agents", Some(person_token)).await else { return };
    let Some(token) = serde_json::from_str::<serde_json::Value>(&body).ok().and_then(|v| v["token"].as_str().map(str::to_string)) else { return };
    if let Some(k) = keychain(&format!("{origin}#agents")) {
        let _ = k.set_password(&token);
    }
    let state = app.state::<Arc<App>>();
    let mut inner = state.inner.lock().await;
    if let Some(r) = inner.relay.as_ref() {
        r.set_agents_token(Some(token));
    }
    // Paired again: dev-port mirrors carried the old credential; the next refresh recreates them.
    for (_, m) in inner.mirrors.drain() {
        m.stop();
    }
}

/// Once per Mac: offer to connect Claude Code and Codex. After that, saying "connect to jamsesh"
/// to either one is enough, whichever host this Mac is on.
fn offer_agents(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<Arc<App>>().inner().clone();
        {
            let mut inner = state.inner.lock().await;
            if inner.cfg.agents_asked || !host::has_agent() {
                return;
            }
            inner.cfg.agents_asked = true;
            state.save(&inner.cfg);
        }
        let handle = app.clone();
        app.dialog()
            .message("Connect Claude Code and Codex on this Mac to JamSesh? Nothing joins the room on its own: tell a chat \"connect to jamsesh\" and only that chat joins.")
            .title("Connect your agents")
            .buttons(MessageDialogButtons::OkCancelCustom("Connect".into(), "Not now".into()))
            .show(move |yes| {
                if yes {
                    on_menu(&handle, "agents");
                }
            });
    });
}

/// The DuckDNS and HTTPS wizard, in its own window (never on the big screen).
fn open_remote_setup(app: &AppHandle, origin: &str) {
    if let Some(w) = app.get_webview_window("remote") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    if let Ok(url) = host::window_url(origin, "/setup?app").parse::<url::Url>() {
        let _ = WebviewWindowBuilder::new(app, "remote", WebviewUrl::External(url))
            .devtools(devtools())
            .title("Remote access")
            .inner_size(900.0, 820.0)
            .build();
    }
}

#[tauri::command]
async fn remote_setup(app: AppHandle, state: State<'_, Arc<App>>) -> Result<(), String> {
    let origin = state.inner.lock().await.hub.as_ref().map(|h| h.origin()).ok_or("Host a session first.")?;
    open_remote_setup(&app, &origin);
    Ok(())
}

fn open_setup(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("setup") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, "setup", WebviewUrl::App("setup.html".into()))
        .devtools(devtools())
        .title("Set up this Mac")
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .inner_size(620.0, 790.0)
        .resizable(false)
        .build();
}

/// Stop hosting or leave: waits its turn behind any project switch, hosting or joining under way.
async fn leave(app: &AppHandle, state: &App) {
    let _turn = state.switching.lock().await;
    leave_now(app, state).await;
}

/// `leave` for a caller that already holds `state.switching` (a switch cleaning up after itself).
async fn leave_now(app: &AppHandle, state: &App) {
    let mut inner = state.inner.lock().await;
    if let Some(r) = inner.relay.take() {
        r.stop();
    }
    for (_, m) in inner.mirrors.drain() {
        m.stop();
    }
    let hub = inner.hub.take();
    inner.cfg.role = None;
    inner.cfg.lobby = false;
    state.save(&inner.cfg);
    drop(inner);
    // The session saves before anything else starts.
    if let Some(mut h) = hub
        && let Ok(Err(e)) = tauri::async_runtime::spawn_blocking(move || h.stop()).await
    {
        app.dialog().message(e).title("The session didn't finish saving").kind(MessageDialogKind::Warning).show(|_| {});
    }
    // Every window the session opened, including a user-less host's extra screens.
    for (label, w) in app.webview_windows() {
        if label == "client" || label.starts_with("bigscreen") {
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
        // Name only the agents the script set up: it prints "ok  Claude Code: …" / "ok  Codex: …".
        let stdout = String::from_utf8_lossy(&out.stdout);
        let set_up = |agent: &str| stdout.lines().any(|l| l.trim_start().starts_with(&format!("ok  {agent}:")));
        let (agents, them) = match (set_up("Claude Code"), set_up("Codex")) {
            (true, true) => ("Claude Code and Codex on this Mac are", "them"),
            (true, false) => ("Claude Code on this Mac is", "it"),
            (false, true) => ("Codex on this Mac is", "it"),
            (false, false) => ("Your agents on this Mac are", "them"),
        };
        Ok(format!("{agents} connected. Restart {them}, then say \"connect to jamsesh\" in each repository you're working in."))
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        Err(format!("Setup didn't finish: {}", err.lines().last().unwrap_or("unknown error")))
    }
}

// ---- menu bar ----

/// Keeps one local mirror per dev server the host lists, so dev tiles load in this Mac's window.
/// A port this Mac already uses is skipped (and tried again on the next refresh).
async fn sync_mirrors(state: &App, st: &serde_json::Value) {
    let wanted: std::collections::HashSet<u16> = st["devservers"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|d| d["hostPort"].as_u64())
        .filter_map(|p| u16::try_from(p).ok())
        .filter(|p| *p != RELAY_PORT && *p >= 1024)
        .collect();
    let mut inner = state.inner.lock().await;
    let gone: Vec<u16> = inner.mirrors.keys().filter(|p| !wanted.contains(*p)).copied().collect();
    for p in gone {
        if let Some(m) = inner.mirrors.remove(&p) {
            m.stop();
        }
    }
    for p in wanted {
        if inner.mirrors.contains_key(&p) {
            continue;
        }
        let Some(relay) = inner.relay.as_ref() else { return };
        if let Ok(m) = relay.mirror(p).await {
            inner.mirrors.insert(p, m);
        }
    }
}

async fn refresh_tray(app: &AppHandle) {
    let state = app.state::<Arc<App>>();
    let (role, label, hub_port, relay_port, userless, lobby, project) = {
        let inner = state.inner.lock().await;
        let label = inner.cfg.host_name.clone().or(inner.cfg.host_url.clone()).unwrap_or_default();
        (
            inner.cfg.role.clone(),
            label,
            inner.hub.as_ref().map(|h| h.port),
            inner.relay.as_ref().map(|r| r.port),
            inner.cfg.userless,
            inner.cfg.lobby,
            inner.cfg.project.clone(),
        )
    };
    let recent = if role.as_deref() == Some("host") { projects::recent(8) } else { Vec::new() };
    let st = match relay_port {
        Some(p) => proxy::get(p, "/api/state").await.ok().and_then(|(_, b)| serde_json::from_str::<serde_json::Value>(&b).ok()),
        None => None,
    };
    if role.as_deref() == Some("join")
        && let Some(st) = &st
    {
        sync_mirrors(&state, st).await;
    }
    // Who's here: people whose windows checked in during the last two minutes, and live agents.
    let present = st.map(|st| {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0);
        let mut people: Vec<String> = st["devices"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|d| d["kind"] == "client" && now - d["lastSeen"].as_f64().unwrap_or(0.0) < 120_000.0)
            .filter_map(|d| d["personId"].as_str().map(str::to_string))
            .collect();
        people.sort();
        people.dedup();
        let agents = st["agents"].as_array().into_iter().flatten().filter(|a| a["status"] != "offline").count();
        let plural = |n: usize, one: &str, many: &str| format!("{n} {}", if n == 1 { one } else { many });
        format!("{}, {} here", plural(people.len(), "person", "people"), plural(agents, "agent", "agents"))
    });
    let code = match hub_port {
        // As this app's window: the hub shows the code only to the host's own windows.
        Some(p) => proxy::get_as_window(p, "/api/pair/code")
            .await
            .ok()
            .and_then(|(_, b)| serde_json::from_str::<serde_json::Value>(&b).ok())
            .and_then(|v| v.get("code").and_then(|c| c.as_str()).map(str::to_string)),
        None => None,
    };
    let Some(tray) = app.tray_by_id("main") else { return };
    let shown = format!("{role:?}|{label}|{code:?}|{present:?}|{userless}|{lobby}|{project:?}|{recent:?}");
    if let Ok(mut last) = state.tray_shown.lock() {
        if *last == shown {
            return;
        }
        *last = shown;
    }
    let build = || -> tauri::Result<Menu<tauri::Wry>> {
        let menu = Menu::new(app)?;
        match role.as_deref() {
            Some("host") if lobby => {
                menu.append(&MenuItem::with_id(app, "status", "Choosing a project", false, None::<&str>)?)?;
                menu.append(&PredefinedMenuItem::separator(app)?)?;
                menu.append(&MenuItem::with_id(app, "open", "Open the Projects window", true, None::<&str>)?)?;
                menu.append(&projects_submenu(app, &recent, None)?)?;
                menu.append(&PredefinedMenuItem::separator(app)?)?;
                menu.append(&MenuItem::with_id(app, "leave", "Stop hosting", true, None::<&str>)?)?;
            }
            Some("host") => {
                menu.append(&MenuItem::with_id(app, "status", "Hosting a session", false, None::<&str>)?)?;
                if let Some(p) = &present {
                    menu.append(&MenuItem::with_id(app, "present", p, false, None::<&str>)?)?;
                }
                menu.append(&MenuItem::with_id(app, "code", format!("Join code: {}", code.as_deref().unwrap_or("…")), false, None::<&str>)?)?;
                menu.append(&PredefinedMenuItem::separator(app)?)?;
                menu.append(&projects_submenu(app, &recent, project.as_deref())?)?;
                menu.append(&PredefinedMenuItem::separator(app)?)?;
                menu.append(&MenuItem::with_id(app, "open", "Open my window", true, None::<&str>)?)?;
                menu.append(&MenuItem::with_id(app, "mute", "Mute or unmute my mic", true, None::<&str>)?)?;
                menu.append(&MenuItem::with_id(app, "muteroom", "Mute or unmute the room mic", true, None::<&str>)?)?;
                menu.append(&MenuItem::with_id(app, "bigscreen", "Show the big screen", true, None::<&str>)?)?;
                menu.append(&MenuItem::with_id(app, "screens", "Screens…", true, None::<&str>)?)?;
                menu.append(&PredefinedMenuItem::separator(app)?)?;
                menu.append(&MenuItem::with_id(app, "agents", "Connect my agents", true, None::<&str>)?)?;
                menu.append(&tauri::menu::CheckMenuItem::with_id(
                    app,
                    "userless",
                    "Use every display (nobody uses this Mac)",
                    true,
                    userless,
                    None::<&str>,
                )?)?;
                menu.append(&MenuItem::with_id(app, "setup", "Set up this Mac…", true, None::<&str>)?)?;
                menu.append(&MenuItem::with_id(app, "remote", "Set up remote access…", true, None::<&str>)?)?;
                menu.append(&PredefinedMenuItem::separator(app)?)?;
                menu.append(&MenuItem::with_id(app, "leave", "Stop hosting", true, None::<&str>)?)?;
            }
            Some("join") => {
                menu.append(&MenuItem::with_id(app, "status", format!("Joined {label}"), false, None::<&str>)?)?;
                if let Some(p) = &present {
                    menu.append(&MenuItem::with_id(app, "present", p, false, None::<&str>)?)?;
                }
                menu.append(&PredefinedMenuItem::separator(app)?)?;
                menu.append(&MenuItem::with_id(app, "open", "Open my window", true, None::<&str>)?)?;
                menu.append(&MenuItem::with_id(app, "mute", "Mute or unmute my mic", true, None::<&str>)?)?;
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

/// The Projects submenu of the menu bar: the recent projects (the open one checked), all of them,
/// and New project…. Choosing one ends this session and opens that project (`projects_menu_action`).
fn projects_submenu(app: &AppHandle, recent: &[projects::Recent], current: Option<&str>) -> tauri::Result<Submenu<tauri::Wry>> {
    let sub = Submenu::with_id(app, "projects", "Projects", true)?;
    for p in recent {
        let name: String = if p.name.chars().count() > 42 { p.name.chars().take(41).chain(['…']).collect() } else { p.name.clone() };
        sub.append(&CheckMenuItem::with_id(app, format!("project:{}", p.slug), name, true, current == Some(p.slug.as_str()), None::<&str>)?)?;
    }
    if !recent.is_empty() {
        sub.append(&PredefinedMenuItem::separator(app)?)?;
        sub.append(&MenuItem::with_id(app, "projects-all", "All projects…", true, None::<&str>)?)?;
    }
    sub.append(&MenuItem::with_id(app, "project-new", "New project…", true, None::<&str>)?)?;
    Ok(sub)
}

async fn projects_menu_action(app: &AppHandle, state: &App, id: &str) {
    let launch = match id.strip_prefix("project:") {
        Some(slug) => {
            let inner = state.inner.lock().await;
            // The project that's open already: nothing to end.
            if !inner.cfg.lobby && inner.cfg.project.as_deref() == Some(slug) {
                return;
            }
            Launch::Project(slug.to_string())
        }
        None => Launch::Lobby { new_project: id == "project-new" },
    };
    if let Err(e) = switch_project(app, state, launch).await {
        app.dialog().message(e).title("Couldn't open the project").kind(MessageDialogKind::Warning).show(|_| {});
    }
}

fn on_menu(app: &AppHandle, id: &str) {
    let app = app.clone();
    let id = id.to_string();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<Arc<App>>().inner().clone();
        let (role, hub_origin, relay, lobby) = {
            let inner = state.inner.lock().await;
            let relay = inner.relay.as_ref().map(|r| r.window_url("/client"));
            (inner.cfg.role.clone(), inner.hub.as_ref().map(|h| h.origin()), relay, inner.cfg.lobby)
        };
        match id.as_str() {
            "open" => match (role.as_deref(), hub_origin, relay) {
                (Some("host"), Some(o), _) if lobby => drop(show_window(&app, "client", &host::window_url(&o, "/projects"), "JamSesh")),
                (Some("host"), Some(o), _) => drop(open_window(&app, "client", &host::window_url(&o, "/client"), "JamSesh")),
                (Some("join"), _, Some(u)) => drop(open_window(&app, "client", &u, "JamSesh")),
                _ => open_start(&app),
            },
            // Every screen keeps its own display, so only reopen what's missing.
            "bigscreen" => {
                if let Some(o) = hub_origin {
                    let _ = screens::arrange(&app, &o).await;
                }
            }
            "screens" => screens::open_setup(&app),
            "agents" => {
                let result = set_up_agents(&app, &state).await;
                let (kind, title, text) = match result {
                    Ok(t) => (MessageDialogKind::Info, "Agents connected", t),
                    Err(t) => (MessageDialogKind::Warning, "Couldn't set up your agents", t),
                };
                app.dialog().message(text).title(title).kind(kind).show(|_| {});
            }
            // The windows' own M shortcut, so muting works from the menu bar without finding the window.
            "mute" | "muteroom" => {
                let label = if id == "mute" { "client" } else { "bigscreen" };
                if let Some(w) = app.get_webview_window(label) {
                    let _ = w.eval("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true }))");
                }
            }
            "userless" => {
                let on = {
                    let mut inner = state.inner.lock().await;
                    inner.cfg.userless = !inner.cfg.userless;
                    state.save(&inner.cfg);
                    inner.cfg.userless
                };
                set_userless(&app, on, hub_origin.as_deref());
                refresh_tray(&app).await;
            }
            "setup" => open_setup(&app),
            "remote" => {
                if let Some(o) = hub_origin {
                    open_remote_setup(&app, &o);
                }
            }
            "reopen" => match (role.as_deref(), hub_origin) {
                (Some("host"), Some(o)) => drop(screens::arrange(&app, &o).await),
                _ => on_menu(&app, "open"),
            },
            "leave" => leave(&app, &state).await,
            id if id == "projects-all" || id == "project-new" || id.starts_with("project:") => projects_menu_action(&app, &state, id).await,
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
    resume_error: Option<String>,
}

#[tauri::command]
async fn start_info(app: AppHandle, state: State<'_, Arc<App>>) -> Result<StartInfo, String> {
    let inner = state.inner.lock().await;
    let resources = app.path().resource_dir().ok().map(|r| r.join("jamsesh"));
    let problem = host::runtime(resources.as_deref()).err();
    Ok(StartInfo {
        can_host: problem.is_none(),
        host_problem: problem,
        last_host: inner.cfg.host_url.clone(),
        last_host_name: inner.cfg.host_name.clone(),
        resume_error: inner.resume_error.clone(),
    })
}

#[tauri::command]
fn nearby_hosts(state: State<'_, Arc<App>>) -> Vec<discover::Found> {
    state.hosts.list()
}

#[tauri::command]
async fn host_here(app: AppHandle, state: State<'_, Arc<App>>) -> Result<(), String> {
    let _turn = state.switching.lock().await;
    start_hosting(&app, &state, Launch::Lobby { new_project: false }).await
}

/// Whether a page may open a project: only the host's own Projects picker, in the "client" window and
/// served by the hub this Mac runs. A joined host's pages come through the relay at 127.0.0.1 too, on
/// another port, and must never stop it or start a hub here.
fn picker_may_open(label: &str, page: &url::Url, role: Option<&str>, hub_origin: Option<&str>) -> bool {
    label == "client" && role == Some("host") && hub_origin.is_some_and(|o| page.origin().ascii_serialization() == o) && page.path() == "/projects"
}

/// Opens a project: ends the session running now (the hub saves and exits first, so nothing is lost),
/// then starts the project's session, or today's again. Called from the picker (this command) and the menu bar.
#[tauri::command]
async fn open_project(
    app: AppHandle,
    webview: tauri::Webview,
    state: State<'_, Arc<App>>,
    slug: Option<String>,
    name: Option<String>,
) -> Result<(), String> {
    let allowed = {
        let inner = state.inner.lock().await;
        let page = webview.url().map_err(|e| e.to_string())?;
        picker_may_open(webview.label(), &page, inner.cfg.role.as_deref(), inner.hub.as_ref().map(|h| h.origin()).as_deref())
    };
    if !allowed {
        return Err("Projects are opened from this Mac's own Projects window.".into());
    }
    let launch = match (slug, name) {
        (Some(slug), _) if !slug.is_empty() => Launch::Project(slug),
        (_, Some(name)) if !name.trim().is_empty() => Launch::New(name),
        _ => return Err("Pick a project, or name a new one.".into()),
    };
    switch_project(&app, &state, launch).await
}

async fn switch_project(app: &AppHandle, state: &App, launch: Launch) -> Result<(), String> {
    // One transition at a time (switches, hosting, joining, leaving), from stopping the old hub to
    // cleaning up after a failed start: so the hub here is always this switch's own.
    let _turn = state.switching.lock().await;
    let (hub, relay, mirrors) = {
        let mut inner = state.inner.lock().await;
        inner.cfg.lobby = false;
        (inner.hub.take(), inner.relay.take(), inner.mirrors.drain().map(|(_, m)| m).collect::<Vec<_>>())
    };
    if let Some(r) = relay {
        r.stop();
    }
    for m in mirrors {
        m.stop();
    }
    // Wait for the old session to save and stop before the next one opens its files. A save that
    // didn't finish is said, and the next project isn't opened over it.
    if let Some(mut h) = hub {
        let stopped = tauri::async_runtime::spawn_blocking(move || h.stop()).await.unwrap_or_else(|e| Err(e.to_string()));
        if let Err(e) = stopped {
            leave_now(app, state).await;
            return Err(e);
        }
    }
    for (label, w) in app.webview_windows() {
        if label.starts_with("bigscreen") {
            let _ = w.close();
        }
    }
    let started = start_hosting(app, state, launch).await;
    if started.is_err() {
        leave_now(app, state).await;
    }
    started
}

#[tauri::command]
async fn join(app: AppHandle, state: State<'_, Arc<App>>, url: String, name: Option<String>) -> Result<(), String> {
    let _turn = state.switching.lock().await;
    start_joining(&app, &state, &url, name).await
}

/// Switches between a host someone uses (one big screen plus their window) and a user-less one
/// (a big screen on every display).
fn set_userless(app: &AppHandle, on: bool, origin: Option<&str>) {
    let Some(origin) = origin else { return };
    // The displays' defaults differ (a user-less host also presents on the laptop's own display).
    let (a, o) = (app.clone(), origin.to_string());
    tauri::async_runtime::spawn(async move { drop(screens::arrange(&a, &o).await) });
    if on {
        if let Some(w) = app.get_webview_window("client") {
            let _ = w.close();
        }
    } else {
        let _ = open_window(app, "client", &host::window_url(origin, "/client"), "JamSesh");
    }
}

#[tauri::command]
async fn get_userless(state: State<'_, Arc<App>>) -> Result<bool, String> {
    Ok(state.inner.lock().await.cfg.userless)
}

#[tauri::command]
async fn toggle_userless(app: AppHandle, state: State<'_, Arc<App>>) -> Result<bool, String> {
    let (on, origin) = {
        let mut inner = state.inner.lock().await;
        inner.cfg.userless = !inner.cfg.userless;
        state.save(&inner.cfg);
        (inner.cfg.userless, inner.hub.as_ref().map(|h| h.origin()))
    };
    set_userless(&app, on, origin.as_deref());
    refresh_tray(&app).await;
    Ok(on)
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

/// The font files of `families` from this Mac's font folders, for this person's canvas, which
/// can't see installed fonts (fonts.rs). Read off the main thread.
#[tauri::command]
async fn local_fonts(families: Vec<String>) -> Vec<fonts::LocalFont> {
    tauri::async_runtime::spawn_blocking(move || fonts::local_fonts(&families)).await.unwrap_or_default()
}

/// A page's heartbeat (web/src/shared/heartbeat.ts). The window is the one that made the call, so a
/// page can only vouch for itself.
#[tauri::command]
fn heartbeat(window: tauri::Window, state: tauri::State<'_, Arc<App>>) {
    if let Ok(mut b) = state.beats.lock() {
        b.beat(window.label(), std::time::Instant::now());
    }
}

/// What a host picks up at launch: the Projects picker if that's where it was, else the last project.
fn resume_launch(cfg: &Config) -> Launch {
    if cfg.lobby {
        return Launch::Lobby { new_project: false };
    }
    cfg.project.clone().map_or(Launch::Last, Launch::Project)
}

/// Screen Recording takes effect after a relaunch.
#[tauri::command]
fn relaunch(app: AppHandle) {
    app.restart();
}

fn main() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .on_window_event(|window, event| {
            let label = window.label();
            if !label.starts_with("bigscreen") {
                return;
            }
            match event {
                tauri::WindowEvent::Moved(_) => screens::moved(window.app_handle()),
                tauri::WindowEvent::Destroyed => screens::closed(window.app_handle(), label),
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            start_info,
            nearby_hosts,
            host_here,
            open_project,
            join,
            perm_status,
            perm_request,
            perm_settings,
            finish_setup,
            relaunch,
            remote_setup,
            get_userless,
            toggle_userless,
            local_fonts,
            heartbeat,
            screens::screens_state,
            screens::screens_preview,
            screens::screens_save,
            screens::screens_identify,
            screens::screens_close
        ])
        .setup(|app| {
            let dir = app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from("/tmp/jamsesh-app"));
            let cfg: Config = std::fs::read(dir.join("app.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
            let state = Arc::new(App {
                inner: Mutex::new(Inner { cfg: cfg.clone(), ..Default::default() }),
                hosts: discover::start(),
                dir,
                tray_shown: std::sync::Mutex::new(String::new()),
                screens: Default::default(),
                beats: Default::default(),
                switching: Mutex::new(()),
            });
            app.manage(state.clone());
            DEVTOOLS.store(cfg.devtools || std::env::var_os("JAMSESH_DEVTOOLS").is_some_and(|v| v == "1"), std::sync::atomic::Ordering::Relaxed);

            let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;
            TrayIconBuilder::with_id("main")
                .icon(icon)
                .icon_as_template(true)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, e| on_menu(app, e.id().as_ref()))
                .build(app)?;

            // Pick up where this Mac left off: keep hosting, or rejoin the same host.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let resumed = match (cfg.role.as_deref(), cfg.host_url.clone()) {
                    (Some("host"), _) => {
                        let _turn = state.switching.lock().await;
                        start_hosting(&handle, &state, resume_launch(&cfg)).await
                    }
                    (Some("join"), Some(url)) => start_joining(&handle, &state, &url, None).await,
                    _ => Err(String::new()),
                };
                if let Err(e) = resumed {
                    // Say why on the start window instead of just showing it.
                    if !e.is_empty() {
                        state.inner.lock().await.resume_error = Some(e);
                    }
                    open_start(&handle);
                }
                refresh_tray(&handle).await;
                // The join code changes every 30 seconds; keep the menu's copy current.
                let mut last_tick = std::time::Instant::now();
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    refresh_tray(&handle).await;
                    screens::watch(&handle);
                    watchdog::tick(&handle, &state.beats, &state.dir, &mut last_tick);
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
            if let Ok(mut inner) = state.inner.try_lock()
                && let Some(mut h) = inner.hub.take()
            {
                let _ = h.stop();
            }
        }
        RunEvent::Reopen { .. } => on_menu(app, "reopen"),
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_hosts_own_projects_picker_opens_a_project() {
        let hub = Some("http://127.0.0.1:4801");
        let at = |u: &str| u.parse::<url::Url>().unwrap();
        assert!(picker_may_open("client", &at("http://127.0.0.1:4801/projects?new=1"), Some("host"), hub));
        // A joined host's page, relayed at 127.0.0.1 on the relay's port, can't: nor while joined at all.
        assert!(!picker_may_open("client", &at("http://127.0.0.1:4790/projects"), Some("host"), hub));
        assert!(!picker_may_open("client", &at("http://127.0.0.1:4790/projects"), Some("join"), None));
        assert!(!picker_may_open("client", &at("http://127.0.0.1:4801/projects"), Some("join"), hub));
        // Nor the big screens, a session page, another host name, or a Mac that isn't hosting.
        assert!(!picker_may_open("bigscreen", &at("http://127.0.0.1:4801/projects"), Some("host"), hub));
        assert!(!picker_may_open("remote", &at("http://127.0.0.1:4801/projects"), Some("host"), hub));
        assert!(!picker_may_open("client", &at("http://127.0.0.1:4801/client"), Some("host"), hub));
        assert!(!picker_may_open("client", &at("http://localhost:4801/projects"), Some("host"), hub));
        assert!(!picker_may_open("client", &at("http://127.0.0.1:4801/projects"), None, None));
    }

    #[test]
    fn a_relaunch_at_the_projects_picker_opens_the_picker() {
        let mut cfg = Config { role: Some("host".into()), project: Some("passport".into()), lobby: true, ..Default::default() };
        assert_eq!(resume_launch(&cfg), Launch::Lobby { new_project: false });
        cfg.lobby = false;
        assert_eq!(resume_launch(&cfg), Launch::Project("passport".into()));
        cfg.project = None;
        assert_eq!(resume_launch(&cfg), Launch::Last);
        // Configs from before this field read as not at the picker.
        let old: Config = serde_json::from_str(r#"{"role":"host","project":"passport"}"#).unwrap();
        assert_eq!(resume_launch(&old), Launch::Project("passport".into()));
    }
}
