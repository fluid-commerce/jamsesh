// The link map: d3-force settles the layout, a plain 2D canvas draws it. It only runs a frame loop while
// something is moving (settling, a hover easing, a pulse), so a still map costs nothing. With reduced motion
// it settles once, off screen, and shows the result.
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation } from "d3-force";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { byImportance, labelled, labelledAtLeast, nodeAt, walkOrder, type GNode, type Graph } from "./graph";
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

/** A force that keeps the names of the important pages clear of each other and of other pages: each such node is a box
 * (the dot and its name below it), and boxes that overlap are pushed apart along the shorter way out. `k` is the screen
 * scale, because a name is a fixed size on screen and so a different size on the map as the map is zoomed to fit. */
function nameRoom(nodes: GNode[], named: Set<string>, k: () => number) {
  const FS = 22;
  const force = (_alpha: number) => {
    const kk = Math.max(0.2, k());
    const box = (n: GNode) => {
      const w = named.has(n.id) ? (Math.min(26, n.title.length) * FS * 0.54 + 26) / kk : 0;
      const h = named.has(n.id) ? (FS + 16) / kk : 0;
      const hw = Math.max(n.r + 4, w / 2);
      return { x: n.x ?? 0, y: (n.y ?? 0) + h / 2 - 0, hw, hh: n.r + 4 + h / 2 };
    };
    // A few passes a tick, moving nodes directly: velocity nudges are too soft to clear a crowded middle.
    for (let pass = 0; pass < 5; pass++) {
      const boxes = nodes.map(box);
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          if (!named.has(nodes[i].id) && !named.has(nodes[j].id)) continue;
          const a = boxes[i], b = boxes[j];
          const dx = b.x - a.x, dy = b.y - a.y;
          const ox = a.hw + b.hw - Math.abs(dx), oy = a.hh + b.hh - Math.abs(dy);
          if (ox <= 0 || oy <= 0) continue;
          const [p, q] = [nodes[i], nodes[j]];
          // Names are wide and short, so most clashes are cleared by moving up or down.
          if (ox * 0.55 < oy) {
            const m = (dx < 0 ? -1 : 1) * ox * 0.35;
            p.x = (p.x ?? 0) - m;
            q.x = (q.x ?? 0) + m;
          } else {
            const m = (dy < 0 ? -1 : 1) * oy * 0.35;
            p.y = (p.y ?? 0) - m;
            q.y = (q.y ?? 0) + m;
          }
        }
      }
    }
  };
  force.initialize = () => {};
  return force as any;
}

export function GraphCanvas({ graph, mode = "full", focus = null, onOpen, coarse = false, label = "Link map of the wiki" }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const stage = mode === "stage";
  const S = stage ? 2 : 1;
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [picked, setPicked] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  // Everything the frame loop reads lives in one ref, so a hover never re-renders React.
  const live = useRef({ hover: null as string | null, active: null as string | null, emph: 0, k: 1, cx: 0, cy: 0, fitted: false, midY: 0, drag: null as { n: GNode; moved: number; sx: number; sy: number } | null, raf: 0, last: 0 });
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
      const padX = stage ? 110 : mode === "local" ? 56 : 52;
      const padY = stage ? 40 : padX;
      const padT = stage ? 110 : 0;
      const padB = stage ? 120 : mode === "full" ? 36 : 0;
      L.midY = padT + (size.h - padT - padB) / 2;
      const kMax = stage ? 2.6 : mode === "local" ? 1.9 : 2;
      const kFit = Math.max(0.25, Math.min(kMax, (size.w - padX * 2) / Math.max(1, x1 - x0), (size.h - padY * 2 - padT - padB) / Math.max(1, y1 - y0)));
      const snap = reduced || !L.fitted;
      L.k = snap ? kFit : ease(L.k, kFit, dt, 3);
      L.cx = snap ? (x0 + x1) / 2 : ease(L.cx, (x0 + x1) / 2, dt, 3);
      L.cy = snap ? (y0 + y1) / 2 : ease(L.cy, (y0 + y1) / 2, dt, 3);
      L.fitted = true;
      const k = L.k;
      const sx = (x: number) => (x - L.cx) * k + size.w / 2;
      const sy = (y: number) => (y - L.cy) * k + L.midY;

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
      const fs = stage ? 22 : coarse ? 11.5 : 12;
      g.font = `${stage ? 500 : 450} ${fs}px "Geist Variable", system-ui, sans-serif`;
      g.textAlign = "center";
      g.textBaseline = "top";
      const room = Math.floor((size.w * size.h) / (stage ? 52000 : coarse ? 30000 : mode === "local" ? 9000 : 15000));
      const top = stage ? labelledAtLeast(graph, 2, 8) : labelled(graph, Math.min(coarse ? 7 : 40, Math.max(mode === "local" ? 14 : 4, room)));
      const want: GNode[] = [];
      for (const n of list) if (n.id === hot || n.id === focus || (hot && near?.has(n.id)) || (!hot && top.has(n.id))) want.push(n);
      const rank = new Map(byImportance(graph).map((n, i) => [n.id, i]));
      want.sort((a, b) => (a.id === hot ? -2 : a.id === focus ? -1 : 0) - (b.id === hot ? -2 : b.id === focus ? -1 : 0) || (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
      const placed: [number, number, number, number][] = [];
      // Every node as a circle on screen, so a name can be kept off other nodes as well as off other names.
      const discs = list.map((n) => ({ id: n.id, x: sx(n.x ?? 0), y: sy(n.y ?? 0), r: Math.max(stage ? 7 : coarse ? 5.5 : 3.5, n.r * Math.min(1.6, Math.max(0.7, k))) + 2 }));
      const hitsDisc = (b: [number, number, number, number], own: string) =>
        discs.some((d) => d.id !== own && d.x + d.r > b[0] && d.x - d.r < b[2] && d.y + d.r > b[1] && d.y - d.r < b[3]);
      const hitsLabel = (b: [number, number, number, number]) => placed.some((p) => b[0] < p[2] && b[2] > p[0] && b[1] < p[3] && b[3] > p[1]);
      for (const n of want) {
        const me = discs.find((d) => d.id === n.id)!;
        const text = n.title.length > 26 ? `${n.title.slice(0, 25)}…` : n.title;
        const w = g.measureText(text).width, h = fs + 2;
        const must = n.id === hot || n.id === focus;
        const key = must || (stage && n.backlinks >= 2);
        // Below the node first, then above, then to the right, then to the left.
        const tries: { box: [number, number, number, number]; align: CanvasTextAlign; x: number; y: number }[] = [
          { x: me.x, y: me.y + me.r + 3, align: "center" as CanvasTextAlign },
          { x: me.x, y: me.y - me.r - 3 - h, align: "center" as CanvasTextAlign },
          { x: me.x + me.r + 5, y: me.y - h / 2, align: "left" as CanvasTextAlign },
          { x: me.x - me.r - 5, y: me.y - h / 2, align: "right" as CanvasTextAlign },
        ].map((t) => ({
          ...t,
          box: (t.align === "center" ? [t.x - w / 2 - 3, t.y - 1, t.x + w / 2 + 3, t.y + h] : t.align === "left" ? [t.x - 3, t.y - 1, t.x + w + 3, t.y + h] : [t.x - w - 3, t.y - 1, t.x + 3, t.y + h]) as [number, number, number, number],
        }));
        const clear = tries.find((t) => !hitsLabel(t.box) && !hitsDisc(t.box, n.id));
        const pick = clear ?? (key ? tries[0] : null);
        if (!pick) continue;
        placed.push(pick.box);
        g.textAlign = pick.align;
        g.fillStyle = hot && !must && !near?.has(n.id) ? "rgba(243,242,239,.4)" : must ? "#f3f2ef" : "rgba(243,242,239,.8)";
        g.shadowColor = "rgba(12,13,15,.9)";
        g.shadowBlur = 5;
        g.fillText(text, pick.x, pick.y);
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
    const aspect = Math.max(0.5, Math.min(2, size.w / Math.max(1, size.h)));
    const links = graph.edges.map((e) => ({ source: e.source, target: e.target }));
    const s = forceSimulation<GNode>(fresh)
      .force("link", forceLink<GNode, { source: string; target: string }>(links).id((n) => n.id).distance(mode === "local" ? 100 * S : 62 * S).strength(stage ? 0.22 : 0.4))
      .force("charge", forceManyBody<GNode>().strength(mode === "local" ? -320 * S : -(160 + Math.min(120, fresh.length * 2)) * S).distanceMax(600 * S))
      .force("center", forceCenter(0, 0))
      // The map takes the shape of the room it has: wide on a screen, tall on a phone.
      .force("x", forceX<GNode>(0).strength((n) => (n.degree ? (mode === "local" ? 0.07 : (stage ? 0.03 : 0.07) / aspect) : 0.3)))
      .force("y", forceY<GNode>(0).strength((n) => (n.degree ? (mode === "local" ? 0.07 : 0.07 * aspect) : 0.3)))
      .force("collide", forceCollide<GNode>((n) => n.r + 5 * S))
      .force("names", stage ? nameRoom(fresh, labelledAtLeast(graph, 2, 8), () => live.current.k) : null)
      // Nothing drifts out of the map: a loose page stays within reach of the rest.
      .force("fence", () => {
        const R = (150 + 34 * Math.sqrt(fresh.length)) * S * (stage ? 1.6 : 1);
        for (const n of fresh) {
          if (n.x !== undefined) n.x = Math.max(-R * (stage ? 2.6 : 2), Math.min(R * (stage ? 2.6 : 2), n.x));
          if (n.y !== undefined) n.y = Math.max(-R * (aspect < 1 ? 2 : 1), Math.min(R * (aspect < 1 ? 2 : 1), n.y));
        }
      })
      .alphaDecay(stage ? 0.022 : 0.035)
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

  useEffect(() => {
    wake();
  }, [picked, focus, wake]);
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
    return { x: (e.clientX - r.left - size.w / 2) / L.k + L.cx, y: (e.clientY - r.top - L.midY) / L.k + L.cy };
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
