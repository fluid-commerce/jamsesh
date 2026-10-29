// The link map: d3-force settles the layout, a plain 2D canvas draws it. It only runs a frame loop while
// something is moving (settling, a hover easing, a pulse), so a still map costs nothing. With reduced motion
// it settles once, off screen, and shows the result.
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation } from "d3-force";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { labelled, nodeAt, walkOrder, type GNode, type Graph } from "./graph";
import { pulses, PULSE_MS } from "./pulse";
import { CATEGORY_COLOR, CATEGORY_LABEL } from "./types";

export type GraphMode = "full" | "local" | "stage";

interface Props {
  graph: Graph;
  mode?: GraphMode;
  /** The page whose neighbourhood this is (kept at the centre in a local map, ringed in a full one). */
  focus?: string | null;
  onOpen?: (slug: string) => void;
  /** Phone: fewer names, a tap selects and a second tap opens. */
  coarse?: boolean;
  label?: string;
}

export const prefersReducedMotion = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

const hex = (c: string, a: number) => {
  const n = parseInt(c.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
};
const ease = (cur: number, to: number, dt: number, rate = 9) => cur + (to - cur) * Math.min(1, dt * rate);

export function GraphCanvas({ graph, mode = "full", focus = null, onOpen, coarse = false, label = "Link map of the wiki" }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const stage = mode === "stage";
  const S = stage ? 2 : 1;
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [picked, setPicked] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  // Everything the frame loop reads lives in one ref, so a hover never re-renders React.
  const live = useRef({ hover: null as string | null, active: null as string | null, emph: 0, k: 1, cx: 0, cy: 0, fitted: false, drag: null as { n: GNode; moved: number; sx: number; sy: number } | null, raf: 0, last: 0 });
  const pos = useRef(new Map<string, { x: number; y: number }>());
  const sim = useRef<Simulation<GNode, undefined> | null>(null);
  const nodes = useRef<GNode[]>([]);
  const hopIx = useRef(-1);
  const order = useMemo(() => walkOrder(graph), [graph]);
  const byId = useRef(new Map<string, GNode>());

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.round(e.contentRect.width), h: Math.round(e.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const draw = useCallback(
    (now: number) => {
      const c = cv.current;
      const g = c?.getContext("2d");
      if (!c || !g || !size.w) return false;
      const L = live.current;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, size.w, size.h);
      const list = nodes.current;
      if (!list.length) return false;
      const reduced = prefersReducedMotion();
      const dt = Math.min(0.05, (now - (L.last || now)) / 1000 || 0.016);
      L.last = now;

      // Fit the whole map in view, easing toward it while it settles.
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const n of list) {
        const x = n.x ?? 0, y = n.y ?? 0;
        x0 = Math.min(x0, x - n.r); x1 = Math.max(x1, x + n.r); y0 = Math.min(y0, y - n.r); y1 = Math.max(y1, y + n.r);
      }
      const pad = (stage ? 120 : mode === "local" ? 56 : 48) + (stage ? 40 : 0);
      const kMax = stage ? 2.2 : mode === "local" ? 1.5 : 1.25;
      const kFit = Math.max(0.25, Math.min(kMax, (size.w - pad * 2) / Math.max(1, x1 - x0), (size.h - pad * 2) / Math.max(1, y1 - y0)));
      const snap = reduced || !L.fitted;
      L.k = snap ? kFit : ease(L.k, kFit, dt, 3);
      L.cx = snap ? (x0 + x1) / 2 : ease(L.cx, (x0 + x1) / 2, dt, 3);
      L.cy = snap ? (y0 + y1) / 2 : ease(L.cy, (y0 + y1) / 2, dt, 3);
      L.fitted = true;
      const k = L.k;
      const sx = (x: number) => (x - L.cx) * k + size.w / 2;
      const sy = (y: number) => (y - L.cy) * k + size.h / 2;

      const hot = L.hover ?? L.active ?? picked;
      const near = hot ? graph.near.get(hot) : undefined;
      L.emph = reduced ? (hot ? 1 : 0) : ease(L.emph, hot ? 1 : 0, dt, 10);
      const dim = 1 - 0.78 * L.emph;
      const lit = (id: string) => !hot || id === hot || near?.has(id);

      // Edges first, then nodes over them.
      g.lineWidth = (stage ? 1.6 : 1) * (coarse ? 1.2 : 1);
      for (const e of graph.edges) {
        const a = byId.current.get(e.source), b = byId.current.get(e.target);
        if (!a || !b) continue;
        const on = hot && (e.source === hot || e.target === hot);
        g.strokeStyle = on ? hex(CATEGORY_COLOR[(e.source === hot ? b : a).category], 0.35 + 0.4 * L.emph) : `rgba(165,172,188,${(hot ? 0.16 : 0.2) * (on ? 1 : dim + 0.1)})`;
        g.beginPath();
        g.moveTo(sx(a.x ?? 0), sy(a.y ?? 0));
        g.lineTo(sx(b.x ?? 0), sy(b.y ?? 0));
        g.stroke();
      }

      let moving = false;
      for (const n of list) {
        const x = sx(n.x ?? 0), y = sy(n.y ?? 0);
        const r = Math.max(stage ? 7 : coarse ? 5.5 : 3.5, n.r * Math.min(1.6, Math.max(0.7, k)));
        const col = CATEGORY_COLOR[n.category];
        const a = lit(n.id) ? 1 : dim;
        const p = pulses.level(n.id, Date.now());
        if (p > 0) {
          moving = true;
          const t = reduced ? 0.4 : 1 - p;
          g.strokeStyle = hex(col, 0.7 * p);
          g.lineWidth = (stage ? 3 : 2) * (0.5 + p);
          g.beginPath();
          g.arc(x, y, r + (6 + 26 * t) * S, 0, 6.2832);
          g.stroke();
          g.fillStyle = hex(col, 0.22 * p);
          g.beginPath();
          g.arc(x, y, r + 8 * S * (0.4 + p), 0, 6.2832);
          g.fill();
        }
        g.fillStyle = hex(col, 0.92 * a);
        g.beginPath();
        g.arc(x, y, r, 0, 6.2832);
        g.fill();
        if (n.id === focus || n.id === L.active || n.id === picked) {
          g.strokeStyle = "rgba(243,242,239,.9)";
          g.lineWidth = stage ? 3 : 2;
          g.beginPath();
          g.arc(x, y, r + 3.5 * S, 0, 6.2832);
          g.stroke();
        }
      }

      // Names: the ones you're pointing at first, then the biggest, never on top of each other.
      const fs = stage ? 25 : coarse ? 11.5 : 12;
      g.font = `${stage ? 500 : 450} ${fs}px "Geist Variable", system-ui, sans-serif`;
      g.textAlign = "center";
      g.textBaseline = "top";
      const room = Math.floor((size.w * size.h) / (stage ? 52000 : coarse ? 30000 : mode === "local" ? 9000 : 15000));
      const top = labelled(graph, Math.min(coarse ? 7 : 40, Math.max(mode === "local" ? 12 : 4, room)));
      const want: GNode[] = [];
      for (const n of list) if (n.id === hot || n.id === focus || (hot && near?.has(n.id)) || (!hot && top.has(n.id))) want.push(n);
      want.sort((a, b) => (a.id === hot ? -2 : a.id === focus ? -1 : 0) - (b.id === hot ? -2 : b.id === focus ? -1 : 0) || b.backlinks - a.backlinks);
      const placed: [number, number, number, number][] = [];
      for (const n of want) {
        const x = sx(n.x ?? 0), y = sy(n.y ?? 0) + Math.max(5, n.r * Math.min(1.6, Math.max(0.7, k))) + 4;
        const text = n.title.length > 26 ? `${n.title.slice(0, 25)}…` : n.title;
        const w = g.measureText(text).width, h = fs + 2;
        const box: [number, number, number, number] = [x - w / 2 - 3, y - 1, x + w / 2 + 3, y + h];
        const must = n.id === hot || n.id === focus;
        if (!must && placed.some((p) => box[0] < p[2] && box[2] > p[0] && box[1] < p[3] && box[3] > p[1])) continue;
        placed.push(box);
        g.fillStyle = hot && !must && !near?.has(n.id) ? "rgba(243,242,239,.4)" : must ? "#f3f2ef" : "rgba(243,242,239,.8)";
        g.shadowColor = "rgba(12,13,15,.9)";
        g.shadowBlur = 5;
        g.fillText(text, x, y);
        g.shadowBlur = 0;
      }

      const s = sim.current;
      const settling = !!s && s.alpha() > s.alphaMin();
      return moving || settling || Math.abs(L.emph - (hot ? 1 : 0)) > 0.01 || Math.abs(L.k - kFit) > 0.002 || !!L.drag || stage;
    },
    [graph, size, focus, picked, stage, mode, coarse, S],
  );

  // The loop always calls the latest draw, so a tap or a resize never rebuilds the layout.
  const drawRef = useRef(draw);
  drawRef.current = draw;
  const wake = useCallback(() => {
    const L = live.current;
    const frame = (now: number) => {
      L.raf = 0;
      const s = sim.current;
      if (s && !prefersReducedMotion() && (s.alpha() > s.alphaMin() || L.drag)) s.tick();
      if (drawRef.current(now)) L.raf = requestAnimationFrame(frame);
      else L.last = 0;
    };
    if (!L.raf) L.raf = requestAnimationFrame(frame);
  }, []);

  // Build the layout whenever the graph or the room it has changes; known nodes keep their places.
  useEffect(() => {
    if (!size.w) return;
    const L = live.current;
    const fresh: GNode[] = graph.nodes.map((n) => {
      const p = pos.current.get(n.id);
      return { ...n, r: n.r * S, x: p?.x, y: p?.y, vx: 0, vy: 0, fx: null, fy: null };
    });
    nodes.current = fresh;
    byId.current = new Map(fresh.map((n) => [n.id, n]));
    sim.current?.stop();
    if (!fresh.length) return void drawRef.current(0);
    const ring = (i: number) => ({ a: i * 2.399963, d: 14 * S * Math.sqrt(i + 1) });
    fresh.forEach((n, i) => {
      if (n.x === undefined) (n.x = Math.cos(ring(i).a) * ring(i).d * 3, (n.y = Math.sin(ring(i).a) * ring(i).d * 3));
    });
    if (mode === "local" && focus) {
      const f = byId.current.get(focus);
      if (f) (f.fx = 0, (f.fy = 0));
    }
    const links = graph.edges.map((e) => ({ source: e.source, target: e.target }));
    const s = forceSimulation<GNode>(fresh)
      .force("link", forceLink<GNode, { source: string; target: string }>(links).id((n) => n.id).distance(mode === "local" ? 70 * S : 38 * S).strength(0.5))
      .force("charge", forceManyBody<GNode>().strength(mode === "local" ? -260 * S : -(70 + Math.min(80, fresh.length)) * S).distanceMax(400 * S))
      .force("center", forceCenter(0, 0))
      .force("x", forceX(0).strength(0.045))
      .force("y", forceY(0).strength(0.045))
      .force("collide", forceCollide<GNode>((n) => n.r + 4 * S))
      .alphaDecay(0.035)
      .velocityDecay(0.42);
    sim.current = s;
    s.stop();
    L.fitted = false;
    s.tick(prefersReducedMotion() ? 320 : 30);
    s.alpha(prefersReducedMotion() ? 0 : Math.max(s.alpha(), 0.5));
    wake();
    return () => {
      for (const n of fresh) if (n.x !== undefined && n.y !== undefined) pos.current.set(n.id, { x: n.x, y: n.y });
      s.stop();
      cancelAnimationFrame(L.raf);
      L.raf = 0;
    };
  }, [graph, size.w, size.h, mode, focus, S, wake]);

  useEffect(() => wake(), [picked, focus, wake]);
  // A pulse needs a frame to start and one to end, even when the map is otherwise still.
  useEffect(() => {
    const off = pulses.on(() => wake());
    return off;
  }, [wake]);
  useEffect(() => {
    if (!prefersReducedMotion()) return;
    const t = setInterval(() => (pulses.active ? wake() : undefined), PULSE_MS / 2);
    return () => clearInterval(t);
  }, [wake]);

  const world = (e: PointerEvent) => {
    const r = cv.current!.getBoundingClientRect();
    const L = live.current;
    return { x: (e.clientX - r.left - size.w / 2) / L.k + L.cx, y: (e.clientY - r.top - size.h / 2) / L.k + L.cy };
  };
  const hit = (e: PointerEvent) => {
    const w = world(e);
    return nodeAt(nodes.current, w.x, w.y, (coarse ? 14 : 6) / live.current.k);
  };

  const onMove = (e: PointerEvent) => {
    const L = live.current;
    if (L.drag) {
      const w = world(e);
      L.drag.n.fx = w.x;
      L.drag.n.fy = w.y;
      L.drag.moved = Math.max(L.drag.moved, Math.hypot(e.clientX - L.drag.sx, e.clientY - L.drag.sy));
      sim.current?.alphaTarget(0.25);
      return wake();
    }
    if (e.pointerType === "touch") return;
    const n = hit(e);
    if ((n?.id ?? null) !== L.hover) {
      L.hover = n?.id ?? null;
      if (cv.current) cv.current.style.cursor = n ? "pointer" : "default";
      wake();
    }
  };
  const onDown = (e: PointerEvent) => {
    const n = hit(e);
    if (!n || stage || e.pointerType === "touch" || mode === "local") return;
    cv.current?.setPointerCapture(e.pointerId);
    live.current.drag = { n, moved: 0, sx: e.clientX, sy: e.clientY };
  };
  const onUp = (e: PointerEvent) => {
    const L = live.current;
    const d = L.drag;
    L.drag = null;
    if (d) {
      d.n.fx = null;
      d.n.fy = null;
      sim.current?.alphaTarget(0);
      if (d.moved > 4) return wake();
    }
    const n = d?.n ?? hit(e);
    if (!n || stage) return;
    if (e.pointerType === "touch" || coarse) {
      if (picked === n.id) onOpen?.(n.id);
      else (setPicked(n.id), wake());
    } else onOpen?.(n.id);
  };
  const onLeave = () => {
    const L = live.current;
    if (L.hover) ((L.hover = null), wake());
  };

  const describe = (id: string) => {
    const n = byId.current.get(id);
    if (!n) return "";
    const links = [...(graph.near.get(id) ?? [])].map((x) => byId.current.get(x)?.title).filter(Boolean);
    return `${n.title}, ${CATEGORY_LABEL[n.category].toLowerCase()}, ${n.backlinks} backlink${n.backlinks === 1 ? "" : "s"}${links.length ? `, linked with ${links.slice(0, 6).join(", ")}` : ""}`;
  };
  const move = (id: string | null) => {
    live.current.active = id;
    setAnnounce(id ? describe(id) : "");
    wake();
  };
  const onKey = (e: KeyboardEvent) => {
    const L = live.current;
    const i = L.active ? order.indexOf(L.active) : -1;
    const around = L.active ? [...(graph.near.get(L.active) ?? [])] : [];
    const hop = () => (around.length ? around[(hopIx.current = (hopIx.current + 1) % around.length)] : null);
    if (e.key === "ArrowRight" || e.key === "ArrowDown") (e.preventDefault(), (hopIx.current = -1), move(order[(i + 1) % order.length] ?? null));
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") (e.preventDefault(), (hopIx.current = -1), move(order[(i - 1 + order.length) % order.length] ?? null));
    else if (e.key === "n" && around.length) (e.preventDefault(), move(hop()));
    else if (e.key === "Enter" && L.active) (e.preventDefault(), onOpen?.(L.active));
    else if (e.key === "Escape" && L.active) move(null);
  };
  const pickedNode = picked ? byId.current.get(picked) : null;

  return (
    <div className={`gc gc-${mode}`} ref={wrap}>
      <canvas
        ref={(el) => {
          cv.current = el;
          if (el && size.w) {
            const dpr = Math.min(2, window.devicePixelRatio || 1);
            if (el.width !== Math.round(size.w * dpr)) (el.width = Math.round(size.w * dpr), (el.height = Math.round(size.h * dpr)));
          }
        }}
        style={{ width: size.w, height: size.h, touchAction: coarse ? "pan-y" : "none" }}
        tabIndex={stage ? -1 : 0}
        role="application"
        aria-label={`${label}. ${graph.nodes.length} pages. Arrow keys move between pages, N hops to a linked page, Enter opens it.`}
        onPointerMove={onMove}
        onPointerDown={onDown}
        onPointerUp={onUp}
        onPointerLeave={onLeave}
        onKeyDown={onKey}
        onFocus={() => !live.current.active && order[0] && move(order[0])}
        onBlur={() => move(null)}
      />
      <span className="sr-only" aria-live="polite">{announce}</span>
      {coarse && pickedNode && (
        <div className="gc-card">
          <i style={{ background: CATEGORY_COLOR[pickedNode.category] }} />
          <span className="gc-card-t">
            <b>{pickedNode.title}</b>
            <small>{CATEGORY_LABEL[pickedNode.category]} · {pickedNode.backlinks} backlink{pickedNode.backlinks === 1 ? "" : "s"}</small>
          </span>
          <button className="btn small" onClick={() => onOpen?.(pickedNode.id)}>Open</button>
        </div>
      )}
    </div>
  );
}
