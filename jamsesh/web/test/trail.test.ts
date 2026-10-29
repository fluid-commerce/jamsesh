import { describe, expect, test } from "bun:test";
import { CALM, FULL, Trail } from "../src/shared/trailmodel";

const drag = (t: Trail, n: number, step = 8, dt = 16, from = 0) => {
  for (let i = 0; i < n; i++) t.push(100 + i * step, 100 + Math.sin(i / 3) * 20, from + i * dt);
};

describe("the rainbow trail", () => {
  test("it follows the path and fades out over about a second", () => {
    const t = new Trail(FULL);
    drag(t, 30);
    const end = 29 * 16;
    expect(t.live(end)).toBe(true);
    const fresh = t.pieces(end);
    expect(fresh.length).toBeGreaterThan(20);
    // The head is bright, the tail faint and thin.
    expect(fresh[fresh.length - 1].alpha).toBeGreaterThan(fresh[0].alpha);
    expect(fresh[fresh.length - 1].width).toBeGreaterThan(fresh[0].width);
    // Most of the way through its life the head is faint; a second on, nothing is left.
    expect(Math.max(...t.pieces(end + 900).map((p) => p.alpha))).toBeLessThan(0.3);
    expect(t.pieces(end + 1001)).toEqual([]);
    expect(t.live(end + 1001)).toBe(false);
    expect(t.pts.length).toBe(0);
  });

  test("the whole spectrum shows from head to tail, even on a short slow stroke", () => {
    const t = new Trail(FULL);
    // A slow 12 px crawl over half a second.
    for (let i = 0; i < 12; i++) t.push(100 + i, 100, i * 45);
    const ps = t.pieces(12 * 45);
    const hues = ps.map((p) => p.hue);
    expect(Math.min(...hues)).toBeLessThan(25);
    // The tail end is violet, not just a step along.
    const spread = Math.max(...hues) - Math.min(...hues);
    expect(spread).toBeGreaterThan(230);
    // Head is the red end, tail the violet end.
    expect(ps[ps.length - 1].hue).toBeLessThan(ps[0].hue);
  });

  test("the gradient drifts slowly over time without changing the head-to-tail order", () => {
    const t = new Trail(FULL);
    drag(t, 20, 8, 16);
    const a = t.pieces(19 * 16);
    const b = new Trail(FULL);
    drag(b, 20, 8, 16);
    const later = b.pieces(19 * 16 + 100);
    expect(Math.abs(later[later.length - 1].hue - a[a.length - 1].hue)).toBeGreaterThan(0.5);
  });

  test("a pause starts a new stroke instead of drawing a line across the gap", () => {
    const t = new Trail(FULL);
    t.push(0, 0, 0);
    t.push(20, 0, 16);
    t.push(900, 700, 600);
    t.push(920, 700, 616);
    const pieces = t.pieces(620);
    // No piece spans the jump from (20,0) to (900,700).
    for (const p of pieces) expect(Math.abs(p.x1 - p.x0) + Math.abs(p.y1 - p.y0)).toBeLessThan(100);
    expect(pieces.length).toBeGreaterThanOrEqual(2);
  });

  test("a resting pointer adds nothing, and junk positions are ignored", () => {
    const t = new Trail(FULL);
    t.push(10, 10, 0);
    for (let i = 1; i < 50; i++) t.push(10.2, 10.1, i * 5);
    expect(t.pts.length).toBeLessThanOrEqual(2);
    t.push(NaN, 3, 300);
    t.push(3, Infinity, 310);
    expect(t.pts.every((p) => Number.isFinite(p.x + p.y))).toBe(true);
  });

  test("a very long session stays bounded", () => {
    const t = new Trail(FULL);
    drag(t, 5000, 3, 1);
    expect(t.pts.length).toBeLessThanOrEqual(400);
  });

  test("reduced motion is shorter, thinner, fainter, and keeps to a calm band of colour", () => {
    expect(CALM.life).toBeLessThan(FULL.life / 2);
    expect(CALM.width).toBeLessThan(FULL.width);
    expect(CALM.alpha).toBeLessThan(FULL.alpha);
    const t = new Trail(CALM);
    drag(t, 60, 12, 16);
    const ps = t.pieces(59 * 16);
    expect(Math.min(...ps.map((p) => p.hue))).toBeGreaterThanOrEqual(CALM.hueFrom);
    expect(Math.max(...ps.map((p) => p.hue))).toBeLessThan(CALM.hueFrom + CALM.hueSpan);
    expect(t.pieces(59 * 16 + CALM.life + 1)).toEqual([]);
    const full = new Trail(FULL);
    drag(full, 60, 12, 16);
    expect(Math.max(...full.pieces(59 * 16).map((p) => p.hue))).toBeGreaterThan(CALM.hueSpan * 2);
  });

  test("idle costs nothing: with no points there is nothing to draw and nothing live", () => {
    const t = new Trail(FULL);
    expect(t.pieces(0)).toEqual([]);
    expect(t.live(0)).toBe(false);
  });
});
