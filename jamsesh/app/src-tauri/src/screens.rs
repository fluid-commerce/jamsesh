// Screens: which of this Mac's displays show the big screen, and where each window goes.
//
// The pure part (layout, roles, names, placement) knows nothing about Tauri, so it is tested with
// simulated display layouts. The thin part below it reads the monitors, opens and moves windows,
// and tells the hub what the room's screens are called.
//
// All coordinates are logical points in macOS's global space (the primary display's top-left is
// 0,0). Tauri reports monitors in physical pixels, each scaled by its own display's factor, so a
// window placed with a physical position lands wrong whenever two displays differ in scale.
use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};

use crate::{App, host, proxy};

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    fn near(&self, o: &Rect) -> bool {
        (self.x - o.x).abs() < 1.5 && (self.y - o.y).abs() < 1.5 && (self.w - o.w).abs() < 1.5 && (self.h - o.h).abs() < 1.5
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    #[default]
    Main,
    Extra,
    Unused,
}

/// A display as the OS reports it.
#[derive(Clone, Debug)]
pub struct Raw {
    pub name: String,
    pub rect: Rect,
    pub scale: f64,
    pub primary: bool,
}

/// A display with a key that stays the same while the same hardware is plugged in the same way.
#[derive(Clone, Debug)]
pub struct Display {
    pub key: String,
    pub raw: Raw,
}

impl Display {
    fn builtin(&self) -> bool {
        self.raw.name.to_lowercase().contains("built-in")
    }
}

/// Keys are `name|WxH@scale`, with `#2`, `#3`... for identical displays, in left-to-right order.
pub fn displays(raw: Vec<Raw>) -> Vec<Display> {
    let mut raw = raw;
    raw.sort_by(|a, b| a.rect.x.total_cmp(&b.rect.x).then(a.rect.y.total_cmp(&b.rect.y)));
    let mut seen: BTreeMap<String, u32> = BTreeMap::new();
    raw.into_iter()
        .map(|r| {
            let base = format!("{}|{}x{}@{}", r.name, r.rect.w.round(), r.rect.h.round(), r.scale);
            let n = seen.entry(base.clone()).or_insert(0);
            *n += 1;
            let key = if *n == 1 { base } else { format!("{base}#{n}") };
            Display { key, raw: r }
        })
        .collect()
}

/// What identifies a set of displays: the same TVs plugged in again find their setup again.
pub fn set_key(ds: &[Display]) -> String {
    let mut keys: Vec<&str> = ds.iter().map(|d| d.key.as_str()).collect();
    keys.sort();
    keys.join(";")
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Choice {
    pub role: Role,
    /// Typed by the person; left out, the screen is named by where it sits.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// The screen's number among the extras ("screen-2"), kept so its stage survives a TV unplugging.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slot: Option<u32>,
}

pub type Saved = BTreeMap<String, Choice>;

/// Each display set the person has set up, by `set_key`.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Setup {
    pub sets: BTreeMap<String, Saved>,
}

impl Setup {
    pub fn load(dir: &std::path::Path) -> Setup {
        std::fs::read(dir.join("screens.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    pub fn save(&self, dir: &std::path::Path) -> Result<(), String> {
        let failed = |e: std::io::Error| format!("Couldn't save the screen setup: {e}");
        std::fs::create_dir_all(dir).map_err(failed)?;
        let json = serde_json::to_vec_pretty(self).map_err(|e| e.to_string())?;
        let tmp = dir.join("screens.json.tmp");
        std::fs::write(&tmp, json).map_err(failed)?;
        std::fs::rename(&tmp, dir.join("screens.json")).map_err(failed)
    }

    /// The choices for these displays, and whether the person saved this very set. A set not saved
    /// yet (a TV unplugged, or a new one plugged in) takes each known display's choice from the saved
    /// set that shares the most displays with it, so the screens still there keep their numbers,
    /// names, stages and history; only the new ones get defaults.
    pub fn choices(&self, ds: &[Display]) -> (Option<Saved>, bool) {
        if let Some(saved) = self.sets.get(&set_key(ds)) {
            return (Some(saved.clone()), true);
        }
        let mut ranked: Vec<&Saved> = self.sets.values().collect();
        ranked.sort_by_key(|s| std::cmp::Reverse(ds.iter().filter(|d| s.contains_key(&d.key)).count()));
        let inherited: Saved = ds.iter().filter_map(|d| ranked.iter().find_map(|s| s.get(&d.key)).map(|c| (d.key.clone(), c.clone()))).collect();
        (if inherited.is_empty() { None } else { Some(inherited) }, false)
    }
}

/// One display that shows (part of) the big screen.
#[derive(Clone, Debug, PartialEq)]
pub struct Screen {
    pub key: String,
    /// "main", or "screen-2", "screen-3"...
    pub id: String,
    pub name: String,
    pub role: Role,
    pub rect: Rect,
}

impl Screen {
    /// The window's label: "bigscreen" for the main screen, "bigscreen-2" for "screen-2".
    pub fn label(&self) -> String {
        match self.id.strip_prefix("screen-") {
            Some(n) => format!("bigscreen-{n}"),
            None => "bigscreen".into(),
        }
    }

    pub fn path(&self) -> String {
        if self.role == Role::Main { "/host".into() } else { format!("/host?screen={}", self.id) }
    }
}

/// Where every display starts out. One display is the big screen. Otherwise a laptop's own display
/// is where its person works, so it sits out (unless nobody uses this Mac); the rest present, the
/// leftmost as the main screen.
pub fn default_roles(ds: &[Display], userless: bool) -> Vec<Role> {
    if ds.len() < 2 {
        return vec![Role::Main; ds.len()];
    }
    let laptop = !userless && ds.iter().any(|d| d.builtin()) && ds.iter().any(|d| !d.builtin());
    let mut roles: Vec<Role> = ds.iter().map(|d| if laptop && d.builtin() { Role::Unused } else { Role::Extra }).collect();
    // The leftmost presenting display (the list is in left-to-right order) is the main one; with no
    // laptop in the way, the primary display wins, since that is where the menu bar and header live.
    let pick = if laptop { roles.iter().position(|r| *r != Role::Unused) } else { ds.iter().position(|d| d.raw.primary).or(Some(0)) };
    if let Some(i) = pick {
        roles[i] = Role::Main;
    }
    roles
}

/// Names by where the screens sit: "Left TV" and "Right TV", "Top TV" and "Bottom TV", or "Left TV",
/// "Middle TV" and "Right TV". More than that, or a laptop's own display, get plain names.
pub fn auto_names(ds: &[Display], roles: &[Role]) -> Vec<String> {
    let pool: Vec<usize> = (0..ds.len()).filter(|&i| roles[i] != Role::Unused && !ds[i].builtin()).collect();
    let mut names: Vec<String> = ds.iter().map(|d| d.raw.name.clone()).collect();
    for (i, d) in ds.iter().enumerate() {
        if roles[i] != Role::Unused && d.builtin() {
            names[i] = "Laptop screen".into();
        }
    }
    let spread = |f: &dyn Fn(&Display) -> f64| {
        let v: Vec<f64> = pool.iter().map(|&i| f(&ds[i])).collect();
        v.iter().cloned().fold(f64::MIN, f64::max) - v.iter().cloned().fold(f64::MAX, f64::min)
    };
    let horizontal = spread(&|d| d.raw.rect.x + d.raw.rect.w / 2.0) >= spread(&|d| d.raw.rect.y + d.raw.rect.h / 2.0);
    let mut order = pool.clone();
    order.sort_by(|&a, &b| {
        let (ka, kb) = if horizontal { (ds[a].raw.rect.x, ds[b].raw.rect.x) } else { (ds[a].raw.rect.y, ds[b].raw.rect.y) };
        ka.total_cmp(&kb)
    });
    let words: &[&str] = match (order.len(), horizontal) {
        (1, _) => &["Big"],
        (2, true) => &["Left", "Right"],
        (2, false) => &["Top", "Bottom"],
        (3, true) => &["Left", "Middle", "Right"],
        (3, false) => &["Top", "Middle", "Bottom"],
        _ => &[],
    };
    for (k, &i) in order.iter().enumerate() {
        names[i] = match words.get(k) {
            Some(w) => format!("{w} TV"),
            None => format!("Screen {}", k + 1),
        };
    }
    names
}

/// The screens for these displays: what the person saved for this set, or the defaults. Always at
/// least one display shows, and exactly one is the main screen.
pub fn resolve(ds: &[Display], saved: Option<&Saved>, userless: bool) -> Vec<Screen> {
    if ds.is_empty() {
        return vec![];
    }
    let defaults = default_roles(ds, userless);
    let mut roles: Vec<Role> = ds.iter().enumerate().map(|(i, d)| saved.and_then(|s| s.get(&d.key)).map_or(defaults[i], |c| c.role)).collect();
    // Exactly one main: the first one marked (primary first), else the first presenting display,
    // else the primary display itself.
    let by_pref: Vec<usize> = {
        let mut v: Vec<usize> = (0..ds.len()).collect();
        v.sort_by_key(|&i| !ds[i].raw.primary);
        v
    };
    let main = by_pref.iter().copied().find(|&i| roles[i] == Role::Main).or_else(|| by_pref.iter().copied().find(|&i| roles[i] == Role::Extra)).unwrap_or(by_pref[0]);
    for (i, r) in roles.iter_mut().enumerate() {
        if i == main {
            *r = Role::Main;
        } else if *r == Role::Main {
            *r = Role::Extra;
        }
    }
    let auto = auto_names(ds, &roles);
    // Extras keep the number they had; new ones take the lowest free number from 2.
    let mut taken: HashSet<u32> = HashSet::new();
    let mut slots: Vec<Option<u32>> = vec![None; ds.len()];
    for (i, d) in ds.iter().enumerate() {
        if roles[i] != Role::Extra {
            continue;
        }
        if let Some(n) = saved.and_then(|s| s.get(&d.key)).and_then(|c| c.slot).filter(|n| *n >= 2 && taken.insert(*n)) {
            slots[i] = Some(n);
        }
    }
    let mut next = 2;
    for (i, _) in ds.iter().enumerate() {
        if roles[i] == Role::Extra && slots[i].is_none() {
            while taken.contains(&next) {
                next += 1;
            }
            taken.insert(next);
            slots[i] = Some(next);
        }
    }
    ds.iter()
        .enumerate()
        .filter(|(i, _)| roles[*i] != Role::Unused)
        .map(|(i, d)| {
            let typed = saved.and_then(|s| s.get(&d.key)).and_then(|c| c.name.clone()).filter(|n| !n.trim().is_empty());
            Screen {
                key: d.key.clone(),
                id: match slots[i] {
                    Some(n) => format!("screen-{n}"),
                    None => "main".into(),
                },
                name: typed.unwrap_or_else(|| auto[i].clone()),
                role: roles[i],
                rect: d.raw.rect,
            }
        })
        .collect()
}

/// A big-screen window as it is now, and the display rect it sits on (None when that is unknown).
#[derive(Clone, Debug)]
pub struct Existing {
    pub label: String,
    pub on: Option<Rect>,
}

#[derive(Debug, PartialEq)]
pub enum Act {
    Open(Screen),
    Move(Screen),
    Close(String),
}

/// What to do to get from the windows there are to one per screen, each full screen on its own
/// display. A window already on its display is left alone (no reload).
pub fn plan(screens: &[Screen], existing: &[Existing]) -> Vec<Act> {
    let mut acts = vec![];
    for e in existing {
        if !screens.iter().any(|s| s.label() == e.label) {
            acts.push(Act::Close(e.label.clone()));
        }
    }
    for s in screens {
        match existing.iter().find(|e| e.label == s.label()) {
            None => acts.push(Act::Open(s.clone())),
            Some(e) if !e.on.is_some_and(|r| r.near(&s.rect)) => acts.push(Act::Move(s.clone())),
            Some(_) => {}
        }
    }
    acts
}

/// A display's identity for noticing changes: the set of displays and which is primary.
pub fn fingerprint(ds: &[Display]) -> String {
    let primary = ds.iter().find(|d| d.raw.primary).map(|d| d.key.as_str()).unwrap_or("");
    let mut v: Vec<String> = ds.iter().map(|d| format!("{}@{},{}", d.key, d.raw.rect.x, d.raw.rect.y)).collect();
    v.sort();
    format!("{primary}|{}", v.join(","))
}

// ---- the setup page's view of it ----

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayView {
    key: String,
    name: String,
    number: usize,
    rect: Rect,
    scale: f64,
    primary: bool,
    role: Role,
    /// What the screen is called now (typed, or by position); empty for a display that sits out.
    label: String,
    /// Whether the person typed that name (rather than it coming from where the screen sits).
    named: bool,
    id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupView {
    displays: Vec<DisplayView>,
    confirmed: bool,
}

/// `confirmed`: the person saved a setup for exactly these displays.
pub fn view(ds: &[Display], saved: Option<&Saved>, confirmed: bool, userless: bool) -> SetupView {
    let screens = resolve(ds, saved, userless);
    SetupView {
        confirmed,
        displays: ds
            .iter()
            .enumerate()
            .map(|(i, d)| {
                let s = screens.iter().find(|s| s.key == d.key);
                DisplayView {
                    key: d.key.clone(),
                    name: d.raw.name.clone(),
                    number: i + 1,
                    rect: d.raw.rect,
                    scale: d.raw.scale,
                    primary: d.raw.primary,
                    role: s.map_or(Role::Unused, |s| s.role),
                    label: s.map_or_else(String::new, |s| s.name.clone()),
                    named: saved.and_then(|s| s.get(&d.key)).and_then(|c| c.name.as_ref()).is_some_and(|n| !n.trim().is_empty()),
                    id: s.map_or_else(String::new, |s| s.id.clone()),
                }
            })
            .collect(),
    }
}

#[derive(Deserialize)]
pub struct Pick {
    key: String,
    role: Role,
    name: Option<String>,
}

/// The picks from the setup page, keeping each extra's number from before.
pub fn merge(ds: &[Display], picks: &[Pick], old: Option<&Saved>, userless: bool) -> Saved {
    let mut saved: Saved = picks
        .iter()
        .filter(|p| ds.iter().any(|d| d.key == p.key))
        .map(|p| {
            let name = p.name.as_ref().map(|n| n.trim().chars().take(40).collect::<String>()).filter(|n| !n.is_empty());
            (p.key.clone(), Choice { role: p.role, name, slot: old.and_then(|o| o.get(&p.key)).and_then(|c| c.slot) })
        })
        .collect();
    // Settle the numbers now, so they're remembered.
    for s in resolve(ds, Some(&saved), userless) {
        if let Some(c) = saved.get_mut(&s.key) {
            c.role = s.role;
            c.slot = s.id.strip_prefix("screen-").and_then(|n| n.parse().ok());
        }
    }
    saved
}

// ---- Tauri side ----

/// Runtime state, kept in `App`.
#[derive(Default)]
pub struct Runtime {
    seen: std::sync::Mutex<String>,
    generation: std::sync::atomic::AtomicU64,
    arranged_until: std::sync::Mutex<Option<std::time::Instant>>,
}

fn read_displays(app: &AppHandle) -> Vec<Display> {
    let primary = app.primary_monitor().ok().flatten().map(|m| (m.position().x, m.position().y));
    let raw = app
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            let s = if m.scale_factor() > 0.0 { m.scale_factor() } else { 1.0 };
            Raw {
                name: m.name().cloned().unwrap_or_else(|| "Display".into()),
                rect: Rect { x: m.position().x as f64 / s, y: m.position().y as f64 / s, w: m.size().width as f64 / s, h: m.size().height as f64 / s },
                scale: s,
                primary: Some((m.position().x, m.position().y)) == primary,
            }
        })
        .collect();
    displays(raw)
}

/// The display rect a window is on, in points.
fn window_display(w: &tauri::WebviewWindow) -> Option<Rect> {
    let m = w.current_monitor().ok().flatten()?;
    let s = if m.scale_factor() > 0.0 { m.scale_factor() } else { 1.0 };
    Some(Rect { x: m.position().x as f64 / s, y: m.position().y as f64 / s, w: m.size().width as f64 / s, h: m.size().height as f64 / s })
}

fn place(w: &tauri::WebviewWindow, r: &Rect) {
    let _ = w.set_simple_fullscreen(false);
    let _ = w.set_position(tauri::LogicalPosition::new(r.x, r.y));
    let _ = w.set_size(tauri::LogicalSize::new(r.w, r.h));
    // Full screen in the same Space, so app windows the brain arranges on this display can sit on top.
    let _ = w.set_simple_fullscreen(true);
}

fn open_screen(app: &AppHandle, origin: &str, s: &Screen) -> Result<(), String> {
    let parsed: url::Url = host::window_url(origin, &s.path()).parse().map_err(|e: url::ParseError| e.to_string())?;
    // Built on its display, at its size, so it never starts life on the wrong one.
    let w = WebviewWindowBuilder::new(app, s.label(), WebviewUrl::External(parsed))
        .devtools(crate::devtools())
        .title("JamSesh big screen")
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(18.0, 30.0))
        // A window behind another keeps its microphone and timers (WebKit would otherwise throttle
        // it, and the room mic would go quiet whenever someone's window covers the big screen).
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        .position(s.rect.x, s.rect.y)
        .inner_size(s.rect.w, s.rect.h)
        .build()
        .map_err(|e| e.to_string())?;
    place(&w, &s.rect);
    Ok(())
}

/// One window per screen, each on its own display; tells the hub the screens' names. Safe to run
/// any time: windows already in place stay as they are.
pub async fn arrange(app: &AppHandle, origin: &str) -> Result<Vec<Screen>, String> {
    let state = app.state::<Arc<App>>().inner().clone();
    let ds = read_displays(app);
    let (userless, setup) = {
        let inner = state.inner.lock().await;
        (inner.cfg.userless, Setup::load(&state.dir))
    };
    let screens = resolve(&ds, setup.choices(&ds).0.as_ref(), userless);
    if screens.is_empty() {
        return Ok(screens);
    }
    // The moves below are this arrangement's own: they don't ask for another one.
    if let Ok(mut until) = state.screens.arranged_until.lock() {
        *until = Some(std::time::Instant::now() + std::time::Duration::from_secs(2));
    }
    let existing: Vec<Existing> = app
        .webview_windows()
        .into_iter()
        .filter(|(l, _)| l.starts_with("bigscreen"))
        .map(|(label, w)| Existing { label, on: window_display(&w) })
        .collect();
    for act in plan(&screens, &existing) {
        match act {
            Act::Close(label) => {
                if let Some(w) = app.get_webview_window(&label) {
                    let _ = w.close();
                }
            }
            Act::Move(s) => match app.get_webview_window(&s.label()) {
                Some(w) => place(&w, &s.rect),
                None => open_screen(app, origin, &s)?,
            },
            Act::Open(s) => open_screen(app, origin, &s)?,
        }
    }
    tell_hub(origin, &screens).await;
    Ok(screens)
}

/// The room's screens and their names, for the picker and for "put it on the left TV".
async fn tell_hub(origin: &str, screens: &[Screen]) {
    let list: Vec<serde_json::Value> = screens.iter().map(|s| serde_json::json!({ "id": s.id, "name": s.name, "role": s.role })).collect();
    let body = serde_json::json!({ "screens": list }).to_string();
    // As this app's window: only the host's own windows name the room's screens.
    let _ = proxy::send_as_window("POST", origin, "/api/screens/config", &body).await;
}

/// First time this Mac sees these displays while hosting: show the setup (the defaults are already
/// on the screens, so a room can start without it).
pub async fn arrange_and_offer(app: &AppHandle, origin: &str) -> Result<(), String> {
    arrange(app, origin).await?;
    let state = app.state::<Arc<App>>().inner().clone();
    let ds = read_displays(app);
    if ds.len() > 1 && !Setup::load(&state.dir).sets.contains_key(&set_key(&ds)) {
        open_setup(app);
    }
    Ok(())
}

/// Rearranges the screens shortly (once things settle: a display being plugged in or a window
/// being moved fires many events).
pub fn schedule(app: &AppHandle) {
    let state = app.state::<Arc<App>>().inner().clone();
    let generation = state.screens.generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(800)).await;
        if state.screens.generation.load(std::sync::atomic::Ordering::SeqCst) != generation {
            return;
        }
        let origin = {
            let inner = state.inner.lock().await;
            if inner.cfg.role.as_deref() != Some("host") {
                return;
            }
            inner.hub.as_ref().map(|h| h.origin())
        };
        if let Some(origin) = origin {
            let _ = arrange(&app, &origin).await;
            // The setup page, if open, shows the new displays.
            if let Some(w) = app.get_webview_window("screens") {
                let _ = w.eval("window.refresh && window.refresh()");
            }
        }
    });
}

/// From the menu bar's refresh loop: displays plugged in, unplugged, or rearranged.
pub fn watch(app: &AppHandle) {
    let now = fingerprint(&read_displays(app));
    let state = app.state::<Arc<App>>();
    let changed = match state.screens.seen.lock() {
        Ok(mut last) if *last != now => {
            let first = last.is_empty();
            *last = now;
            !first
        }
        _ => false,
    };
    if changed {
        schedule(app);
    }
}

/// A big-screen window moved: if it left its display, put the screens back in order.
pub fn moved(app: &AppHandle) {
    let ours = app.state::<Arc<App>>().screens.arranged_until.lock().ok().and_then(|u| *u).is_some_and(|until| std::time::Instant::now() < until);
    if !ours {
        schedule(app);
    }
}

/// An extra screen's window closed: tell the hub, so the brain stops sending it things.
/// (Not when a window with the same label is open again by then.)
pub fn closed(app: &AppHandle, label: &str) {
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

pub fn open_setup(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("screens") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, "screens", WebviewUrl::App("screens.html".into()))
        .devtools(crate::devtools())
        .title("Screens")
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .inner_size(760.0, 700.0)
        .build();
}

#[tauri::command]
pub async fn screens_state(app: AppHandle, state: State<'_, Arc<App>>) -> Result<SetupView, String> {
    let ds = read_displays(&app);
    let userless = state.inner.lock().await.cfg.userless;
    let (saved, confirmed) = Setup::load(&state.dir).choices(&ds);
    Ok(view(&ds, saved.as_ref(), confirmed, userless))
}

/// What the setup would look like with these picks (names by position follow the roles), unsaved.
#[tauri::command]
pub async fn screens_preview(app: AppHandle, state: State<'_, Arc<App>>, picks: Vec<Pick>) -> Result<SetupView, String> {
    let ds = read_displays(&app);
    let userless = state.inner.lock().await.cfg.userless;
    let (old, _) = Setup::load(&state.dir).choices(&ds);
    Ok(view(&ds, Some(&merge(&ds, &picks, old.as_ref(), userless)), true, userless))
}

/// Saves the picks for the displays there are now, and puts the windows where they say.
#[tauri::command]
pub async fn screens_save(app: AppHandle, state: State<'_, Arc<App>>, picks: Vec<Pick>) -> Result<SetupView, String> {
    let ds = read_displays(&app);
    let (userless, origin) = {
        let inner = state.inner.lock().await;
        (inner.cfg.userless, inner.hub.as_ref().map(|h| h.origin()))
    };
    let mut setup = Setup::load(&state.dir);
    let key = set_key(&ds);
    // Numbers come from what these displays had (in this set or the one they were part of).
    let saved = merge(&ds, &picks, setup.choices(&ds).0.as_ref(), userless);
    setup.sets.insert(key.clone(), saved);
    setup.save(&state.dir)?;
    if let Some(origin) = origin {
        arrange(&app, &origin).await?;
    }
    Ok(view(&ds, setup.sets.get(&key), true, userless))
}

/// Flashes each display's number, big, on that display, for a few seconds.
#[tauri::command]
pub async fn screens_identify(app: AppHandle) -> Result<(), String> {
    let ds = read_displays(&app);
    let mut opened = vec![];
    for (i, d) in ds.iter().enumerate() {
        let label = format!("identify-{}", i + 1);
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.close();
        }
        let url = WebviewUrl::App(format!("identify.html?n={}", i + 1).into());
        let r = &d.raw.rect;
        let built = WebviewWindowBuilder::new(&app, &label, url)
            .title("Identify")
            .decorations(false)
            .resizable(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .focused(false)
            .position(r.x, r.y)
            .inner_size(r.w, r.h)
            .build();
        if let Ok(w) = built {
            // Over a full screen window too, on exactly this display.
            let _ = w.set_position(tauri::LogicalPosition::new(r.x, r.y));
            let _ = w.set_size(tauri::LogicalSize::new(r.w, r.h));
            opened.push(label);
        }
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        for label in opened {
            if let Some(w) = app.get_webview_window(&label) {
                let _ = w.close();
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub fn screens_close(app: AppHandle) {
    if let Some(w) = app.get_webview_window("screens") {
        let _ = w.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(name: &str, x: f64, y: f64, w: f64, h: f64, scale: f64, primary: bool) -> Raw {
        Raw { name: name.into(), rect: Rect { x, y, w, h }, scale, primary }
    }
    fn laptop() -> Raw {
        raw("Built-in Retina Display", 0.0, 0.0, 1512.0, 982.0, 2.0, true)
    }
    fn tv(x: f64, y: f64) -> Raw {
        raw("TV", x, y, 1920.0, 1080.0, 1.0, false)
    }
    fn ids(s: &[Screen]) -> Vec<String> {
        s.iter().map(|s| format!("{}:{}", s.id, s.name)).collect()
    }

    #[test]
    fn one_display_is_the_big_screen_without_asking() {
        let ds = displays(vec![laptop()]);
        let s = resolve(&ds, None, false);
        assert_eq!(s.len(), 1);
        assert_eq!(s[0].id, "main");
        assert_eq!(s[0].label(), "bigscreen");
        assert_eq!(s[0].path(), "/host");
    }

    #[test]
    fn laptop_with_two_tvs_side_by_side_puts_the_big_screen_on_the_tvs() {
        // The laptop on the left, a TV to the right of it, and another to the right of that.
        let ds = displays(vec![laptop(), tv(1512.0, 0.0), tv(3432.0, 0.0)]);
        assert!(ds[2].key.ends_with("#2"));
        let s = resolve(&ds, None, false);
        assert_eq!(ids(&s), ["main:Left TV", "screen-2:Right TV"]);
        assert_eq!(s[0].rect.x, 1512.0);
        assert_eq!(s[1].label(), "bigscreen-2");
        assert_eq!(s[1].path(), "/host?screen=screen-2");
    }

    #[test]
    fn nobody_using_the_mac_uses_the_laptop_display_too() {
        let ds = displays(vec![laptop(), tv(1512.0, 0.0)]);
        let s = resolve(&ds, None, true);
        assert_eq!(s.len(), 2);
        // The primary display is the main screen.
        assert_eq!(s.iter().find(|s| s.role == Role::Main).map(|s| s.name.as_str()), Some("Laptop screen"));
    }

    #[test]
    fn stacked_tvs_are_top_and_bottom() {
        let ds = displays(vec![raw("A", 0.0, 0.0, 1920.0, 1080.0, 1.0, true), raw("B", 0.0, 1080.0, 1920.0, 1080.0, 1.0, false)]);
        let s = resolve(&ds, None, false);
        assert_eq!(ids(&s), ["main:Top TV", "screen-2:Bottom TV"]);
    }

    #[test]
    fn three_tvs_in_a_row_and_four_screens_named_by_number() {
        let three = displays(vec![tv(0.0, 0.0), tv(1920.0, 0.0), tv(3840.0, 0.0)]);
        let s = resolve(&three, None, false);
        assert_eq!(s.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["Left TV", "Middle TV", "Right TV"]);
        let four = displays(vec![tv(0.0, 0.0), tv(1920.0, 0.0), tv(3840.0, 0.0), tv(5760.0, 0.0)]);
        let s = resolve(&four, None, false);
        assert_eq!(s.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["Screen 1", "Screen 2", "Screen 3", "Screen 4"]);
    }

    #[test]
    fn different_scales_and_sizes_keep_their_own_rects() {
        // A 4K TV at 2x (3840 px = 1920 pt) beside a 1080p one at 1x and a 5K monitor above.
        let ds = displays(vec![
            raw("4K TV", 0.0, 0.0, 1920.0, 1080.0, 2.0, true),
            raw("HD TV", 1920.0, 0.0, 1920.0, 1080.0, 1.0, false),
            raw("5K", 480.0, -1440.0, 2560.0, 1440.0, 2.0, false),
        ]);
        let s = resolve(&ds, None, false);
        let rects: Vec<(f64, f64, f64, f64)> = s.iter().map(|s| (s.rect.x, s.rect.y, s.rect.w, s.rect.h)).collect();
        assert!(rects.contains(&(480.0, -1440.0, 2560.0, 1440.0)));
        assert!(rects.contains(&(1920.0, 0.0, 1920.0, 1080.0)));
        assert_eq!(s.len(), 3);
    }

    #[test]
    fn lid_closed_the_set_changes_and_so_does_the_remembered_setup() {
        let open = displays(vec![laptop(), tv(1512.0, 0.0)]);
        let closed = displays(vec![raw("TV", 0.0, 0.0, 1920.0, 1080.0, 1.0, true)]);
        assert_ne!(set_key(&open), set_key(&closed));
        // The TV alone is the big screen, even though it is now the primary display.
        let s = resolve(&closed, None, false);
        assert_eq!(ids(&s), ["main:Big TV"]);
    }

    #[test]
    fn saved_choices_win_and_names_are_kept() {
        let ds = displays(vec![laptop(), tv(1512.0, 0.0), tv(3432.0, 0.0)]);
        let mut saved = Saved::new();
        saved.insert(ds[0].key.clone(), Choice { role: Role::Unused, ..Default::default() });
        saved.insert(ds[1].key.clone(), Choice { role: Role::Extra, name: Some("Kitchen".into()), slot: Some(3) });
        saved.insert(ds[2].key.clone(), Choice { role: Role::Main, ..Default::default() });
        let s = resolve(&ds, Some(&saved), false);
        assert_eq!(ids(&s), ["screen-3:Kitchen", "main:Right TV"]);
    }

    #[test]
    fn a_setup_with_no_main_or_two_mains_is_repaired() {
        let ds = displays(vec![tv(0.0, 0.0), tv(1920.0, 0.0)]);
        let mut none = Saved::new();
        none.insert(ds[0].key.clone(), Choice { role: Role::Extra, ..Default::default() });
        none.insert(ds[1].key.clone(), Choice { role: Role::Unused, ..Default::default() });
        let s = resolve(&ds, Some(&none), false);
        assert_eq!(s.len(), 1);
        assert_eq!(s[0].role, Role::Main);
        let mut all_unused = Saved::new();
        for d in &ds {
            all_unused.insert(d.key.clone(), Choice { role: Role::Unused, ..Default::default() });
        }
        assert_eq!(resolve(&ds, Some(&all_unused), false).len(), 1);
        let mut two = Saved::new();
        for d in &ds {
            two.insert(d.key.clone(), Choice { role: Role::Main, ..Default::default() });
        }
        let s = resolve(&ds, Some(&two), false);
        assert_eq!(s.iter().filter(|s| s.role == Role::Main).count(), 1);
        assert_eq!(s.len(), 2);
    }

    #[test]
    fn a_tv_unplugged_and_plugged_back_in_leaves_the_others_ids_and_names_alone() {
        // The setup lookup `arrange` and the setup page use, through the unplug and replug sequence.
        let sony = || raw("Sony", 1920.0, 0.0, 1920.0, 1080.0, 1.0, false);
        let lg = |x: f64| raw("LG", x, 0.0, 1920.0, 1080.0, 1.0, false);
        let all = displays(vec![tv(0.0, 0.0), sony(), lg(3840.0)]);
        let picks: Vec<Pick> = all
            .iter()
            .enumerate()
            .map(|(i, d)| Pick { key: d.key.clone(), role: if i == 0 { Role::Main } else { Role::Extra }, name: (i == 2).then(|| "Kitchen".into()) })
            .collect();
        let mut setup = Setup::default();
        setup.sets.insert(set_key(&all), merge(&all, &picks, setup.choices(&all).0.as_ref(), false));
        let screens = |setup: &Setup, ds: &[Display]| ids(&resolve(ds, setup.choices(ds).0.as_ref(), false));
        assert_eq!(screens(&setup, &all), ["main:Left TV", "screen-2:Middle TV", "screen-3:Kitchen"]);
        // The Sony goes away: the LG is still screen-3 and still the Kitchen (its stage and history stay with it).
        let without = displays(vec![tv(0.0, 0.0), lg(1920.0)]);
        let (inherited, confirmed) = setup.choices(&without);
        assert!(!confirmed);
        assert!(inherited.is_some());
        assert_eq!(screens(&setup, &without), ["main:Left TV", "screen-3:Kitchen"]);
        // A new TV in the Sony's place takes the free number; nobody else moves.
        let vizio = displays(vec![tv(0.0, 0.0), lg(1920.0), raw("Vizio", 3840.0, 0.0, 1920.0, 1080.0, 1.0, false)]);
        assert_eq!(screens(&setup, &vizio)[1..], ["screen-3:Kitchen".to_string(), "screen-2:Right TV".to_string()]);
        // Saving the smaller set keeps the LG's number; plugging the Sony back in finds the first setup again.
        let picks: Vec<Pick> = without
            .iter()
            .map(|d| Pick { key: d.key.clone(), role: if d.raw.name == "LG" { Role::Extra } else { Role::Main }, name: None })
            .collect();
        let saved = merge(&without, &picks, setup.choices(&without).0.as_ref(), false);
        setup.sets.insert(set_key(&without), saved);
        assert_eq!(screens(&setup, &without), ["main:Left TV", "screen-3:Right TV"]);
        assert_eq!(screens(&setup, &all), ["main:Left TV", "screen-2:Middle TV", "screen-3:Kitchen"]);
        assert!(setup.choices(&all).1);
        // Displays never seen before: no choices, the defaults.
        assert_eq!(Setup::default().choices(&all), (None, false));
        assert_eq!(setup.choices(&displays(vec![raw("Projector", 0.0, 0.0, 1280.0, 720.0, 1.0, true)])), (None, false));
    }

    #[test]
    fn the_plan_opens_moves_and_closes_only_what_it_must() {
        let ds = displays(vec![laptop(), tv(1512.0, 0.0), tv(3432.0, 0.0)]);
        let s = resolve(&ds, None, false);
        // Nothing open: open both.
        assert_eq!(plan(&s, &[]).len(), 2);
        // Both already on their displays: nothing to do.
        let placed = vec![Existing { label: "bigscreen".into(), on: Some(s[0].rect) }, Existing { label: "bigscreen-2".into(), on: Some(s[1].rect) }];
        assert!(plan(&s, &placed).is_empty());
        // The main one drifted onto the laptop: move it back. A leftover window closes.
        let drifted = vec![
            Existing { label: "bigscreen".into(), on: Some(ds[0].raw.rect) },
            Existing { label: "bigscreen-2".into(), on: Some(s[1].rect) },
            Existing { label: "bigscreen-3".into(), on: Some(s[1].rect) },
        ];
        let acts = plan(&s, &drifted);
        assert_eq!(acts.len(), 2);
        assert!(acts.contains(&Act::Close("bigscreen-3".into())));
        assert!(acts.iter().any(|a| matches!(a, Act::Move(m) if m.id == "main")));
        // A window whose display is unknown is put in place.
        assert_eq!(plan(&s[..1], &[Existing { label: "bigscreen".into(), on: None }]).len(), 1);
    }

    #[test]
    fn a_tv_unplugged_closes_its_window_and_a_new_one_opens() {
        let before = displays(vec![laptop(), tv(1512.0, 0.0), tv(3432.0, 0.0)]);
        let sb = resolve(&before, None, false);
        let open: Vec<Existing> = sb.iter().map(|s| Existing { label: s.label(), on: Some(s.rect) }).collect();
        let after = displays(vec![laptop(), tv(1512.0, 0.0)]);
        let sa = resolve(&after, None, false);
        let acts = plan(&sa, &open);
        assert_eq!(acts, vec![Act::Close("bigscreen-2".into())]);
        // Plugged back in: it opens again as screen-2.
        let acts = plan(&sb, &[Existing { label: "bigscreen".into(), on: Some(sb[0].rect) }]);
        assert!(matches!(&acts[..], [Act::Open(s)] if s.id == "screen-2"));
    }

    #[test]
    fn a_change_of_displays_is_noticed_but_a_reorder_of_the_list_is_not() {
        let a = displays(vec![laptop(), tv(1512.0, 0.0)]);
        let b = displays(vec![tv(1512.0, 0.0), laptop()]);
        assert_eq!(fingerprint(&a), fingerprint(&b));
        let moved = displays(vec![laptop(), tv(-1920.0, 0.0)]);
        assert_ne!(fingerprint(&a), fingerprint(&moved));
    }

    #[test]
    fn the_setup_view_lists_every_display_and_remembers_nothing_until_saved() {
        let ds = displays(vec![laptop(), tv(1512.0, 0.0)]);
        let v = view(&ds, None, false, false);
        assert!(!v.confirmed);
        assert_eq!(v.displays.len(), 2);
        assert_eq!(v.displays[0].role, Role::Unused);
        assert_eq!(v.displays[1].role, Role::Main);
        assert_eq!(v.displays[1].id, "main");
        let picks = vec![Pick { key: ds[0].key.clone(), role: Role::Extra, name: Some("  Desk  ".into()) }, Pick { key: ds[1].key.clone(), role: Role::Main, name: Some("".into()) }, Pick { key: "gone".into(), role: Role::Main, name: None }];
        let saved = merge(&ds, &picks, None, false);
        assert_eq!(saved.len(), 2);
        assert_eq!(saved[&ds[0].key].name.as_deref(), Some("Desk"));
        assert_eq!(saved[&ds[1].key].name, None);
        assert_eq!(saved[&ds[0].key].slot, Some(2));
    }

    #[test]
    fn the_setup_is_remembered_on_disk() {
        let dir = std::env::temp_dir().join(format!("jamsesh-screens-test-{}", std::process::id()));
        let ds = displays(vec![laptop(), tv(1512.0, 0.0)]);
        let mut setup = Setup::default();
        setup.sets.insert(set_key(&ds), merge(&ds, &[Pick { key: ds[1].key.clone(), role: Role::Main, name: Some("Left TV".into()) }], None, false));
        setup.save(&dir).unwrap();
        let back = Setup::load(&dir);
        assert_eq!(back.sets.len(), 1);
        assert_eq!(back.sets[&set_key(&ds)][&ds[1].key].name.as_deref(), Some("Left TV"));
        let _ = std::fs::remove_dir_all(&dir);
        assert!(Setup::load(&dir).sets.is_empty());
        // A folder that can't be written says so instead of reporting the setup as saved.
        let blocked = std::env::temp_dir().join(format!("jamsesh-screens-blocked-{}", std::process::id()));
        std::fs::write(&blocked, "a file, not a folder").unwrap();
        assert!(setup.save(&blocked.join("app")).unwrap_err().starts_with("Couldn't save the screen setup"));
        let _ = std::fs::remove_file(&blocked);
    }
}
