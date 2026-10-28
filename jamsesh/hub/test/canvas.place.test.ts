import { expect, test } from "bun:test";
import { Canvas } from "../src/canvas/canvas";

// place() only reads occupied/placed rectangles; no server is needed.
function canvas(occupied: { x: number; y: number; w: number; h: number }[]) {
  const c = Object.create(Canvas.prototype) as any;
  c.occupied = occupied.map((r) => ({ ...r, at: Date.now() }));
  c.placed = [];
  return c as Canvas;
}

test("a frame dropped on existing work moves right of it", () => {
  const c = canvas([{ x: 0, y: 0, w: 390, h: 844 }, { x: 470, y: 0, w: 390, h: 844 }]);
  const args = c.place("create_node", { type: "frame", x: 0, y: 0, width: 1440, height: 900 });
  expect(args.x).toBe(860 + 120);
  expect(args.y).toBe(0);
});

test("a frame in open space stays put", () => {
  const c = canvas([{ x: 0, y: 0, w: 390, h: 844 }]);
  expect(c.place("create_node", { type: "frame", x: 0, y: 2000, width: 390, height: 844 }).x).toBe(0);
});

test("a batch of variants moves together and keeps its spacing", () => {
  const c = canvas([{ x: 0, y: 0, w: 390, h: 844 }]);
  const args = c.place("batch", {
    commands: [
      { command: "node.create", params: { type: "frame", x: 0, y: 0, width: 390, height: 844 } },
      { command: "node.create", params: { type: "text", parent: { $ref: "f" }, text: "x" } },
      { command: "node.create", params: { type: "frame", x: 470, y: 0, width: 390, height: 844 } },
    ],
  });
  const [a, , b] = args.commands.map((s: any) => s.params);
  expect(a.x).toBe(510);
  expect(b.x - a.x).toBe(470);
});

test("frames placed back to back before the next poll don't stack", () => {
  const c = canvas([]);
  const one = c.place("create_node", { type: "frame", x: 0, y: 0, width: 390, height: 844 });
  const two = c.place("create_node", { type: "frame", x: 0, y: 0, width: 390, height: 844 });
  expect(one.x).toBe(0);
  expect(two.x).toBeGreaterThan(390);
});

test("children are never moved", () => {
  const c = canvas([{ x: 0, y: 0, w: 390, h: 844 }]);
  expect(c.place("create_node", { type: "text", parent: 5, x: 0, y: 0 }).x).toBe(0);
});
