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
    // Half a second on, the head has faded to under a third; a second on, nothing is left.
    expect(Math.max(...t.pieces(end + 500).map((p) => p.alpha))).toBeLessThan(0.3);
    expect(t.pieces(end + 1001)).toEqual([]);
    expect(t.live(end + 1001)).toBe(false);
    expect(t.pts.length).toBe(0);
  });

  test("the spectrum runs along the path: the hue follows distance travelled, not time", () => {
    const slow = new Trail(FULL);
    const fast = new Trail(FULL);
    drag(slow, 40, 8, 100);
    drag(fast, 40, 8, 5);
    const hues = (t: Trail) => t.pts.map((p) => Math.round(p.h));
    expect(hues(slow)).toEqual(hues(fast));
    // It cycles through a good part of the wheel over a long sweep.
    const span = fast.pts[fast.pts.length - 1].h - fast.pts[0].h;
    expect(span).toBeGreaterThan(90);
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
