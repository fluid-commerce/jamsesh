// Overrides that let a test build run beside the real app. Each variable is read once, at launch;
// unset, everything is what it always was (relay on 4790, Keychain item "JamSesh", hosts on
// 4747/4848/4949, the app's own data folder, Bonjour `_jamsesh._tcp`). A variable that is set but
// empty or wrong stops the launch with a message: a typo must never fall back to the real app's
// port or Keychain item, because that is exactly the collision these exist to avoid.
//
//   JAMSESH_RELAY_PORT        the port agents on this Mac use to reach the room (default 4790)
//   JAMSESH_KEYCHAIN_SERVICE  the Keychain service name tokens are stored under (default "JamSesh")
//   JAMSESH_HUB_PORTS         comma list of ports the hosted session may use (default 4747,4848,4949)
//   JAMSESH_APP_DATA          the app's data folder (app.json, logs, screen layouts); the session's
//                             own data (JAMSESH_HOME) moves to <it>/home unless JAMSESH_HOME is set
//   JAMSESH_BONJOUR_SERVICE   the Bonjour service type, so test hosts and real ones don't list each other
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

pub const DEFAULT_RELAY_PORT: u16 = 4790;
pub const DEFAULT_KEYCHAIN_SERVICE: &str = "JamSesh";
pub const DEFAULT_HUB_PORTS: [u16; 3] = [4747, 4848, 4949];
const DEFAULT_BONJOUR: &str = "_jamsesh._tcp";
/// Ports the real app and its hub use. An isolated build (a data folder override) never takes one.
pub const REAL_PORTS: [u16; 12] = [4790, 4747, 4848, 4949, 8178, 47900, 5100, 5101, 5102, 5103, 5104, 4443];

#[derive(Debug, Clone, PartialEq)]
pub struct Isolation {
    pub relay_port: u16,
    pub keychain_service: String,
    pub hub_ports: Vec<u16>,
    /// Set only when `JAMSESH_APP_DATA` is: replaces the system's app data folder.
    pub app_data: Option<PathBuf>,
    /// The session's data folder (`JAMSESH_HOME`): the one the environment names, else inside `app_data`.
    pub hub_home: Option<PathBuf>,
    /// Bonjour service type without the `.local.` suffix.
    pub bonjour: String,
    /// The hub's speech helper port (`JAMSESH_WHISPER_PORT`). An isolated build without one runs no speech helper.
    pub whisper_port: Option<u16>,
    /// FigCraft's port (`JAMSESH_FIGCRAFT_PORT`) and the first live-build port (`JAMSESH_DEV_PORT_START`);
    /// an isolated build without them is given free ports at launch.
    pub figcraft_port: Option<u16>,
    pub dev_port_start: Option<u16>,
}

impl Default for Isolation {
    fn default() -> Self {
        Isolation {
            relay_port: DEFAULT_RELAY_PORT,
            keychain_service: DEFAULT_KEYCHAIN_SERVICE.into(),
            hub_ports: DEFAULT_HUB_PORTS.to_vec(),
            app_data: None,
            hub_home: None,
            bonjour: DEFAULT_BONJOUR.into(),
            whisper_port: None,
            figcraft_port: None,
            dev_port_start: None,
        }
    }
}

/// `None` when the variable is unset; an error when it is set to nothing.
fn present(name: &str, raw: Option<String>) -> Result<Option<String>, String> {
    match raw {
        None => Ok(None),
        Some(v) if v.trim().is_empty() => Err(format!("{name} is set but empty. Unset it to use the default.")),
        Some(v) => Ok(Some(v.trim().to_string())),
    }
}

fn port(name: &str, v: &str) -> Result<u16, String> {
    match v.parse::<u16>() {
        Ok(p) if p >= 1024 => Ok(p),
        _ => Err(format!("{name} must be a port from 1024 to 65535, not \"{v}\".")),
    }
}

impl Isolation {
    pub fn from_vars(get: impl Fn(&str) -> Option<String>) -> Result<Isolation, String> {
        let mut o = Isolation::default();
        if let Some(v) = present("JAMSESH_RELAY_PORT", get("JAMSESH_RELAY_PORT"))? {
            o.relay_port = port("JAMSESH_RELAY_PORT", &v)?;
        }
        if let Some(v) = present("JAMSESH_HUB_PORTS", get("JAMSESH_HUB_PORTS"))? {
            let mut ports = Vec::new();
            for part in v.split(',') {
                let p = port("JAMSESH_HUB_PORTS", part.trim())?;
                if !ports.contains(&p) {
                    ports.push(p);
                }
            }
            o.hub_ports = ports;
        }
        if o.hub_ports.contains(&o.relay_port) {
            return Err(format!("The relay port {} is also in JAMSESH_HUB_PORTS; they must differ.", o.relay_port));
        }
        if let Some(v) = present("JAMSESH_APP_DATA", get("JAMSESH_APP_DATA"))? {
            let dir = PathBuf::from(&v);
            if !dir.is_absolute() {
                return Err(format!("JAMSESH_APP_DATA must be an absolute path, not \"{v}\"."));
            }
            o.hub_home = Some(dir.join("home"));
            o.app_data = Some(dir);
        }
        if let Some(v) = present("JAMSESH_HOME", get("JAMSESH_HOME"))? {
            o.hub_home = Some(PathBuf::from(v));
        }
        // A data folder alone must not leave the Keychain item or the Bonjour type at the real app's names.
        if let Some(dir) = &o.app_data {
            let tag = format!("{:05x}", fnv128(dir.to_string_lossy().as_bytes()) & 0xfffff);
            o.keychain_service = format!("JamSesh Test {tag}");
            o.bonjour = format!("_jamsesh-{tag}._tcp");
        }
        if let Some(v) = present("JAMSESH_KEYCHAIN_SERVICE", get("JAMSESH_KEYCHAIN_SERVICE"))? {
            o.keychain_service = v;
        }
        if let Some(v) = present("JAMSESH_BONJOUR_SERVICE", get("JAMSESH_BONJOUR_SERVICE"))? {
            o.bonjour = v.trim_end_matches('.').trim_end_matches(".local").to_string();
        }
        for (name, slot) in [("JAMSESH_WHISPER_PORT", &mut o.whisper_port), ("JAMSESH_FIGCRAFT_PORT", &mut o.figcraft_port), ("JAMSESH_DEV_PORT_START", &mut o.dev_port_start)] {
            if let Some(v) = present(name, get(name))? {
                *slot = Some(port(name, &v)?);
            }
        }
        if o.isolated() {
            let mine = [Some(o.relay_port), o.whisper_port, o.figcraft_port, o.dev_port_start].into_iter().flatten().chain(o.hub_ports.iter().copied());
            if let Some(p) = mine.into_iter().find(|p| REAL_PORTS.contains(p)) {
                return Err(format!("Port {p} belongs to the real JamSesh. A build with JAMSESH_APP_DATA set must say its own JAMSESH_RELAY_PORT and JAMSESH_HUB_PORTS (and any other port it sets) and use none of the real app's."));
            }
        }
        Ok(o)
    }

    /// Whether this is a test build beside the real app: a set `JAMSESH_APP_DATA` means it shares nothing with
    /// the real one (data, Keychain, ports, speech helper, agent setup, web view store).
    pub fn isolated(&self) -> bool {
        self.app_data.is_some()
    }

    /// The agent setup script writes ~/.jamsesh and the real Claude Code and Codex configuration (MCP entry,
    /// skill, hooks): a test build beside the real app never runs it, and the offers and menu items go with it.
    pub fn agent_setup_off(&self) -> Option<&'static str> {
        self.isolated().then_some("Agent setup is off in a test build: it would change the Claude Code and Codex setup that the real JamSesh uses.")
    }

    /// The environment the hub it starts gets, beyond the ports: it must share nothing with the real hub.
    /// `free` supplies a free port for the ones not set (FigCraft, live builds).
    pub fn hub_env(&self, free: &mut dyn FnMut() -> u16) -> Vec<(&'static str, String)> {
        if !self.isolated() {
            return Vec::new();
        }
        let mut env = vec![("JAMSESH_ISOLATED", "1".to_string())];
        env.push(("JAMSESH_FIGCRAFT_PORT", self.figcraft_port.unwrap_or_else(&mut *free).to_string()));
        env.push(("JAMSESH_DEV_PORT_START", self.dev_port_start.unwrap_or_else(&mut *free).to_string()));
        if let Some(p) = self.whisper_port {
            env.push(("JAMSESH_WHISPER_PORT", p.to_string()));
        }
        env
    }

    /// A stable id for the web view's data store (macOS 14 and later) when the app data folder is
    /// overridden, so cookies and local storage don't mix with another build's. FNV-1a, 128 bits.
    pub fn web_store_id(&self) -> Option<[u8; 16]> {
        let dir = self.app_data.as_ref()?;
        Some(fnv128(dir.to_string_lossy().as_bytes()).to_be_bytes())
    }

    pub fn bonjour_type(&self) -> String {
        format!("{}.local.", self.bonjour)
    }
}

fn fnv128(bytes: &[u8]) -> u128 {
    let mut h: u128 = 0x6c62272e07bb014262b821756295c58d;
    for b in bytes {
        h ^= *b as u128;
        h = h.wrapping_mul(0x0000000001000000000000000000013b);
    }
    h
}

static CELL: OnceLock<Isolation> = OnceLock::new();

/// Reads the environment once. Call first thing in `main`; an error is the message to show.
pub fn init() -> Result<&'static Isolation, String> {
    if let Some(o) = CELL.get() {
        return Ok(o);
    }
    let o = Isolation::from_vars(|k| std::env::var_os(k).map(|v| v.to_string_lossy().into_owned()))?;
    Ok(CELL.get_or_init(|| o))
}

/// The settings `init` read; the defaults when it hasn't run (unit tests).
pub fn get() -> &'static Isolation {
    CELL.get_or_init(Isolation::default)
}

/// The app's data folder: the override, else the system's.
pub fn app_data_or(system: Option<PathBuf>) -> PathBuf {
    get().app_data.clone().or(system).unwrap_or_else(|| Path::new("/tmp/jamsesh-app").to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let m: Vec<(String, String)> = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        move |k| m.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone())
    }

    #[test]
    fn nothing_set_is_what_it_always_was() {
        let o = Isolation::from_vars(vars(&[])).unwrap();
        assert_eq!(o, Isolation::default());
        assert_eq!((o.relay_port, o.keychain_service.as_str()), (4790, "JamSesh"));
        assert_eq!(o.hub_ports, [4747, 4848, 4949]);
        assert!(o.app_data.is_none() && o.hub_home.is_none() && o.web_store_id().is_none());
        assert_eq!(o.bonjour_type(), "_jamsesh._tcp.local.");
        assert!(!o.isolated() && o.whisper_port.is_none());
    }

    #[test]
    fn a_data_folder_alone_never_leaves_the_real_keychain_item_or_bonjour_type() {
        let base = [("JAMSESH_RELAY_PORT", "5890"), ("JAMSESH_HUB_PORTS", "5747")];
        let with = |dir: &str, extra: &[(&str, &str)]| {
            let mut pairs = base.to_vec();
            pairs.push(("JAMSESH_APP_DATA", dir));
            pairs.extend_from_slice(extra);
            Isolation::from_vars(vars(&pairs)).unwrap()
        };
        let a = with("/tmp/a", &[]);
        assert!(a.keychain_service.starts_with("JamSesh Test ") && a.keychain_service != DEFAULT_KEYCHAIN_SERVICE);
        assert!(a.bonjour.starts_with("_jamsesh-") && a.bonjour != DEFAULT_BONJOUR);
        assert!(a.bonjour.split('.').next().is_some_and(|n| n.len() <= 15), "a Bonjour service name is at most 15 characters: {}", a.bonjour);
        assert_ne!(a.keychain_service, with("/tmp/b", &[]).keychain_service);
        // A name set on purpose still wins.
        let c = with("/tmp/a", &[("JAMSESH_KEYCHAIN_SERVICE", "Mine"), ("JAMSESH_BONJOUR_SERVICE", "_mine._tcp")]);
        assert_eq!((c.keychain_service.as_str(), c.bonjour.as_str()), ("Mine", "_mine._tcp"));
    }

    #[test]
    fn a_test_build_has_no_agent_setup_and_gets_its_own_hub_ports() {
        assert!(Isolation::default().agent_setup_off().is_none());
        let mut next = 6000;
        let mut free = || {
            next += 1;
            next
        };
        assert!(Isolation::default().hub_env(&mut free).is_empty());
        let o = Isolation::from_vars(vars(&[("JAMSESH_APP_DATA", "/tmp/a"), ("JAMSESH_RELAY_PORT", "5890"), ("JAMSESH_HUB_PORTS", "5747")])).unwrap();
        assert!(o.agent_setup_off().is_some());
        let env = o.hub_env(&mut free);
        assert!(env.contains(&("JAMSESH_ISOLATED", "1".to_string())));
        assert!(env.contains(&("JAMSESH_FIGCRAFT_PORT", "6001".to_string())) && env.contains(&("JAMSESH_DEV_PORT_START", "6002".to_string())));
        // No speech helper port, none passed: the hub runs without one rather than using 8178.
        assert!(!env.iter().any(|(k, _)| *k == "JAMSESH_WHISPER_PORT"));
    }

    #[test]
    fn app_data_alone_makes_the_build_isolated_and_the_real_ports_are_refused() {
        // A data folder alone is refused: the relay and hub ports would be the real app's defaults.
        assert!(Isolation::from_vars(vars(&[("JAMSESH_APP_DATA", "/tmp/a")])).is_err());
        let base = [("JAMSESH_APP_DATA", "/tmp/a"), ("JAMSESH_RELAY_PORT", "5890"), ("JAMSESH_HUB_PORTS", "5747,5848")];
        assert!(Isolation::from_vars(vars(&base)).unwrap().isolated());
        for (k, v) in [("JAMSESH_RELAY_PORT", "4790"), ("JAMSESH_HUB_PORTS", "5800,4747"), ("JAMSESH_WHISPER_PORT", "8178"), ("JAMSESH_FIGCRAFT_PORT", "47900"), ("JAMSESH_DEV_PORT_START", "5102")] {
            let mut pairs: Vec<_> = base.iter().filter(|(n, _)| n != &k).copied().collect();
            pairs.push((k, v));
            assert!(Isolation::from_vars(vars(&pairs)).is_err(), "{k}={v}");
        }
        let mut pairs = base.to_vec();
        pairs.extend([("JAMSESH_WHISPER_PORT", "5878"), ("JAMSESH_FIGCRAFT_PORT", "5879"), ("JAMSESH_DEV_PORT_START", "5900")]);
        let ok = Isolation::from_vars(vars(&pairs)).unwrap();
        assert_eq!((ok.whisper_port, ok.figcraft_port, ok.dev_port_start), (Some(5878), Some(5879), Some(5900)));
        // Without a data folder the old defaults stay legal (the real app itself).
        assert!(Isolation::from_vars(vars(&[("JAMSESH_RELAY_PORT", "4790")])).is_ok());
    }

    #[test]
    fn each_override_applies() {
        let o = Isolation::from_vars(vars(&[
            ("JAMSESH_RELAY_PORT", " 5890 "),
            ("JAMSESH_KEYCHAIN_SERVICE", "JamSesh Test"),
            ("JAMSESH_HUB_PORTS", "5747, 5848,5747"),
            ("JAMSESH_APP_DATA", "/tmp/jam-test"),
            ("JAMSESH_BONJOUR_SERVICE", "_jamsesh-test._tcp"),
        ]))
        .unwrap();
        assert_eq!((o.relay_port, o.keychain_service.as_str()), (5890, "JamSesh Test"));
        assert_eq!(o.hub_ports, [5747, 5848]);
        assert_eq!(o.app_data, Some(PathBuf::from("/tmp/jam-test")));
        assert_eq!(o.hub_home, Some(PathBuf::from("/tmp/jam-test/home")));
        assert_eq!(o.bonjour_type(), "_jamsesh-test._tcp.local.");
    }

    #[test]
    fn the_sessions_own_home_wins_over_the_app_data_folder() {
        let o = Isolation::from_vars(vars(&[("JAMSESH_APP_DATA", "/tmp/a"), ("JAMSESH_HOME", "/tmp/h"), ("JAMSESH_RELAY_PORT", "5890"), ("JAMSESH_HUB_PORTS", "5747")])).unwrap();
        assert_eq!(o.hub_home, Some(PathBuf::from("/tmp/h")));
        let o = Isolation::from_vars(vars(&[("JAMSESH_HOME", "/tmp/h")])).unwrap();
        assert_eq!((o.app_data, o.hub_home), (None, Some(PathBuf::from("/tmp/h"))));
    }

    #[test]
    fn a_wrong_value_stops_the_launch_instead_of_falling_back() {
        for (k, v) in [
            ("JAMSESH_RELAY_PORT", ""),
            ("JAMSESH_RELAY_PORT", "abc"),
            ("JAMSESH_RELAY_PORT", "80"),
            ("JAMSESH_RELAY_PORT", "70000"),
            ("JAMSESH_KEYCHAIN_SERVICE", "  "),
            ("JAMSESH_HUB_PORTS", "5747,,5848"),
            ("JAMSESH_HUB_PORTS", "5747,x"),
            ("JAMSESH_APP_DATA", "relative/dir"),
            ("JAMSESH_APP_DATA", ""),
        ] {
            assert!(Isolation::from_vars(vars(&[(k, v)])).is_err(), "{k}={v}");
        }
    }

    #[test]
    fn the_relay_and_the_hubs_cant_share_a_port() {
        assert!(Isolation::from_vars(vars(&[("JAMSESH_RELAY_PORT", "4747")])).is_err());
        assert!(Isolation::from_vars(vars(&[("JAMSESH_RELAY_PORT", "5000"), ("JAMSESH_HUB_PORTS", "5000,5001")])).is_err());
    }

    #[test]
    fn the_web_store_id_follows_the_folder_and_stays_put() {
        let id = |d: &str| Isolation::from_vars(vars(&[("JAMSESH_APP_DATA", d), ("JAMSESH_RELAY_PORT", "5890"), ("JAMSESH_HUB_PORTS", "5747")])).unwrap().web_store_id().unwrap();
        assert_eq!(id("/tmp/a"), id("/tmp/a"));
        assert_ne!(id("/tmp/a"), id("/tmp/b"));
    }
}
