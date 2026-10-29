// How the tiles the big screen already has take a driver's input (SPEC 10.6): a live build's frame gets the event posted into it
// (the dev proxy's script replays it there), and the canvas takes pan, zoom and select through FigCraft's own commands.
import { pageAt, readView, type CanvasView } from "./pointer";
import { api } from "./hub";
import type { DriveTarget, TileEvent } from "./driving";

/** The session's frame key (only the host's big screen gets one): a build's frame takes input only with it. */
let frameKey: string | null = null;
let asking: Promise<unknown> | null = null;
function withKey(): string | null {
  asking ??= api<{ key: string }>("/drive/frame-key")
    .then((r) => (frameKey = typeof r?.key === "string" ? r.key : null))
    .catch(() => (asking = null));
  return frameKey;
}

/**
 * A frame from the dev proxy: post the event in, in fractions of the frame (the page script turns them into its own pixels),
 * to the frame's exact origin and with the session's key. Events before the key arrives are dropped.
 */
export function frameDriver(iframe: HTMLIFrameElement): DriveTarget["handle"] {
  return (ev) => {
    const w = iframe.contentWindow;
    const key = withKey();
    if (!w || !key) return;
    let origin: string;
    try {
      origin = new URL(iframe.src).origin;
    } catch {
      return;
    }
    const msg = ev.k === "key" || ev.k === "leave" ? ev : { ...ev, x: ev.lx, y: ev.ly };
    try {
      w.postMessage({ jamDrive: msg, key }, origin);
    } catch {}
  };
}

const ZOOM_MIN = 0.02;
const ZOOM_MAX = 64;
/** A press that moves less than this many canvas pixels is a click, not a drag. */
const CLICK_SLOP = 4;

const figcraft = (iframe: HTMLIFrameElement) => {
  try {
    return (iframe.contentWindow as any)?.figcraft as { execute(c: string, p?: unknown): Promise<any> } | undefined;
  } catch {
    return undefined;
  }
};

/** The canvas: wheel pans, ctrl-wheel (a pinch) zooms about the cursor, a drag pans, and a click selects what is under it. */
export function canvasDriver(iframe: HTMLIFrameElement): DriveTarget["handle"] {
  let wheel = { dx: 0, dy: 0, zoom: 1, fx: 0.5, fy: 0.5 };
  let busy = false;
  let drag: { fx: number; fy: number; view: CanvasView | null; moved: boolean } | null = null;
  let dragAt: { fx: number; fy: number } | null = null;

  const pending = () => !!((drag?.view && dragAt) || wheel.dx || wheel.dy || wheel.zoom !== 1);

  // One pass at a time; input that arrives while FigCraft is answering is applied in the next pass, so a fast trackpad never queues up.
  const apply = async () => {
    if (busy) return;
    busy = true;
    try {
      for (let i = 0; i < 100 && pending(); i++) {
        const f = figcraft(iframe);
        if (!f) break;
        // A drag keeps the page point it grabbed under the cursor; a wheel moves the view by what it scrolled.
        if (drag?.view && dragAt) {
          const [v, at, was] = [drag.view, dragAt, drag];
          dragAt = null;
          await f.execute("view.set", { cx: v.cx - ((at.fx - was.fx) * v.vw) / v.zoom, cy: v.cy - ((at.fy - was.fy) * v.vh) / v.zoom });
        }
        const w = wheel;
        if (w.dx || w.dy || w.zoom !== 1) {
          wheel = { dx: 0, dy: 0, zoom: 1, fx: w.fx, fy: w.fy };
          const v = await readView(iframe);
          if (!v) continue;
          const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.zoom * w.zoom));
          const under = pageAt(v, w.fx, w.fy);
          // Zooming keeps the page point under the cursor where it was; panning moves the centre by the scrolled distance.
          const cx = w.zoom !== 1 ? under.x - ((w.fx - 0.5) * v.vw) / zoom : v.cx + w.dx / v.zoom;
          const cy = w.zoom !== 1 ? under.y - ((w.fy - 0.5) * v.vh) / zoom : v.cy + w.dy / v.zoom;
          await f.execute("view.set", { cx, cy, zoom });
        }
      }
    } catch {
    } finally {
      busy = false;
    }
  };

  return (ev: TileEvent) => {
    if (ev.k === "wheel") {
      if (ev.ctrl) wheel.zoom *= Math.exp(-Math.max(-60, Math.min(60, ev.dy)) * 0.01);
      else ((wheel.dx += ev.dx), (wheel.dy += ev.dy));
      (wheel.fx = ev.lx), (wheel.fy = ev.ly);
      void apply();
    } else if (ev.k === "down" && !ev.b) {
      drag = { fx: ev.lx, fy: ev.ly, view: null, moved: false };
      dragAt = null;
      const grabbed = drag;
      void readView(iframe).then((v) => (grabbed.view = v));
    } else if (ev.k === "move" && drag) {
      const px = Math.hypot((ev.lx - drag.fx) * iframe.clientWidth, (ev.ly - drag.fy) * iframe.clientHeight);
      if (px > CLICK_SLOP) drag.moved = true;
      if (drag.moved) {
        dragAt = { fx: ev.lx, fy: ev.ly };
        void apply();
      }
    } else if (ev.k === "up" && drag) {
      const was = drag;
      drag = dragAt = null;
      if (was.moved) return;
      // A click goes to FigCraft as a real pointer click at that page point, so it selects what a click selects (frames, groups, shift
      // aside); a second click of a double is FigCraft's own double-click.
      const kind = ev.n === 2 ? "double" : "click";
      void (async () => {
        const v = was.view ?? (await readView(iframe));
        const f = (iframe.contentWindow as any)?.figcraft as { request(m: string, p?: unknown): Promise<unknown> } | undefined;
        if (v && f) await f.request("ui.pointer", { kind, ...pageAt(v, ev.lx, ev.ly) }).catch(() => {});
      })();
    }
  };
}
