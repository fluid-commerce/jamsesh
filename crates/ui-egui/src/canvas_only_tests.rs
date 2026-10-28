//! Canvas-only mode: no chrome, and the overlay and placeholder draw without a panic.

use egui::{Event, Pos2, RawInput, Rect, ViewportId, vec2};
use figcraft_engine::Session;
use serde_json::json;

use crate::{FigApp, NoServices};

fn frames(app: &mut FigApp, ctx: &egui::Context, n: usize) -> Vec<String> {
    let mut texts = Vec::new();
    for i in 0..n {
        let input = RawInput {
            screen_rect: Some(Rect::from_min_size(Pos2::ZERO, vec2(1280.0, 800.0))),
            time: Some(i as f64 / 60.0),
            events: Vec::<Event>::new(),
            ..Default::default()
        };
        let mut out = ctx.run_ui(input, |ui| app.ui(ui));
        out.textures_delta.clear();
        texts = out
            .shapes
            .iter()
            .filter_map(|s| if let egui::epaint::Shape::Text(t) = &s.shape { Some(t.galley.text().to_string()) } else { None })
            .collect();
        let _ = ViewportId::ROOT;
    }
    texts
}

fn app(canvas_only: bool, file: bool) -> FigApp {
    let mut s = if file { Session::new() } else { Session::empty() };
    if file {
        s.execute("file.new", &json!({})).expect("a new file");
    }
    let mut app = FigApp::new(s, Box::new(NoServices));
    app.ui.home = false;
    app.ui.canvas_only = canvas_only;
    app
}

#[test]
fn a_file_shows_the_presence_pill_and_zoom_chip_and_no_chrome() {
    let (ctx, mut app) = (egui::Context::default(), app(true, true));
    let texts = frames(&mut app, &ctx, 4);
    assert!(app.ui.toast.is_none(), "no panic toast: {:?}", app.ui.toast.as_ref().map(|t| &t.0));
    assert!(texts.iter().any(|t| t.ends_with('%')), "the zoom chip: {texts:?}");
    assert!(texts.iter().any(|t| t == "Offline"), "the status: {texts:?}");
    for chrome in ["Layers", "Pages", "Share", "Design"] {
        assert!(!texts.iter().any(|t| t == chrome), "{chrome} is chrome: {texts:?}");
    }
}

#[test]
fn without_a_file_it_is_a_placeholder_never_home() {
    let (ctx, mut app) = (egui::Context::default(), app(true, false));
    app.ui.home = true;
    let texts = frames(&mut app, &ctx, 4);
    assert!(app.ui.toast.is_none(), "no panic toast");
    assert!(!app.ui.home, "home is switched off");
    assert!(texts.iter().any(|t| t.contains("session")), "the placeholder: {texts:?}");
}
