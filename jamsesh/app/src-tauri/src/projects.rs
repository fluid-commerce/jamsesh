// Projects, as the app needs them: which one to open, and the recent ones for the menu bar. The hub
// owns the folders (hub/src/projects.ts); this only reads their project.json files.
use std::path::PathBuf;

use serde::Deserialize;

/// What to start the hub on (hub/src/config.ts `enterProject`).
#[derive(Clone, Debug, PartialEq)]
pub enum Launch {
    /// Only the Projects picker, no session yet.
    Lobby { new_project: bool },
    /// The project used last (what a terminal does with no name).
    Last,
    /// An existing project, by slug.
    Project(String),
    /// A new project, by name.
    New(String),
}

#[derive(Clone, Debug, PartialEq)]
pub struct Recent {
    pub slug: String,
    pub name: String,
}

#[derive(Deserialize)]
struct ProjectFile {
    name: Option<String>,
    #[serde(default, rename = "lastUsed")]
    last_used: f64,
}

/// `~/.jamsesh`, or `$JAMSESH_HOME` (the hub reads the same variable).
fn home() -> PathBuf {
    std::env::var_os("JAMSESH_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".jamsesh")))
        .unwrap_or_else(|| PathBuf::from("/"))
}

/// The most recently used projects, newest first.
pub fn recent(limit: usize) -> Vec<Recent> {
    recent_in(&home(), limit)
}

fn recent_in(home: &std::path::Path, limit: usize) -> Vec<Recent> {
    let mut found: Vec<(f64, Recent)> = std::fs::read_dir(home.join("projects"))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let slug = e.file_name().into_string().ok()?;
            let f: ProjectFile = serde_json::from_slice(&std::fs::read(e.path().join("project.json")).ok()?).ok()?;
            Some((f.last_used, Recent { name: f.name.filter(|n| !n.trim().is_empty())?, slug }))
        })
        .collect();
    found.sort_by(|a, b| b.0.total_cmp(&a.0).then_with(|| a.1.name.cmp(&b.1.name)));
    found.into_iter().take(limit).map(|(_, r)| r).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(home: &std::path::Path, slug: &str, body: &str) {
        let dir = home.join("projects").join(slug);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("project.json"), body).unwrap();
    }

    #[test]
    fn recent_is_newest_first_and_skips_what_it_cannot_read() {
        let home = std::env::temp_dir().join(format!("jam-recent-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        project(&home, "old", r#"{"name":"Old","created":1,"lastUsed":10,"people":[]}"#);
        project(&home, "new", r#"{"name":"New","created":1,"lastUsed":20,"people":[]}"#);
        project(&home, "broken", "{nope");
        project(&home, "nameless", r#"{"lastUsed":99}"#);
        let list = recent_in(&home, 5);
        assert_eq!(list.iter().map(|r| r.slug.as_str()).collect::<Vec<_>>(), ["new", "old"]);
        assert_eq!(recent_in(&home, 1).len(), 1);
        assert!(recent_in(&home.join("missing"), 5).is_empty());
        let _ = std::fs::remove_dir_all(&home);
    }
}
