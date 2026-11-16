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
    // The status is a dot: the page around the canvas (JamSesh) says it in words, once.
    assert!(!texts.iter().any(|t| t == "Offline"), "the status is a dot, its words on hover: {texts:?}");
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

/// A session command's note ("You left the session…") isn't toasted over a canvas-only window:
/// the page around it shows the session's state. The full app keeps the toast.
#[test]
fn session_notes_are_left_to_the_page_in_canvas_only_mode() {
    for canvas_only in [true, false] {
        let mut app = app(canvas_only, true);
        app.session.message = Some("You left the session; your copy stays open here".into());
        app.run("collab.peers", json!({}));
        assert_eq!(app.ui.toast.is_some(), !canvas_only, "canvas-only {canvas_only}: {:?}", app.ui.toast.as_ref().map(|t| &t.0));
    }
    // Other commands' notes still show.
    let mut app = app(true, true);
    app.session.message = Some("Copied".into());
    app.run("view.zoomFit", json!({}));
    assert!(app.ui.toast.is_some());
}

fn panels_app(buttons: bool) -> FigApp {
    let mut app = app(true, true);
    app.ui.canvas_panels = buttons;
    app
}

/// A person's canvas keeps its panels out until asked; each command slides one in, alone.
#[test]
fn the_panel_buttons_slide_each_panel_in_alone() {
    let (ctx, mut app) = (egui::Context::default(), panels_app(true));
    let texts = frames(&mut app, &ctx, 30);
    assert!(app.ui.toast.is_none(), "no panic toast: {:?}", app.ui.toast.as_ref().map(|t| &t.0));
    assert!(!texts.iter().any(|t| t == "Layers" || t == "Design"), "both out at first: {texts:?}");
    app.run("view.canvasPanel", json!({"side": "left"}));
    let texts = frames(&mut app, &ctx, 40);
    assert!(texts.iter().any(|t| t == "Layers"), "the layers panel slid in: {texts:?}");
    assert!(!texts.iter().any(|t| t == "Design"), "the properties panel stayed out: {texts:?}");
    app.run("view.canvasPanel", json!({"side": "right"}));
    let texts = frames(&mut app, &ctx, 40);
    assert!(texts.iter().any(|t| t == "Design"), "the properties panel slid in: {texts:?}");
    app.run("view.canvasPanel", json!({"side": "left"}));
    app.run("view.canvasPanel", json!({"side": "right"}));
    let texts = frames(&mut app, &ctx, 40);
    assert!(!texts.iter().any(|t| t == "Layers" || t == "Design"), "slid out again: {texts:?}");
}

/// The big screen has no buttons, and nothing it is told (a stale preference, a command) slides a panel in.
#[test]
fn without_the_buttons_no_panel_shows() {
    let (ctx, mut app) = (egui::Context::default(), panels_app(false));
    app.session.prefs.canvas_panels = (true, true);
    app.run("view.canvasPanel", json!({"side": "left", "on": true}));
    let texts = frames(&mut app, &ctx, 40);
    assert!(!texts.iter().any(|t| t == "Layers" || t == "Design"), "{texts:?}");
}

/// Mid-slide, down to a sliver, the panel draws without a panic; and a reduced-motion person has no animation.
#[test]
fn a_panel_mid_slide_draws_and_reduced_motion_is_immediate() {
    let (ctx, mut app) = (egui::Context::default(), panels_app(true));
    frames(&mut app, &ctx, 2);
    app.run("view.canvasPanel", json!({"side": "left"}));
    app.run("view.canvasPanel", json!({"side": "right"}));
    for _ in 0..12 {
        frames(&mut app, &ctx, 1);
        assert!(app.ui.toast.is_none(), "{:?}", app.ui.toast.as_ref().map(|t| &t.0));
    }
    let (ctx, mut app) = (egui::Context::default(), panels_app(true));
    app.session.prefs.reduce_motion = true;
    frames(&mut app, &ctx, 2);
    app.run("view.canvasPanel", json!({"side": "left"}));
    let texts = frames(&mut app, &ctx, 3);
    assert!(texts.iter().any(|t| t == "Layers"), "{texts:?}");
}

/// A room canvas's properties panel has no Share button and no people bar (JamSesh's page has both);
/// the full app's keeps them.
#[test]
fn the_room_canvas_properties_panel_has_no_share_or_avatars() {
    for room in [true, false] {
        let (ctx, mut app) = (egui::Context::default(), if room { panels_app(true) } else { app(false, true) });
        app.ui.canvas_only = room;
        app.session.prefs.canvas_panels = (false, true);
        app.session.prefs.reduce_motion = true;
        app.session.prefs.user_name = "Dana".into();
        let texts = frames(&mut app, &ctx, 5);
        assert!(texts.iter().any(|t| t == "Design"), "the properties panel shows: {texts:?}");
        assert_eq!(texts.iter().any(|t| t == "Share"), !room, "room {room}: {texts:?}");
    }
}

/// Frames at `size`, `events` on the first, returning the last frame's shapes.
fn frames_at(app: &mut FigApp, ctx: &egui::Context, size: egui::Vec2, n: usize, mut events: Vec<Event>) -> Vec<egui::epaint::ClippedShape> {
    let mut shapes = Vec::new();
    for i in 0..n {
        let input = RawInput {
            screen_rect: Some(Rect::from_min_size(Pos2::ZERO, size)),
            time: Some(i as f64 / 60.0),
            events: std::mem::take(&mut events),
            ..Default::default()
        };
        let mut out = ctx.run_ui(input, |ui| app.ui(ui));
        out.textures_delta.clear();
        shapes = out.shapes;
    }
    shapes
}

fn bar(app: &FigApp) -> Rect {
    crate::toolbar::pill_rect(app.canvas.rect, crate::toolbar::bar_width(app))
}

/// A person's canvas draws the floating toolbar; the big screen's stays clean.
#[test]
fn the_toolbar_shows_on_a_persons_canvas_and_not_on_the_big_screen() {
    for panels in [true, false] {
        let (ctx, mut app) = (egui::Context::default(), panels_app(panels));
        app.session.prefs.reduce_motion = true;
        let size = vec2(1280.0, 800.0);
        frames_at(&mut app, &ctx, size, 4, vec![]);
        assert!(app.ui.toast.is_none());
        assert_eq!(crate::canvas_only::toolbar_shown(&app), panels);
        // The pill's border is a rounded rect exactly where the full editor puts it.
        let want = bar(&app);
        let shapes = frames_at(&mut app, &ctx, size, 1, vec![]);
        let near = |a: Rect| (a.min - want.min).abs().max_elem() < 0.5 && (a.max - want.max).abs().max_elem() < 0.5;
        let drawn = shapes.iter().any(|s| matches!(&s.shape, egui::epaint::Shape::Rect(r) if near(r.rect)));
        assert_eq!(drawn, panels, "toolbar drawn: {panels}");
    }
}

/// Clicking a tool button on the toolbar chooses that tool (the full editor's own command).
#[test]
fn choosing_a_tool_on_the_toolbar_sets_the_active_tool() {
    let (ctx, mut app) = (egui::Context::default(), panels_app(true));
    app.session.prefs.reduce_motion = true;
    let size = vec2(1280.0, 800.0);
    frames_at(&mut app, &ctx, size, 4, vec![]);
    assert_eq!(app.session.tool.tool, figcraft_engine::ToolId::Move);
    // The Move and Frame groups each take a button, a flyout caret and a gap; Shape is third.
    let b = bar(&app);
    let at = Pos2::new(b.min.x + 8.0 + 2.0 * (32.0 + 2.0 + 16.0 + 4.0) + 16.0, b.center().y);
    for pressed in [true, false] {
        let ev = vec![
            Event::PointerMoved(at),
            Event::PointerButton { pos: at, button: egui::PointerButton::Primary, pressed, modifiers: Default::default() },
        ];
        frames_at(&mut app, &ctx, size, 1, ev);
    }
    frames_at(&mut app, &ctx, size, 2, vec![]);
    assert_eq!(app.session.tool.tool, figcraft_engine::ToolId::Rectangle);
}

/// The shape group's flyout opens from its caret on the room canvas's toolbar, and a pick in it
/// chooses that tool.
#[test]
fn the_toolbar_flyouts_work() {
    let (ctx, mut app) = (egui::Context::default(), panels_app(true));
    app.session.prefs.reduce_motion = true;
    let size = vec2(1280.0, 800.0);
    frames_at(&mut app, &ctx, size, 4, vec![]);
    let b = bar(&app);
    let caret = Pos2::new(b.min.x + 8.0 + 2.0 * 54.0 + 32.0 + 2.0 + 8.0, b.center().y);
    for pressed in [true, false] {
        let ev = vec![
            Event::PointerMoved(caret),
            Event::PointerButton { pos: caret, button: egui::PointerButton::Primary, pressed, modifiers: Default::default() },
        ];
        frames_at(&mut app, &ctx, size, 1, ev);
    }
    let shapes = frames_at(&mut app, &ctx, size, 2, vec![]);
    assert_eq!(app.ui.tool_flyout, Some("shape"));
    let texts: Vec<String> =
        shapes.iter().filter_map(|s| if let egui::epaint::Shape::Text(t) = &s.shape { Some(t.galley.text().to_string()) } else { None }).collect();
    assert!(texts.iter().any(|t| t.contains("Ellipse")), "the flyout lists the shapes: {texts:?}");
}

/// At a phone-narrow width, whichever panels are in, the toolbar stays inside the canvas the
/// panels leave (never under one) and the zoom chip is not on it.
#[test]
fn the_toolbar_clears_the_panels_and_the_zoom_chip_at_a_narrow_width() {
    let size = vec2(420.0, 700.0);
    for (l, r) in [(false, false), (true, false), (false, true), (true, true)] {
        let (ctx, mut app) = (egui::Context::default(), panels_app(true));
        app.session.prefs.reduce_motion = true;
        app.session.prefs.canvas_panels = (l, r);
        let shapes = frames_at(&mut app, &ctx, size, 6, vec![]);
        assert!(app.ui.toast.is_none(), "{:?}", app.ui.toast.as_ref().map(|t| &t.0));
        let canvas = app.canvas.rect;
        let b = bar(&app);
        assert!(canvas.contains_rect(b), "panels {l}/{r}: pill {b:?} in canvas {canvas:?}");
        let chip = shapes.iter().find_map(|s| match &s.shape {
            egui::epaint::Shape::Text(t) if t.galley.text().ends_with('%') => Some(Rect::from_min_size(t.pos, t.galley.size())),
            _ => None,
        });
        let chip = chip.expect("the zoom chip");
        assert!(!chip.intersects(b), "panels {l}/{r}: zoom chip {chip:?} over the toolbar {b:?}");
    }
}
