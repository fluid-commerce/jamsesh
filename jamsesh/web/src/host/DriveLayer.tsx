// The cursors of whoever is driving a screen (SPEC 10.6), drawn once per person above every tile, and on the big screen
// the input they send replayed into the tile under each one. The dart and its name tag are FigCraft's own collaborator
// pointer (crates/ui-egui/src/live.rs: `pointer`, `name_tag`, `text_on`) drawn again here as SVG, and it glides the same way.
import { useEffect, useRef, useState } from "react";
import { driveScale, emitGlide, onCursor, targetAt, useDriverState, type DriveCursor, type DriveTarget, type Glide } from "../shared/driving";

/** live.rs GLIDE: the shown position covers 1 - exp(-dt * GLIDE) of the way to the reported one each frame. */
const GLIDE = 20;
/** Within this many pixels the cursor is there (live.rs: half a pixel). */
const SNAP = 0.5;
/** A cursor nobody has moved for this long fades out. */
const IDLE_MS = 8000;

/** live.rs `text_on`: black on a light fill, white otherwise. */
export function textOn(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "#fff";
  const n = parseInt(m[1], 16);
  const l = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return l > 170 ? "#1e1e1e" : "#fff";
}

/** live.rs `pointer`: tip, left, notch, right. */
const DART = "0,0 3.5,15.5 7.5,8.5 15.5,4";

/** One step of the glide: where a shown value `from` ends up after `dt` seconds on its way to `to` (jumping with Reduce Motion). */
export function glide(from: number, to: number, dt: number, reduce: boolean): number {
  return reduce ? to : from + (to - from) * (1 - Math.exp(-Math.min(Math.max(dt, 0), 0.1) * GLIDE));
}

interface Shown {
  name: string;
  color: string;
  /** Where it was last told to be (fractions). */
  x: number;
  y: number;
  /** Where it is drawn (px). */
  sx: number;
  sy: number;
  fresh: boolean;
  down: boolean;
  seen: number;
  hidden: boolean;
}

interface Replay {
  hover?: DriveTarget | null;
  down?: DriveTarget | null;
}

/** Tells the tiles a driver was over or pressing that they've gone: each lets go of any button or key it was holding for them. */
function letGo(st: Replay | undefined, personId: string) {
  for (const t of new Set([st?.down, st?.hover])) t?.handle({ k: "leave" }, personId);
  if (st) st.down = st.hover = null;
}

export function DriveLayer({ screen, replay }: { screen: string; replay?: boolean }) {
  const layer = useRef<HTMLDivElement>(null);
  const els = useRef(new Map<string, HTMLDivElement>());
  const shown = useRef(new Map<string, Shown>());
  const replays = useRef(new Map<string, Replay>());
  const raf = useRef(0);
  const [people, setPeople] = useState<{ id: string; name: string; color: string }[]>([]);
  const driving = useDriverState(screen).drivers;
  const drivingIds = driving.map((d) => d.id).join(",");

  // Over the canvas a driver has one cursor: FigCraft's collaborator cursors on the big screen's canvas are hidden while anyone drives
  // (FigCraft can only hide them all), and come back when driving ends.
  useEffect(() => {
    if (!replay) return;
    const set = (on: boolean) => {
      for (const f of layer.current?.parentElement?.querySelectorAll("iframe") ?? []) {
        try {
          void (f.contentWindow as any)?.figcraft?.execute("view.multiplayerCursors", { on }).catch(() => {});
        } catch {}
      }
    };
    if (!drivingIds) return;
    set(false);
    const again = setInterval(() => set(false), 2000);
    return () => {
      clearInterval(again);
      set(true);
    };
  }, [replay, drivingIds]);

  // Cursors of people who stopped driving (or lost the lock) go away with it.
  useEffect(() => {
    const live = new Set(drivingIds ? drivingIds.split(",") : []);
    for (const id of [...shown.current.keys()]) {
      if (live.has(id)) continue;
      // A driver who is out lets go of whatever they held, wherever it was pressed.
      letGo(replays.current.get(id), id);
      shown.current.delete(id);
      replays.current.delete(id);
    }
    setPeople((p) => (p.some((x) => !live.has(x.id)) ? p.filter((x) => live.has(x.id)) : p));
  }, [drivingIds]);

  useEffect(() => {
    const reduce = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    let last = performance.now();
    const frame = (now: number) => {
      raf.current = 0;
      const box = layer.current;
      if (!box) return;
      const [w, h] = [box.clientWidth, box.clientHeight];
      const dt = (now - last) / 1000;
      last = now;
      const out: Glide[] = [];
      let moving = false;
      for (const [id, c] of shown.current) {
        const el = els.current.get(id);
        if (!el) continue;
        const [tx, ty] = [c.x * w, c.y * h];
        if (c.fresh) ((c.sx = tx), (c.sy = ty), (c.fresh = false));
        else {
          c.sx = glide(c.sx, tx, dt, reduce());
          c.sy = glide(c.sy, ty, dt, reduce());
        }
        if (Math.hypot(tx - c.sx, ty - c.sy) < SNAP) (c.sx = tx), (c.sy = ty);
        else moving = true;
        const idle = Date.now() - c.seen > IDLE_MS;
        const scale = driveScale(innerWidth, !!replay);
        el.style.transform = `translate(${c.sx}px,${c.sy}px) scale(${scale})`;
        el.style.opacity = c.hidden || idle ? "0" : "1";
        el.dataset.down = c.down ? "1" : "0";
        if (!c.hidden && !idle) out.push({ screen, personId: id, name: c.name, color: c.color, x: w ? c.sx / w : 0, y: h ? c.sy / h : 0, down: c.down, scale });
      }
      if (out.length) emitGlide(out);
      if (moving || out.length) raf.current = requestAnimationFrame(frame);
    };
    const wake = () => {
      if (!raf.current) ((last = performance.now()), (raf.current = requestAnimationFrame(frame)));
    };

    const replayEv = (c: DriveCursor) => {
      const root = layer.current?.parentElement;
      if (!root) return;
      const { ev } = c;
      const st = replays.current.get(c.personId) ?? {};
      replays.current.set(c.personId, st);
      if (ev.k === "key") return void (st.down ?? st.hover)?.handle(ev, c.personId);
      if (ev.k === "leave") {
        st.hover?.handle({ k: "leave" }, c.personId);
        st.hover = null;
        return;
      }
      const r = root.getBoundingClientRect();
      const [x, y] = [r.left + ev.x * r.width, r.top + ev.y * r.height];
      // A press keeps going to the tile it started on, so a drag that leaves it still pans it.
      const t = st.down && (ev.k === "move" || ev.k === "up") ? st.down : targetAt(root, x, y);
      if (t !== st.hover) {
        st.hover?.handle({ k: "leave" }, c.personId);
        st.hover = t;
      }
      if (!t) {
        if (ev.k === "up") st.down = null;
        return;
      }
      const tr = t.el.getBoundingClientRect();
      const [lx, ly] = [(x - tr.left) / tr.width, (y - tr.top) / tr.height];
      if (ev.k === "move") t.handle({ k: "move", lx, ly }, c.personId);
      else if (ev.k === "down") ((st.down = t), t.handle({ k: "down", lx, ly, b: ev.b, n: ev.n }, c.personId));
      else if (ev.k === "up") ((st.down = null), t.handle({ k: "up", lx, ly, b: ev.b, n: ev.n }, c.personId));
      else if (ev.k === "wheel") t.handle({ k: "wheel", lx, ly, dx: ev.dx, dy: ev.dy, ctrl: ev.ctrl }, c.personId);
    };

    const off = onCursor((c) => {
      if (c.screen !== screen) return;
      if (replay) replayEv(c);
      const { ev } = c;
      if (ev.k === "key") return;
      let s = shown.current.get(c.personId);
      if (!s) {
        s = { name: c.name, color: c.color, x: 0, y: 0, sx: 0, sy: 0, fresh: true, down: false, seen: 0, hidden: true };
        shown.current.set(c.personId, s);
        setPeople((p) => (p.some((x) => x.id === c.personId) ? p : [...p, { id: c.personId, name: c.name, color: c.color }]));
      }
      s.seen = Date.now();
      if (ev.k === "leave") s.hidden = true;
      else {
        if (s.hidden) s.fresh = true;
        s.hidden = false;
        (s.x = ev.x), (s.y = ev.y);
        if (ev.k === "down") s.down = true;
        else if (ev.k === "up") s.down = false;
      }
      wake();
    });
    return () => {
      off();
      for (const [id, st] of replays.current) letGo(st, id);
      cancelAnimationFrame(raf.current);
      raf.current = 0;
    };
  }, [screen, replay]);

  return (
    <div ref={layer} className="drive-layer" aria-hidden>
      {people.map((p) => (
        <div key={p.id} ref={(el) => void (el ? els.current.set(p.id, el) : els.current.delete(p.id))} className="drive-cursor" data-person={p.id} style={{ opacity: 0 }}>
          <svg className="drive-dart" width="17" height="17" viewBox="0 0 17 17" overflow="visible">
            <polygon points={DART} fill={p.color} />
            <polygon points={DART} fill="none" stroke="#fff" strokeWidth="1.5" strokeLinejoin="round" />
          </svg>
          <span className="drive-tag" style={{ background: p.color, color: textOn(p.color) }}>
            {p.name}
          </span>
        </div>
      ))}
    </div>
  );
}
