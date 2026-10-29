// Fonts from this Mac for this person's canvas.
//
// A person's canvas is FigCraft's WebAssembly build, which can't see the Mac's installed fonts: text
// an agent set in Helvetica Neue (drawn natively on the host) shows in a substitute there. The page
// asks for the families its canvas reports missing, and this reads them from the Mac's own font
// folders (system, local and the person's) so the page can hand them to the canvas with
// `text.loadFont`. The bytes go to the page in this app's window, which is the host's page: whoever
// hosts the session can ask for any installed family (capped per request below), so this is not a
// boundary between a person's Mac and the host.
use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde::Serialize;

/// At most this many families per request.
pub const MAX_FAMILIES: usize = 24;
/// A single font file larger than this is skipped (Apple Color Emoji is ~180 MB).
pub const MAX_FILE: u64 = 48 * 1024 * 1024;
/// At most this much font data per request.
pub const MAX_TOTAL: u64 = 96 * 1024 * 1024;
/// A family that isn't found walks the folders again (a font installed since) at most this often.
const RESCAN_AFTER: Duration = Duration::from_secs(30);

#[derive(Serialize, Debug)]
pub struct LocalFont {
    /// The family as the canvas asked for it.
    pub family: String,
    /// The font file, base64 (a collection carries every face).
    pub data: String,
}

/// The font folders, indexed once (and again when asked for a family they didn't have).
static DB: Mutex<Option<(Instant, fontdb::Database)>> = Mutex::new(None);

fn scan() -> fontdb::Database {
    let mut db = fontdb::Database::new();
    db.load_system_fonts();
    db
}

/// The files that hold `family`'s faces (any case; a face's localized family names count too).
pub fn files_for(db: &fontdb::Database, family: &str) -> Vec<PathBuf> {
    let want = family.trim().to_lowercase();
    if want.is_empty() {
        return Vec::new();
    }
    let mut out = BTreeSet::new();
    for face in db.faces() {
        if !face.families.iter().any(|(name, _)| name.to_lowercase() == want) {
            continue;
        }
        if let fontdb::Source::File(path) = &face.source {
            out.insert(path.clone());
        }
    }
    out.into_iter().collect()
}

/// The files for each of `families`, with the folders walked again (at most every 30 s) when one
/// isn't known.
fn lookup_files(families: &[String]) -> Vec<(String, Vec<PathBuf>)> {
    let mut guard = DB.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let (at, db) = guard.get_or_insert_with(|| (Instant::now(), scan()));
    let found = |db: &fontdb::Database| families.iter().map(|f| (f.clone(), files_for(db, f))).collect::<Vec<_>>();
    let mut out = found(db);
    if out.iter().any(|(_, files)| files.is_empty()) && at.elapsed() > RESCAN_AFTER {
        (*at, *db) = (Instant::now(), scan());
        out = found(db);
    }
    out
}

/// Which of `families` this Mac has installed (as asked), without reading any font: the page uses
/// it to know whether it can offer to lend one. Same limits as [`local_fonts`].
pub fn installed(families: &[String]) -> Vec<String> {
    let mut wanted: Vec<String> = families.iter().map(|f| f.trim().to_string()).filter(|f| !f.is_empty() && f.len() <= 200).collect();
    wanted.truncate(MAX_FAMILIES);
    lookup_files(&wanted).into_iter().filter(|(_, files)| !files.is_empty()).map(|(f, _)| f).collect()
}

/// The font files of the families this Mac has, read and base64-encoded: each file once, files
/// over [`MAX_FILE`] skipped, and at most [`MAX_TOTAL`] in all. Families it doesn't have are left out.
pub fn local_fonts(families: &[String]) -> Vec<LocalFont> {
    let mut wanted: Vec<String> = Vec::new();
    for f in families.iter().map(|f| f.trim()).filter(|f| !f.is_empty() && f.len() <= 200) {
        if !wanted.iter().any(|w| w.eq_ignore_ascii_case(f)) {
            wanted.push(f.to_string());
        }
    }
    wanted.truncate(MAX_FAMILIES);
    read_files(lookup_files(&wanted))
}

fn read_files(found: Vec<(String, Vec<PathBuf>)>) -> Vec<LocalFont> {
    let mut sent = BTreeSet::new();
    let mut total = 0u64;
    let mut out = Vec::new();
    for (family, files) in found {
        for path in files {
            if sent.contains(&path) {
                continue;
            }
            let Ok(meta) = std::fs::metadata(&path) else { continue };
            if meta.len() > MAX_FILE || total + meta.len() > MAX_TOTAL {
                continue;
            }
            let Ok(bytes) = std::fs::read(&path) else { continue };
            total += bytes.len() as u64;
            sent.insert(path);
            out.push(LocalFont { family: family.clone(), data: base64::engine::general_purpose::STANDARD.encode(bytes) });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_a_system_family_by_name_in_any_case() {
        let db = scan();
        // Every Mac has Helvetica Neue (a collection of its faces).
        let files = files_for(&db, "helvetica neue");
        assert!(!files.is_empty(), "Helvetica Neue isn't in the system font folders");
        assert!(files.iter().all(|p| p.exists()));
        assert!(files_for(&db, "No Such Family 7f3a").is_empty());
        assert!(files_for(&db, "  ").is_empty());
    }

    #[test]
    fn says_which_families_are_installed_without_reading_them() {
        let asked: Vec<String> = ["Helvetica Neue", "No Such Family 7f3a", "  ", "HELVETICA NEUE"].map(String::from).to_vec();
        assert_eq!(installed(&asked), vec!["Helvetica Neue".to_string(), "HELVETICA NEUE".to_string()]);
        let many: Vec<String> = (0..MAX_FAMILIES + 10).map(|i| format!("No Such Family {i}")).collect();
        assert!(installed(&many).is_empty());
    }

    #[test]
    fn reads_each_file_once_and_leaves_out_what_this_mac_lacks() {
        let fonts = local_fonts(&["Helvetica Neue".into(), "HELVETICA NEUE".into(), "No Such Family 7f3a".into()]);
        assert!(!fonts.is_empty());
        assert!(fonts.iter().all(|f| f.family == "Helvetica Neue"));
        let bytes = base64::engine::general_purpose::STANDARD.decode(&fonts[0].data).unwrap_or_default();
        // A TrueType collection or a single font file.
        assert!(bytes.starts_with(b"ttcf") || bytes.starts_with(&[0, 1, 0, 0]) || bytes.starts_with(b"OTTO") || bytes.starts_with(b"true"));
    }

    #[test]
    fn caps_how_much_one_request_reads() {
        let db = scan();
        let path = files_for(&db, "Helvetica Neue");
        let one = path.first().cloned().into_iter().collect::<Vec<_>>();
        // The same file under many names is read once.
        let many: Vec<(String, Vec<PathBuf>)> = (0..50).map(|i| (format!("f{i}"), one.clone())).collect();
        assert_eq!(read_files(many).len(), 1);
        let asked: Vec<String> = (0..100).map(|i| format!("Family {i}")).collect();
        assert!(local_fonts(&asked).is_empty());
        const { assert!(MAX_FILE < MAX_TOTAL) };
    }
}
