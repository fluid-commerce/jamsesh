// The rainbow trail (6.2): the path your pointer just took, fading behind it, so everyone can see
// the pointer is part of the recording. This is only the model; trail.tsx draws it.

export interface TrailStyle {
  /** How long a point takes to fade out, in ms. */
  life: number;
  /** Stroke width at the head, in px. */
  width: number;
  /** Peak opacity at the head. */
  alpha: number;
  /** Degrees of hue from the head of the visible trail to its tail: the whole trail always shows this much of the spectrum. */
  sweep: number;
  /** Degrees per ms the whole gradient drifts, so it feels alive. */
  drift: number;
  /** The hue band used; reduced motion keeps to a narrow cool band instead of the full wheel. */
  hueFrom: number;
  hueSpan: number;
}

export const FULL: TrailStyle = { life: 1000, width: 7, alpha: 0.95, sweep: 285, drift: 0.02, hueFrom: 0, hueSpan: 360 };
/** Reduced motion: shorter, thinner, fainter, and a calm band of colour instead of the whole spectrum. */
export const CALM: TrailStyle = { life: 450, width: 3, alpha: 0.55, sweep: 100, drift: 0, hueFrom: 190, hueSpan: 110 };

export interface TrailPoint {
  x: number;
  y: number;
  at: number;
  /** A gap in time starts a new stroke instead of joining two places the pointer never crossed. */
  cut: boolean;
}

export interface TrailPiece {
  x0: number;
  y0: number;
  cx: number;
  cy: number;
  x1: number;
  y1: number;
  /** CSS hue, 0..360 */
  hue: number;
  alpha: number;
  width: number;
}

/** A pointer that stopped for this long has left a gap: the next move is a new stroke. */
const GAP_MS = 350;
/** Moves shorter than this add nothing to the shape. */
const MIN_STEP = 1.5;
const MAX_POINTS = 400;

export class Trail {
  pts: TrailPoint[] = [];
  constructor(public style: TrailStyle = FULL) {}

  push(x: number, y: number, at: number) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const last = this.pts[this.pts.length - 1];
    const d = last ? Math.hypot(x - last.x, y - last.y) : 0;
    if (last && d < MIN_STEP && at - last.at < GAP_MS) return;
    const cut = !last || at - last.at > GAP_MS;
    this.pts.push({ x, y, at, cut });
    if (this.pts.length > MAX_POINTS) this.pts.splice(0, this.pts.length - MAX_POINTS);
  }

  /** Drops what has faded. */
  prune(now: number) {
    let n = 0;
    while (n < this.pts.length && now - this.pts[n].at >= this.style.life) n++;
    if (n) this.pts.splice(0, n);
  }

  /** Whether anything is left to draw. */
  live(now: number) {
    const last = this.pts[this.pts.length - 1];
    return !!last && now - last.at < this.style.life;
  }

  /**
   * Smooth curve pieces. Within each unbroken stroke the line runs midpoint to midpoint with each
   * sample as the control point, so coarse mouse samples still draw as one flowing line. A piece takes
   * its colour, opacity and width from its control sample. Colour runs the spectrum from the head
   * (red) to the oldest visible point (violet), however short the stroke, and the whole gradient drifts slowly.
   */
  pieces(now: number): TrailPiece[] {
    this.prune(now);
    const { life, width, alpha, hueFrom, hueSpan, sweep, drift } = this.style;
    const out: TrailPiece[] = [];
    const p = this.pts;
    // The spectrum spans each stroke from its head back to where it has mostly faded (or its start, if shorter).
    const lookAt = (q: TrailPoint, headAt: number, span: number) => {
      const u = Math.min(1, Math.max(0, (headAt - q.at) / span));
      const k = Math.min(1, Math.max(0, (now - q.at) / life));
      // Time takes the trail away; the tail end dims only a little ahead of that, so the whole spectrum stays visible.
      const fade = (1 - Math.pow(k, 1.5)) * (1 - 0.5 * u);
      return { hue: hueFrom + ((((u * sweep + now * drift) % hueSpan) + hueSpan) % hueSpan), alpha: alpha * fade, width: Math.max(0.6, width * (1 - 0.85 * k)) };
    };
    const mid = (u: TrailPoint, v: TrailPoint) => ({ x: (u.x + v.x) / 2, y: (u.y + v.y) / 2 });
    for (let from = 0; from < p.length; ) {
      let to = from + 1;
      while (to < p.length && !p[to].cut) to++;
      const run = p.slice(from, to);
      from = to;
      if (run.length < 2) continue;
      const headAt = run[run.length - 1].at;
      const span = Math.min(life * 0.65, Math.max(200, headAt - run[0].at));
      const look = (q: TrailPoint) => lookAt(q, headAt, span);
      const first = mid(run[0], run[1]);
      out.push({ x0: run[0].x, y0: run[0].y, cx: run[0].x, cy: run[0].y, x1: first.x, y1: first.y, ...look(run[0]) });
      for (let i = 1; i < run.length - 1; i++) {
        const s = mid(run[i - 1], run[i]);
        const e = mid(run[i], run[i + 1]);
        out.push({ x0: s.x, y0: s.y, cx: run[i].x, cy: run[i].y, x1: e.x, y1: e.y, ...look(run[i]) });
      }
      const n = run.length;
      const last = mid(run[n - 2], run[n - 1]);
      out.push({ x0: last.x, y0: last.y, cx: run[n - 1].x, cy: run[n - 1].y, x1: run[n - 1].x, y1: run[n - 1].y, ...look(run[n - 1]) });
    }
    return out;
  }
}
