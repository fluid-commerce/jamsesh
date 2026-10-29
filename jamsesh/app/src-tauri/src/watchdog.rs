// Restarts the page of a window that stops answering.
//
// Each hub-served page calls the app's `heartbeat` command every few seconds (web/src/shared/heartbeat.ts;
// the app takes the window's label from the call itself, not from anything the page says). A page
// stuck in a loop of promise work can't run its timer, while the app itself stays healthy, so the
// app notices the silence and restarts that window's WebKit page process. A plain reload doesn't
// do it: the hung process never reads the request (tried: a page spinning in microtasks ignores
// `reload()` and keeps its 100% CPU even after its window closes). Killing the page process and
// then reloading does, and it is what was done by hand when this happened for real.
use std::collections::HashMap;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

/// How long a visible window may stay silent before its page is restarted.
pub const SILENCE: Duration = Duration::from_secs(15);
/// Quiet needed after a restart before the window's strikes are forgotten.
const STABLE: Duration = Duration::from_secs(60);
const FIRST_BACKOFF: Duration = Duration::from_secs(30);
const MAX_BACKOFF: Duration = Duration::from_secs(10 * 60);

struct Strike {
    count: u32,
    at: Instant,
    /// No new restart before this, however silent the page is.
    not_before: Instant,
}

/// Which windows have beaten, when, and how often each was restarted. Pure bookkeeping, so the
/// timing rules are testable without a window.
#[derive(Default)]
pub struct Beats {
    seen: HashMap<String, Instant>,
    strikes: HashMap<String, Strike>,
}

impl Beats {
    pub fn beat(&mut self, label: &str, now: Instant) {
        self.seen.insert(label.to_string(), now);
        // A window that has kept beating for a while since its last restart starts over.
        if self.strikes.get(label).is_some_and(|s| now.duration_since(s.at) >= STABLE) {
            self.strikes.remove(label);
        }
    }

    pub fn forget(&mut self, label: &str) {
        self.seen.remove(label);
        self.strikes.remove(label);
    }

    /// The app (or the Mac) was itself stalled: nobody's silence counts for that time.
    pub fn pause(&mut self, now: Instant) {
        for t in self.seen.values_mut() {
            *t = now;
        }
    }

    pub fn known(&self) -> Vec<String> {
        self.seen.keys().cloned().collect()
    }

    /// Windows to restart now: silent for `SILENCE`, visible, and past their backoff. Windows that
    /// never beat (an older host's page without the heartbeat, a page that failed to load) aren't
    /// watched at all. Each restart doubles the wait before the next one for that window.
    pub fn stalled(&mut self, now: Instant, visible: impl Fn(&str) -> bool) -> Vec<String> {
        let mut out = Vec::new();
        for (label, last) in self.seen.iter_mut() {
            // A hidden page may be throttled: its silence starts counting when it is shown again.
            if !visible(label) {
                *last = now;
                continue;
            }
            if now.duration_since(*last) < SILENCE {
                continue;
            }
            let count = self.strikes.get(label).map_or(0, |s| s.count);
            if self.strikes.get(label).is_some_and(|s| now < s.not_before) {
                continue;
            }
            let wait = FIRST_BACKOFF.saturating_mul(1u32 << count.min(10)).min(MAX_BACKOFF);
            self.strikes.insert(label.clone(), Strike { count: count + 1, at: now, not_before: now + wait });
            // The reloaded page gets a fresh stretch before it counts as silent again.
            *last = now;
            out.push(label.clone());
        }
        out
    }
}

pub fn log(dir: &std::path::Path, line: &str) {
    use std::io::Write;
    let dir = dir.join("logs");
    let _ = std::fs::create_dir_all(&dir);
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("app.log")) {
        let _ = writeln!(f, "[{secs}] {line}");
    }
}

/// Run every few seconds. `last` is when this last ran: a long gap means the app was stalled (or
/// the Mac slept), and the silence in it isn't the pages' fault.
pub fn tick(app: &AppHandle, beats: &std::sync::Mutex<Beats>, dir: &std::path::Path, last: &mut Instant) {
    let now = Instant::now();
    let stalled = {
        let Ok(mut b) = beats.lock() else { return };
        if now.duration_since(*last) > Duration::from_secs(20) {
            b.pause(now);
        }
        for label in b.known() {
            if app.get_webview_window(&label).is_none() {
                b.forget(&label);
            }
        }
        b.stalled(now, |label| app.get_webview_window(label).is_some_and(|w| watched(&w)))
    };
    *last = now;
    for label in stalled {
        restart(app, dir, &label);
    }
}

/// A window is watched when someone could be looking at it: shown, not minimized, and with some part
/// of it on screen. A fully covered window (or one on another Space) may have its page throttled or
/// suspended by WebKit, which would look like a hang; when the state can't be read, it isn't watched.
fn watched(w: &tauri::WebviewWindow) -> bool {
    w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false) && on_screen(w) == Some(true)
}

/// Whether any part of the window is visible (NSWindow.occlusionState has the Visible bit).
fn on_screen(w: &tauri::WebviewWindow) -> Option<bool> {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    const NS_WINDOW_OCCLUSION_STATE_VISIBLE: usize = 1 << 1;
    let ptr = w.ns_window().ok()? as *mut AnyObject;
    if ptr.is_null() {
        return None;
    }
    // SAFETY: `ns_window()` is this window's NSWindow, alive while `w` is; `occlusionState` is a plain getter.
    let state: usize = unsafe { msg_send![&*ptr, occlusionState] };
    Some(state & NS_WINDOW_OCCLUSION_STATE_VISIBLE != 0)
}

/// The page process to stop for `label`: none when another window runs in the same process
/// (stopping it would blank that window too), or when its pid is unknown.
fn kill_target(pids: &[(String, Option<i32>)], label: &str) -> Option<i32> {
    let pid = pids.iter().find(|(l, _)| l == label).and_then(|(_, p)| *p)?;
    let sharers = pids.iter().filter(|(l, p)| l != label && *p == Some(pid)).count();
    (sharers == 0).then_some(pid)
}

fn restart(app: &AppHandle, dir: &std::path::Path, label: &str) {
    if app.get_webview_window(label).is_none() {
        return;
    }
    log(dir, &format!("watchdog: the {label} window's page sent no heartbeat for {}s; restarting its page process", SILENCE.as_secs()));
    let app = app.clone();
    let (dir, label) = (dir.to_path_buf(), label.to_string());
    // Off the async runtime's threads: this waits on the main thread and on `kill`.
    tauri::async_runtime::spawn_blocking(move || {
        // Every window's page process, so a process two windows share is never killed.
        let pids: Vec<(String, Option<i32>)> = app.webview_windows().into_iter().map(|(l, win)| (l, page_pid(&win))).collect();
        match kill_target(&pids, &label) {
            Some(pid) if is_page_process(pid) => {
                let killed = std::process::Command::new("/bin/kill").args(["-9", &pid.to_string()]).status().is_ok_and(|s| s.success());
                log(&dir, &format!("watchdog: {label}: stopped page process {pid} ({})", if killed { "ok" } else { "kill failed" }));
            }
            other => log(&dir, &format!("watchdog: {label}: no page process to stop ({other:?}, or shared with another window); reloading only")),
        }
        std::thread::sleep(Duration::from_millis(500));
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.reload();
        }
    });
}

/// The WebKit page process behind a window. Uses a private WKWebView property (the same kind of
/// call Tauri makes for the inspector); a Mac where it's missing gets a plain reload.
fn page_pid(w: &tauri::WebviewWindow) -> Option<i32> {
    let (tx, rx) = std::sync::mpsc::channel();
    w.with_webview(move |wv| {
        use objc2::runtime::AnyObject;
        use objc2::{msg_send, sel};
        let ptr = wv.inner() as *mut AnyObject;
        let pid = if ptr.is_null() {
            0
        } else {
            // SAFETY: `inner()` is this window's WKWebView, alive for the closure (it runs on the main thread).
            let obj: &AnyObject = unsafe { &*ptr };
            if obj.class().responds_to(sel!(_webProcessIdentifier)) { unsafe { msg_send![obj, _webProcessIdentifier] } } else { 0 }
        };
        let _ = tx.send(pid);
    })
    .ok()?;
    rx.recv_timeout(Duration::from_secs(3)).ok().filter(|p: &i32| *p > 1 && *p as u32 != std::process::id())
}

/// Never signal anything but a WebKit page process.
fn is_page_process(pid: i32) -> bool {
    std::process::Command::new("/bin/ps")
        .args(["-o", "command=", "-p", &pid.to_string()])
        .output()
        .is_ok_and(|o| String::from_utf8_lossy(&o.stdout).contains("com.apple.WebKit.WebContent"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secs(t: Instant, n: u64) -> Instant {
        t + Duration::from_secs(n)
    }

    fn pids(list: &[(&str, Option<i32>)]) -> Vec<(String, Option<i32>)> {
        list.iter().map(|(l, p)| (l.to_string(), *p)).collect()
    }

    #[test]
    fn stops_a_page_process_only_when_the_window_has_it_alone() {
        let own = pids(&[("client", Some(100)), ("bigscreen", Some(200)), ("bigscreen-2", Some(300))]);
        assert_eq!(kill_target(&own, "client"), Some(100));
        assert_eq!(kill_target(&own, "bigscreen-2"), Some(300));
        // Two windows in one process: killing it would blank both, so neither is killed.
        let shared = pids(&[("client", Some(100)), ("bigscreen", Some(100)), ("bigscreen-2", Some(300))]);
        assert_eq!(kill_target(&shared, "client"), None);
        assert_eq!(kill_target(&shared, "bigscreen"), None);
        assert_eq!(kill_target(&shared, "bigscreen-2"), Some(300));
        // Unknown pids never match each other, and an unknown window has no target.
        let unknown = pids(&[("client", None), ("bigscreen", None), ("remote", Some(7))]);
        assert_eq!(kill_target(&unknown, "client"), None);
        assert_eq!(kill_target(&unknown, "remote"), Some(7));
        assert_eq!(kill_target(&unknown, "missing"), None);
    }

    #[test]
    fn restarts_a_visible_window_after_the_silence() {
        let t0 = Instant::now();
        let mut b = Beats::default();
        b.beat("client", t0);
        assert!(b.stalled(secs(t0, 14), |_| true).is_empty());
        assert_eq!(b.stalled(secs(t0, 16), |_| true), vec!["client"]);
    }

    #[test]
    fn leaves_hidden_windows_and_windows_that_never_beat_alone() {
        let t0 = Instant::now();
        let mut b = Beats::default();
        b.beat("client", t0);
        assert!(b.stalled(secs(t0, 600), |_| false).is_empty());
        let mut none = Beats::default();
        assert!(none.stalled(secs(t0, 600), |_| true).is_empty());
    }

    #[test]
    fn a_window_shown_again_gets_the_whole_silence_before_a_restart() {
        let t0 = Instant::now();
        let mut b = Beats::default();
        b.beat("client", t0);
        assert!(b.stalled(secs(t0, 600), |_| false).is_empty());
        assert!(b.stalled(secs(t0, 601), |_| true).is_empty());
        assert!(b.stalled(secs(t0, 614), |_| true).is_empty());
        assert_eq!(b.stalled(secs(t0, 616), |_| true), vec!["client"]);
    }

    #[test]
    fn backs_off_between_restarts_instead_of_looping() {
        let t0 = Instant::now();
        let mut b = Beats::default();
        b.beat("client", t0);
        let mut restarts = 0;
        // Never beats again: one restart now, then waits of 30 s, 60 s, 120 s ... not one per tick.
        for s in (16..=600).step_by(5) {
            restarts += b.stalled(secs(t0, s), |_| true).len();
        }
        assert!((4..=6).contains(&restarts), "restarted {restarts} times in 10 minutes");
    }

    #[test]
    fn a_page_that_keeps_beating_starts_over() {
        let t0 = Instant::now();
        let mut b = Beats::default();
        b.beat("client", t0);
        assert_eq!(b.stalled(secs(t0, 16), |_| true).len(), 1);
        b.beat("client", secs(t0, 20));
        // Still within the minute after the restart: its strike stays, so the next one waits 60 s.
        assert!(b.stalled(secs(t0, 40), |_| true).is_empty());
        b.beat("client", secs(t0, 80));
        // A minute of beating later the strikes are gone: back to the first backoff.
        assert_eq!(b.stalled(secs(t0, 100), |_| true).len(), 1);
        assert!(b.stalled(secs(t0, 120), |_| true).is_empty());
        assert_eq!(b.stalled(secs(t0, 135), |_| true).len(), 1);
    }

    #[test]
    fn a_stall_of_the_app_itself_is_not_the_pages_silence() {
        let t0 = Instant::now();
        let mut b = Beats::default();
        b.beat("client", t0);
        b.pause(secs(t0, 100));
        assert!(b.stalled(secs(t0, 101), |_| true).is_empty());
    }
}
