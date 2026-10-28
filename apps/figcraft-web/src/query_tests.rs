//! `#join=`, `?control`, `?canvas` and `?name=` in the page's URL.

use crate::query::{canvas, control, join_link, name};

#[test]
fn join_takes_the_rest_of_the_fragment() {
    let link = "figcraft://join?host=192.168.1.20:47900&file=abc&token=AbCdEfGhIjKlMnOpQrStUv";
    assert_eq!(join_link(&format!("#join={link}")), Some(link), "a pasted link keeps its own &s");
    assert_eq!(join_link(&format!("#x=1&join={link}")), Some(link), "after other entries");
    assert_eq!(join_link("#join=figcraft%3A%2F%2Fjoin%3Fhost%3Dh"), Some("figcraft%3A%2F%2Fjoin%3Fhost%3Dh"), "escaped, decoded later");
    assert_eq!(join_link("join=K7M-2QX-9TD"), Some("K7M-2QX-9TD"), "a join code, no leading #");
}

#[test]
fn no_join_without_the_entry() {
    assert_eq!(join_link(""), None);
    assert_eq!(join_link("#"), None);
    assert_eq!(join_link("#join="), None);
    assert_eq!(join_link("#rejoin=x"), None, "only the whole entry name");
    assert_eq!(join_link("#xjoin=x&a=1"), None);
    assert_eq!(join_link("?join=x"), None, "the query isn't read: it goes to the web host");
}

#[test]
fn an_overlong_link_is_ignored() {
    let long = format!("#join=figcraft://join?host=h&file=f&token={}", "a".repeat(7000));
    assert_eq!(join_link(&long), None);
    assert_eq!(join_link(&format!("#join={}", "é".repeat(4000))), None, "length counts bytes");
}

#[test]
fn control_is_opt_in() {
    assert!(control("?control"));
    assert!(control("?webgl&control=1"), "after other entries, with a value");
    assert!(control("control"), "no leading ?");
    assert!(!control(""));
    assert!(!control("?"));
    assert!(!control("?webgl"));
    assert!(!control("?nocontrol&controls"), "only the whole entry name");
}

#[test]
fn canvas_is_opt_in_under_either_name() {
    assert!(canvas("?canvas"));
    assert!(canvas("?jamsesh"));
    assert!(canvas("?webgl&canvas=1"), "after other entries, with a value");
    assert!(canvas("jamsesh"), "no leading ?");
    assert!(!canvas(""));
    assert!(!canvas("?webgl"));
    assert!(!canvas("?canvases&notcanvas"), "only the whole entry name");
}

#[test]
fn the_name_is_unescaped_and_bounded() {
    assert_eq!(name("?name=Chey"), Some("Chey".into()));
    assert_eq!(name("?canvas&name=Chey%20R%C3%A4smussen"), Some("Chey Räsmussen".into()));
    assert_eq!(name("?name=Two+Words&canvas"), Some("Two Words".into()));
    assert_eq!(name("?name=100%"), Some("100%".into()), "a stray % stays");
    assert_eq!(name("?name=%E0%A4"), Some("\u{fffd}".into()), "bad UTF-8 is replaced, not dropped");
    assert_eq!(name("?name=%20%20"), None, "blank");
    assert_eq!(name("?name="), None);
    assert_eq!(name("?canvas"), None);
    assert_eq!(name("?username=x"), None, "only the whole entry name");
    assert_eq!(name(&format!("?name={}", "a".repeat(200))).map(|n| n.chars().count()), Some(64));
}
