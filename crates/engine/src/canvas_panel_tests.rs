//! `view.canvasPanel`: the room canvas's layers and properties panels, each slid in or out alone.

use serde_json::json;

use crate::Session;

#[test]
fn each_side_toggles_alone_and_both_start_out() {
    let mut s = Session::new();
    assert_eq!(s.prefs.canvas_panels, (false, false));
    let r = s.execute("view.canvasPanel", &json!({"side": "left"})).unwrap();
    assert_eq!((r["left"].as_bool(), r["right"].as_bool()), (Some(true), Some(false)));
    s.execute("view.canvasPanel", &json!({"side": "right", "on": true})).unwrap();
    assert_eq!(s.prefs.canvas_panels, (true, true));
    s.execute("view.canvasPanel", &json!({"side": "left", "on": false})).unwrap();
    s.execute("view.canvasPanel", &json!({"side": "right"})).unwrap();
    assert_eq!(s.prefs.canvas_panels, (false, false));
}

#[test]
fn a_side_that_is_not_one_is_refused_and_changes_nothing() {
    let mut s = Session::new();
    for p in [json!({}), json!({"side": "top"}), json!({"side": 3}), json!({"side": null, "on": true}), json!(null)] {
        assert!(s.execute("view.canvasPanel", &p).is_err(), "{p}");
    }
    assert_eq!(s.prefs.canvas_panels, (false, false));
}

#[test]
fn the_choice_survives_the_prefs_file() {
    let mut s = Session::new();
    s.execute("view.canvasPanel", &json!({"side": "right"})).unwrap();
    let saved = serde_json::to_string(&s.prefs).unwrap();
    let back: crate::Prefs = serde_json::from_str(&saved).unwrap();
    assert_eq!(back.canvas_panels, (false, true));
    let old: crate::Prefs = serde_json::from_str("{}").unwrap();
    assert_eq!(old.canvas_panels, (false, false), "prefs saved before this existed");
}
