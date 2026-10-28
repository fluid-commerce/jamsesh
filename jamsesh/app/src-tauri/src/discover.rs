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
pub fn start() -> Hosts {
    let hosts = Hosts::default();
    let found = hosts.clone();
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
                    let name = full.strip_suffix(&format!(".{SERVICE}")).unwrap_or(&full).replace("\\032", " ");
                    let session = info.get_property_val_str("session").map(str::to_string).filter(|s| !s.is_empty());
                    let url = format!("http://{addr}:{}", info.get_port());
                    if let Ok(mut m) = found.0.lock() {
                        m.insert(full, Found { name, session, url });
                    }
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
