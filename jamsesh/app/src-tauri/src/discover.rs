// Finds JamSesh hosts on the local network (Bonjour), for the Join list.
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

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

/// What the search itself ran into, apart from the hosts it found.
#[derive(Default)]
struct Scan {
    /// Why Bonjour couldn't be started or stopped working, in plain words.
    error: Option<String>,
}

#[derive(Clone)]
pub struct Hosts(Arc<Mutex<BTreeMap<String, Entry>>>, Arc<Mutex<Scan>>, Instant);

impl Default for Hosts {
    fn default() -> Self {
        Self(Arc::default(), Arc::default(), Instant::now())
    }
}

/// How long the search is called "looking" before it says nothing turned up.
const LOOK_FOR: Duration = Duration::from_secs(6);

/// Everything the explanation depends on, so it can be tested with made-up results.
pub struct Facts {
    /// Hosts that answer and are listed.
    pub listed: usize,
    /// Hosts that advertised themselves, answering or not.
    pub advertised: usize,
    pub error: Option<String>,
    pub has_network: bool,
    pub waited: Duration,
}

/// What the join window shows when nothing is listed.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Status {
    /// `found`, `looking` or `none`.
    pub state: &'static str,
    /// Why nothing turned up: `blocked`, `offline`, `unreachable` or `empty`.
    pub reason: Option<&'static str>,
    pub headline: String,
    pub detail: String,
}

fn status(state: &'static str, reason: Option<&'static str>, headline: &str, detail: &str) -> Status {
    Status { state, reason, headline: headline.into(), detail: detail.into() }
}

/// Says what the search found, or the likeliest reason it found nothing.
pub fn diagnose(f: &Facts) -> Status {
    if f.listed > 0 {
        return status("found", None, "", "");
    }
    if let Some(error) = &f.error {
        return Status {
            detail: format!("{error} Check that JamSesh is allowed under System Settings > Privacy & Security > Local Network, then reopen the app."),
            ..status("none", Some("blocked"), "JamSesh can't look for rooms", "")
        };
    }
    if !f.has_network {
        return status("none", Some("offline"), "This Mac isn't on a network", "Connect to the Wi-Fi the big screen is on, or type its address if you have one.");
    }
    if f.waited < LOOK_FOR {
        return status("looking", None, "Looking for rooms on this network…", "");
    }
    if f.advertised > 0 {
        return status(
            "none",
            Some("unreachable"),
            "A room is nearby, but this Mac can't reach it",
            "This Wi-Fi may keep devices apart, as guest and office networks often do. Type the address from the big screen or scan its QR code.",
        );
    }
    status(
        "none",
        Some("empty"),
        "No rooms found on this network",
        "Nobody may be hosting yet, this Wi-Fi may block Bonjour, or you may be on a different Wi-Fi than the big screen. Type the address or scan the QR code instead.",
    )
}

/// Whether this Mac has a route out of the machine. Sends nothing: connecting a UDP socket only picks a route.
fn has_network() -> bool {
    std::net::UdpSocket::bind("0.0.0.0:0")
        .and_then(|s| s.connect("192.0.2.1:9").and_then(|()| s.local_addr()))
        .is_ok_and(|a| !a.ip().is_unspecified() && !a.ip().is_loopback())
}

impl Hosts {
    /// The search's state for the join window.
    pub fn status(&self) -> Status {
        let (listed, advertised) = self.0.lock().map(|m| (m.values().filter(|e| e.up).count(), m.len())).unwrap_or_default();
        let error = self.1.lock().ok().and_then(|s| s.error.clone());
        diagnose(&Facts { listed, advertised, error, has_network: has_network(), waited: self.2.elapsed() })
    }

    fn fail(&self, error: &str) {
        if let Ok(mut s) = self.1.lock() {
            s.error = Some(error.into());
        }
    }

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
    f.url.trim_start_matches("http://").parse::<std::net::SocketAddr>().is_ok_and(|addr| {
        std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(800)).is_ok()
    })
}

/// Browses in the background for as long as the app runs.
pub fn start() -> Hosts {
    let hosts = Hosts::default();
    let found = hosts.clone();
    let sweep = hosts.clone();
    let failed = hosts.clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(CHECK_EVERY);
            sweep.check(answers);
        }
    });
    std::thread::spawn(move || {
        let Ok(daemon) = ServiceDaemon::new() else { return failed.fail("The network scanner wouldn't start.") };
        let Ok(events) = daemon.browse(SERVICE) else { return failed.fail("The network scanner wouldn't start.") };
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
        failed.fail("The network scanner stopped.");
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
    use super::{Facts, Hosts, Found, LOOK_FOR, Status, diagnose, plain_name};
    use std::time::Duration;

    fn facts() -> Facts {
        Facts { listed: 0, advertised: 0, error: None, has_network: true, waited: LOOK_FOR }
    }

    fn reason(s: &Status) -> Option<&'static str> {
        s.reason
    }

    #[test]
    fn says_it_is_still_looking_for_the_first_seconds_then_why_nothing_turned_up() {
        let early = diagnose(&Facts { waited: Duration::from_secs(2), ..facts() });
        assert_eq!((early.state, early.reason), ("looking", None));
        let late = diagnose(&facts());
        assert_eq!((late.state, reason(&late)), ("none", Some("empty")));
        assert!(late.detail.contains("Bonjour") && late.detail.contains("different Wi-Fi") && late.detail.contains("QR"));
    }

    #[test]
    fn names_the_likely_reason_in_order_of_certainty() {
        let found = diagnose(&Facts { listed: 1, advertised: 1, ..facts() });
        assert_eq!(found.state, "found");
        let blocked = diagnose(&Facts { error: Some("The network scanner wouldn't start.".into()), ..facts() });
        assert_eq!(reason(&blocked), Some("blocked"));
        assert!(blocked.detail.contains("Local Network"));
        // A failed scanner wins over everything else, even before the wait is up.
        assert_eq!(reason(&diagnose(&Facts { error: Some("x".into()), waited: Duration::ZERO, ..facts() })), Some("blocked"));
        let offline = diagnose(&Facts { has_network: false, ..facts() });
        assert_eq!(reason(&offline), Some("offline"));
        let isolated = diagnose(&Facts { advertised: 2, ..facts() });
        assert_eq!(reason(&isolated), Some("unreachable"));
        assert!(isolated.detail.contains("keep devices apart"));
    }

    #[test]
    fn a_host_that_advertised_but_never_answered_is_reported_as_unreachable_not_missing() {
        let hosts = Hosts::default();
        hosts.advertise("a".into(), host("http://10.0.0.2:4747"));
        hosts.check(|_| false);
        // Pretend the wait is over: the status counts the advert, not the (empty) list.
        let m = hosts.0.lock().map(|m| (m.values().filter(|e| e.up).count(), m.len())).unwrap_or_default();
        assert_eq!(m, (0, 1));
        assert_eq!(reason(&diagnose(&Facts { advertised: m.1, listed: m.0, ..facts() })), Some("unreachable"));
        hosts.check(|_| true);
        assert_eq!(hosts.list().len(), 1);
    }

    #[test]
    fn a_scanner_failure_is_remembered_for_the_status() {
        let hosts = Hosts::default();
        hosts.fail("The network scanner stopped.");
        let s = hosts.status();
        assert_eq!(s.reason, Some("blocked"));
    }

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
