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
    /// Every change of session (hosting, a project switch, joining, leaving, resuming, Quit, Reopen) takes a turn here.
    switching: Turns,
}

/// The one queue for changing session: one transition at a time, from stopping the old hub to cleaning up after a
/// failed start. A request is made against the session as it was then (its `Ticket`); if another transition ran
/// while it waited, the session it was about is gone and it does nothing (a project picked behind Leave never
/// starts hosting again). Quit and Reopen take the last turn: nothing queued behind them starts, and the app
/// exits only once the hub's save was acknowledged (`ended`).
struct Turns {
    lock: Mutex<()>,
    quitting: std::sync::atomic::AtomicBool,
    /// Counts the transitions that ran.
    epoch: std::sync::atomic::AtomicU64,
    /// The final stop finished and the person was told how it went: only now may the app exit.
    ended: std::sync::atomic::AtomicBool,
    /// A session's last save didn't finish. It can't be retried (the hub is gone), so it blocks every restart until the
    /// person chooses to reopen anyway.
    unsaved: std::sync::Mutex<Option<String>>,
}

/// The session a request was made against.
#[derive(Clone, Copy)]
struct Ticket(u64);

/// A transition's turn. Letting go of it counts the transition as run, so requests made before it are stale; a quiet
/// turn (arranging the screens of the session there is) doesn't.
struct Turn<'a> {
    turns: &'a Turns,
    counts: bool,
    _held: tokio::sync::MutexGuard<'a, ()>,
}

impl Drop for Turn<'_> {
    fn drop(&mut self) {
        if self.counts {
            self.turns.epoch.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
    }
}

impl Turn<'_> {
    /// A Reopen whose save failed: the app stays, so later transitions may run again.
    fn keep_running(&self) {
        self.turns.quitting.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

impl Turns {
    fn new() -> Self {
        Turns { lock: Mutex::new(()), quitting: false.into(), epoch: 0.into(), ended: false.into(), unsaved: Default::default() }
    }
    /// The session as a request finds it, taken when the request is made (before it waits).
    fn ticket(&self) -> Ticket {
        Ticket(self.epoch.load(std::sync::atomic::Ordering::SeqCst))
    }
    /// The turn for a request made against `ticket`: `None` if the app is quitting, or if another transition ran
    /// since the request was made, so what it asked for no longer applies.
    async fn lock(&self, ticket: Ticket) -> Option<Turn<'_>> {
        self.take(Some(ticket), true).await
    }
    /// Leave's turn: it ends whatever session is there by then, so it is never stale; only Quit stops it.
    async fn lock_now(&self) -> Option<Turn<'_>> {
        self.take(None, true).await
    }
    /// A turn for work on the session `ticket` was taken in that doesn't change which session runs (arranging its
    /// windows, telling its hub about displays): no transition runs meanwhile, and it never makes others stale.
    async fn lock_quiet(&self, ticket: Ticket) -> Option<Turn<'_>> {
        self.take(Some(ticket), false).await
    }
    async fn take(&self, ticket: Option<Ticket>, counts: bool) -> Option<Turn<'_>> {
        let held = self.lock.lock().await;
        let quitting = self.quitting.load(std::sync::atomic::Ordering::SeqCst);
        let stale = ticket.is_some_and(|t| self.epoch.load(std::sync::atomic::Ordering::SeqCst) != t.0);
        // Refused without counting as a transition: nothing changed.
        if quitting || stale {
            return None;
        }
        Some(Turn { turns: self, counts, _held: held })
    }
    /// The last turn (Quit): everyone after it gets `None`.
    async fn quit(&self) -> Turn<'_> {
        let held = self.lock.lock().await;
        self.quitting.store(true, std::sync::atomic::Ordering::SeqCst);
        Turn { turns: self, counts: true, _held: held }
    }
    /// Reopen's last turn, for a request made against `ticket`: `None` when another transition (an earlier Reopen
    /// among them) ran since, so two Reopens never both act.
    async fn quit_for(&self, ticket: Ticket) -> Option<Turn<'_>> {
        let turn = self.lock(ticket).await?;
        self.quitting.store(true, std::sync::atomic::Ordering::SeqCst);
        Some(turn)
    }
    /// Why the app may not restart: a save that didn't finish and that the person hasn't chosen to leave behind.
    fn unsaved(&self) -> Option<String> {
        self.unsaved.lock().ok().and_then(|u| u.clone())
    }
    fn set_unsaved(&self, why: Option<String>) {
        if let Ok(mut u) = self.unsaved.lock() {
            *u = why;
        }
    }
}

/// Whether windows get Web Inspector; set once at launch from the saved config or the environment.
static DEVTOOLS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn devtools() -> bool {
    DEVTOOLS.load(std::sync::atomic::Ordering::Relaxed)
}

impl App {
    fn save(&self, cfg: &Config) -> Result<(), String> {
        write_config(&self.dir, cfg)
    }
}

/// Writes app.json whole or not at all (a temp file renamed over it), so an interrupted or failed
/// write never leaves relaunch reading half a config.
fn write_config(dir: &std::path::Path, cfg: &Config) -> Result<(), String> {
    let failed = |e: std::io::Error| format!("Couldn't save JamSesh's settings: {e}");
    std::fs::create_dir_all(dir).map_err(failed)?;
    let json = serde_json::to_vec_pretty(cfg).map_err(|e| e.to_string())?;
    let tmp = dir.join("app.json.tmp");
    std::fs::write(&tmp, json).map_err(failed)?;
    std::fs::rename(&tmp, dir.join("app.json")).map_err(failed)
}

fn warn(app: &AppHandle, title: &str, message: String) {
    app.dialog().message(message).title(title).kind(MessageDialogKind::Warning).show(|_| {});
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
        state.save(&inner.cfg)?;
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
    state.save(&inner.cfg)?;
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

/// The join code from a scanned QR code, as the connect page takes it: capitals and digits only.
fn clean_code(code: Option<&str>) -> Option<String> {
    let c: String = code?.to_uppercase().chars().filter(char::is_ascii_alphanumeric).collect();
    matches!(c.len(), 4 | 8).then_some(c)
}

async fn start_joining(app: &AppHandle, state: &App, input: &str, name: Option<String>, code: Option<&str>) -> Result<(), String> {
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
    let connect = match clean_code(code) {
        Some(c) => format!("/connect?next=%2Fclient&c={c}"),
        None => "/connect?next=%2Fclient".to_string(),
    };
    let url = relay.window_url(if paired { "/client" } else { &connect });
    let needs_agents = paired && agents.is_none();
    inner.relay = Some(relay);
    inner.cfg.role = Some("join".into());
    inner.cfg.host_url = Some(origin);
    if name.is_some() {
        inner.cfg.host_name = name;
    }
    state.save(&inner.cfg)?;
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
            if let Err(e) = state.save(&inner.cfg) {
                warn(&app, "Settings not saved", e);
            }
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
    let Some(_turn) = state.switching.lock_now().await else { return };
    leave_now(app, state).await;
}

/// What a transition starts from, checked once it has its turn (the session may have changed while it waited).
#[derive(Clone, Copy, Debug, PartialEq)]
enum Before {
    /// No hub and no relay: hosting or joining starts from nothing, so it never leaves an old session running.
    Idle,
    /// This Mac's hub is running: a project switch replaces it.
    Hosting,
}

fn may_start(before: Before, role: Option<&str>, hub: bool, relay: bool) -> Result<(), String> {
    match before {
        Before::Idle if !hub && !relay => Ok(()),
        Before::Idle => Err("This Mac is already in a session. Leave it first.".into()),
        Before::Hosting if hub && role == Some("host") => Ok(()),
        Before::Hosting => Err("This Mac isn't hosting any more, so there's no project to switch.".into()),
    }
}

/// `may_start` against the session now. The caller holds its turn.
async fn session_is(state: &App, before: Before) -> Result<(), String> {
    let inner = state.inner.lock().await;
    may_start(before, inner.cfg.role.as_deref(), inner.hub.is_some(), inner.relay.is_some())
}

/// Said to a request whose session changed while it waited for its turn.
const STALE: &str = "The session changed while this was waiting, so nothing was opened. Try again.";

/// The last transition (Quit, Reopen): takes the last turn, so nothing queued behind it starts, then stops the hub
/// and waits for it to say its final save finished.
async fn final_stop(state: &App) -> (Turn<'_>, Result<(), String>) {
    let turn = state.switching.quit().await;
    let stopped = stop_hub(state).await;
    (turn, stopped)
}

/// Takes this Mac's hub and waits for it to say its final save finished. The caller holds its turn. A save that didn't
/// finish is remembered (`Turns::unsaved`): no restart goes ahead over it until the person says so.
async fn stop_hub(state: &App) -> Result<(), String> {
    let hub = state.inner.lock().await.hub.take();
    let stopped = match hub {
        Some(mut h) => tauri::async_runtime::spawn_blocking(move || h.stop()).await.unwrap_or_else(|e| Err(e.to_string())),
        None => Ok(()),
    };
    if let Err(e) = &stopped {
        state.switching.set_unsaved(Some(e.clone()));
    }
    stopped
}

/// A transition (hosting, joining, resuming) that failed part way leaves nothing behind: its hub or
/// relay stops, the saved role is cleared and the start window is back, so trying again starts clean.
/// The caller holds `state.switching`.
async fn rolled_back(app: &AppHandle, state: &App, result: Result<(), String>) -> Result<(), String> {
    if result.is_err() {
        leave_now(app, state).await;
    }
    result
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
    let saved = state.save(&inner.cfg);
    drop(inner);
    if let Err(e) = saved {
        warn(app, "Settings not saved", e);
    }
    // The session saves before anything else starts.
    if let Some(mut h) = hub {
        // A stop that panicked or was cancelled has an unknown save outcome: say so, as `stop_hub` does.
        let failed = match tauri::async_runtime::spawn_blocking(move || h.stop()).await {
            Ok(Ok(())) => None,
            Ok(Err(e)) => Some(e),
            Err(e) => Some(e.to_string()),
        };
        if let Some(e) = failed {
            state.switching.set_unsaved(Some(e.clone()));
            app.dialog().message(e).title("The session didn't finish saving").kind(MessageDialogKind::Warning).show(|_| {});
        }
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
    let mut cmd = tokio::process::Command::new("/bin/bash");
    cmd.arg("-s")
        .env("PATH", host::path_env())
        .env("JAMSESH_NAME", &name)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    // The setup checks Codex's TOML config with Bun's parser. The app's own hub is a Bun executable (it
    // runs as Bun itself when told to), so a Mac without Bun installed still has one.
    let resources = app.path().resource_dir().ok().map(|r| r.join("jamsesh"));
    match host::runtime(resources.as_deref()) {
        Ok(host::Runtime::Bundled { hub, .. }) => cmd.env("JAMSESH_BUN", hub),
        Ok(host::Runtime::Checkout { bun, .. }) => cmd.env("JAMSESH_BUN", bun),
        Err(_) => &mut cmd,
    };
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
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
        Err(format!("Setup didn't finish:\n{}", failure_lines(&err, &String::from_utf8_lossy(&out.stdout))))
    }
}

/// What setup printed, for the dialog: the line it marked `ERROR:` (the root error, always kept), the last
/// lines of stderr (what was put back, what was not, where the saved copies are) and the last lines of
/// stdout. Each line is cut to a fixed length, so the root error survives however much follows it.
fn failure_lines(stderr: &str, stdout: &str) -> String {
    const TAIL_ERR: usize = 8;
    const TAIL_OUT: usize = 3;
    const LINE: usize = 300;
    let cut = |l: &str| if l.chars().count() > LINE { format!("{}…", l.chars().take(LINE).collect::<String>()) } else { l.to_string() };
    let nonblank = |t: &str| t.lines().map(str::trim).filter(|l| !l.is_empty()).map(cut).collect::<Vec<_>>();
    let err = nonblank(stderr);
    let out = nonblank(stdout);
    let Some(root) = err.iter().position(|l| l.starts_with("ERROR:")).or(if err.is_empty() { None } else { Some(0) }) else {
        return if out.is_empty() { "unknown error".to_string() } else { out[out.len().saturating_sub(TAIL_OUT)..].join("\n") };
    };
    let tail_from = err.len().saturating_sub(TAIL_ERR).max(root + 1);
    let mut shown = vec![err[root].clone()];
    if tail_from > root + 1 {
        shown.push("…".to_string());
    }
    shown.extend(err[tail_from..].iter().cloned());
    if !out.is_empty() {
        shown.push("Setup also printed:".to_string());
        shown.extend(out[out.len().saturating_sub(TAIL_OUT)..].iter().cloned());
    }
    shown.join("\n")
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
    fn the_root_error_and_the_end_are_shown_whatever_comes_between() {
        assert_eq!(failure_lines("", ""), "unknown error");
        assert_eq!(failure_lines("a\n\nb\n", ""), "a\nb");
        let mut lines = vec!["noise 0".to_string(), "ERROR: the root".to_string()];
        lines.extend((0..30).map(|i| format!("line {i}")));
        let shown = failure_lines(&lines.join("\n"), "ok one\nok two\nok three\nDone\n");
        assert!(shown.starts_with("ERROR: the root\n…\nline 22"), "{shown}");
        assert!(shown.contains("line 29\nSetup also printed:\nok two\nok three\nDone") && !shown.contains("noise 0") && !shown.contains("line 10"));
        // One huge line can't push the root error out, and is cut itself.
        let long = format!("ERROR: root\n{}\nlast", "x".repeat(5000));
        let shown = failure_lines(&long, "");
        assert!(shown.starts_with("ERROR: root\n") && shown.ends_with("last") && shown.chars().count() < 700);
        // With no ERROR: line the first line stands in.
        assert!(failure_lines("first\nsecond", "").starts_with("first"));
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

async fn projects_menu_action(app: &AppHandle, state: &App, ticket: Ticket, id: &str) {
    let Some(_turn) = state.switching.lock(ticket).await else { return };
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
    let switched = match session_is(state, Before::Hosting).await {
        Ok(()) => switch_now(app, state, launch).await,
        Err(e) => Err(e),
    };
    if let Err(e) = switched {
        app.dialog().message(e).title("Couldn't open the project").kind(MessageDialogKind::Warning).show(|_| {});
    }
}

fn on_menu(app: &AppHandle, id: &str) {
    let app = app.clone();
    let id = id.to_string();
    // The session this click was about, before anything waits.
    let ticket = app.state::<Arc<App>>().switching.ticket();
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
                let _ = screens::arrange_for(&app, ticket).await;
            }
            "screens" => screens::open_setup(&app),
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
                if let Err(e) = toggle_userless_for(&app, &state, ticket).await {
                    warn(&app, "Settings not saved", e);
                }
                refresh_tray(&app).await;
            }
            "setup" => open_setup(&app),
            "remote" => {
                if let Some(o) = hub_origin {
                    open_remote_setup(&app, &o);
                }
            }
            "reopen" => match (role.as_deref(), hub_origin) {
                (Some("host"), Some(_)) => drop(screens::arrange_for(&app, ticket).await),
                _ => on_menu(&app, "open"),
            },
            "leave" => leave(&app, &state).await,
            id if id == "projects-all" || id == "project-new" || id.starts_with("project:") => projects_menu_action(&app, &state, ticket, id).await,
            // The session saves first (after any switch under way). The turn is held to the end: a switch
            // queued behind Quit never starts a session, and the exit waits for the acknowledged stop.
            "quit" => {
                let (_turn, stopped) = final_stop(&state).await;
                match stopped {
                    Ok(()) => {
                        state.switching.ended.store(true, std::sync::atomic::Ordering::SeqCst);
                        app.exit(0)
                    }
                    Err(e) => {
                        let (handle, st) = (app.clone(), state.clone());
                        app.dialog().message(e).title("The session didn't finish saving").kind(MessageDialogKind::Warning).show(move |_| {
                            st.switching.ended.store(true, std::sync::atomic::Ordering::SeqCst);
                            handle.exit(0)
                        });
                        std::future::pending::<()>().await;
                    }
                }
            }
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
fn discovery_status(state: State<'_, Arc<App>>) -> discover::Status {
    state.hosts.status()
}

#[tauri::command]
async fn host_here(app: AppHandle, state: State<'_, Arc<App>>) -> Result<(), String> {
    let ticket = state.switching.ticket();
    let Some(_turn) = state.switching.lock(ticket).await else { return Ok(()) };
    session_is(&state, Before::Idle).await?;
    let started = start_hosting(&app, &state, Launch::Lobby { new_project: false }).await;
    rolled_back(&app, &state, started).await
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
    let ticket = state.switching.ticket();
    let launch = match (slug, name) {
        (Some(slug), _) if !slug.is_empty() => Launch::Project(slug),
        (_, Some(name)) if !name.trim().is_empty() => Launch::New(name),
        _ => return Err("Pick a project, or name a new one.".into()),
    };
    let Some(_turn) = state.switching.lock(ticket).await else { return Err(STALE.into()) };
    // Checked in the turn: the picker is still this Mac's own, on the hub running now.
    let allowed = {
        let inner = state.inner.lock().await;
        let page = webview.url().map_err(|e| e.to_string())?;
        picker_may_open(webview.label(), &page, inner.cfg.role.as_deref(), inner.hub.as_ref().map(|h| h.origin()).as_deref())
    };
    if !allowed {
        return Err("Projects are opened from this Mac's own Projects window.".into());
    }
    session_is(&state, Before::Hosting).await?;
    switch_now(&app, &state, launch).await
}

/// Ends this Mac's session and starts `launch`'s. The caller holds its turn and checked that this Mac is hosting,
/// so the hub stopped here is the one the request was about.
async fn switch_now(app: &AppHandle, state: &App, launch: Launch) -> Result<(), String> {
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
            state.switching.set_unsaved(Some(e.clone()));
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
async fn join(app: AppHandle, state: State<'_, Arc<App>>, url: String, name: Option<String>, code: Option<String>) -> Result<(), String> {
    let ticket = state.switching.ticket();
    let Some(_turn) = state.switching.lock(ticket).await else { return Ok(()) };
    session_is(&state, Before::Idle).await?;
    let joined = start_joining(&app, &state, &url, name, code.as_deref()).await;
    rolled_back(&app, &state, joined).await
}

/// Switches between a host someone uses (one big screen plus their window) and a user-less one
/// (a big screen on every display).
/// In a quiet turn for the session `ticket` was taken in, the setting, the windows and the arrangement change together,
/// or (the session changed since) none of them. Returns the setting as it is now.
async fn toggle_userless_for(app: &AppHandle, state: &App, ticket: Ticket) -> Result<bool, String> {
    let Some(_turn) = state.switching.lock_quiet(ticket).await else { return Ok(state.inner.lock().await.cfg.userless) };
    let (on, origin) = {
        let mut inner = state.inner.lock().await;
        let next = Config { userless: !inner.cfg.userless, ..inner.cfg.clone() };
        state.save(&next)?;
        inner.cfg = next;
        (inner.cfg.userless, inner.hub.as_ref().map(|h| h.origin()))
    };
    if let Some(origin) = origin {
        if on {
            if let Some(w) = app.get_webview_window("client") {
                let _ = w.close();
            }
        } else {
            let _ = open_window(app, "client", &host::window_url(&origin, "/client"), "JamSesh");
        }
        // The displays' defaults differ (a user-less host also presents on the laptop's own display).
        let _ = screens::arrange_current(app).await;
    }
    Ok(on)
}

#[tauri::command]
async fn get_userless(state: State<'_, Arc<App>>) -> Result<bool, String> {
    Ok(state.inner.lock().await.cfg.userless)
}

#[tauri::command]
async fn toggle_userless(app: AppHandle, state: State<'_, Arc<App>>) -> Result<bool, String> {
    let ticket = state.switching.ticket();
    let on = toggle_userless_for(&app, &state, ticket).await?;
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
    state.save(&inner.cfg)?;
    drop(inner);
    if let Some(w) = app.get_webview_window("setup") {
        let _ = w.close();
    }
    Ok(())
}

/// Lends a font to the session (fonts.rs). A native dialog names the font, the session and who is waiting, and only
/// "I'm allowed to share it" reads the files. This sends them to the hub itself, so the page that asked never holds
/// them: with a ticket the hub issued for this window, signed with a key no page can read. That key is the window key
/// this app shares with the hub it started, or, for a joined host reached through the relay, the hash of the window's
/// own credential (the relay adds the credential; the hub keeps its hash). The hub takes lent fonts only this way.
#[tauri::command]
async fn lend_font(
    app: AppHandle,
    webview: tauri::Webview,
    state: State<'_, Arc<App>>,
    family: String,
    session: String,
    askers: Vec<String>,
) -> Result<(), String> {
    let origin = webview.url().map_err(|e| e.to_string())?.origin().ascii_serialization();
    let key = {
        let inner = state.inner.lock().await;
        if inner.hub.as_ref().is_some_and(|h| h.origin() == origin) {
            proxy::window_key().map(|k| k.as_bytes().to_vec())
        } else {
            inner.relay.as_ref().filter(|r| r.url("") == origin).and_then(|r| r.person_token()).map(|t| fonts::sha256_hex(t.as_bytes()).into_bytes())
        }
    }
    .ok_or("Fonts are shared from a JamSesh window on this Mac.")?;
    let asked = family.clone();
    let files = tauri::async_runtime::spawn_blocking(move || {
        fonts::lend(&asked, &session, &askers, |text| {
            app.dialog()
                .message(text)
                .title("Share a font")
                .buttons(MessageDialogButtons::OkCancelCustom("I'm allowed to share it".into(), "Don't share".into()))
                .blocking_show()
        })
    })
    .await
    .map_err(|_| "Couldn't share the font.".to_string())??;
    let files: Vec<String> = files.into_iter().map(|f| f.data).collect();
    let answer = proxy::post_as_window_json(&origin, "/api/fonts/lend-ticket", serde_json::json!({ "family": family }).to_string(), 8).await?;
    let ticket = serde_json::from_str::<serde_json::Value>(&answer)
        .ok()
        .and_then(|v| v["ticket"].as_str().map(str::to_string))
        .ok_or("The host didn't answer.")?;
    let sig = fonts::lend_signature(&key, &ticket, &files);
    let body = serde_json::json!({ "family": family, "files": files, "ticket": ticket, "sig": sig }).to_string();
    proxy::post_as_window_json(&origin, "/api/fonts/lend", body, 120).await.map(|_| ())
}

/// Which of `families` are installed on this Mac (names only; no font is read). The page offers
/// to lend a font only if its Mac has it (fonts.rs).
#[tauri::command]
async fn has_fonts(families: Vec<String>) -> Vec<String> {
    tauri::async_runtime::spawn_blocking(move || fonts::installed(&families)).await.unwrap_or_default()
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

/// Screen Recording takes effect after a relaunch. Like Quit: the last turn, and the hub's acknowledged save, before
/// the app reopens (into the same session). Made against the session it was asked in: a second Reopen queued behind
/// the first does nothing. A save that didn't finish, now or before, blocks the reopen until the person chooses to
/// reopen anyway.
#[tauri::command]
async fn relaunch(app: AppHandle, state: State<'_, Arc<App>>) -> Result<(), String> {
    let ticket = state.switching.ticket();
    let Err(e) = reopen(&app, &state, ticket, false).await else { return Ok(()) };
    // Ask; "Reopen anyway" is the person leaving that save behind, for the session they were asked about.
    let ticket = state.switching.ticket();
    let (handle, st) = (app.clone(), state.inner().clone());
    app.dialog()
        .message(format!("{e} JamSesh hasn't reopened. Reopen anyway, leaving those changes behind?"))
        .title("The session didn't finish saving")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom("Reopen anyway".into(), "Not now".into()))
        .show(move |anyway| {
            if anyway {
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = reopen(&handle, &st, ticket, true).await {
                        warn(&handle, "The session didn't finish saving", e);
                    }
                });
            }
        });
    Err(e)
}

/// One Reopen: the last turn for the session `ticket` was taken in (a second Reopen queued behind it, or a dialog
/// answered after the session changed, does nothing). An earlier save that didn't finish (`Turns::unsaved`) stops it
/// before anything is stopped, unless the person chose to leave it behind (`discard`, cleared only inside this valid
/// turn). Then the hub's acknowledged stop, and a restart only if that save finished; if not, the app stays, back at
/// the start, and says why.
async fn reopen(app: &AppHandle, state: &App, ticket: Ticket, discard: bool) -> Result<(), String> {
    let Some(turn) = state.switching.quit_for(ticket).await else { return Ok(()) };
    if discard {
        state.switching.set_unsaved(None);
    }
    if let Some(e) = state.switching.unsaved() {
        // The running session, if any, is left exactly as it is.
        turn.keep_running();
        return Err(e);
    }
    if let Err(e) = stop_hub(state).await {
        turn.keep_running();
        leave_now(app, state).await;
        return Err(e);
    }
    state.switching.ended.store(true, std::sync::atomic::Ordering::SeqCst);
    app.request_restart();
    Ok(())
}

fn main() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .on_window_event(|window, event| {
            let label = window.label();
            if !label.starts_with("bigscreen") {
                return;
            }
            if screens::rearranges_on(event) {
                screens::moved(window.app_handle());
            } else if matches!(event, tauri::WindowEvent::Destroyed) {
                screens::closed(window.app_handle(), label);
            }
        })
        .invoke_handler(tauri::generate_handler![
            start_info,
            nearby_hosts,
            discovery_status,
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
            has_fonts,
            lend_font,
            heartbeat,
            screens::screens_state,
            screens::screens_preview,
            screens::screens_save,
            screens::screens_identify,
            screens::screens_close
        ])
        .setup(|app| {
            let dir = app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from("/tmp/jamsesh-app"));
            let stuck = forget_voice_copies(&dir);
            if !stuck.is_empty() {
                let list = stuck.iter().map(|(p, e)| format!("{} ({e})", p.display())).collect::<Vec<_>>().join("\n");
                let text = format!("Earlier versions kept a copy of your voice on this Mac. JamSesh couldn't delete it:\n{list}\nDelete it in Finder; JamSesh will try again next time it opens.");
                app.dialog().message(text).title("An old copy of your voice is still here").kind(MessageDialogKind::Warning).show(|_| {});
            }
            let cfg: Config = std::fs::read(dir.join("app.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
            let state = Arc::new(App {
                inner: Mutex::new(Inner { cfg: cfg.clone(), ..Default::default() }),
                hosts: discover::start(),
                dir,
                tray_shown: std::sync::Mutex::new(String::new()),
                screens: Default::default(),
                beats: Default::default(),
                switching: Turns::new(),
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
            let ticket = state.switching.ticket();
            tauri::async_runtime::spawn(async move {
                let resumed = {
                    let Some(_turn) = state.switching.lock(ticket).await else { return };
                    let r = match (cfg.role.as_deref(), cfg.host_url.clone()) {
                        (Some("host"), _) => start_hosting(&handle, &state, resume_launch(&cfg)).await,
                        (Some("join"), Some(url)) => start_joining(&handle, &state, &url, None, None).await,
                        _ => Err(String::new()),
                    };
                    // Say why on the start window instead of just showing it.
                    if let Err(e) = &r
                        && !e.is_empty()
                    {
                        state.inner.lock().await.resume_error = Some(e.clone());
                        rolled_back(&handle, &state, r.clone()).await
                    } else {
                        r
                    }
                };
                if resumed.is_err() {
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
        // Any other way out (the system logging out, say) goes through Quit: the last turn and the acknowledged save.
        RunEvent::ExitRequested { api, .. } if !app.state::<Arc<App>>().switching.ended.load(std::sync::atomic::Ordering::SeqCst) => {
            api.prevent_exit();
            on_menu(app, "quit");
        }
        // Only a restart can't be held back, and Reopen stops the hub before asking for one; a hub still here
        // is stopped now, waiting for it, and what happened is kept in the log.
        RunEvent::Exit => {
            let state = app.state::<Arc<App>>().inner().clone();
            let hub = tauri::async_runtime::block_on(async {
                tokio::time::timeout(std::time::Duration::from_secs(5), state.inner.lock()).await.map(|mut i| i.hub.take())
            });
            let stopped = match hub {
                Ok(Some(mut h)) => h.stop(),
                Ok(None) => Ok(()),
                Err(_) => Err("JamSesh exited while a session change was under way; the hub wasn't stopped cleanly.".into()),
            };
            if let Err(e) = stopped {
                use std::io::Write;
                let _ = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(state.dir.join("logs").join("exit.log"))
                    .and_then(|mut f| writeln!(f, "{e}"));
            }
        }
        RunEvent::Reopen { .. } => on_menu(app, "reopen"),
        _ => {}
    });
}

/// Earlier builds kept a copy of the person's voice in the app's folder, as voiceprint.json, written through
/// voiceprint.json.<pid>.<n>.part (left behind if the app was killed mid-write). Voices now stay on the host
/// that learned them, so every such copy is deleted. Returns the ones that are still there after two tries.
fn forget_voice_copies(dir: &std::path::Path) -> Vec<(PathBuf, std::io::Error)> {
    let names = match std::fs::read_dir(dir) {
        Ok(entries) => entries.filter_map(|e| e.ok()).map(|e| e.file_name()).collect::<Vec<_>>(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(e) => return vec![(dir.to_path_buf(), e)],
    };
    let mut stuck = Vec::new();
    for name in names {
        let Some(n) = name.to_str() else { continue };
        if !(n == "voiceprint.json" || (n.starts_with("voiceprint.json.") && n.ends_with(".part"))) {
            continue;
        }
        let path = dir.join(n);
        let gone = |r: std::io::Result<()>| match r {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        };
        if let Err(e) = gone(std::fs::remove_file(&path)).or_else(|_| gone(std::fs::remove_file(&path))) {
            stuck.push((path, e));
        }
    }
    stuck
}

#[cfg(test)]
mod voice_copy_tests {
    use super::*;

    fn folder(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("jamsesh-voice-copies-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn an_old_voice_copy_and_an_interrupted_write_of_one_are_deleted_and_nothing_else() {
        let d = folder("ok");
        for f in ["voiceprint.json", "voiceprint.json.4242.7.part", "voiceprint.json.1.0.part", "app.json", "voiceprint.json.bak", "notes.part"] {
            std::fs::write(d.join(f), "x").unwrap();
        }
        assert!(forget_voice_copies(&d).is_empty());
        let mut left: Vec<String> = std::fs::read_dir(&d).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        left.sort();
        assert_eq!(left, ["app.json", "notes.part", "voiceprint.json.bak"]);
        // Nothing to delete, or no folder yet: nothing to report.
        assert!(forget_voice_copies(&d).is_empty());
        assert!(forget_voice_copies(&d.join("missing")).is_empty());
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn a_copy_that_cant_be_deleted_is_reported() {
        let d = folder("stuck");
        // A folder where the copy was: remove_file fails on it, as it would on a locked file.
        std::fs::create_dir(d.join("voiceprint.json")).unwrap();
        std::fs::write(d.join("voiceprint.json.9.1.part"), "x").unwrap();
        let stuck = forget_voice_copies(&d);
        assert_eq!(stuck.iter().map(|(p, _)| p.clone()).collect::<Vec<_>>(), [d.join("voiceprint.json")]);
        assert!(!d.join("voiceprint.json.9.1.part").exists());
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn only_a_join_or_invite_code_is_passed_to_the_connect_page() {
        assert_eq!(clean_code(Some("ab3k")).as_deref(), Some("AB3K"));
        assert_eq!(clean_code(Some("ABCD2345")).as_deref(), Some("ABCD2345"));
        assert_eq!(clean_code(Some("AB&next=//evil")), None);
        assert_eq!(clean_code(Some("AB3")), None);
        assert_eq!(clean_code(None), None);
    }

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

    #[tokio::test]
    async fn nothing_starts_a_session_once_quit_has_its_turn() {
        let turns = Turns::new();
        // A switch is mid-flight; Quit queues behind it, then a second switch and a Leave queue behind Quit.
        let first = turns.lock(turns.ticket()).await.unwrap();
        let quit = turns.quit();
        let late = turns.lock(turns.ticket());
        let leave = turns.lock_now();
        tokio::pin!(quit, late, leave);
        drop(first);
        let held = (&mut quit).await;
        // The late switch waits while Quit holds its turn...
        assert!(tokio::time::timeout(std::time::Duration::from_millis(50), &mut late).await.is_err());
        drop(held);
        // ...and is refused once Quit lets go, never getting a turn to start a hub in; so is anything after.
        assert!((&mut late).await.is_none());
        assert!((&mut leave).await.is_none());
        assert!(turns.lock(turns.ticket()).await.is_none());
    }

    #[tokio::test]
    async fn a_request_queued_behind_another_transition_is_about_a_session_that_is_gone() {
        let turns = Turns::new();
        // Leave is under way; a project picked in the picker before it finished waits behind it.
        let leaving = turns.lock_now().await.unwrap();
        let picked = turns.lock(turns.ticket());
        tokio::pin!(picked);
        assert!(tokio::time::timeout(std::time::Duration::from_millis(30), &mut picked).await.is_err());
        drop(leaving);
        // Its session ended while it waited: it gets no turn, so it can't start hosting again.
        assert!((&mut picked).await.is_none());
        // A refused request isn't a transition: a request made now still gets its turn.
        let now = turns.ticket();
        assert!(turns.lock(now).await.is_some());
        // Leave acts on whatever session there is, however long it waited.
        let switching = turns.lock(turns.ticket()).await.unwrap();
        let leave = turns.lock_now();
        tokio::pin!(leave);
        assert!(tokio::time::timeout(std::time::Duration::from_millis(30), &mut leave).await.is_err());
        drop(switching);
        assert!((&mut leave).await.is_some());
    }

    #[tokio::test]
    async fn a_reopen_whose_save_failed_lets_the_app_go_on() {
        let turns = Turns::new();
        let before = turns.ticket();
        let turn = turns.quit().await;
        turn.keep_running();
        drop(turn);
        // What was asked before the Reopen is stale; a fresh request runs.
        assert!(turns.lock(before).await.is_none());
        assert!(turns.lock(turns.ticket()).await.is_some());
        assert!(!turns.ended.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[tokio::test]
    async fn two_reopens_queued_together_act_once_and_a_failed_save_blocks_every_restart() {
        let turns = Turns::new();
        // Two Reopen clicks, both made against the same session.
        let ticket = turns.ticket();
        let first = turns.quit_for(ticket).await.unwrap();
        let second = turns.quit_for(ticket);
        tokio::pin!(second);
        assert!(tokio::time::timeout(std::time::Duration::from_millis(30), &mut second).await.is_err());
        // The first one's save fails: remembered, the app goes on.
        turns.set_unsaved(Some("The session's last save didn't finish.".into()));
        first.keep_running();
        drop(first);
        // The second never acts (it would find no hub and take that for a finished save).
        assert!((&mut second).await.is_none());
        // A fresh Reopen gets its turn, but the failed save still stands until the person leaves it behind.
        let again = turns.quit_for(turns.ticket()).await.unwrap();
        assert_eq!(turns.unsaved().as_deref(), Some("The session's last save didn't finish."));
        again.keep_running();
        drop(again);
        turns.set_unsaved(None);
        assert!(turns.unsaved().is_none());
    }

    #[tokio::test]
    async fn an_old_reopen_dialog_never_clears_a_later_failed_save() {
        let turns = Turns::new();
        // The dialog was shown for the session then; the person hosted again, and that session's save failed too.
        let dialog = turns.ticket();
        drop(turns.lock(turns.ticket()).await.unwrap());
        turns.set_unsaved(Some("The newer session's save didn't finish.".into()));
        // "Reopen anyway" on the old dialog: its turn is refused, so it clears nothing (reopen clears only inside it).
        assert!(turns.quit_for(dialog).await.is_none());
        assert_eq!(turns.unsaved().as_deref(), Some("The newer session's save didn't finish."));
    }

    #[tokio::test]
    async fn arranging_screens_waits_out_a_transition_and_never_acts_on_the_session_after_it() {
        let turns = Turns::new();
        // A display change is noticed while a project switch runs: its arrangement waits for the switch...
        let ticket = turns.ticket();
        let switching = turns.lock(ticket).await.unwrap();
        let arranging = turns.lock_quiet(ticket);
        tokio::pin!(arranging);
        assert!(tokio::time::timeout(std::time::Duration::from_millis(30), &mut arranging).await.is_err());
        drop(switching);
        // ...and, made for the old session, does nothing to the new one.
        assert!((&mut arranging).await.is_none());
        // One made now runs, and doesn't make a project pick made before it stale.
        let pick = turns.ticket();
        let quiet = turns.lock_quiet(turns.ticket()).await.unwrap();
        drop(quiet);
        assert!(turns.lock(pick).await.is_some());
    }

    #[test]
    fn hosting_and_joining_start_only_from_nothing_and_a_switch_only_from_hosting() {
        // The start window's Host or Join after a session began (a second click, or one queued behind a resume).
        assert!(may_start(Before::Idle, None, false, false).is_ok());
        assert!(may_start(Before::Idle, Some("host"), false, false).is_ok());
        assert!(may_start(Before::Idle, Some("host"), true, true).is_err());
        assert!(may_start(Before::Idle, Some("join"), false, true).is_err());
        // A project switch needs this Mac's hub: not after Leave, and not while joined to someone else's.
        assert!(may_start(Before::Hosting, Some("host"), true, true).is_ok());
        assert!(may_start(Before::Hosting, None, false, false).is_err());
        assert!(may_start(Before::Hosting, Some("join"), false, true).is_err());
        assert!(may_start(Before::Hosting, Some("host"), false, false).is_err());
    }

    #[test]
    fn the_config_is_written_whole_or_not_at_all() {
        let dir = std::env::temp_dir().join(format!("jamsesh-config-{}", std::process::id()));
        let cfg = Config { role: Some("host".into()), project: Some("passport".into()), ..Default::default() };
        write_config(&dir, &cfg).unwrap();
        let back: Config = serde_json::from_slice(&std::fs::read(dir.join("app.json")).unwrap()).unwrap();
        assert_eq!(back.project.as_deref(), Some("passport"));
        assert!(!dir.join("app.json.tmp").exists());
        // A folder that can't be written: an error, and the saved config is untouched.
        let blocked = dir.join("blocked");
        std::fs::write(&blocked, "a file, not a folder").unwrap();
        assert!(write_config(&blocked, &cfg).unwrap_err().starts_with("Couldn't save JamSesh's settings"));
        // A failed write never replaces the good copy with a partial one.
        std::fs::create_dir_all(dir.join("app.json.tmp")).unwrap();
        assert!(write_config(&dir, &Config::default()).is_err());
        let still: Config = serde_json::from_slice(&std::fs::read(dir.join("app.json")).unwrap()).unwrap();
        assert_eq!(still.project.as_deref(), Some("passport"));
        let _ = std::fs::remove_dir_all(&dir);
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
