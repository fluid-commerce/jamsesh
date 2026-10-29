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
pub const REAL_PORTS: [u16; 13] = [4790, 4747, 4848, 4949, 4443, 5100, 5101, 5102, 5103, 5104, 7979, 8178, 47900];

/// Variables that say where data, tools or helpers live. An isolated build ignores them and the hub it starts never sees them.
pub const LOCATION_VARS: [&str; 12] = [
    "JAMSESH_DATA",
    "JAMSESH_TEAM",
    "JAMSESH_HOME",
    "JAMSESH_FIGCRAFT_BIN_DIR",
    "JAMSESH_FIGCRAFT_PORT",
    "JAMSESH_DEV_PORT_START",
    "JAMSESH_WHISPER_PORT",
    "JAMSESH_WHISPER_MODEL",
    "JAMSESH_WHISPER_SERVER",
    "JAMSESH_PARAKEET_DIR",
    "JAMSESH_PUBLIC_URL",
    "JAMSESH_PUBLIC_HOST",
];

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

/// The real app's storage: `~/.jamsesh` and its system app data folder, resolved through links.
fn real_roots(home: Option<&str>) -> Vec<PathBuf> {
    let Some(h) = home else { return Vec::new() };
    [Path::new(h).join(".jamsesh"), Path::new(h).join("Library/Application Support/com.fluidcommerce.jamsesh")].iter().map(|p| realish(p)).collect()
}

/// realpath of the deepest part that exists, then the rest (a folder not made yet still resolves through its real parents).
fn realish(p: &Path) -> PathBuf {
    let mut rest = Vec::new();
    let mut cur = p;
    loop {
        if let Ok(real) = cur.canonicalize() {
            return rest.iter().rev().fold(real, |acc, c: &&std::ffi::OsStr| acc.join(c));
        }
        match (cur.file_name(), cur.parent()) {
            (Some(name), Some(parent)) => {
                rest.push(name);
                cur = parent;
            }
            _ => return p.to_path_buf(),
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
        // An isolated build builds its home from JAMSESH_APP_DATA alone: an inherited JAMSESH_HOME is ignored.
        if o.app_data.is_none()
            && let Some(v) = present("JAMSESH_HOME", get("JAMSESH_HOME"))?
        {
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
        if o.isolated() {
            let roots = real_roots(get("HOME").as_deref());
            for p in [o.app_data.as_ref(), o.hub_home.as_ref()].into_iter().flatten() {
                if let Some(root) = roots.iter().find(|r| realish(p).starts_with(r)) {
                    return Err(format!("{} is inside the real JamSesh's storage ({}). A test build needs its own JAMSESH_APP_DATA.", p.display(), root.display()));
                }
            }
            if o.keychain_service == DEFAULT_KEYCHAIN_SERVICE || o.bonjour == DEFAULT_BONJOUR.trim_end_matches(".local") {
                return Err("A build with JAMSESH_APP_DATA set can't use the real app's Keychain service or Bonjour type.".into());
            }
            let mut mine = std::iter::once(o.relay_port).chain(o.hub_ports.iter().copied());
            if let Some(p) = mine.find(|p| REAL_PORTS.contains(p)) {
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

    /// What the hub it starts gets when isolated: every inherited location variable removed (the caller does that),
    /// then these. Its home is `<app data>/home`; it chooses its own helper and canvas ports (port 0).
    pub fn hub_env(&self) -> Vec<(&'static str, String)> {
        let Some(dir) = &self.app_data else { return Vec::new() };
        vec![("JAMSESH_ISOLATED", "1".into()), ("JAMSESH_APP_DATA", dir.to_string_lossy().into_owned()), ("JAMSESH_HOME", dir.join("home").to_string_lossy().into_owned())]
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
        assert!(!o.isolated());
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

    const BASE: [(&str, &str); 3] = [("JAMSESH_APP_DATA", "/tmp/a"), ("JAMSESH_RELAY_PORT", "5890"), ("JAMSESH_HUB_PORTS", "5747,5848")];

    fn iso(extra: &[(&str, &str)]) -> Result<Isolation, String> {
        let mut pairs: Vec<_> = BASE.iter().filter(|(n, _)| !extra.iter().any(|(k, _)| k == n)).copied().collect();
        pairs.extend_from_slice(extra);
        Isolation::from_vars(vars(&pairs))
    }

    #[test]
    fn a_test_build_has_no_agent_setup_and_the_hub_gets_only_its_own_home() {
        assert!(Isolation::default().agent_setup_off().is_none());
        assert!(Isolation::default().hub_env().is_empty());
        let o = iso(&[]).unwrap();
        assert!(o.agent_setup_off().is_some());
        let env = o.hub_env();
        assert!(env.contains(&("JAMSESH_ISOLATED", "1".to_string())));
        assert!(env.contains(&("JAMSESH_APP_DATA", "/tmp/a".to_string())) && env.contains(&("JAMSESH_HOME", "/tmp/a/home".to_string())));
        // Everything that says where data, helpers or ports live is removed from the hub's environment.
        for k in ["JAMSESH_DATA", "JAMSESH_TEAM", "JAMSESH_HOME", "JAMSESH_WHISPER_PORT", "JAMSESH_FIGCRAFT_PORT", "JAMSESH_DEV_PORT_START", "JAMSESH_WHISPER_MODEL", "JAMSESH_PUBLIC_URL"] {
            assert!(LOCATION_VARS.contains(&k), "{k}");
        }
    }

    #[test]
    fn refusal_a_data_folder_without_its_own_relay_and_hub_ports() {
        assert!(Isolation::from_vars(vars(&[("JAMSESH_APP_DATA", "/tmp/a")])).is_err());
        assert!(iso(&[]).unwrap().isolated());
    }

    #[test]
    fn refusal_every_real_port_is_refused_when_given() {
        for p in REAL_PORTS {
            assert!(iso(&[("JAMSESH_RELAY_PORT", &p.to_string())]).is_err(), "relay {p}");
            assert!(iso(&[("JAMSESH_HUB_PORTS", &format!("5800,{p}"))]).is_err(), "hub {p}");
        }
        // Without a data folder the old defaults stay legal (the real app itself).
        assert!(Isolation::from_vars(vars(&[("JAMSESH_RELAY_PORT", "4790")])).is_ok());
    }

    #[test]
    fn refusal_the_real_keychain_service_and_bonjour_type_even_when_given() {
        assert!(iso(&[("JAMSESH_KEYCHAIN_SERVICE", "JamSesh")]).is_err());
        assert!(iso(&[("JAMSESH_BONJOUR_SERVICE", "_jamsesh._tcp")]).is_err());
        assert!(iso(&[("JAMSESH_BONJOUR_SERVICE", "_jamsesh._tcp.local.")]).is_err());
        assert!(iso(&[("JAMSESH_KEYCHAIN_SERVICE", "Mine"), ("JAMSESH_BONJOUR_SERVICE", "_mine._tcp")]).is_ok());
    }

    #[test]
    fn refusal_a_data_folder_inside_the_real_storage_even_through_a_link_or_a_missing_folder() {
        let tmp = std::env::temp_dir().join(format!("jam-iso-{}", std::process::id()));
        let home = tmp.join("home");
        std::fs::create_dir_all(home.join(".jamsesh")).unwrap();
        std::os::unix::fs::symlink(home.join(".jamsesh"), tmp.join("link")).unwrap();
        let h = home.to_string_lossy().into_owned();
        let try_dir = |d: &std::path::Path| iso(&[("JAMSESH_APP_DATA", &d.to_string_lossy()), ("HOME", &h)]);
        assert!(try_dir(&home.join(".jamsesh")).is_err());
        assert!(try_dir(&home.join(".jamsesh/deeper/not-made-yet")).is_err());
        assert!(try_dir(&tmp.join("link")).is_err());
        assert!(try_dir(&tmp.join("link/new")).is_err());
        assert!(try_dir(&home.join("Library/Application Support/com.fluidcommerce.jamsesh/x")).is_err());
        assert!(try_dir(&tmp.join("elsewhere")).is_ok());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn an_inherited_home_is_ignored_when_isolated() {
        let o = iso(&[("JAMSESH_HOME", "/Users/x/.jamsesh")]).unwrap();
        assert_eq!(o.hub_home, Some(PathBuf::from("/tmp/a/home")));
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
    fn without_a_data_folder_the_homes_override_still_applies() {
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
