//! The page's URL: the invite link its fragment names, and the flags its query sets.

/// The invite link in `#join=<link>` (`fragment` is `location.hash`, with or without its `#`), still
/// escaped. The fragment, unlike the query, never leaves the browser, so the link's secret stays out
/// of the web host's logs and `Referer` headers. `join` takes the rest of the fragment, so a pasted
/// `figcraft://join?host=…&file=…&token=…` keeps its own `&`s. Anything longer than an escaped invite
/// link can be is ignored; what is left is checked by `collab.join` like a link the desktop app is
/// opened with.
pub fn join_link(fragment: &str) -> Option<&str> {
    // An invite link is at most 2 KiB; every byte of it escaped is three.
    const MAX: usize = 3 * 2048;
    let fragment = fragment.strip_prefix('#').unwrap_or(fragment);
    let start = if fragment.starts_with("join=") { 0 } else { fragment.find("&join=")? + 1 };
    fragment.get(start + "join=".len()..).filter(|link| !link.is_empty() && link.len() <= MAX)
}

/// Whether `search` (`location.search`, with or without its `?`) has a `control` entry (`?control`,
/// or `?control=…` with any value): the page's control channel, `window.figcraft`, is installed only
/// when it is asked for.
pub fn control(search: &str) -> bool {
    search.strip_prefix('?').unwrap_or(search).split('&').any(|entry| entry.split('=').next() == Some("control"))
}

/// Whether `search` asks for the canvas-only room view: `?canvas` or `?jamsesh` (any value). The
/// page is then just the live canvas, and a `#join=` link joins without a confirmation.
pub fn canvas(search: &str) -> bool {
    search.strip_prefix('?').unwrap_or(search).split('&').any(|entry| matches!(entry.split('=').next(), Some("canvas" | "jamsesh")))
}

/// The display name in `?name=<escaped>` (`+` and `%20` are spaces), at most 64 characters, `None`
/// when it is missing or blank.
pub fn name(search: &str) -> Option<String> {
    let value = search.strip_prefix('?').unwrap_or(search).split('&').find_map(|entry| entry.strip_prefix("name="))?;
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while let Some(&b) = bytes.get(i) {
        let hex = |at: usize| bytes.get(at..at + 2).and_then(|h| std::str::from_utf8(h).ok()).and_then(|h| u8::from_str_radix(h, 16).ok());
        match (b, if b == b'%' { hex(i + 1) } else { None }) {
            (_, Some(byte)) => {
                out.push(byte);
                i += 3;
            }
            (b'+', _) => {
                out.push(b' ');
                i += 1;
            }
            _ => {
                out.push(b);
                i += 1;
            }
        }
    }
    let name: String = String::from_utf8_lossy(&out).trim().chars().take(64).collect();
    (!name.is_empty()).then_some(name)
}
