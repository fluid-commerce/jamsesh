// Pointer capture for "record a prompt", after CursorCap's model (spec/motion-distillation.md):
// raw samples while recording, distilled afterwards into dwell / click / drag marks, each tied to the
// tile (data-jam-target) it landed on. Works across the document and every same-origin iframe (frames
// from another origin get a capture overlay from their tile while recording), and
// for canvas tiles turns an iframe pixel into a FigCraft page point plus the top-level frame under it.
import { hub } from "./hub";

export type JamTargetKind = "canvas" | "artifact" | "web" | "screen";

export interface JamTarget {
  kind: JamTargetKind;
  ref: string;
  label: string;
  nodeId?: string | null;
  canvasX?: number | null;
  canvasY?: number | null;
  /** The page of the build or canvas the pointer was on. */
  page?: string | null;
}

/** What the hub's /api/prompt-window takes. */
export interface PointerMark {
  t: number;
  kind: "dwell" | "click" | "drag";
  x: number;
  y: number;
  dur?: number;
  target: JamTarget;
  /** How far the page or viewer was scrolled at that moment. */
  scroll?: { x: number; y: number } | null;
}

// ---------- targets ----------

/** The tile root for an element, climbing out of same-origin iframes too. */
export function targetRoot(el: Element | null): HTMLElement | null {
  let cur: Element | null = el;
  for (let hops = 0; cur && hops < 6; hops++) {
    const root = cur.closest?.("[data-jam-target]") as HTMLElement | null;
    if (root) return root;
    let frame: Element | null = null;
    try {
      frame = cur.ownerDocument.defaultView?.frameElement ?? null;
    } catch {}
    cur = frame;
  }
  return null;
}

export function readTarget(root: Element | null): JamTarget | null {
  const raw = root?.getAttribute("data-jam-target");
  if (!raw) return null;
  try {
    const t = JSON.parse(raw);
    if (!t?.kind) return null;
    return { kind: t.kind, ref: String(t.ref ?? ""), label: String(t.label ?? t.ref ?? t.kind) };
  } catch {
    return null;
  }
}

// ---------- FigCraft canvas ----------

interface FigcraftApi {
  request(method: string, params?: unknown): Promise<any>;
  execute(command: string, params?: unknown): Promise<any>;
}

export interface CanvasView {
  cx: number;
  cy: number;
  zoom: number;
  vw: number;
  vh: number;
  /** FigCraft is drawing its own comment bubbles */
  comments?: boolean;
}

export function canvasIframe(root: Element | null): HTMLIFrameElement | null {
  return (root?.querySelector("iframe") as HTMLIFrameElement | null) ?? null;
}

function figcraftOf(iframe: HTMLIFrameElement | null): FigcraftApi | null {
  try {
    return ((iframe?.contentWindow as any)?.figcraft as FigcraftApi | undefined) ?? null;
  } catch {
    return null;
  }
}

const within = <T,>(p: Promise<T>, ms = 1500) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

/** The view FigCraft is drawing: page point at the center, zoom, and the canvas size in its own points. */
export async function readView(iframe: HTMLIFrameElement | null): Promise<CanvasView | null> {
  const f = figcraftOf(iframe);
  if (!f) return null;
  try {
    const v = await within(f.execute("view.get", {}), 900);
    if (typeof v?.zoom !== "number" || !v.vw || !v.vh) return null;
    return { cx: v.cx, cy: v.cy, zoom: v.zoom, vw: v.vw, vh: v.vh, comments: v.comments };
  } catch {
    return null;
  }
}

/**
 * Iframe fraction (0..1 across the iframe) to a FigCraft page point. FigCraft draws the whole iframe as
 * its canvas (`?canvas` mode), with the view's center at the middle and `zoom` page units per canvas
 * point (`vw` x `vh` points fill the iframe). Fractions, not pixels, so devicePixelRatio, CSS scaling
 * of the tile and the app's UI scale all cancel out.
 */
export function pageAt(v: CanvasView, fx: number, fy: number) {
  return { x: v.cx + ((fx - 0.5) * v.vw) / v.zoom, y: v.cy + ((fy - 0.5) * v.vh) / v.zoom };
}

/** The inverse: where a page point sits as a 0..1 fraction of the iframe. */
export function fractionOf(v: CanvasView, px: number, py: number) {
  return { fx: ((px - v.cx) * v.zoom) / v.vw + 0.5, fy: ((py - v.cy) * v.zoom) / v.vh + 0.5 };
}

export interface CanvasHit {
  canvasX: number;
  canvasY: number;
  nodeId: string | null;
  label: string | null;
}

/** Page point and top-level frame under a point given as iframe fractions. */
export async function canvasHit(iframe: HTMLIFrameElement | null, fx: number, fy: number, view?: CanvasView | null): Promise<CanvasHit | null> {
  const v = view ?? (await readView(iframe));
  if (!v) return null;
  const p = pageAt(v, fx, fy);
  const hit: CanvasHit = { canvasX: Math.round(p.x * 10) / 10, canvasY: Math.round(p.y * 10) / 10, nodeId: null, label: null };
  try {
    const r = await within(figcraftOf(iframe)!.execute("select.layersAt", { x: p.x, y: p.y }));
    const layers: { depth: number; id: number | string; name: string }[] = r?.layers ?? [];
    const top = layers.find((l) => l.depth === 0) ?? layers[layers.length - 1];
    if (top) {
      hit.nodeId = String(top.id);
      hit.label = top.name || null;
    }
  } catch {}
  return hit;
}

/** Hide FigCraft's own comment bubbles in this iframe (JamSesh pins stand in for them). */
export async function hideNativeComments(iframe: HTMLIFrameElement | null) {
  try {
    await within(figcraftOf(iframe)!.execute("view.comments", { on: false }), 900);
  } catch {}
}

/** Viewport point to fractions of an iframe's box. */
export function iframeFraction(iframe: HTMLIFrameElement, vx: number, vy: number) {
  const r = iframe.getBoundingClientRect();
  return { fx: (vx - r.left) / Math.max(1, r.width), fy: (vy - r.top) / Math.max(1, r.height) };
}

// ---------- recording state ----------

let recordingNow = false;
const recordingSubs = new Set<() => void>();
/** True while a PointerRecorder is running; tiles use it to lay a capture overlay over frames. */
export const pointerRecording = {
  get: () => recordingNow,
  sub: (f: () => void) => (recordingSubs.add(f), () => void recordingSubs.delete(f)),
};
function setRecording(v: boolean) {
  if (recordingNow === v) return;
  recordingNow = v;
  recordingSubs.forEach((f) => f());
}

/** Whether a frame's document can't be reached from here (another origin, or a sandbox). */
export function isOpaqueFrame(f: HTMLIFrameElement | null) {
  try {
    return !f?.contentDocument;
  } catch {
    return true;
  }
}

/**
 * The box a mark's 0..1 position is measured in: the tile's pin layer when it has one (the same box
 * the pins are placed in, so a pointed-at spot lands where a pin dropped there would), else the tile.
 */
function frameBox(root: HTMLElement) {
  return root.querySelector<HTMLElement>(".an-layer, [data-jam-box]") ?? root;
}

/** Where a pointed-at element's page was scrolled to, and which page of a build it was (same-origin frames only). */
function contextOf(root: HTMLElement | null, el: Element | null): { scroll: { x: number; y: number } | null; page: string | null } {
  let scroll: { x: number; y: number } | null = null;
  let page: string | null = null;
  try {
    for (let cur: Element | null = el; cur && cur !== root?.parentElement; cur = cur.parentElement) {
      if (cur.scrollTop || cur.scrollLeft) {
        scroll = { x: Math.round(cur.scrollLeft), y: Math.round(cur.scrollTop) };
        break;
      }
    }
    const win = el?.ownerDocument.defaultView;
    if (win && win !== window) {
      if (!scroll && (win.scrollX || win.scrollY)) scroll = { x: Math.round(win.scrollX), y: Math.round(win.scrollY) };
      page = `${win.location.pathname}${win.location.search}`.slice(0, 200) || null;
    }
  } catch {}
  return { scroll, page };
}

/** One position of a driver's dart on the big screen, with what is under it. */
export interface DartPoint {
  t: number;
  down: boolean;
  /** What the dart is over, and where inside it (0..1). */
  target: JamTarget | null;
  x: number;
  y: number;
}

// ---------- recorder ----------

type Ev = { t: number; x: number; y: number; type: "move" | "down" | "up" | "leave"; el: Element | null; ctx?: { scroll: { x: number; y: number } | null; page: string | null }; fixed?: { target: JamTarget; x: number; y: number } };
export type TrailSample = { t: number; x: number; y: number; down: boolean };

const RADIUS = 6; // px a point may wander and still count as held
const MIN_DWELL = 300; // ms
const MAX_MARKS = 40;

export class PointerRecorder {
  private events: Ev[] = [];
  private attached = new WeakSet<Document>();
  private offs: (() => void)[] = [];
  private timers: ReturnType<typeof setInterval>[] = [];
  private views = new Map<HTMLIFrameElement, { t: number; view: CanvasView }[]>();
  private down = false;
  private ctx: Ev["ctx"] | null = null;
  private ctxAt = 0;
  private t0 = 0;
  running = false;
  /** Live samples for the on-screen trail. */
  onSample: ((s: TrailSample) => void) | null = null;

  /** `dom: false` records a driver's dart on the big screen (fed with `feedDart`) instead of this window's own pointer. */
  start(opts: { dom?: boolean } = {}) {
    this.events = [];
    this.views.clear();
    this.t0 = hub.now();
    this.running = true;
    setRecording(true);
    if (opts.dom === false) return;
    this.attach(document, null);
    this.scanFrames();
    this.timers.push(setInterval(() => this.scanFrames(), 400));
    this.timers.push(setInterval(() => void this.pollViews(), 250));
    void this.pollViews();
  }

  /** A dart position from the big screen (6.1). Samples with nothing under them still move the trail but make no marks. */
  feedDart(d: DartPoint) {
    if (!this.running) return;
    const type: Ev["type"] = d.down && !this.down ? "down" : !d.down && this.down ? "up" : "move";
    this.down = d.down;
    this.events.push({ t: d.t, x: d.x, y: d.y, type, el: null, ...(d.target ? { fixed: { target: d.target, x: d.x, y: d.y } } : {}) });
  }

  private scanFrames() {
    for (const f of Array.from(document.querySelectorAll("iframe"))) {
      try {
        const doc = f.contentDocument;
        if (doc && !this.attached.has(doc)) this.attach(doc, f);
      } catch {
        // cross-origin: the pointer is invisible inside; tiles lay a capture overlay over it while recording
      }
    }
  }

  /** Remember FigCraft's view (center, zoom) over time so marks can be placed in canvas space. */
  private async pollViews() {
    const roots = Array.from(document.querySelectorAll<HTMLElement>("[data-jam-target]")).filter((r) => readTarget(r)?.kind === "canvas");
    for (const r of roots) {
      const f = canvasIframe(r);
      if (!f) continue;
      const v = await readView(f);
      if (!v) continue;
      const list = this.views.get(f) ?? [];
      list.push({ t: hub.now(), view: v });
      this.views.set(f, list);
    }
  }

  private viewAt(f: HTMLIFrameElement, t: number): CanvasView | null {
    const list = this.views.get(f);
    if (!list?.length) return null;
    let best = list[0];
    for (const s of list) if (s.t <= t + 120) best = s;
    return best.view;
  }

  private attach(doc: Document, frame: HTMLIFrameElement | null) {
    this.attached.add(doc);
    const win = doc.defaultView;
    if (!win) return;
    const toViewport = (e: PointerEvent) => {
      if (!frame) return { x: e.clientX, y: e.clientY };
      const r = frame.getBoundingClientRect();
      const sx = r.width / Math.max(1, frame.clientWidth);
      const sy = r.height / Math.max(1, frame.clientHeight);
      return { x: r.left + e.clientX * sx, y: r.top + e.clientY * sy };
    };
    const push = (type: Ev["type"]) => (e: Event) => {
      if (!this.running) return;
      const pe = e as PointerEvent;
      if (type !== "leave" && pe.isPrimary === false) return;
      if ((type === "down" || type === "up") && pe.button !== 0) return;
      const p = type === "leave" ? { x: 0, y: 0 } : toViewport(pe);
      const t = hub.now();
      const el = type === "leave" ? null : (pe.target as Element);
      // Scroll and page are read as the pointer acts, not at the end, when the viewer may be gone; moves share a reading for a moment.
      if (el && (type === "down" || t - this.ctxAt > 250)) {
        this.ctxAt = t;
        this.ctx = contextOf(targetRoot(el), el);
      }
      this.events.push({ t, x: p.x, y: p.y, type, el, ...(el && this.ctx ? { ctx: this.ctx } : {}) });
      if (type === "down") this.down = true;
      if (type === "up" || type === "leave") this.down = false;
      if (type !== "leave") this.onSample?.({ t, x: p.x, y: p.y, down: this.down });
    };
    const opts = { capture: true, passive: true } as const;
    const bindings: [string, (e: Event) => void][] = [
      ["pointermove", push("move")],
      ["pointerdown", push("down")],
      ["pointerup", push("up")],
      ["pointercancel", push("up")],
      ["mouseleave", push("leave")],
    ];
    for (const [name, fn] of bindings) {
      const target: EventTarget = name === "mouseleave" ? doc.documentElement : win;
      target.addEventListener(name, fn, opts);
      this.offs.push(() => target.removeEventListener(name, fn, opts));
    }
  }

  /** Stops, distills, and resolves each mark's target (and the canvas frame under it). */
  async stop(): Promise<PointerMark[]> {
    this.running = false;
    setRecording(false);
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const off of this.offs) off();
    this.offs = [];
    this.attached = new WeakSet();
    const t1 = hub.now();
    const events = this.events;
    this.events = [];
    this.onSample = null;
    return this.distill(events, t1);
  }

  private async distill(events: Ev[], t1: number): Promise<PointerMark[]> {
    type Raw = { t: number; kind: PointerMark["kind"]; x: number; y: number; dur?: number; el: Element | null; score: number; downT?: number; ctx?: Ev["ctx"]; fixed?: Ev["fixed"] };
    const raw: Raw[] = [];
    const inDrag: [number, number][] = [];
    const clickSpans: { t0: number; t1: number; x: number; y: number }[] = [];

    // 1. Pair down/up. Movement beyond RADIUS between them promotes the pair to a drag.
    for (let i = 0; i < events.length; i++) {
      const d = events[i];
      if (d.type !== "down") continue;
      let j = i + 1;
      let moved = false;
      let minX = d.x, maxX = d.x, minY = d.y, maxY = d.y;
      while (j < events.length && events[j].type !== "up" && events[j].type !== "down") {
        const e = events[j];
        if (e.type === "move") {
          if (Math.abs(e.x - d.x) > RADIUS || Math.abs(e.y - d.y) > RADIUS) moved = true;
          minX = Math.min(minX, e.x); maxX = Math.max(maxX, e.x); minY = Math.min(minY, e.y); maxY = Math.max(maxY, e.y);
        }
        j++;
      }
      const u = events[j]?.type === "up" ? events[j] : null;
      if (u && (Math.abs(u.x - d.x) > RADIUS || Math.abs(u.y - d.y) > RADIUS)) moved = true;
      const end = u?.t ?? t1;
      if (moved) {
        inDrag.push([d.t, end]);
        raw.push({ t: d.t, kind: "drag", x: (minX + maxX) / 2, y: (minY + maxY) / 2, dur: end - d.t, el: d.el, score: 80, ctx: d.ctx, fixed: d.fixed });
      } else {
        clickSpans.push({ t0: d.t, t1: end, x: d.x, y: d.y });
        raw.push({ t: d.t, kind: "click", x: d.x, y: d.y, el: d.el, score: 100, ctx: d.ctx, fixed: d.fixed });
      }
      i = j;
    }

    // 2. Dwells: a point anchored within RADIUS for at least MIN_DWELL, outside drags.
    const seq = events.filter((e) => !inDrag.some(([a, b]) => e.t >= a && e.t <= b));
    for (let k = 0; k < seq.length; ) {
      if (seq[k].type === "leave") { k++; continue; }
      let j = k;
      while (j + 1 < seq.length && seq[j + 1].type !== "leave" && Math.abs(seq[j + 1].x - seq[k].x) <= RADIUS && Math.abs(seq[j + 1].y - seq[k].y) <= RADIUS) j++;
      const end = j + 1 < seq.length ? seq[j + 1].t : t1;
      const dur = Math.min(end - seq[k].t, 8000);
      const span = seq.slice(k, j + 1);
      const absorbed = clickSpans.some((c) => c.t0 >= seq[k].t - 20 && c.t0 <= end + 20 && Math.abs(c.x - seq[k].x) <= RADIUS * 2 && Math.abs(c.y - seq[k].y) <= RADIUS * 2);
      if (dur >= MIN_DWELL && !absorbed) {
        const mx = span.reduce((a, s) => a + s.x, 0) / span.length;
        const my = span.reduce((a, s) => a + s.y, 0) / span.length;
        const mid = span[Math.floor(span.length / 2)];
        raw.push({ t: seq[k].t, kind: "dwell", x: mx, y: my, dur, el: mid.el, score: 3 + dur / 100, ctx: mid.ctx, fixed: mid.fixed });
      }
      k = j + 1;
    }

    // 3. Tie each to its tile, drop what landed outside any, keep the most meaningful.
    const resolved: { raw: Raw; root: HTMLElement | null; target: JamTarget }[] = [];
    for (const r of raw) {
      if (r.fixed) {
        resolved.push({ raw: r, root: null, target: r.fixed.target });
        continue;
      }
      const root = targetRoot(r.el);
      const target = readTarget(root);
      if (root && target) resolved.push({ raw: r, root, target });
    }
    resolved.sort((a, b) => b.raw.score - a.raw.score);
    const kept = resolved.slice(0, MAX_MARKS).sort((a, b) => a.raw.t - b.raw.t);

    return Promise.all(
      kept.map(async ({ raw: r, root, target }): Promise<PointerMark> => {
        const t: JamTarget = { ...target };
        // A dart's position is already inside the item it is over.
        if (!root) {
          const mark: PointerMark = { t: Math.round(r.t), kind: r.kind, x: round3(clamp01(r.fixed!.x)), y: round3(clamp01(r.fixed!.y)), target: t };
          if (r.dur) mark.dur = Math.round(r.dur);
          return mark;
        }
        const box = frameBox(root).getBoundingClientRect();
        const x = clamp01((r.x - box.left) / Math.max(1, box.width));
        const y = clamp01((r.y - box.top) / Math.max(1, box.height));
        if (r.ctx?.page && !t.page) t.page = r.ctx.page;
        if (target.kind === "canvas") {
          const f = canvasIframe(root);
          if (f) {
            const { fx, fy } = iframeFraction(f, r.x, r.y);
            const hit = await canvasHit(f, clamp01(fx), clamp01(fy), this.viewAt(f, r.t));
            if (hit) {
              t.canvasX = hit.canvasX;
              t.canvasY = hit.canvasY;
              t.nodeId = hit.nodeId;
              if (hit.label) t.label = hit.label;
            }
          }
        }
        const mark: PointerMark = { t: Math.round(r.t), kind: r.kind, x: round3(x), y: round3(y), target: t };
        if (r.dur) mark.dur = Math.round(r.dur);
        if (r.ctx?.scroll) mark.scroll = r.ctx.scroll;
        return mark;
      }),
    );
  }
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const round3 = (n: number) => Math.round(n * 1000) / 1000;
