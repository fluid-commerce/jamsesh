//! Which of a room canvas's panels are slid in, kept in this browser (per person: a page's local
//! storage) so a reload or a rejoin comes back the way they left it.

const KEY: &str = "figcraft.canvasPanels";

fn storage() -> Option<web_sys::Storage> {
    web_sys::window()?.local_storage().ok().flatten()
}

/// `(layers, properties)` as last kept; both out when nothing was or the storage is blocked.
pub fn read() -> (bool, bool) {
    let saved = storage().and_then(|s| s.get_item(KEY).ok().flatten()).unwrap_or_default();
    (saved.contains('l'), saved.contains('r'))
}

pub fn write((left, right): (bool, bool)) {
    let value = format!("{}{}", if left { "l" } else { "" }, if right { "r" } else { "" });
    if let Some(s) = storage() {
        let _ = s.set_item(KEY, &value);
    }
}
