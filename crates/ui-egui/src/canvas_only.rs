//! Canvas-only mode (`UiState::canvas_only`): the window is just the live canvas. These are the
//! two things it adds over the canvas itself: a presence pill (who is here, and whether the
//! session is up) at the top right, a zoom chip at the bottom right, and the placeholder shown
//! while no file has opened yet (a join still connecting).

use egui::{Align2, Color32, CornerRadius, Rect, Sense, Stroke, StrokeKind, pos2, vec2};
use figcraft_engine::live::Status;
use serde_json::json;

use crate::FigApp;
use crate::a11y::Tip;
use crate::i18n::{tr, trf};
use crate::live::{avatar, color, failure_text};
use crate::theme::{Tokens, regular, semibold};

const R: f32 = 13.0;
const STEP: f32 = 22.0;
const PAD: f32 = 5.0;
const MARGIN: f32 = 12.0;
/// The most avatars drawn before the rest collapse into a "+n".
const MAX_SHOWN: usize = 8;

/// A pill-shaped backdrop in the panel colours, so the overlay reads on any canvas.
fn pill(painter: &egui::Painter, r: Rect, t: &Tokens) {
    let radius = CornerRadius::same((r.height() / 2.0).round() as u8);
    painter.rect_filled(r.translate(vec2(0.0, 1.0)), radius, t.shadow);
    painter.rect_filled(r, radius, t.panel);
    painter.rect_stroke(r, radius, Stroke::new(1.0, t.border), StrokeKind::Inside);
}

/// The status of the connection as a dot colour and a label (nothing while the session is up).
fn status_note(status: &Status, t: &Tokens) -> Option<(Color32, String)> {
    match status {
        Status::Live => None,
        Status::Connecting => Some((t.warning, tr("Connecting…").to_string())),
        Status::Reconnecting { .. } => Some((t.warning, tr("Reconnecting…").to_string())),
        Status::Failed { .. } | Status::Off => Some((t.danger, tr("Offline").to_string())),
    }
}

/// The presence pill (top right) and zoom chip (bottom right) over `canvas`.
pub fn overlay(app: &mut FigApp, ctx: &egui::Context, canvas: Rect, zoom: Option<f64>) {
    presence(app, ctx, canvas);
    if let Some(z) = zoom {
        zoom_chip(app, ctx, canvas, z);
    }
}

fn presence(app: &mut FigApp, ctx: &egui::Context, canvas: Rect) {
    let t = Tokens::get(ctx);
    let live = app.session.live();
    let me_name = match live.info.as_ref() {
        Some(i) if !i.name.is_empty() => i.name.clone(),
        _ => app.session.prefs.user_name.clone(),
    };
    let me_fill = live.info.as_ref().map_or(t.accent, |i| color(&i.color));
    let peers: Vec<(u32, String, Color32)> = live.peers.values().map(|p| (p.client_id, p.name.clone(), color(&p.color))).collect();
    let follow = live.follow;
    let note = status_note(&live.status, &t);
    if matches!(live.status, Status::Connecting | Status::Reconnecting { .. }) {
        ctx.request_repaint_after(std::time::Duration::from_millis(50));
    }
    let shown = peers.len().min(MAX_SHOWN);
    let more = peers.len() - shown;
    // Left to right: the status, then you, then everyone else.
    let note_galley = note.as_ref().map(|(_, text)| ctx.fonts_mut(|f| f.layout_no_wrap(text.clone(), regular(12.0), t.text_secondary)));
    let note_w = note_galley.as_ref().map_or(0.0, |g| g.size().x + 22.0);
    let count = 1 + shown + usize::from(more > 0);
    let width = PAD * 2.0 + note_w + 2.0 * R + (count - 1) as f32 * STEP;
    let size = vec2(width, 2.0 * R + 2.0 * PAD);
    let rect = Rect::from_min_size(pos2(canvas.max.x - MARGIN - size.x, canvas.min.y + MARGIN), size);
    let mut clicked = None;
    egui::Area::new(egui::Id::unique("canvas_only_presence")).order(egui::Order::Foreground).fixed_pos(rect.min).show(ctx, |ui| {
        ui.set_clip_rect(rect.expand(4.0));
        let painter = ui.painter();
        pill(painter, rect, &t);
        let cy = rect.center().y;
        let mut x = rect.min.x + PAD;
        if let (Some((dot, _)), Some(galley)) = (&note, note_galley) {
            let pulse = if app.reduce_motion() { 1.0 } else { 0.55 + 0.45 * (ctx.input(|i| i.time) * 4.0).sin().abs() as f32 };
            painter.circle_filled(pos2(x + 9.0, cy), 3.5, dot.gamma_multiply(pulse));
            painter.galley(pos2(x + 18.0, cy - galley.size().y / 2.0), galley.clone(), t.text_secondary);
            x += note_w;
        }
        let mut c = pos2(x + R, cy);
        let me = ui.interact(Rect::from_center_size(c, vec2(2.0 * R, 2.0 * R)), ui.scope_id().with("me"), Sense::hover());
        avatar(ui.painter(), c, R, &me_name, me_fill);
        me.tip(trf("{name} (you)", &[("name", &me_name)]));
        for (id, name, fill) in peers.iter().take(shown) {
            c.x += STEP;
            let resp = ui.interact(Rect::from_center_size(c, vec2(2.0 * R, 2.0 * R)), ui.scope_id().with(("peer", id)), Sense::click());
            ui.painter().circle_stroke(c, R + 1.0, Stroke::new(2.0, t.panel));
            avatar(ui.painter(), c, R, name, *fill);
            let following = follow == Some(*id);
            if following || resp.hovered() {
                ui.painter().circle_stroke(c, R + 2.0, Stroke::new(2.0, *fill));
            }
            let tip = if following { trf("Stop following {name}", &[("name", name)]) } else { trf("Follow {name}", &[("name", name)]) };
            if resp.tip(tip).clicked() {
                clicked = Some(*id);
            }
        }
        if more > 0 {
            c.x += STEP;
            ui.painter().circle_stroke(c, R + 1.0, Stroke::new(2.0, t.panel));
            ui.painter().circle_filled(c, R, t.pressed);
            ui.painter().text(c, Align2::CENTER_CENTER, format!("+{more}"), semibold(11.0), t.text);
        }
    });
    if let Some(id) = clicked {
        let params = if follow == Some(id) { json!({}) } else { json!({"client": id}) };
        app.run("collab.follow", params);
    }
}

/// The zoom as a chip at the bottom right; a click fits the page's content in the window.
fn zoom_chip(app: &mut FigApp, ctx: &egui::Context, canvas: Rect, zoom: f64) {
    let t = Tokens::get(ctx);
    let text = format!("{}%", (zoom * 100.0).round());
    let galley = ctx.fonts_mut(|f| f.layout_no_wrap(text, semibold(12.0), t.text_secondary));
    let size = vec2(galley.size().x + 24.0, 28.0);
    let rect = Rect::from_min_size(pos2(canvas.max.x - MARGIN - size.x, canvas.max.y - MARGIN - size.y), size);
    let mut fit = false;
    egui::Area::new(egui::Id::unique("canvas_only_zoom")).order(egui::Order::Foreground).fixed_pos(rect.min).show(ctx, |ui| {
        let resp = ui.interact(rect, ui.scope_id().with("chip"), Sense::click()).tip(tr("Zoom to fit"));
        pill(ui.painter(), rect, &t);
        if resp.hovered() {
            ui.painter().rect_filled(rect, CornerRadius::same(14), t.hover);
        }
        ui.painter().galley(rect.center() - galley.size() / 2.0, galley, if resp.hovered() { t.text } else { t.text_secondary });
        fit = resp.clicked();
    });
    if fit {
        app.run("view.zoomFit", json!({}));
    }
}

/// What the window shows with no file open: the empty canvas, saying that a session is coming.
pub fn empty(app: &mut FigApp, ui: &mut egui::Ui) {
    let t = Tokens::get(ui.ctx());
    egui::CentralPanel::default().frame(egui::Frame::NONE.fill(t.canvas)).show(ui, |ui| {
        let rect = ui.max_rect();
        let status = app.session.live().status.clone();
        let text = match &status {
            Status::Failed { reason } => failure_text(reason).to_string(),
            Status::Off => tr("Waiting for a session…").to_string(),
            Status::Reconnecting { .. } => tr("Reconnecting to the session…").to_string(),
            _ => tr("Connecting to the session…").to_string(),
        };
        let fill = if matches!(status, Status::Failed { .. }) { t.danger } else { t.text_secondary };
        ui.painter().text(rect.center(), Align2::CENTER_CENTER, text, regular(14.0), fill);
        if matches!(status, Status::Connecting | Status::Reconnecting { .. }) {
            ui.ctx().request_repaint_after(std::time::Duration::from_millis(250));
        }
        let ctx = ui.ctx().clone();
        presence(app, &ctx, rect);
    });
}
