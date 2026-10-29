// A person's voiceprint copy, kept by this app for them so it travels to every host they join
// (SPEC "Voiceprints travel with the person"). Embeddings only, never audio. One file per person under
// this Mac user's app data, with that person's own yes or no: the app asks the host who the window is
// (never the page), so a shared Mac never hands one person's copy, or their choice, to another.
//
// A person is known across hosts by the name they go by, the one thing that is the same on every host
// (person ids are each host's own).

use serde::{Deserialize, Serialize};
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
        assert_eq!(load(&d, "Chey"), Kept { consent: Some(false), copy: None });
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
