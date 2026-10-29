// The rainbow trail (6.2): the path your pointer just took, fading behind it, so everyone can see
// the pointer is part of the recording. This is only the model; trail.tsx draws it.

export interface TrailStyle {
  /** How long a point takes to fade out, in ms. */
  life: number;
  /** Stroke width at the head, in px. */
  width: number;
  /** Peak opacity at the head. */
  alpha: number;
  /** Degrees of hue per pixel travelled: how fast the spectrum cycles along the path. */
  hueRate: number;
  /** The hue range used; reduced motion keeps to a narrow cool band instead of the full spectrum. */
  hueFrom: number;
  hueSpan: number;
}

export const FULL: TrailStyle = { life: 1000, width: 7, alpha: 0.95, hueRate: 0.32, hueFrom: 0, hueSpan: 360 };
/** Reduced motion: shorter, thinner, fainter, and a calm band of colour instead of the whole spectrum. */
export const CALM: TrailStyle = { life: 450, width: 3, alpha: 0.55, hueRate: 0.12, hueFrom: 190, hueSpan: 110 };

export interface TrailPoint {
  x: number;
  y: number;
  at: number;
  /** Degrees along the spectrum, set by how far the pointer has travelled, so colour follows the path and not the clock. */
  h: number;
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
  private travelled = 0;
  constructor(public style: TrailStyle = FULL) {}

  push(x: number, y: number, at: number) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const last = this.pts[this.pts.length - 1];
    const d = last ? Math.hypot(x - last.x, y - last.y) : 0;
    if (last && d < MIN_STEP && at - last.at < GAP_MS) return;
    const cut = !last || at - last.at > GAP_MS;
    this.travelled += cut ? 0 : d;
    this.pts.push({ x, y, at, h: this.travelled * this.style.hueRate, cut });
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
   * its colour, opacity and width from its control sample, so the spectrum stays put along the path
   * while the tail thins and fades.
   */
  pieces(now: number): TrailPiece[] {
    this.prune(now);
    const { life, width, alpha, hueFrom, hueSpan } = this.style;
    const out: TrailPiece[] = [];
    const p = this.pts;
    const look = (q: TrailPoint) => {
      const k = Math.min(1, Math.max(0, (now - q.at) / life));
      const fade = Math.pow(1 - k, 1.6) * (1 - 0.3 * k);
      return { hue: hueFrom + (((q.h % hueSpan) + hueSpan) % hueSpan), alpha: alpha * fade, width: Math.max(0.6, width * (1 - 0.85 * k)) };
    };
    const mid = (u: TrailPoint, v: TrailPoint) => ({ x: (u.x + v.x) / 2, y: (u.y + v.y) / 2 });
    for (let from = 0; from < p.length; ) {
      let to = from + 1;
      while (to < p.length && !p[to].cut) to++;
      const run = p.slice(from, to);
      from = to;
      if (run.length < 2) continue;
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
