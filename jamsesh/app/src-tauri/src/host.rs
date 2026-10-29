// Host mode: runs the JamSesh hub on this Mac as a child process and stops it on quit.
use std::fs::{OpenOptions, create_dir_all};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use crate::projects::Launch;
use crate::proxy::{get_as_window, healthy, random_hex, window_key};

/// The started hub's stdin: this app's window key, then a one-time link id per window (see
/// `window_url`). A pipe, not the environment, which other processes on this Mac can list.
static LINKS: Mutex<Option<ChildStdin>> = Mutex::new(None);

/// Where one of this app's windows opens `path` (with its query) on the hub it started: a one-time
/// host link that gives the window the window key in an HttpOnly cookie, so it can act as the
/// host's person (SPEC 14). On a hub this app didn't start, the plain address (a read-only view).
pub fn window_url(origin: &str, path: &str) -> String {
    let plain = format!("{origin}{path}");
    let Ok(mut links) = LINKS.lock() else { return plain };
    let (Some(pipe), Some(once)) = (links.as_mut(), random_hex(16)) else { return plain };
    if pipe.write_all(format!("once {once}\n").as_bytes()).and_then(|_| pipe.flush()).is_err() {
        *links = None;
        return plain;
    }
    let next: String = url::form_urlencoded::byte_serialize(path.as_bytes()).collect();
    format!("{origin}/host-window?once={once}&next={next}")
}

/// The ports a hosted session may use, in the order tried (`JAMSESH_HUB_PORTS` overrides them).
fn ports() -> Vec<u16> {
    crate::isolation::get().hub_ports.clone()
}

fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"))
}

/// "4747, 4848 and 4949".
fn list_ports(ports: &[u16]) -> String {
    match ports {
        [] => String::new(),
        [one] => one.to_string(),
        [rest @ .., last] => format!("{} and {last}", rest.iter().map(u16::to_string).collect::<Vec<_>>().join(", ")),
    }
}

/// Whether Claude Code or Codex is on this Mac. Their CLIs are often off PATH: the Claude desktop
/// app keeps its own copy of Claude Code, and nvm and Volta keep theirs in their own folders. The
/// agent setup script (install-scripts.ts) looks in the same places.
pub fn has_agent() -> bool {
    let h = home();
    let mut dirs: Vec<PathBuf> = std::env::split_paths(&path_env()).collect();
    dirs.extend([h.join(".claude/local"), h.join(".volta/bin")]);
    let children = |dir: PathBuf| std::fs::read_dir(dir).into_iter().flatten().flatten().map(|e| e.path()).collect::<Vec<_>>();
    dirs.extend(children(h.join(".nvm/versions/node")).into_iter().map(|v| v.join("bin")));
    let bundled = children(h.join("Library/Application Support/Claude/claude-code")).into_iter().flat_map(children);
    dirs.extend(bundled.map(|b| b.join("claude.app/Contents/MacOS")));
    h.join(".codex").is_dir() || dirs.iter().any(|d| ["claude", "codex"].iter().any(|b| d.join(b).is_file()))
}

/// Apps opened from Finder get a bare PATH; the hub and its tools need the usual places.
pub fn path_env() -> String {
    let h = home();
    let mut dirs = vec![h.join(".bun/bin"), h.join(".local/bin"), h.join(".cargo/bin")];
    dirs.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].map(PathBuf::from));
    dirs.iter().map(|d| d.to_string_lossy().into_owned()).collect::<Vec<_>>().join(":")
}

/// How to run the hub: the compiled hub inside the app (what people get), or a checkout (development).
pub enum Runtime {
    Bundled { hub: PathBuf, resources: PathBuf },
    Checkout { repo: PathBuf, bun: PathBuf },
}

pub fn runtime(resources: Option<&Path>) -> Result<Runtime, String> {
    if let Some(res) = resources {
        let hub = res.join("hub/jamsesh-hub");
        if hub.is_file() {
            return Ok(Runtime::Bundled { hub, resources: res.to_path_buf() });
        }
    }
    checkout().map(|(repo, bun)| Runtime::Checkout { repo, bun })
}

/// The JamSesh checkout that holds the hub: `$JAMSESH_REPO`, the one this app was built from, or ~/jamsesh.
fn checkout() -> Result<(PathBuf, PathBuf), String> {
    let candidates =
        [std::env::var_os("JAMSESH_REPO").map(PathBuf::from), option_env!("JAMSESH_BUILD_REPO").map(PathBuf::from), Some(home().join("jamsesh"))];
    let repo = candidates
        .into_iter()
        .flatten()
        .find(|r| r.join("jamsesh/hub/src/index.ts").is_file())
        .ok_or("Hosting needs the JamSesh host files on this Mac (run jamsesh/install.sh in the JamSesh repository once).")?;
    let bun = [home().join(".bun/bin/bun"), PathBuf::from("/opt/homebrew/bin/bun"), PathBuf::from("/usr/local/bin/bun")]
        .into_iter()
        .find(|b| b.is_file())
        .ok_or("Hosting needs Bun on this Mac: curl -fsSL https://bun.sh/install | bash")?;
    Ok((repo, bun))
}

pub struct Hub {
    pub port: u16,
    child: Option<Child>,
}

impl Hub {
    pub fn origin(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    /// Starts this app's hub. A hub this app didn't start (one from a terminal) is never adopted:
    /// the app couldn't give its windows the window key, so they couldn't act as the host's person.
    pub async fn start(log_dir: &Path, resources: Option<&Path>, launch: &Launch, bundle_id: &str) -> Result<Hub, String> {
        // A hub left by this app's last launch stops on its own within seconds (it watches its parent).
        let mut running = None;
        for _ in 0..20 {
            running = None;
            for port in ports() {
                if healthy(&format!("http://127.0.0.1:{port}")).await {
                    running = Some(port);
                    break;
                }
            }
            if running.is_none() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        if let Some(port) = running {
            return Err(format!(
                "A JamSesh host is already running on this Mac (port {port}), probably from a terminal. Quit it (Ctrl-C in its terminal) and host from the app, or keep using the host link that terminal printed."
            ));
        }
        let rt = runtime(resources)?;
        let all = ports();
        let port = all
            .iter()
            .copied()
            .find(|p| std::net::TcpListener::bind(("0.0.0.0", *p)).is_ok() && std::net::TcpListener::bind(("::", *p)).is_ok())
            .ok_or_else(|| format!("Ports {} are all in use by other apps.", list_ports(&all)))?;
        let _ = create_dir_all(log_dir);
        let log = OpenOptions::new().create(true).append(true).open(log_dir.join("hub.log")).map_err(|e| e.to_string())?;
        let err = log.try_clone().map_err(|e| e.to_string())?;
        let mut cmd = match &rt {
            Runtime::Bundled { hub, resources } => {
                let mut c = Command::new(hub);
                c.current_dir(resources).env("JAMSESH_RESOURCES", resources);
                c
            }
            Runtime::Checkout { repo, bun } => {
                let mut c = Command::new(bun);
                c.args(["run", "hub/src/index.ts"]).current_dir(repo.join("jamsesh"));
                c
            }
        };
        match launch {
            Launch::Lobby { .. } => {
                cmd.env("JAMSESH_LOBBY", "1");
            }
            Launch::Last => {}
            Launch::Project(slug) => {
                cmd.env("JAMSESH_PROJECT", slug);
            }
            Launch::New(name) => {
                cmd.env("JAMSESH_NEW_PROJECT", name);
            }
        }
        if let Some(home) = &crate::isolation::get().hub_home {
            cmd.env("JAMSESH_HOME", home);
        }
        // A test build's hub is built from the data folder alone: inherited location variables never reach it.
        if crate::isolation::get().isolated() {
            for k in crate::isolation::LOCATION_VARS {
                cmd.env_remove(k);
            }
        }
        for (k, v) in crate::isolation::get().hub_env() {
            cmd.env(k, v);
        }
        let child = cmd
            .env("PATH", path_env())
            // The hub exits on its own if this app goes away without stopping it.
            .env("JAMSESH_PARENT_PID", std::process::id().to_string())
            .env("JAMSESH_PORT", port.to_string())
            .env("JAMSESH_BONJOUR_SERVICE", &crate::isolation::get().bonjour)
            .env("JAMSESH_BUNDLE_ID", bundle_id)
            .env("JAMSESH_WINDOW_LINKS", "stdin")
            .stdin(Stdio::piped())
            .stdout(Stdio::from(log))
            .stderr(Stdio::from(err))
            .spawn()
            .map_err(|e| format!("Couldn't start the session: {e}"))?;
        let mut child = child;
        let handed = match (child.stdin.take(), window_key()) {
            (Some(mut pipe), Some(key)) => {
                pipe.write_all(format!("key {key}\n").as_bytes()).and_then(|_| pipe.flush()).is_ok()
                    && LINKS.lock().map(|mut links| *links = Some(pipe)).is_ok()
            }
            _ => false,
        };
        let mut hub = Hub { port, child: Some(child) };
        if !handed {
            let _ = hub.stop();
            return Err("Couldn't hand the session its window key, so this Mac's windows couldn't act for you. Try hosting again.".into());
        }
        for _ in 0..120 {
            if healthy(&hub.origin()).await {
                // The hub has the key once it shows the pairing code to this app as one of its windows.
                for _ in 0..20 {
                    if matches!(get_as_window(hub.port, "/api/pair/code").await, Ok((s, _)) if s.is_success()) {
                        return Ok(hub);
                    }
                    tokio::time::sleep(Duration::from_millis(250)).await;
                }
                let _ = hub.stop();
                return Err(format!(
                    "The session started but didn't accept this app's window key. Details are in {}.",
                    log_dir.join("hub.log").display()
                ));
            }
            if let Some(Ok(Some(status))) = hub.child.as_mut().map(|c| c.try_wait()) {
                return Err(format!("The session stopped while starting ({status}). Details are in {}.", log_dir.join("hub.log").display()));
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        let _ = hub.stop();
        Err("The session took too long to start.".into())
    }

    /// Asks the hub to save and exit, and waits for it (see `stop_child`).
    pub fn stop(&mut self) -> Result<(), String> {
        let Some(child) = self.child.take() else { return Ok(()) };
        if let Ok(mut links) = LINKS.lock() {
            *links = None;
        }
        stop_child(child, SHUTDOWN_WAIT)
    }
}

impl Drop for Hub {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

/// How long the hub may take to save and exit: longer than its own shutdown steps add up to
/// (10 s for work in flight, `Hub.SHUTDOWN_WAIT_MS`, then 8 + 4 + 5 + 12 + 3 s, `Hub.SHUTDOWN_MS`, then up to
/// 4 s to reap its helpers), so a slow save is never cut short.
const SHUTDOWN_WAIT: Duration = Duration::from_secs(50);

/// Stops a hub process: SIGTERM, then wait for it. Ok only when it exits 0, which is the hub saying
/// its final save finished (hub/src/index.ts). An unfinished save (exit 3), or a hub still running
/// after `wait` (then killed), is an error, so the caller never treats a cut-off save as done.
fn stop_child(mut child: Child, wait: Duration) -> Result<(), String> {
    let _ = Command::new("/bin/kill").args(["-TERM", &child.id().to_string()]).status();
    let until = std::time::Instant::now() + wait;
    while std::time::Instant::now() < until {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(status)) => return Err(format!("The session's last save didn't finish ({status}); its newest changes may be missing.")),
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => return Err(format!("Couldn't tell whether the session finished saving: {e}")),
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    Err("The session took too long to save and was stopped; its newest changes may be missing.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sh(script: &str) -> Child {
        let child = Command::new("/bin/sh").args(["-c", script]).spawn().unwrap();
        // Give the shell a moment to install its trap.
        std::thread::sleep(Duration::from_millis(200));
        child
    }

    #[test]
    fn stopping_waits_for_the_save_and_says_when_it_didnt_finish() {
        // Saves for a while, then exits 0: waited for, however long the save takes within the budget.
        let t0 = std::time::Instant::now();
        assert_eq!(stop_child(sh("trap 'sleep 1; exit 0' TERM; while :; do sleep 0.05; done"), Duration::from_secs(5)), Ok(()));
        assert!(t0.elapsed() >= Duration::from_millis(900));
        // Says its save didn't finish (exit 3).
        assert!(stop_child(sh("trap 'exit 3' TERM; while :; do sleep 0.05; done"), Duration::from_secs(5)).unwrap_err().contains("didn't finish"));
        // Never exits: killed after the wait, and reported.
        let t0 = std::time::Instant::now();
        assert!(stop_child(sh("trap '' TERM; while :; do sleep 0.05; done"), Duration::from_millis(500)).unwrap_err().contains("too long"));
        assert!(t0.elapsed() < Duration::from_secs(3));
        // The app's wait outlasts the hub's own shutdown steps (10 + 8 + 4 + 5 + 12 + 3 seconds, and 4 to reap helpers).
        assert!(SHUTDOWN_WAIT > Duration::from_secs(46));
    }
}
