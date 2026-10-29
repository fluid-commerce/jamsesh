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

/// An advertised host and whether it answered the last time it was checked.
struct Entry {
    found: Found,
    /// Answers right now; only these are listed.
    up: bool,
    /// Checks in a row it failed since it last answered.
    misses: u32,
}

/// A listed host that fails this many checks in a row is hidden (one slow answer on a busy network
/// isn't enough); an advertised host that has never answered isn't listed at all.
const MISSES_TO_HIDE: u32 = 2;
const CHECK_EVERY: std::time::Duration = std::time::Duration::from_secs(5);

#[derive(Clone, Default)]
pub struct Hosts(Arc<Mutex<BTreeMap<String, Entry>>>);

impl Hosts {
    /// Hosts that answered their latest check.
    pub fn list(&self) -> Vec<Found> {
        self.0.lock().map(|m| m.values().filter(|e| e.up).map(|e| e.found.clone()).collect()).unwrap_or_default()
    }

    /// A host's advert came in (or changed). It stays hidden until `check` finds it answering.
    fn advertise(&self, key: String, found: Found) {
        if let Ok(mut m) = self.0.lock() {
            // A renamed advert for the same address replaces the old one.
            m.retain(|k, e| e.found.url != found.url || *k == key);
            let up = m.get(&key).is_some_and(|e| e.up && e.found.url == found.url);
            m.insert(key, Entry { found, up, misses: 0 });
        }
    }

    fn withdraw(&self, key: &str) {
        if let Ok(mut m) = self.0.lock() {
            m.remove(key);
        }
    }

    /// Checks every advertised host (including ones hidden earlier: a host that was slow to start
    /// shows up once it answers, and one whose advert outlives it drops off the list).
    fn check(&self, answers: impl Fn(&Found) -> bool) {
        let all: Vec<(String, Found)> = self.0.lock().map(|m| m.iter().map(|(k, e)| (k.clone(), e.found.clone())).collect()).unwrap_or_default();
        for (key, found) in all {
            let ok = answers(&found);
            if let Ok(mut m) = self.0.lock()
                && let Some(e) = m.get_mut(&key)
                && e.found.url == found.url
            {
                if ok {
                    (e.up, e.misses) = (true, 0);
                } else {
                    e.misses += 1;
                    if !e.up || e.misses >= MISSES_TO_HIDE {
                        e.up = false;
                    }
                }
            }
        }
    }
}

fn answers(f: &Found) -> bool {
    f.url
        .trim_start_matches("http://")
        .parse::<std::net::SocketAddr>()
        .is_ok_and(|addr| std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(800)).is_ok())
}

/// Browses in the background for as long as the app runs.
pub fn start() -> Hosts {
    let hosts = Hosts::default();
    let found = hosts.clone();
    let sweep = hosts.clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(CHECK_EVERY);
            sweep.check(answers);
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
                    found.advertise(full, Found { name, session, url });
                    // List it as soon as it answers, without waiting for the next sweep.
                    let list = found.clone();
                    std::thread::spawn(move || list.check(answers));
                }
                ServiceEvent::ServiceRemoved(_, full) => found.withdraw(&full),
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
    use super::{Found, Hosts, plain_name};

    fn host(url: &str) -> Found {
        Found { name: "Mac".into(), session: None, url: url.into() }
    }

    #[test]
    fn hides_hosts_that_never_answered_and_shows_them_once_they_do() {
        let hosts = Hosts::default();
        hosts.advertise("a".into(), host("http://10.0.0.2:4747"));
        assert!(hosts.list().is_empty(), "not listed before it answers");
        hosts.check(|_| false);
        assert!(hosts.list().is_empty());
        hosts.check(|_| true);
        assert_eq!(hosts.list().len(), 1);
    }

    #[test]
    fn drops_a_host_whose_advert_outlives_it_but_not_for_one_slow_answer() {
        let hosts = Hosts::default();
        hosts.advertise("a".into(), host("http://10.0.0.2:4747"));
        hosts.check(|_| true);
        hosts.check(|_| false);
        assert_eq!(hosts.list().len(), 1, "one miss keeps it");
        hosts.check(|_| false);
        assert!(hosts.list().is_empty(), "two misses in a row hide it");
        hosts.check(|_| true);
        assert_eq!(hosts.list().len(), 1, "it comes back when it answers again");
    }

    #[test]
    fn a_renamed_advert_replaces_the_old_one_and_a_withdrawn_one_goes() {
        let hosts = Hosts::default();
        hosts.advertise("old".into(), host("http://10.0.0.2:4747"));
        hosts.advertise("new".into(), host("http://10.0.0.2:4747"));
        hosts.check(|_| true);
        assert_eq!(hosts.list().len(), 1);
        hosts.withdraw("new");
        assert!(hosts.list().is_empty());
    }

    #[test]
    fn drops_bonjour_counter() {
        assert_eq!(plain_name("Deer’s\\032Mac\\032mini\\032(3)"), "Deer’s Mac mini");
        assert_eq!(plain_name("Studio (East)"), "Studio (East)");
        assert_eq!(plain_name("Mac ()"), "Mac ()");
        assert_eq!(plain_name("Chey's MacBook Pro"), "Chey's MacBook Pro");
    }
}
