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

/// What one request returns: the font files found, and the families it didn't get to.
#[derive(Serialize, Debug, Default)]
pub struct LocalFonts {
    /// One entry per font file, so a family kept in several files (Regular, Bold …) sends each.
    pub fonts: Vec<LocalFont>,
    /// Families that were asked for but not looked at (past [`MAX_FAMILIES`]) or that didn't fit in
    /// this response ([`MAX_TOTAL`]): ask for them again. A family absent from both lists and from
    /// `fonts` is one this Mac doesn't have.
    pub deferred: Vec<String>,
}

/// The font files of the families this Mac has, read and base64-encoded: each file once, files
/// over [`MAX_FILE`] skipped, and at most [`MAX_TOTAL`] in all. A family goes whole or not at all
/// (so its faces stay together) unless it is alone too big, then as many of its files as fit.
/// Families it doesn't have are left out; families it didn't get to are named in `deferred`.
pub fn local_fonts(families: &[String]) -> LocalFonts {
    let mut wanted: Vec<String> = Vec::new();
    for f in families.iter().map(|f| f.trim()).filter(|f| !f.is_empty() && f.len() <= 200) {
        if !wanted.iter().any(|w| w.eq_ignore_ascii_case(f)) {
            wanted.push(f.to_string());
        }
    }
    let rest = wanted.split_off(wanted.len().min(MAX_FAMILIES));
    let mut out = read_files(lookup_files(&wanted));
    out.deferred.extend(rest);
    out
}

fn read_files(found: Vec<(String, Vec<PathBuf>)>) -> LocalFonts {
    read_files_capped(found, MAX_TOTAL)
}

fn read_files_capped(found: Vec<(String, Vec<PathBuf>)>, max_total: u64) -> LocalFonts {
    let mut sent = BTreeSet::new();
    let mut total = 0u64;
    let mut out = LocalFonts::default();
    for (family, files) in found {
        let sizes: Vec<(PathBuf, u64)> = files
            .into_iter()
            .filter(|p| !sent.contains(p))
            .filter_map(|p| std::fs::metadata(&p).ok().map(|m| (p, m.len())))
            .filter(|(_, len)| *len <= MAX_FILE)
            .collect();
        let size: u64 = sizes.iter().map(|(_, len)| len).sum();
        if total > 0 && total + size > max_total {
            out.deferred.push(family);
            continue;
        }
        for (path, len) in sizes {
            if total + len > max_total {
                continue; // a family too big for one response sends what fits
            }
            let Ok(bytes) = std::fs::read(&path) else { continue };
            total += bytes.len() as u64;
            sent.insert(path);
            out.fonts.push(LocalFont { family: family.clone(), data: base64::engine::general_purpose::STANDARD.encode(bytes) });
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
    fn reads_each_file_once_and_leaves_out_what_this_mac_lacks() {
        let got = local_fonts(&["Helvetica Neue".into(), "HELVETICA NEUE".into(), "No Such Family 7f3a".into()]);
        assert!(got.deferred.is_empty());
        let fonts = got.fonts;
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
        assert_eq!(read_files(many).fonts.len(), 1);
        let asked: Vec<String> = (0..100).map(|i| format!("Family {i}")).collect();
        let got = local_fonts(&asked);
        assert!(got.fonts.is_empty());
        // The 76 it didn't look at are named, not mistaken for fonts this Mac lacks.
        assert_eq!(got.deferred.len(), 100 - MAX_FAMILIES);
        assert_eq!(got.deferred[0], format!("Family {MAX_FAMILIES}"));
        const { assert!(MAX_FILE < MAX_TOTAL) };
    }

    #[test]
    fn a_family_keeps_all_its_files_and_one_that_does_not_fit_waits() {
        let dir = std::env::temp_dir().join(format!("jamsesh-fonts-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = |n: &str, len: usize| {
            let p = dir.join(n);
            std::fs::write(&p, vec![7u8; len]).unwrap();
            p
        };
        let (reg, bold) = (file("r.ttf", 10), file("b.ttf", 20));
        let found = vec![("Mine".to_string(), vec![reg.clone(), bold.clone()])];
        let got = read_files(found);
        // Regular and Bold in separate files both go.
        assert_eq!(got.fonts.len(), 2);
        assert!(got.deferred.is_empty());
        // Past the cap, a family waits whole (its faces stay together); a smaller one after it still fits.
        let (big, small) = (file("big.ttf", 15), file("small.ttf", 5));
        let found = vec![("A".to_string(), vec![reg, bold]), ("B".to_string(), vec![big]), ("C".to_string(), vec![small])];
        let got = read_files_capped(found, 40);
        let names: Vec<_> = got.fonts.iter().map(|f| f.family.as_str()).collect();
        assert_eq!(names, ["A", "A", "C"]);
        assert_eq!(got.deferred, ["B"]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
