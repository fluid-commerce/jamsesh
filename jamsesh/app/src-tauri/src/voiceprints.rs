// A person's voiceprint copy, kept by this app for them so it travels to every host they join
// (SPEC "Voiceprints travel with the person"). Embeddings only, never audio. One file per person under
// this Mac user's app data, with that person's own yes or no: the app asks the host who the window is
// (never the page), so a shared Mac never hands one person's copy, or their choice, to another.
//
// A person is known across hosts by the name they go by, the one thing that is the same on every host
// (person ids are each host's own).
//
// The samples never reach a host's page until that person has said yes to that host: the first time
// their copy would go to a host it hasn't gone to before, the app asks in a native dialog, and keeps
// the answer per host id (what the host's /api/pair/info says, not its address). Until then the page
// sees the copy's version and dates only.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::future::Future;
use std::path::{Path, PathBuf};

/// What a device may carry, as the hub checks it (hub/src/audio/voiceprint.ts).
const DIM: usize = 256;
const MAX_SAMPLES: usize = 32;
const MAX_NAME: usize = 80;

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
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Kept {
    pub consent: Option<bool>,
    pub copy: Option<Copy>,
    /// Hosts (by host id) this person said Share or Not this room to.
    #[serde(default)]
    pub hosts: BTreeMap<String, bool>,
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
pub async fn share<F, Fut>(dir: &Path, name: &str, host_id: &str, ask: F) -> Result<Option<Copy>, String>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = bool>,
{
    if host_id.is_empty() || host_id.len() > 64 {
        return Err("This host didn't say who it is.".into());
    }
    let kept = load(dir, name);
    let (Some(true), Some(_)) = (kept.consent, kept.copy.as_ref()) else { return Ok(None) };
    let yes = match kept.hosts.get(host_id) {
        Some(&answer) => answer,
        None => {
            let answer = ask().await;
            // Read again: the file may have changed while the dialog was up.
            let mut now = load(dir, name);
            now.hosts.insert(host_id.to_string(), answer);
            save(dir, name, &now)?;
            answer
        }
    };
    Ok(if yes { load(dir, name).copy } else { None })
}

/// The file for the person who goes by `name`: their name in hex, so any name is a safe file name.
fn file_for(dir: &Path, name: &str) -> Option<PathBuf> {
    let key: String = name.trim().to_lowercase().chars().take(MAX_NAME).collect();
    if key.is_empty() {
        return None;
    }
    let hex: String = key.bytes().map(|b| format!("{b:02x}")).collect();
    Some(dir.join("voiceprints").join(format!("{hex}.json")))
}

/// A copy the app will keep: the hub's shape and limits, every number finite.
pub fn check(c: &Copy) -> Result<(), String> {
    if c.dim != DIM || c.model.is_empty() || c.model.len() > 64 {
        return Err("That isn't a voiceprint this app keeps.".into());
    }
    if c.samples.is_empty() || c.samples.len() > MAX_SAMPLES {
        return Err(format!("A voiceprint holds 1 to {MAX_SAMPLES} samples."));
    }
    if c.samples.iter().any(|s| s.kind.len() > 16 || s.embedding.len() != DIM || !s.embedding.iter().all(|n| n.is_finite())) {
        return Err("A sample in that voiceprint is malformed.".into());
    }
    if c.version.as_ref().is_some_and(|v| v.len() > 64)
        || c.host.as_ref().is_some_and(|h| h.len() > 64)
        || c.updated_at.is_some_and(|t| !t.is_finite())
    {
        return Err("That voiceprint's details are malformed.".into());
    }
    Ok(())
}

pub fn load(dir: &Path, name: &str) -> Kept {
    file_for(dir, name)
        .and_then(|f| std::fs::read(f).ok())
        .and_then(|b| serde_json::from_slice::<Kept>(&b).ok())
        .filter(|k| k.copy.as_ref().is_none_or(|c| check(c).is_ok()))
        .unwrap_or_default()
}

fn save(dir: &Path, name: &str, kept: &Kept) -> Result<(), String> {
    let file = file_for(dir, name).ok_or("This window has no person yet.")?;
    let parent = file.parent().ok_or("No folder for voiceprints.")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let tmp = file.with_extension("json.part");
    std::fs::write(&tmp, serde_json::to_vec(kept).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &file).map_err(|e| e.to_string())
}

/// Their yes or no. No forgets the copy.
pub fn set_consent(dir: &Path, name: &str, on: bool) -> Result<(), String> {
    let mut kept = load(dir, name);
    kept.consent = Some(on);
    if !on {
        kept.copy = None;
        kept.hosts.clear();
    }
    save(dir, name, &kept)
}

/// Keeps a copy, only for someone who said yes.
pub fn put(dir: &Path, name: &str, copy: Copy) -> Result<(), String> {
    check(&copy)?;
    let mut kept = load(dir, name);
    if kept.consent != Some(true) {
        return Err("Keeping your voice in the app is off.".into());
    }
    kept.copy = Some(copy);
    save(dir, name, &kept)
}

/// The host's id and the name to ask about ("Design review", else its address), from `/api/pair/info`.
pub fn host_of(info: &str, fallback: &str) -> Option<(String, String)> {
    let v: serde_json::Value = serde_json::from_str(info).ok()?;
    let id = v.get("hostId")?.as_str()?.trim().to_string();
    let name = v.get("name").and_then(|n| n.as_str()).map(str::trim).filter(|n| !n.is_empty()).unwrap_or(fallback);
    (!id.is_empty()).then(|| (id, name.chars().take(60).collect()))
}

/// The question, in the dialog's words.
pub fn question(person: &str, room: &str) -> String {
    format!("Share {person}'s voice with {room}? It's numbers that describe your voice, never a recording.")
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
        }
    }

    fn dir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("jam-vp-{}", random()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    fn random() -> u64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos() as u64 ^ (std::process::id() as u64) << 32
    }

    #[test]
    fn each_person_has_their_own_copy_and_choice() {
        let d = dir();
        assert_eq!(load(&d, "Chey"), Kept::default());
        // Nothing is kept until they say yes.
        assert!(put(&d, "Chey", copy(2, 0.1)).is_err());
        set_consent(&d, "Chey", true).unwrap();
        put(&d, "Chey", copy(2, 0.1)).unwrap();
        assert_eq!(load(&d, " chey ").copy, Some(copy(2, 0.1)));
        // Another person on this app sees neither Chey's copy nor Chey's yes.
        assert_eq!(load(&d, "Pat"), Kept::default());
        assert!(put(&d, "Pat", copy(2, 0.2)).is_err());
        // No forgets the copy.
        set_consent(&d, "Chey", false).unwrap();
        assert_eq!(load(&d, "Chey"), Kept { consent: Some(false), copy: None, hosts: Default::default() });
        assert!(set_consent(&d, "  ", true).is_err());
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
    fn a_host_gets_the_voice_only_after_a_yes_and_each_host_is_asked_once() {
        let d = dir();
        let asked = std::cell::Cell::new(0);
        // Nothing kept yet: nothing to send, nobody asked.
        assert_eq!(block(share(&d, "Chey", "hostA", stub(true, &asked))).unwrap(), None);
        set_consent(&d, "Chey", true).unwrap();
        put(&d, "Chey", copy(3, 0.1)).unwrap();
        // Before any answer the page sees the copy's dates, not its samples.
        let seen = for_page(load(&d, "Chey"), "hostA");
        assert!(seen.copy.as_ref().unwrap().samples.is_empty());
        assert_eq!(seen.copy.as_ref().unwrap().version.as_deref(), Some("v1"));
        // Not this room: nothing goes, and that room isn't asked again.
        assert_eq!(block(share(&d, "Chey", "hostA", stub(false, &asked))).unwrap(), None);
        assert_eq!(block(share(&d, "Chey", "hostA", stub(true, &asked))).unwrap(), None);
        assert_eq!(asked.get(), 1);
        // Another host is its own question. Share: it goes, now and later, without asking again.
        assert_eq!(block(share(&d, "Chey", "hostB", stub(true, &asked))).unwrap(), Some(copy(3, 0.1)));
        assert_eq!(block(share(&d, "Chey", "hostB", stub(false, &asked))).unwrap(), Some(copy(3, 0.1)));
        assert_eq!(asked.get(), 2);
        assert_eq!(for_page(load(&d, "Chey"), "hostB").copy.unwrap().samples.len(), 3);
        assert!(for_page(load(&d, "Chey"), "hostB").hosts.is_empty());
        // Another person on this Mac has their own answers.
        set_consent(&d, "Pat", true).unwrap();
        put(&d, "Pat", copy(1, 0.2)).unwrap();
        assert_eq!(block(share(&d, "Pat", "hostB", stub(false, &asked))).unwrap(), None);
        assert_eq!(asked.get(), 3);
        // Turning keeping off forgets the answers too.
        set_consent(&d, "Chey", false).unwrap();
        assert!(load(&d, "Chey").hosts.is_empty());
        assert!(block(share(&d, "Chey", "", stub(true, &asked))).is_err());
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn the_host_is_known_by_its_id_and_named_by_its_room() {
        assert_eq!(host_of(r#"{"name":"Design review","hostId":"ab12"}"#, "10.0.0.2:4747"), Some(("ab12".into(), "Design review".into())));
        assert_eq!(host_of(r#"{"name":"","hostId":"ab12"}"#, "10.0.0.2:4747"), Some(("ab12".into(), "10.0.0.2:4747".into())));
        assert_eq!(host_of(r#"{"name":"Design review"}"#, "x"), None);
        assert_eq!(
            question("Chey", "Design review"),
            "Share Chey's voice with Design review? It's numbers that describe your voice, never a recording."
        );
    }

    #[test]
    fn the_person_comes_from_the_hosts_answer() {
        assert_eq!(person_of(r#"{"person":{"id":"p_1","name":"Chey"}}"#), Some(("p_1".into(), "Chey".into())));
        assert_eq!(person_of(r#"{"person":null}"#), None);
        assert_eq!(person_of(r#"{"person":{"id":"p_1","name":"  "}}"#), None);
        assert_eq!(person_of("not json"), None);
    }

    #[test]
    fn a_name_is_always_a_safe_file_name() {
        let d = Path::new("/x");
        let f = file_for(d, "../../etc/passwd").unwrap();
        assert_eq!(f.parent(), Some(Path::new("/x/voiceprints")));
        assert!(f.file_name().unwrap().to_str().unwrap().chars().all(|c| c.is_ascii_hexdigit() || c == '.' || c.is_ascii_alphabetic()));
    }
}
