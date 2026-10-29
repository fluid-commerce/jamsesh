// JamSesh for Mac: host a session on this Mac, or join one.
//
// Host mode runs the hub as a child process and shows the big screen and your own window.
// Join mode shows the host's client view through a local relay (see proxy.rs), so the microphone
// works without HTTPS, and keeps this Mac's token in the Keychain.
mod discover;
mod fonts;
mod host;
mod perms;
mod proxy;
mod watchdog;

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
    /// User-less host: nobody uses this Mac, so every display is a big screen and no personal
    /// window opens.
    #[serde(default)]
    userless: bool,
    /// Web Inspector in this app's windows (right-click, Inspect Element; or Safari's Develop
    /// menu). Off unless this is set or `JAMSESH_DEVTOOLS=1`: it's for finding out why a page froze.
    #[serde(default)]
    devtools: bool,
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
    /// The displays as last seen (positions and sizes); a change rearranges a user-less host's screens.
    displays: std::sync::Mutex<String>,
    /// Bumped by each request to rearrange the screens; only the latest one runs (see `schedule_arrange`).
    arrange_gen: std::sync::atomic::AtomicU64,
    /// Until when big-screen moves are the arrangement's own and don't trigger another one.
    arranged_until: std::sync::Mutex<Option<std::time::Instant>>,
    /// What the menu bar menu shows now; it's only rebuilt when this changes (an open menu stays open).
    tray_shown: std::sync::Mutex<String>,
    hosts: discover::Hosts,
    dir: PathBuf,
    /// Heartbeats from the windows' pages (see watchdog.rs).
    beats: Arc<std::sync::Mutex<watchdog::Beats>>,
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

/// The big screen goes full screen on the display that isn't this Mac's main one, when there is one.
/// A big-screen window, full screen on one display (in the same Space, so app windows the brain
/// arranges there can sit on top).
fn big_window(app: &AppHandle, label: &str, url: &str, at: Option<tauri::PhysicalPosition<i32>>) -> Result<(), String> {
    let parsed: url::Url = url.parse().map_err(|e: url::ParseError| e.to_string())?;
    let w = WebviewWindowBuilder::new(app, label, WebviewUrl::External(parsed))
        .devtools(devtools())
        .title("JamSesh big screen")
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(18.0, 30.0))
        // A window behind another keeps its microphone and timers (WebKit would otherwise throttle
        // it, and the room mic would go quiet whenever someone's window covers the big screen).
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        .inner_size(1440.0, 900.0)
        .build()
        .map_err(|e| e.to_string())?;
    if let Some(p) = at {
        let _ = w.set_position(p);
    }
    let _ = w.set_simple_fullscreen(true);
    Ok(())
}

/// User-less host: one big screen per display. The main display gets the main screen (header,
/// join code, room feed); the others, left to right, are "screen-2", "screen-3", and so on. Runs
/// again whenever the displays change or a big screen leaves its display: a screen already on its
/// display stays as it is (no reload), one on the wrong display moves back, a missing one opens and
/// one whose display is gone closes (and the hub hears so, see `screen_closed`).
fn arrange_screens(app: &AppHandle, origin: &str) -> Result<(), String> {
    let mut monitors = app.available_monitors().unwrap_or_default();
    if monitors.is_empty() {
        return Ok(());
    }
    let primary = app.primary_monitor().ok().flatten().map(|m| *m.position());
    monitors.sort_by_key(|m| (Some(*m.position()) != primary, m.position().x, m.position().y));
    let wanted: Vec<(String, String, tauri::PhysicalPosition<i32>)> = monitors
        .iter()
        .enumerate()
        .map(|(i, m)| match i {
            0 => ("bigscreen".to_string(), "/host".to_string(), *m.position()),
            _ => (format!("bigscreen-{}", i + 1), format!("/host?screen=screen-{}", i + 1), *m.position()),
        })
        .collect();
    // The moves below are this arrangement's own: they don't ask for another one.
    if let Ok(mut until) = app.state::<Arc<App>>().arranged_until.lock() {
        *until = Some(std::time::Instant::now() + std::time::Duration::from_secs(2));
    }
    for (label, w) in app.webview_windows() {
        if label.starts_with("bigscreen") && !wanted.iter().any(|(l, ..)| *l == label) {
            let _ = w.close();
        }
    }
    for (label, path, at) in wanted {
        match app.get_webview_window(&label) {
            Some(w) => {
                if w.current_monitor().ok().flatten().map(|m| *m.position()) != Some(at) {
                    let _ = w.set_simple_fullscreen(false);
                    let _ = w.set_position(at);
                    let _ = w.set_simple_fullscreen(true);
                }
            }
            None => big_window(app, &label, &host::window_url(origin, &path), Some(at))?,
        }
    }
    Ok(())
}

/// Rearranges a user-less host's screens shortly (once things settle: a display being plugged in
/// or a window being moved fires many events).
fn schedule_arrange(app: &AppHandle) {
    let state = app.state::<Arc<App>>().inner().clone();
    let generation = state.arrange_gen.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(800)).await;
        if state.arrange_gen.load(std::sync::atomic::Ordering::SeqCst) != generation {
            return;
        }
        let origin = {
            let inner = state.inner.lock().await;
            if inner.cfg.role.as_deref() != Some("host") || !inner.cfg.userless {
                return;
            }
            inner.hub.as_ref().map(|h| h.origin())
        };
        if let Some(origin) = origin {
            let _ = arrange_screens(&app, &origin);
        }
    });
}

/// Checks the displays (from the menu bar's refresh loop) and rearranges when they changed.
fn watch_displays(app: &AppHandle) {
    let mut seen: Vec<String> = app.available_monitors().unwrap_or_default().iter().map(|m| format!("{:?}{:?}", m.position(), m.size())).collect();
    seen.sort();
    let primary = app.primary_monitor().ok().flatten().map(|m| *m.position());
    let now = format!("{primary:?}|{}", seen.join(","));
    let state = app.state::<Arc<App>>();
    let changed = match state.displays.lock() {
        Ok(mut last) if *last != now => {
            let first = last.is_empty();
            *last = now;
            !first
        }
        _ => false,
    };
    if changed {
        schedule_arrange(app);
    }
}

/// A big-screen window moved: if it left its display, put the screens back in order.
fn screen_moved(app: &AppHandle) {
    let ours = app.state::<Arc<App>>().arranged_until.lock().ok().and_then(|u| *u).is_some_and(|until| std::time::Instant::now() < until);
    if !ours {
        schedule_arrange(app);
    }
}

/// A user-less host's extra screen closed: tell the hub, so the brain stops sending it things.
/// (Not when a window with the same label is open again by then.)
fn screen_closed(app: &AppHandle, label: &str) {
    let Some(n) = label.strip_prefix("bigscreen-") else { return };
    let (app, label, screen) = (app.clone(), label.to_string(), format!("screen-{n}"));
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        if app.get_webview_window(&label).is_some() {
            return;
        }
        let origin = app.state::<Arc<App>>().inner.lock().await.hub.as_ref().map(|h| h.origin());
        if let Some(origin) = origin {
            let body = serde_json::json!({ "screen": screen }).to_string();
            let _ = proxy::send("DELETE", &origin, "/api/display", None, &body).await;
        }
    });
}

fn open_big_screen(app: &AppHandle, origin: &str, next_display: bool) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("bigscreen") {
        if !next_display {
            let _ = w.show();
            let _ = w.set_focus();
            return Ok(());
        }
        let _ = w.close();
    }
    let parsed: url::Url = host::window_url(origin, "/host").parse().map_err(|e: url::ParseError| e.to_string())?;
    let w = WebviewWindowBuilder::new(app, "bigscreen", WebviewUrl::External(parsed))
        .devtools(devtools())
        .title("JamSesh big screen")
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(18.0, 30.0))
        // A window behind another keeps its microphone and timers (WebKit would otherwise throttle
        // it, and the room mic would go quiet whenever someone's window covers the big screen).
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        .inner_size(1440.0, 900.0)
        .build()
        .map_err(|e| e.to_string())?;
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
        arrange_screens(app, &origin)?;
    } else {
        open_big_screen(app, &origin, false)?;
        open_window(app, "client", &host::window_url(&origin, "/client"), "JamSesh")?;
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
        let _ = WebviewWindowBuilder::new(app, "remote", WebviewUrl::External(url)).devtools(devtools()).title("Remote access").inner_size(900.0, 820.0).build();
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

async fn leave(app: &AppHandle, state: &App) {
    let mut inner = state.inner.lock().await;
    if let Some(r) = inner.relay.take() {
        r.stop();
    }
    for (_, m) in inner.mirrors.drain() {
        m.stop();
    }
    if let Some(mut h) = inner.hub.take() {
        tauri::async_runtime::spawn_blocking(move || h.stop());
    }
    inner.cfg.role = None;
    state.save(&inner.cfg);
    drop(inner);
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
        let mut msg = format!("{agents} connected. Restart {them}, then say \"connect to jamsesh\" in each repository you're working in.");
        let old = old_block_notices(&String::from_utf8_lossy(&out.stderr));
        if !old.is_empty() {
            msg.push_str(&format!("\n\nOne more step: an earlier JamSesh left instructions that can still make a chat join the room by itself. Delete them:\n{}", old.join("\n")));
        }
        Ok(msg)
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        Err(format!("Setup didn't finish:\n{}", failure_lines(&err)))
    }
}

/// Every line setup printed to stderr (they name the failed paths and where the saved copies are), capped
/// so a runaway script can't fill the dialog.
fn failure_lines(stderr: &str) -> String {
    let lines: Vec<&str> = stderr.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    if lines.is_empty() {
        return "unknown error".to_string();
    }
    let mut text = lines.iter().take(12).copied().collect::<Vec<_>>().join("\n");
    if lines.len() > 12 {
        text.push_str("\n…");
    }
    if text.chars().count() > 1500 {
        text = text.chars().take(1500).collect::<String>() + "…";
    }
    text
}

/// Held while the agent setup runs; taking it fails if another run holds it.
struct SetupGuard;
static SETUP_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
impl SetupGuard {
    fn take() -> Option<SetupGuard> {
        (!SETUP_RUNNING.swap(true, std::sync::atomic::Ordering::SeqCst)).then_some(SetupGuard)
    }
}
impl Drop for SetupGuard {
    fn drop(&mut self) {
        SETUP_RUNNING.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

/// The setup's notices about the block an earlier JamSesh wrote into an instruction file (file, lines,
/// what to delete), taken from its stderr. Any other stderr line is not shown.
fn old_block_notices(stderr: &str) -> Vec<String> {
    stderr.lines().filter(|l| l.starts_with("JamSesh: ") && l.contains(" still has the block an earlier JamSesh wrote")).map(str::to_string).collect()
}

#[cfg(test)]
mod tests {
    use super::{failure_lines, old_block_notices};

    #[test]
    fn the_whole_failure_is_shown_but_capped() {
        assert_eq!(failure_lines(""), "unknown error");
        assert_eq!(failure_lines("a\n\nb\n"), "a\nb");
        let many = (0..30).map(|i| format!("line {i}")).collect::<Vec<_>>().join("\n");
        let shown = failure_lines(&many);
        assert!(shown.contains("line 11") && !shown.contains("line 12") && shown.ends_with('…'));
    }

    #[test]
    fn only_one_setup_at_a_time() {
        let first = super::SetupGuard::take();
        assert!(first.is_some());
        assert!(super::SetupGuard::take().is_none());
        drop(first);
        assert!(super::SetupGuard::take().is_some());
    }

    #[test]
    fn keeps_only_the_old_block_notices() {
        let err = "some warning\nJamSesh: /Users/a/.claude/CLAUDE.md still has the block an earlier JamSesh wrote (lines 4-9). Delete them.\nJamSesh: other\n";
        assert_eq!(old_block_notices(err), vec!["JamSesh: /Users/a/.claude/CLAUDE.md still has the block an earlier JamSesh wrote (lines 4-9). Delete them."]);
        assert!(old_block_notices("").is_empty());
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
    let (role, label, hub_port, relay_port, userless) = {
        let inner = state.inner.lock().await;
        let label = inner.cfg.host_name.clone().or(inner.cfg.host_url.clone()).unwrap_or_default();
        (inner.cfg.role.clone(), label, inner.hub.as_ref().map(|h| h.port), inner.relay.as_ref().map(|r| r.port), inner.cfg.userless)
    };
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
    let shown = format!("{role:?}|{label}|{code:?}|{present:?}|{userless}");
    if let Ok(mut last) = state.tray_shown.lock() {
        if *last == shown {
            return;
        }
        *last = shown;
    }
    let build = || -> tauri::Result<Menu<tauri::Wry>> {
        let menu = Menu::new(app)?;
        match role.as_deref() {
            Some("host") => {
                menu.append(&MenuItem::with_id(app, "status", "Hosting a session", false, None::<&str>)?)?;
                if let Some(p) = &present {
                    menu.append(&MenuItem::with_id(app, "present", p, false, None::<&str>)?)?;
                }
                menu.append(&MenuItem::with_id(app, "code", format!("Join code: {}", code.as_deref().unwrap_or("…")), false, None::<&str>)?)?;
                menu.append(&PredefinedMenuItem::separator(app)?)?;
                menu.append(&MenuItem::with_id(app, "open", "Open my window", true, None::<&str>)?)?;
                menu.append(&MenuItem::with_id(app, "mute", "Mute or unmute my mic", true, None::<&str>)?)?;
                menu.append(&MenuItem::with_id(app, "muteroom", "Mute or unmute the room mic", true, None::<&str>)?)?;
                menu.append(&MenuItem::with_id(app, "bigscreen", "Show the big screen", true, None::<&str>)?)?;
                // A user-less host has a big screen on every display already.
                if !userless {
                    menu.append(&MenuItem::with_id(app, "nextdisplay", "Move the big screen to the next display", true, None::<&str>)?)?;
                }
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

fn on_menu(app: &AppHandle, id: &str) {
    let app = app.clone();
    let id = id.to_string();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<Arc<App>>().inner().clone();
        let (role, hub_origin, relay, userless) = {
            let inner = state.inner.lock().await;
            let relay = inner.relay.as_ref().map(|r| r.window_url("/client"));
            (inner.cfg.role.clone(), inner.hub.as_ref().map(|h| h.origin()), relay, inner.cfg.userless)
        };
        match id.as_str() {
            "open" => match (role.as_deref(), hub_origin, relay) {
                (Some("host"), Some(o), _) => drop(open_window(&app, "client", &host::window_url(&o, "/client"), "JamSesh")),
                (Some("join"), _, Some(u)) => drop(open_window(&app, "client", &u, "JamSesh")),
                _ => open_start(&app),
            },
            "bigscreen" | "nextdisplay" => {
                if let Some(o) = hub_origin {
                    // User-less: every display keeps its own screen, so only reopen what's missing.
                    let _ = if userless { arrange_screens(&app, &o) } else { open_big_screen(&app, &o, id == "nextdisplay") };
                }
            }
            "agents" => {
                // One setup at a time: a second would race the first over the same files.
                if let Some(_running) = SetupGuard::take() {
                    let result = set_up_agents(&app, &state).await;
                    let (kind, title, text) = match result {
                        Ok(t) => (MessageDialogKind::Info, "Agents connected", t),
                        Err(t) => (MessageDialogKind::Warning, "Couldn't set up your agents", t),
                    };
                    app.dialog().message(text).title(title).kind(kind).show(|_| {});
                } else {
                    app.dialog().message("Agent setup is already running. Wait for it to finish.").title("Setup is running").kind(MessageDialogKind::Info).show(|_| {});
                }
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
                (Some("host"), Some(o)) if userless => drop(arrange_screens(&app, &o)),
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
    start_hosting(&app, &state).await
}

#[tauri::command]
async fn join(app: AppHandle, state: State<'_, Arc<App>>, url: String, name: Option<String>) -> Result<(), String> {
    start_joining(&app, &state, &url, name).await
}

/// Switches between a host someone uses (one big screen plus their window) and a user-less one
/// (a big screen on every display).
fn set_userless(app: &AppHandle, on: bool, origin: Option<&str>) {
    let Some(origin) = origin else { return };
    if on {
        if let Some(w) = app.get_webview_window("client") {
            let _ = w.close();
        }
        let _ = arrange_screens(app, origin);
    } else {
        for (label, w) in app.webview_windows() {
            if label.starts_with("bigscreen") {
                let _ = w.close();
            }
        }
        let _ = open_big_screen(app, origin, false);
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
                tauri::WindowEvent::Moved(_) => screen_moved(window.app_handle()),
                tauri::WindowEvent::Destroyed => screen_closed(window.app_handle(), label),
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            start_info,
            nearby_hosts,
            host_here,
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
            heartbeat
        ])
        .setup(|app| {
            let dir = app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from("/tmp/jamsesh-app"));
            let cfg: Config = std::fs::read(dir.join("app.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
            let state = Arc::new(App {
                inner: Mutex::new(Inner { cfg: cfg.clone(), ..Default::default() }),
                hosts: discover::start(),
                dir,
                tray_shown: std::sync::Mutex::new(String::new()),
                displays: std::sync::Mutex::new(String::new()),
                arrange_gen: std::sync::atomic::AtomicU64::new(0),
                arranged_until: std::sync::Mutex::new(None),
                beats: Default::default(),
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
                    (Some("host"), _) => start_hosting(&handle, &state).await,
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
                    watch_displays(&handle);
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
                h.stop();
            }
        }
        RunEvent::Reopen { .. } => on_menu(app, "reopen"),
        _ => {}
    });
}
