// Host mode: runs the JamSesh hub on this Mac as a child process and stops it on quit.
use std::fs::{OpenOptions, create_dir_all};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use crate::proxy::healthy;

pub const PORTS: [u16; 3] = [4747, 4848, 4949];

fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"))
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
    let candidates = [std::env::var_os("JAMSESH_REPO").map(PathBuf::from), option_env!("JAMSESH_BUILD_REPO").map(PathBuf::from), Some(home().join("jamsesh"))];
    let repo = candidates.into_iter().flatten().find(|r| r.join("jamsesh/hub/src/index.ts").is_file()).ok_or("Hosting needs the JamSesh host files on this Mac (run jamsesh/install.sh in the JamSesh repository once).")?;
    let bun = [home().join(".bun/bin/bun"), PathBuf::from("/opt/homebrew/bin/bun"), PathBuf::from("/usr/local/bin/bun")].into_iter().find(|b| b.is_file()).ok_or("Hosting needs Bun on this Mac: curl -fsSL https://bun.sh/install | bash")?;
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

    /// Uses a hub that's already running on this Mac, or starts one.
    pub async fn start(log_dir: &Path, resources: Option<&Path>) -> Result<Hub, String> {
        for port in PORTS {
            if healthy(&format!("http://127.0.0.1:{port}")).await {
                return Ok(Hub { port, child: None });
            }
        }
        let rt = runtime(resources)?;
        let port = PORTS.into_iter().find(|p| std::net::TcpListener::bind(("0.0.0.0", *p)).is_ok() && std::net::TcpListener::bind(("::", *p)).is_ok()).ok_or("Ports 4747, 4848 and 4949 are all in use by other apps.")?;
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
        let child = cmd
            .env("PATH", path_env())
            // The hub exits on its own if this app goes away without stopping it.
            .env("JAMSESH_PARENT_PID", std::process::id().to_string())
            .env("JAMSESH_PORT", port.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::from(log))
            .stderr(Stdio::from(err))
            .spawn()
            .map_err(|e| format!("Couldn't start the session: {e}"))?;
        let mut hub = Hub { port, child: Some(child) };
        for _ in 0..120 {
            if healthy(&hub.origin()).await {
                return Ok(hub);
            }
            if let Some(Ok(Some(status))) = hub.child.as_mut().map(|c| c.try_wait()) {
                return Err(format!("The session stopped while starting ({status}). Details are in {}.", log_dir.join("hub.log").display()));
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        hub.stop();
        Err("The session took too long to start.".into())
    }

    /// Asks the hub to save and exit, then waits up to ten seconds.
    pub fn stop(&mut self) {
        let Some(mut child) = self.child.take() else { return };
        let _ = Command::new("/bin/kill").args(["-TERM", &child.id().to_string()]).status();
        for _ in 0..100 {
            if let Ok(Some(_)) = child.try_wait() {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = child.kill();
    }

}

impl Drop for Hub {
    fn drop(&mut self) {
        self.stop();
    }
}

