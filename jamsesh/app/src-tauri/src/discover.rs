// Finds JamSesh hosts on the local network (Bonjour), for the Join list.
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use mdns_sd::{ServiceDaemon, ServiceEvent};
use serde::Serialize;

const SERVICE: &str = "_jamsesh._tcp.local.";

#[derive(Clone, Debug, Serialize)]
pub struct Found {
    /// The host Mac's name, for example "Chey's Mac mini".
    pub name: String,
    /// The session's name, when the host shares it.
    pub session: Option<String>,
    /// The address to join: `http://<lan address>:<port>`.
    pub url: String,
}

#[derive(Clone, Default)]
pub struct Hosts(Arc<Mutex<BTreeMap<String, Found>>>);

impl Hosts {
    pub fn list(&self) -> Vec<Found> {
        self.0.lock().map(|m| m.values().cloned().collect()).unwrap_or_default()
    }
}

/// Browses in the background for as long as the app runs.
fn answers(addr: std::net::SocketAddr) -> bool {
    std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(800)).is_ok()
}

pub fn start() -> Hosts {
    let hosts = Hosts::default();
    let found = hosts.clone();
    // Every 10 seconds, drop hosts that stopped answering (closed without saying goodbye).
    let sweep = hosts.clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(std::time::Duration::from_secs(10));
            let listed: Vec<(String, String)> =
                sweep.0.lock().map(|m| m.iter().map(|(k, v)| (k.clone(), v.url.clone())).collect()).unwrap_or_default();
            for (key, url) in listed {
                let addr = url.trim_start_matches("http://").parse::<std::net::SocketAddr>();
                if addr.is_ok_and(|a| !answers(a))
                    && let Ok(mut m) = sweep.0.lock()
                {
                    m.remove(&key);
                }
            }
        }
    });
    std::thread::spawn(move || {
        let Ok(daemon) = ServiceDaemon::new() else { return };
        let Ok(events) = daemon.browse(SERVICE) else { return };
        while let Ok(ev) = events.recv() {
            match ev {
                ServiceEvent::ServiceResolved(info) => {
                    let mut v4: Vec<_> = info.get_addresses_v4().into_iter().copied().filter(|a| !a.is_link_local() && !a.is_loopback()).collect();
                    v4.sort();
                    let Some(addr) = v4.first() else { continue };
                    let full = info.get_fullname().to_string();
                    let name = plain_name(full.strip_suffix(&format!(".{SERVICE}")).unwrap_or(&full));
                    let session = info.get_property_val_str("session").map(str::to_string).filter(|s| !s.is_empty());
                    let url = format!("http://{addr}:{}", info.get_port());
                    // Listed only once something answers there: an advertisement can outlive its host.
                    let sock = std::net::SocketAddr::from((*addr, info.get_port()));
                    let list = found.clone();
                    std::thread::spawn(move || {
                        if answers(sock)
                            && let Ok(mut m) = list.0.lock()
                        {
                            // One row per address, whatever names its advertisements carry.
                            m.retain(|k, f| f.url != url || *k == full);
                            m.insert(full, Found { name, session, url });
                        }
                    });
                }
                ServiceEvent::ServiceRemoved(_, full) => {
                    if let Ok(mut m) = found.0.lock() {
                        m.remove(&full);
                    }
                }
                _ => {}
            }
        }
    });
    hosts
}

/// The Mac's name as people know it: Bonjour escapes spaces and adds " (2)" when a name is taken.
fn plain_name(instance: &str) -> String {
    let name = instance.replace("\\032", " ");
    let trimmed = name.trim_end();
    let counted = trimmed.strip_suffix(')').and_then(|s| s.rsplit_once(" (")).filter(|(_, n)| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()));
    counted.map_or(trimmed, |(base, _)| base).to_string()
}

#[cfg(test)]
mod tests {
    use super::plain_name;

    #[test]
    fn drops_bonjour_counter() {
        assert_eq!(plain_name("Deer’s\\032Mac\\032mini\\032(3)"), "Deer’s Mac mini");
        assert_eq!(plain_name("Studio (East)"), "Studio (East)");
        assert_eq!(plain_name("Mac ()"), "Mac ()");
        assert_eq!(plain_name("Chey's MacBook Pro"), "Chey's MacBook Pro");
    }
}
