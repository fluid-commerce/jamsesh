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
        if let Some(v) = present("JAMSESH_KEYCHAIN_SERVICE", get("JAMSESH_KEYCHAIN_SERVICE"))? {
            o.keychain_service = v;
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
        if let Some(v) = present("JAMSESH_BONJOUR_SERVICE", get("JAMSESH_BONJOUR_SERVICE"))? {
            o.bonjour = v.trim_end_matches('.').trim_end_matches(".local").to_string();
        }
        Ok(o)
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
        let o = Isolation::from_vars(vars(&[("JAMSESH_APP_DATA", "/tmp/a"), ("JAMSESH_HOME", "/tmp/h")])).unwrap();
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
        let id = |d: &str| Isolation::from_vars(vars(&[("JAMSESH_APP_DATA", d)])).unwrap().web_store_id().unwrap();
        assert_eq!(id("/tmp/a"), id("/tmp/a"));
        assert_ne!(id("/tmp/a"), id("/tmp/b"));
    }
}
