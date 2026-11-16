// JamSesh's saved sign-ins, all in ONE Keychain item.
//
// The Keychain asks (once per item, per read or write) whether this build may use an item, and
// every new ad-hoc-signed build counts as a stranger. So the person token and the agents token of
// every host live together as a small JSON map in a single item: read at most once per run (on
// the first join that needs it), kept in memory, written only when a value changes.
//
// Before this, each host had two items of its own (`origin` and `origin#agents`). The first join
// of a host that isn't in the map yet reads those two once, moves them into the map and deletes
// them, so that one last prompt is the only one.
use std::collections::{BTreeMap, HashSet};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

const SERVICE: &str = "JamSesh";
const ACCOUNT: &str = "credentials";

/// What this Mac holds for one host: the person's token, and the one this Mac's agents use.
#[derive(Clone, Default, PartialEq, Debug, Serialize, Deserialize)]
pub struct Creds {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agents: Option<String>,
}

type Map = BTreeMap<String, Creds>;

/// The Keychain, as little as this needs of it. Tests use an in-memory one.
pub trait Store: Send + Sync {
    /// `Ok(None)` is "no such item"; `Err` is "couldn't read it" (denied, locked).
    fn get(&self, account: &str) -> Result<Option<String>, String>;
    fn set(&self, account: &str, value: &str) -> Result<(), String>;
    fn delete(&self, account: &str) -> Result<(), String>;
}

pub struct Keychain;

impl Keychain {
    fn entry(account: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(SERVICE, account).map_err(|e| e.to_string())
    }
}

impl Store for Keychain {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        match Self::entry(account)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }
    fn set(&self, account: &str, value: &str) -> Result<(), String> {
        Self::entry(account)?.set_password(value).map_err(|e| e.to_string())
    }
    fn delete(&self, account: &str) -> Result<(), String> {
        Self::entry(account)?.delete_credential().map_err(|e| e.to_string())
    }
}

/// The map from the item's text. Anything unreadable (not JSON, not an object) is an empty map, and
/// an entry that isn't a credentials object is skipped, so one bad entry doesn't lose the rest.
/// Unknown fields inside an entry are ignored.
fn decode(text: Option<&str>) -> Map {
    let Some(serde_json::Value::Object(obj)) = text.and_then(|t| serde_json::from_str(t).ok()) else { return Map::new() };
    obj.into_iter().filter_map(|(origin, v)| serde_json::from_value::<Creds>(v).ok().map(|c| (origin, c))).collect()
}

fn encode(map: &Map) -> String {
    serde_json::to_string(map).unwrap_or_else(|_| "{}".into())
}

/// Puts the given values into `origin`'s entry (a `None` leaves that value as it was, an empty
/// string counts as none). True when something actually changed.
fn merge(map: &mut Map, origin: &str, token: Option<&str>, agents: Option<&str>) -> bool {
    let keep = |s: Option<&str>| s.filter(|v| !v.is_empty()).map(str::to_string);
    let (token, agents) = (keep(token), keep(agents));
    let before = map.get(origin).cloned();
    let mut entry = before.clone().unwrap_or_default();
    if token.is_some() {
        entry.token = token;
    }
    if agents.is_some() {
        entry.agents = agents;
    }
    if before.as_ref() == Some(&entry) || (before.is_none() && entry == Creds::default()) {
        return false;
    }
    map.insert(origin.to_string(), entry);
    true
}

#[derive(Default)]
struct Loaded {
    /// None until the Keychain item has been read (successfully) this run.
    map: Option<Map>,
    /// Hosts whose legacy items were already looked for this run.
    migrated: HashSet<String>,
}

pub struct Credentials {
    store: Box<dyn Store>,
    /// Held across Keychain calls on purpose: two quick joins queue here and the second finds the
    /// map already loaded.
    state: Mutex<Loaded>,
}

impl Credentials {
    pub fn new(store: Box<dyn Store>) -> Self {
        Self { store, state: Mutex::new(Loaded::default()) }
    }

    /// What's saved for `origin`. May block on the Keychain (and its prompt): call it off the
    /// async runtime's threads.
    pub fn lookup(&self, origin: &str) -> Creds {
        let mut st = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if !self.ensure_loaded(&mut st) {
            return Creds::default();
        }
        self.migrate(&mut st, origin);
        st.map.as_ref().and_then(|m| m.get(origin).cloned()).unwrap_or_default()
    }

    /// Keeps new values for `origin`. Writes the Keychain only if one differs from what's saved.
    pub fn remember(&self, origin: &str, token: Option<&str>, agents: Option<&str>) {
        let mut st = self.state.lock().unwrap_or_else(|p| p.into_inner());
        // Not loaded (the Keychain refused the read): writing now would replace what's in it with
        // only this host, so leave it for a later run.
        if !self.ensure_loaded(&mut st) {
            return;
        }
        self.migrate(&mut st, origin);
        if let Some(map) = st.map.as_mut()
            && merge(map, origin, token, agents)
        {
            let _ = self.store.set(ACCOUNT, &encode(map));
        }
    }

    fn ensure_loaded(&self, st: &mut Loaded) -> bool {
        if st.map.is_none() {
            match self.store.get(ACCOUNT) {
                Ok(text) => st.map = Some(decode(text.as_deref())),
                Err(_) => return false,
            }
        }
        true
    }

    /// Moves `origin`'s two old per-host items into the map, once per run. The old items are
    /// deleted only after the map holding their values is saved.
    fn migrate(&self, st: &mut Loaded, origin: &str) {
        if !st.migrated.insert(origin.to_string()) || st.map.as_ref().is_some_and(|m| m.contains_key(origin)) {
            return;
        }
        let agents_account = format!("{origin}#agents");
        let token = self.store.get(origin).ok().flatten();
        let agents = self.store.get(&agents_account).ok().flatten();
        let Some(map) = st.map.as_mut() else { return };
        if !merge(map, origin, token.as_deref(), agents.as_deref()) || self.store.set(ACCOUNT, &encode(map)).is_err() {
            return;
        }
        if token.is_some() {
            let _ = self.store.delete(origin);
        }
        if agents.is_some() {
            let _ = self.store.delete(&agents_account);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Arc;

    #[derive(Default)]
    struct Fake {
        items: Mutex<HashMap<String, String>>,
        reads: Mutex<Vec<String>>,
        writes: Mutex<Vec<String>>,
        deny_reads: Mutex<bool>,
    }

    struct Handle(Arc<Fake>);

    impl Store for Handle {
        fn get(&self, account: &str) -> Result<Option<String>, String> {
            self.0.reads.lock().unwrap().push(account.to_string());
            if *self.0.deny_reads.lock().unwrap() {
                return Err("denied".into());
            }
            Ok(self.0.items.lock().unwrap().get(account).cloned())
        }
        fn set(&self, account: &str, value: &str) -> Result<(), String> {
            self.0.writes.lock().unwrap().push(account.to_string());
            self.0.items.lock().unwrap().insert(account.to_string(), value.to_string());
            Ok(())
        }
        fn delete(&self, account: &str) -> Result<(), String> {
            self.0.items.lock().unwrap().remove(account);
            Ok(())
        }
    }

    fn creds(fake: &Arc<Fake>) -> Credentials {
        Credentials::new(Box::new(Handle(fake.clone())))
    }

    fn count(v: &Mutex<Vec<String>>) -> usize {
        v.lock().unwrap().len()
    }

    #[test]
    fn decode_tolerates_garbage_and_unknown_fields() {
        assert!(decode(None).is_empty());
        assert!(decode(Some("not json")).is_empty());
        assert!(decode(Some("[1,2]")).is_empty());
        let m = decode(Some(r#"{"https://a":{"token":"t","future":1},"https://b":"junk","https://c":{"agents":"g"}}"#));
        assert_eq!(m.len(), 2);
        assert_eq!(m["https://a"], Creds { token: Some("t".into()), agents: None });
        assert_eq!(m["https://c"].agents.as_deref(), Some("g"));
    }

    #[test]
    fn encode_round_trips() {
        let mut m = Map::new();
        merge(&mut m, "https://a", Some("t"), Some("g"));
        assert_eq!(decode(Some(&encode(&m))), m);
    }

    #[test]
    fn merge_reports_only_real_changes() {
        let mut m = Map::new();
        assert!(!merge(&mut m, "o", None, None));
        assert!(!merge(&mut m, "o", Some(""), None));
        assert!(m.is_empty());
        assert!(merge(&mut m, "o", Some("t"), None));
        assert!(!merge(&mut m, "o", Some("t"), None));
        assert!(merge(&mut m, "o", None, Some("g")));
        assert_eq!(m["o"], Creds { token: Some("t".into()), agents: Some("g".into()) });
        assert!(merge(&mut m, "o", Some("t2"), Some("g")));
        assert!(!merge(&mut m, "o", None, Some("g")));
    }

    #[test]
    fn reads_the_item_once_however_many_joins() {
        let fake = Arc::new(Fake::default());
        fake.items.lock().unwrap().insert(ACCOUNT.into(), r#"{"o":{"token":"t","agents":"g"}}"#.into());
        let c = creds(&fake);
        assert_eq!(c.lookup("o").token.as_deref(), Some("t"));
        assert_eq!(c.lookup("o").agents.as_deref(), Some("g"));
        assert_eq!(count(&fake.reads), 1);
        assert_eq!(count(&fake.writes), 0);
    }

    #[test]
    fn writes_only_when_a_value_changes() {
        let fake = Arc::new(Fake::default());
        let c = creds(&fake);
        c.remember("o", Some("t"), None);
        c.remember("o", Some("t"), None);
        c.remember("o", None, Some("g"));
        c.remember("o", None, Some("g"));
        assert_eq!(count(&fake.writes), 2);
        assert_eq!(decode(fake.items.lock().unwrap().get(ACCOUNT).map(String::as_str))["o"].agents.as_deref(), Some("g"));
    }

    #[test]
    fn migrates_legacy_items_once_and_deletes_them() {
        let fake = Arc::new(Fake::default());
        {
            let mut items = fake.items.lock().unwrap();
            items.insert("o".into(), "tok".into());
            items.insert("o#agents".into(), "ag".into());
        }
        let c = creds(&fake);
        let got = c.lookup("o");
        assert_eq!((got.token.as_deref(), got.agents.as_deref()), (Some("tok"), Some("ag")));
        assert!(!fake.items.lock().unwrap().contains_key("o"));
        assert!(!fake.items.lock().unwrap().contains_key("o#agents"));
        assert_eq!(count(&fake.writes), 1);
        // A fresh run reads just the one item.
        let reads = count(&fake.reads);
        let again = creds(&fake);
        assert_eq!(again.lookup("o").token.as_deref(), Some("tok"));
        assert_eq!(count(&fake.reads), reads + 1);
    }

    #[test]
    fn unknown_host_costs_no_write_and_no_second_legacy_look() {
        let fake = Arc::new(Fake::default());
        let c = creds(&fake);
        assert_eq!(c.lookup("new"), Creds::default());
        let reads = count(&fake.reads);
        assert_eq!(c.lookup("new"), Creds::default());
        assert_eq!(count(&fake.reads), reads);
        assert_eq!(count(&fake.writes), 0);
    }

    #[test]
    fn a_refused_read_never_overwrites_the_item() {
        let fake = Arc::new(Fake::default());
        fake.items.lock().unwrap().insert(ACCOUNT.into(), r#"{"other":{"token":"keep"}}"#.into());
        *fake.deny_reads.lock().unwrap() = true;
        let c = creds(&fake);
        assert_eq!(c.lookup("o"), Creds::default());
        c.remember("o", Some("t"), None);
        assert_eq!(count(&fake.writes), 0);
        // Allowed later in the same run: it loads then.
        *fake.deny_reads.lock().unwrap() = false;
        assert_eq!(c.lookup("other").token.as_deref(), Some("keep"));
    }
}
