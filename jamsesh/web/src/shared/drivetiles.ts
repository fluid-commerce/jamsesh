// How the tiles the big screen already has take a driver's input (SPEC 10.6): a live build's frame gets the event posted into it
// (the dev proxy's script replays it there), and the canvas takes pan, zoom and select through FigCraft's own commands.
import { canvasHit, pageAt, readView, type CanvasView } from "./pointer";
import type { DriveTarget, TileEvent } from "./driving";

/** A frame from the dev proxy: post the event in, in fractions of the frame (the page script turns them into its own pixels). */
export function frameDriver(iframe: HTMLIFrameElement): DriveTarget["handle"] {
  return (ev) => {
    const w = iframe.contentWindow;
    if (!w) return;
    let origin = "*";
    try {
      origin = new URL(iframe.src).origin;
    } catch {}
    const msg = ev.k === "key" || ev.k === "leave" ? ev : { ...ev, x: ev.lx, y: ev.ly };
    try {
      w.postMessage({ jamDrive: msg }, origin);
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

  const apply = async () => {
    if (busy) return;
    busy = true;
    try {
      const f = figcraft(iframe);
      // A drag asks for the page point it grabbed to stay under the cursor; a wheel moves the view by what it scrolled.
      if (drag?.view && dragAt && f) {
        const v = drag.view;
        const [at, was] = [dragAt, drag];
        await f.execute("view.set", { cx: v.cx - ((at.fx - was.fx) * v.vw) / v.zoom, cy: v.cy - ((at.fy - was.fy) * v.vh) / v.zoom });
      }
      const w = wheel;
      if ((w.dx || w.dy || w.zoom !== 1) && f) {
        wheel = { dx: 0, dy: 0, zoom: 1, fx: w.fx, fy: w.fy };
        const v = await readView(iframe);
        if (v) {
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
    if (wheel.dx || wheel.dy || wheel.zoom !== 1 || (drag?.moved && dragAt)) void apply();
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
      // A click: select the frame or layer under the cursor (nothing under it clears the selection).
      void canvasHit(iframe, ev.lx, ev.ly, was.view).then((hit) => {
        const f = figcraft(iframe);
        if (!f) return;
        const ids = hit?.nodeId ? [Number.isFinite(Number(hit.nodeId)) ? Number(hit.nodeId) : hit.nodeId] : [];
        void (ids.length ? f.execute("select.set", { ids }) : f.execute("select.none", {})).catch(() => {});
      });
    }
  };
}
