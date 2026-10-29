// The voiceprint copy of this app's own person, kept so it travels to every host they join (SPEC
// "Voiceprints travel with the person"). Embeddings only, never audio. One file under this Mac user's
// app data, for the one person this app is: their "me" profile, made with a local random id the first
// time they say yes, and never chosen by a name a host gives. Several people sharing one copy of the
// app is out of scope (SPEC).
//
// The samples never reach a host's page until the person said yes to that host: the first time the copy
// would go to a host it hasn't gone to before, the app asks in a native dialog and keeps the answer under
// the host's public key, which the host proves it holds by signing a fresh nonce each time (/api/host-proof).
// A host at the same address claiming the same id can't sign as the one the person trusted. Until then the
// page sees the copy's version and dates only. A host trusted with the voice may also replace the copy the
// app keeps (it's the person's latest voice, from a host they chose); the copy must be the hub's model and shape.
//
// Every change is read, changed and written under one lock, through a temporary file of its own, so a
// "no" and a copy arriving at the same moment can't undo each other.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

/// What a device may carry, as the hub checks it (hub/src/audio/voiceprint.ts).
const MODEL: &str = "wespeaker_en";
const KINDS: [&str; 4] = ["auto", "enrol", "correction", "carried"];
const DIM: usize = 256;
const MAX_SAMPLES: usize = 32;
const KEY_MAX: usize = 200;

static LOCK: Mutex<()> = Mutex::new(());
static WRITES: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Sample {
    pub kind: String,
    pub embedding: Vec<f32>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Copy {
    pub model: String,
    pub dim: usize,
    pub samples: Vec<Sample>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    /// The seal of the host the copy came from; only that host reads it (after a reset there).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stamp: Option<serde_json::Value>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Kept {
    /// This app's person: a local random id, made the first time anything is kept.
    #[serde(default)]
    pub me: String,
    pub consent: Option<bool>,
    pub copy: Option<Copy>,
    /// Hosts (by the public key they proved they hold) the person said Share or Not this room to.
    #[serde(default)]
    pub hosts: BTreeMap<String, bool>,
}

fn file(dir: &Path) -> PathBuf {
    dir.join("voiceprint.json")
}

/// A copy the app will keep: the hub's shape and limits, every number finite.
pub fn check(c: &Copy) -> Result<(), String> {
    if c.dim != DIM || c.model != MODEL {
        return Err("That isn't a voiceprint this app keeps.".into());
    }
    if c.samples.is_empty() || c.samples.len() > MAX_SAMPLES {
        return Err(format!("A voiceprint holds 1 to {MAX_SAMPLES} samples."));
    }
    // Every sample a direction the hub can use: finite, and not all zeros (nothing to normalize).
    let usable = |e: &[f32]| e.len() == DIM && e.iter().all(|n| n.is_finite()) && {
        let norm = e.iter().map(|n| f64::from(*n) * f64::from(*n)).sum::<f64>().sqrt();
        norm.is_finite() && norm > 1e-6
    };
    if c.samples.iter().any(|s| !KINDS.contains(&s.kind.as_str()) || !usable(&s.embedding)) {
        return Err("A sample in that voiceprint is malformed.".into());
    }
    if c.stamp.as_ref().is_some_and(|v| v.to_string().len() > 512) {
        return Err("That voiceprint's details are malformed.".into());
    }
    if c.version.as_ref().is_some_and(|v| v.len() > 64)
        || c.host.as_ref().is_some_and(|h| h.len() > 64)
        || c.updated_at.is_some_and(|t| !t.is_finite())
    {
        return Err("That voiceprint's details are malformed.".into());
    }
    Ok(())
}

pub fn load(dir: &Path) -> Kept {
    std::fs::read(file(dir))
        .ok()
        .and_then(|b| serde_json::from_slice::<Kept>(&b).ok())
        .filter(|k| k.copy.as_ref().is_none_or(|c| check(c).is_ok()))
        .unwrap_or_default()
}

fn save(dir: &Path, kept: &Kept) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("Couldn't save your voice in the app: {e}"))?;
    let tmp = dir.join(format!("voiceprint.json.{}.{}.part", std::process::id(), WRITES.fetch_add(1, Ordering::Relaxed)));
    let json = serde_json::to_vec(kept).map_err(|e| e.to_string())?;
    let written = std::fs::write(&tmp, json).and_then(|()| std::fs::rename(&tmp, file(dir)));
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written.map_err(|e| format!("Couldn't save your voice in the app: {e}"))
}

/// Reads, changes and writes the file under the lock. An error from the change leaves the file as it was.
fn change<R>(dir: &Path, f: impl FnOnce(&mut Kept) -> Result<R, String>) -> Result<R, String> {
    let _held = LOCK.lock().map_err(|_| "The app's voice store is unavailable.".to_string())?;
    let mut kept = load(dir);
    let out = f(&mut kept)?;
    if kept.me.is_empty() {
        kept.me = crate::proxy::random_hex(16).ok_or("No randomness for an id.")?;
    }
    save(dir, &kept)?;
    Ok(out)
}

/// Their yes or no. No forgets the copy and every host's answer.
pub fn set_consent(dir: &Path, on: bool) -> Result<(), String> {
    change(dir, |k| {
        k.consent = Some(on);
        if !on {
            k.copy = None;
            k.hosts.clear();
        }
        Ok(())
    })
}

/// Keeps a copy, only for someone who said yes (checked under the lock, so a "no" can't be overtaken).
fn put_now(dir: &Path, copy: Copy) -> Result<(), String> {
    check(&copy)?;
    change(dir, |k| {
        if k.consent != Some(true) {
            return Err("Keeping your voice in the app is off.".into());
        }
        k.copy = Some(copy);
        Ok(())
    })
}

/// A copy a host's page brought, to keep in place of the app's own. The page is the host's code, so
/// this is a host's say and not the person's: it's kept only for a host the person trusted with their
/// voice (said Share, or Keep, to it), and the first time `ask` puts the question in a native dialog.
pub async fn put<F, Fut>(dir: &Path, host_key: &str, copy: Copy, ask: F) -> Result<(), String>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = bool>,
{
    if host_key.is_empty() || host_key.len() > KEY_MAX {
        return Err("This host didn't say who it is.".into());
    }
    check(&copy)?;
    let kept = load(dir);
    if kept.consent != Some(true) {
        return Err("Keeping your voice in the app is off.".into());
    }
    match kept.hosts.get(host_key) {
        Some(true) => {}
        Some(false) => return Err("You said not this room.".into()),
        None => {
            let answer = ask().await;
            change(dir, |k| {
                if k.consent == Some(true) {
                    k.hosts.insert(host_key.to_string(), answer);
                }
                Ok(())
            })?;
            if !answer {
                return Err("You said not this room.".into());
            }
        }
    }
    put_now(dir, copy)
}

/// Their voice was reset on a host: the copy goes too (the choice stays), so it can't bring the old voice back.
/// A host's page can ask, so this happens only when the person says yes in a native dialog.
/// True when no copy is left.
pub async fn forget<F, Fut>(dir: &Path, ask: F) -> Result<bool, String>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = bool>,
{
    if load(dir).copy.is_none() {
        return Ok(true);
    }
    if !ask().await {
        return Ok(false);
    }
    change(dir, |k| {
        k.copy = None;
        Ok(())
    })?;
    Ok(true)
}

/// Their choice from a host's page. Yes only turns keeping on (a copy still needs a trusted host); turning it
/// off erases the copy and every host's answer, so it happens only when the person says yes in a native dialog.
pub async fn choose<F, Fut>(dir: &Path, on: bool, ask: F) -> Result<bool, String>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = bool>,
{
    if !on && load(dir).consent == Some(true) && !ask().await {
        return Ok(false);
    }
    set_consent(dir, on)?;
    Ok(true)
}

/// What a host's page may see of the copy: everything once the person said Share to this host, else
/// the copy without its samples (enough to tell which copy is newer), and never the other hosts' answers.
pub fn for_page(mut kept: Kept, host_id: &str) -> Kept {
    let shared = kept.hosts.get(host_id) == Some(&true);
    kept.hosts.clear();
    if !shared && let Some(c) = kept.copy.as_mut() {
        c.samples.clear();
    }
    kept
}

/// Hands the copy over for the host `host_id`, asking the person the first time (`ask` shows the
/// dialog; it says yes or no). The answer is kept, so each host is asked once. None: nothing to send,
/// keeping is off, or they said no.
pub async fn share<F, Fut>(dir: &Path, host_id: &str, ask: F) -> Result<Option<Copy>, String>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = bool>,
{
    if host_id.is_empty() || host_id.len() > KEY_MAX {
        return Err("This host didn't say who it is.".into());
    }
    let kept = load(dir);
    let (Some(true), Some(_)) = (kept.consent, kept.copy.as_ref()) else { return Ok(None) };
    let yes = match kept.hosts.get(host_id) {
        Some(&answer) => answer,
        None => {
            // Not under the lock: the dialog waits on the person. The answer is written under it.
            let answer = ask().await;
            change(dir, |k| {
                if k.consent == Some(true) {
                    k.hosts.insert(host_id.to_string(), answer);
                }
                Ok(())
            })?;
            answer
        }
    };
    let now = load(dir);
    Ok(if yes && now.consent == Some(true) { now.copy } else { None })
}

/// The host's id and the name to ask about ("Design review", else its address), from `/api/pair/info`.
pub fn host_of(info: &str, fallback: &str) -> Option<(String, String)> {
    let v: serde_json::Value = serde_json::from_str(info).ok()?;
    let id = v.get("hostId")?.as_str()?.trim().to_string();
    let name = v.get("name").and_then(|n| n.as_str()).map(str::trim).filter(|n| !n.is_empty()).unwrap_or(fallback);
    (!id.is_empty()).then(|| (id, name.chars().take(60).collect()))
}

/// The message a host signs: the app's own fresh nonce, so an old answer can't be replayed.
fn proof_message(nonce: &str) -> String {
    format!("jamsesh-host-proof:v1:{nonce}")
}

/// The host's public key (base64), when its answer to `/api/host-proof?nonce=…` is a valid Ed25519 signature
/// over this nonce. What a host is known by here: a host can claim any id or sit at any address, not sign
/// with another host's key.
pub fn verify_host(proof: &str, nonce: &str) -> Option<String> {
    use base64::Engine as _;
    let v: serde_json::Value = serde_json::from_str(proof).ok()?;
    let b64 = base64::engine::general_purpose::STANDARD;
    let key = v.get("publicKey")?.as_str()?;
    let public = b64.decode(key).ok().filter(|k| k.len() == 32)?;
    let signature = b64.decode(v.get("signature")?.as_str()?).ok()?;
    ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, &public)
        .verify(proof_message(nonce).as_bytes(), &signature)
        .ok()
        .map(|()| key.to_string())
}

/// What a host is known by here: the key it proved it holds.
pub fn host_key(public_key: &str) -> String {
    format!("ed25519:{}", public_key.trim()).chars().take(KEY_MAX).collect()
}

/// A short, readable fingerprint of a host's key for the dialog ("A1B2-C3D4"): a host that changed keys reads differently.
pub fn fingerprint(key: &str) -> String {
    let d = ring::digest::digest(&ring::digest::SHA256, key.as_bytes());
    let hex: String = d.as_ref().iter().take(4).map(|b| format!("{b:02X}")).collect();
    format!("{}-{}", &hex[..4], &hex[4..])
}

/// The question, in the dialog's words. The address and fingerprint are the app's, not the host's say.
pub fn question(person: &str, room: &str, address: &str, print: &str) -> String {
    format!("Share {person}'s voice with {room} ({address}, key {print})? It's numbers that describe your voice, never a recording.")
}

/// Asked when a host's page brings a copy for the app to keep.
pub fn keep_question(person: &str, room: &str, address: &str, print: &str) -> String {
    format!("Keep {person}'s voice from {room} ({address}, key {print}) on this Mac, and let that host have it? It's numbers that describe your voice, never a recording.")
}

/// The window's person on the host it shows, from `/api/me` as the host answers it for this app's window:
/// (their id on that host, their name).
pub fn person_of(me: &str) -> Option<(String, String)> {
    let v: serde_json::Value = serde_json::from_str(me).ok()?;
    let id = v.pointer("/person/id")?.as_str()?.to_string();
    let name = v.pointer("/person/name")?.as_str()?.trim().to_string();
    (!id.is_empty() && !name.is_empty()).then_some((id, name))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn copy(n: usize, value: f32) -> Copy {
        Copy {
            model: "wespeaker_en".into(),
            dim: DIM,
            samples: (0..n).map(|_| Sample { kind: "enrol".into(), embedding: vec![value; DIM] }).collect(),
            version: Some("v1".into()),
            updated_at: Some(5.0),
            host: Some("hostA".into()),
            stamp: None,
        }
    }

    fn dir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("jam-vp-{}", crate::proxy::random_hex(8).unwrap()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn block<T>(f: impl Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(f)
    }

    /// A stand-in for the dialog: answers `yes` and counts how often it was asked. Nothing is shown.
    fn stub(yes: bool, asked: &std::cell::Cell<u32>) -> impl FnOnce() -> std::future::Ready<bool> + '_ {
        move || {
            asked.set(asked.get() + 1);
            std::future::ready(yes)
        }
    }

    #[test]
    fn one_person_one_copy_kept_only_after_a_yes() {
        let d = dir();
        assert_eq!(load(&d), Kept::default());
        assert!(put_now(&d, copy(2, 0.1)).is_err());
        set_consent(&d, true).unwrap();
        let me = load(&d).me;
        assert_eq!(me.len(), 32);
        put_now(&d, copy(2, 0.1)).unwrap();
        assert_eq!(load(&d).copy, Some(copy(2, 0.1)));
        set_consent(&d, true).unwrap();
        assert_eq!(load(&d).me, me);
        let asked = std::cell::Cell::new(0);
        assert!(block(forget(&d, stub(true, &asked))).unwrap());
        assert_eq!((load(&d).consent, load(&d).copy), (Some(true), None));
        put_now(&d, copy(2, 0.1)).unwrap();
        set_consent(&d, false).unwrap();
        assert_eq!((load(&d).consent, load(&d).copy), (Some(false), None));
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn a_hosts_page_cannot_erase_or_switch_off_without_the_person_saying_yes_in_the_dialog() {
        let d = dir();
        let asked = std::cell::Cell::new(0);
        set_consent(&d, true).unwrap();
        put_now(&d, copy(2, 0.1)).unwrap();
        // Declined: the copy and the choice stay.
        assert!(!block(forget(&d, stub(false, &asked))).unwrap());
        assert!(!block(choose(&d, false, stub(false, &asked))).unwrap());
        assert_eq!((load(&d).consent, load(&d).copy.is_some()), (Some(true), true));
        assert_eq!(asked.get(), 2);
        // Turning on is never a prompt; with nothing to delete, neither is forgetting.
        assert!(block(choose(&d, true, stub(false, &asked))).unwrap());
        assert_eq!(asked.get(), 2);
        // Agreed: gone.
        assert!(block(choose(&d, false, stub(true, &asked))).unwrap());
        assert_eq!((load(&d).consent, load(&d).copy), (Some(false), None));
        assert!(block(forget(&d, stub(false, &asked))).unwrap());
        assert_eq!(asked.get(), 3);
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn a_hosts_copy_is_kept_only_for_a_host_the_person_trusted() {
        let d = dir();
        let asked = std::cell::Cell::new(0);
        // Keeping is off: no dialog, no copy.
        assert!(block(put(&d, "10.0.0.2:4747#a", copy(2, 0.1), stub(true, &asked))).is_err());
        assert_eq!(asked.get(), 0);
        set_consent(&d, true).unwrap();
        // A host the person declines never replaces anything, and isn't asked again.
        assert!(block(put(&d, "evil:4747#a", copy(2, 0.9), stub(false, &asked))).is_err());
        assert!(block(put(&d, "evil:4747#a", copy(2, 0.9), stub(true, &asked))).is_err());
        assert_eq!((asked.get(), load(&d).copy), (1, None));
        // A trusted host's copy is kept, and replaces the last one without another question.
        block(put(&d, "10.0.0.2:4747#a", copy(2, 0.1), stub(true, &asked))).unwrap();
        block(put(&d, "10.0.0.2:4747#a", copy(3, 0.2), stub(false, &asked))).unwrap();
        assert_eq!((asked.get(), load(&d).copy), (2, Some(copy(3, 0.2))));
        // The declined host still can't poison it.
        assert!(block(put(&d, "evil:4747#a", copy(2, 0.9), stub(true, &asked))).is_err());
        assert_eq!(load(&d).copy, Some(copy(3, 0.2)));
        std::fs::remove_dir_all(&d).unwrap();
    }

    /// A real signature (made with Node's Ed25519 for this nonce), as a hub's /api/host-proof answers.
    const NONCE: &str = "0123456789abcdef0123456789abcdef";
    const PUBLIC: &str = "NyGsxgHuNJ/6zSU64LIFujAAplYXcVFCoR+t1iZJTL4=";
    const SIGNATURE: &str = "+ta8ip3w/YoAtRB3oVLXuflh2XIDpmIZZTJi8Fv4ttHcEDX7qlSr2flVSWzekGrteMpCSI5FM/eCByBP2VdyCQ==";
    fn proof(key: &str, sig: &str) -> String {
        format!(r#"{{"publicKey":"{key}","signature":"{sig}"}}"#)
    }

    #[test]
    fn a_host_is_known_by_the_key_it_proves_it_holds() {
        assert_eq!(verify_host(&proof(PUBLIC, SIGNATURE), NONCE), Some(PUBLIC.to_string()));
        // Another nonce (a replayed answer), another key claiming the signature, junk: no host.
        assert_eq!(verify_host(&proof(PUBLIC, SIGNATURE), "ffffffffffffffffffffffffffffffff"), None);
        assert_eq!(verify_host(&proof("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", SIGNATURE), NONCE), None);
        assert_eq!(verify_host(&proof(PUBLIC, "AAAA"), NONCE), None);
        assert_eq!(verify_host(r#"{"hostId":"same-id"}"#, NONCE), None);
        assert_eq!(verify_host("not json", NONCE), None);
        let print = fingerprint(PUBLIC);
        assert_eq!(print.len(), 9);
        assert_ne!(print, fingerprint("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="));
    }

    #[test]
    fn a_host_that_cant_sign_as_the_trusted_one_is_a_stranger() {
        let d = dir();
        let asked = std::cell::Cell::new(0);
        set_consent(&d, true).unwrap();
        put_now(&d, copy(3, 0.1)).unwrap();
        // Same address, same claimed id; only the proven key tells them apart.
        let a = host_key(&verify_host(&proof(PUBLIC, SIGNATURE), NONCE).unwrap());
        let b = host_key("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
        assert_ne!(a, b);
        assert_eq!(block(share(&d, &a, stub(true, &asked))).unwrap(), Some(copy(3, 0.1)));
        // The second host copied the first one's id and is asked as a stranger; the answer is no.
        assert_eq!(block(share(&d, &b, stub(false, &asked))).unwrap(), None);
        assert_eq!(asked.get(), 2);
        assert!(for_page(load(&d), &b).copy.unwrap().samples.is_empty());
        assert_eq!(for_page(load(&d), &a).copy.unwrap().samples.len(), 3);
        assert!(question("Chey", "Review", "evil.example", "AB12-CD34").contains("(evil.example, key AB12-CD34)"));
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn a_no_and_a_copy_at_the_same_moment_never_leave_a_copy_after_the_no() {
        let d = dir();
        for _ in 0..40 {
            set_consent(&d, true).unwrap();
            let (a, b) = (d.clone(), d.clone());
            let put_t = std::thread::spawn(move || put_now(&a, copy(3, 0.1)));
            let off_t = std::thread::spawn(move || set_consent(&b, false));
            let put_r = put_t.join().unwrap();
            off_t.join().unwrap().unwrap();
            let k = load(&d);
            assert_eq!(k.consent, Some(false));
            // Whichever went first, the "no" is last or the copy was refused: no copy remains.
            assert_eq!(k.copy, None, "put returned {put_r:?}");
        }
        // No temporary file is left behind.
        let left = std::fs::read_dir(&d).unwrap().filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().ends_with(".part")).count();
        assert_eq!(left, 0);
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn a_failed_write_is_an_error_not_a_silent_no_op() {
        let d = dir();
        let blocked = d.join("not-a-folder");
        std::fs::write(&blocked, "a file where the folder should be").unwrap();
        assert!(set_consent(&blocked, true).is_err());
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn only_a_well_formed_copy_is_kept() {
        assert!(check(&copy(32, 0.1)).is_ok());
        assert!(check(&copy(0, 0.1)).is_err());
        assert!(check(&copy(33, 0.1)).is_err());
        assert!(check(&copy(1, f32::INFINITY)).is_err());
        assert!(check(&copy(1, f32::NAN)).is_err());
        let mut short = copy(1, 0.1);
        short.samples[0].embedding.truncate(100);
        assert!(check(&short).is_err());
        // Numbers too big for f32 arrive as infinity and are refused.
        let big: Result<Copy, _> = serde_json::from_str(&format!(
            r#"{{"model":"m","dim":256,"samples":[{{"kind":"enrol","embedding":[{}]}}]}}"#,
            vec!["1e100"; DIM].join(",")
        ));
        assert!(big.is_err() || check(&big.unwrap()).is_err());
    }

    #[test]
    fn a_host_gets_the_voice_only_after_a_yes_and_each_host_is_asked_once() {
        let d = dir();
        let asked = std::cell::Cell::new(0);
        // Nothing kept yet: nothing to send, nobody asked.
        assert_eq!(block(share(&d, "hostA", stub(true, &asked))).unwrap(), None);
        set_consent(&d, true).unwrap();
        put_now(&d, copy(3, 0.1)).unwrap();
        // Before any answer the page sees the copy's dates, not its samples.
        let seen = for_page(load(&d), "hostA");
        assert!(seen.copy.as_ref().unwrap().samples.is_empty());
        assert_eq!(seen.copy.as_ref().unwrap().version.as_deref(), Some("v1"));
        // Not this room: nothing goes, and that room isn't asked again.
        assert_eq!(block(share(&d, "hostA", stub(false, &asked))).unwrap(), None);
        assert_eq!(block(share(&d, "hostA", stub(true, &asked))).unwrap(), None);
        assert_eq!(asked.get(), 1);
        // Another host is its own question. Share: it goes, now and later, without asking again.
        assert_eq!(block(share(&d, "hostB", stub(true, &asked))).unwrap(), Some(copy(3, 0.1)));
        assert_eq!(block(share(&d, "hostB", stub(false, &asked))).unwrap(), Some(copy(3, 0.1)));
        assert_eq!(asked.get(), 2);
        assert_eq!(for_page(load(&d), "hostB").copy.unwrap().samples.len(), 3);
        assert!(for_page(load(&d), "hostB").hosts.is_empty());
        // Turning keeping off forgets the answers too.
        set_consent(&d, false).unwrap();
        assert!(load(&d).hosts.is_empty());
        assert!(block(share(&d, "", stub(true, &asked))).is_err());
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn only_the_hubs_model_and_usable_samples_are_kept() {
        assert!(check(&copy(2, 0.1)).is_ok());
        let mut wrong_model = copy(2, 0.1);
        wrong_model.model = "other_model".into();
        assert!(check(&wrong_model).is_err());
        assert!(check(&copy(2, 0.0)).is_err());
        let mut odd_kind = copy(2, 0.1);
        odd_kind.samples[0].kind = "made-up".into();
        assert!(check(&odd_kind).is_err());
        let mut tiny = copy(1, 0.1);
        tiny.samples[0].embedding = vec![1e-30; DIM];
        assert!(check(&tiny).is_err());
        let mut sealed = copy(1, 0.1);
        sealed.stamp = Some(serde_json::json!({ "gen": 1, "at": 5, "mac": "m" }));
        assert!(check(&sealed).is_ok());
        sealed.stamp = Some(serde_json::json!({ "mac": "x".repeat(600) }));
        assert!(check(&sealed).is_err());
    }

    #[test]
    fn the_host_is_named_by_its_room() {
        assert_eq!(host_of(r#"{"name":"Design review","hostId":"ab12"}"#, "10.0.0.2:4747"), Some(("ab12".into(), "Design review".into())));
        assert_eq!(host_of(r#"{"name":"","hostId":"ab12"}"#, "10.0.0.2:4747"), Some(("ab12".into(), "10.0.0.2:4747".into())));
        assert_eq!(host_of(r#"{"name":"Design review"}"#, "x"), None);
        assert_eq!(
            question("Chey", "Design review", "10.0.0.2:4747", "AB12-CD34"),
            "Share Chey's voice with Design review (10.0.0.2:4747, key AB12-CD34)? It's numbers that describe your voice, never a recording."
        );
    }

    #[test]
    fn the_person_comes_from_the_hosts_answer() {
        assert_eq!(person_of(r#"{"person":{"id":"p_1","name":"Chey"}}"#), Some(("p_1".into(), "Chey".into())));
        assert_eq!(person_of(r#"{"person":null}"#), None);
        assert_eq!(person_of(r#"{"person":{"id":"p_1","name":"  "}}"#), None);
        assert_eq!(person_of("not json"), None);
    }
}
