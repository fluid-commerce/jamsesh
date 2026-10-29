// The graph's data: shaped safely from whatever the hub sends, and the lookups the canvas relies on.
import { expect, test } from "bun:test";
import { labelled, localGraph, MAX_NODES, nodeAt, radiusFor, shapeGraph, walkOrder } from "../src/wiki/graph";
import { PULSE_MS, PulseStore } from "../src/wiki/pulse";

const raw = {
  nodes: [
    { id: "a", title: "Alpha", category: "people", backlinks: 3 },
    { id: "b", title: "Beta", category: "decisions", backlinks: 0 },
    { id: "c", title: "Gamma", category: "nonsense", backlinks: 1 },
    { id: "a", title: "Alpha again", category: "people", backlinks: 9 },
    { id: "d", title: "Delta", category: "topics", backlinks: -4 },
  ],
  edges: [
    { from: "a", to: "b" },
    { from: "a", to: "b" },
    { from: "b", to: "a" },
    { from: "a", to: "a" },
    { from: "a", to: "ghost" },
    { from: "c", to: "a" },
  ],
};

test("repeats, self links and links to pages that don't exist are dropped; odd categories and counts are made safe", () => {
  const g = shapeGraph(raw);
  expect(g.nodes.map((n) => n.id)).toEqual(["a", "b", "c", "d"]);
  expect(g.nodes[0].title).toBe("Alpha");
  expect(g.nodes[2].category).toBe("topics");
  expect(g.nodes[3].backlinks).toBe(0);
  expect(g.edges).toEqual([{ source: "a", target: "b" }, { source: "b", target: "a" }, { source: "c", target: "a" }]);
  expect(g.nodes.find((n) => n.id === "a")!.degree).toBe(3);
  expect([...g.near.get("a")!].sort()).toEqual(["b", "c"]);
  expect(g.near.get("d")!.size).toBe(0);
});

test("junk in, an empty map out", () => {
  for (const bad of [null, undefined, {}, { nodes: "x", edges: 4 }, { nodes: [null, 3, { id: 7 }], edges: [null, {}] }] as any[]) {
    const g = shapeGraph(bad);
    expect(g.nodes).toEqual([]);
    expect(g.edges).toEqual([]);
  }
});

test("size grows with backlinks but flattens, and scales for the big screen", () => {
  expect(radiusFor(0)).toBeLessThan(radiusFor(1));
  expect(radiusFor(8) - radiusFor(4)).toBeLessThan(radiusFor(4) - radiusFor(0));
  expect(radiusFor(4, 2)).toBeCloseTo(radiusFor(4) * 2);
  expect(radiusFor(NaN)).toBe(radiusFor(0));
});

test("a huge wiki is cut to the best-connected pages, with no edges left dangling", () => {
  const nodes = Array.from({ length: MAX_NODES + 80 }, (_, i) => ({ id: `p${i}`, title: `P${i}`, category: "topics", backlinks: 0 }));
  const edges = nodes.slice(1).map((n) => ({ from: "p0", to: n.id }));
  const g = shapeGraph({ nodes, edges });
  expect(g.nodes.length).toBe(MAX_NODES);
  expect(g.nodes[0].id).toBe("p0");
  const ids = new Set(g.nodes.map((n) => n.id));
  expect(g.edges.every((e) => ids.has(e.source) && ids.has(e.target))).toBe(true);
});

test("the local map is the page and the pages it is linked with, either way round, and nothing else", () => {
  const g = shapeGraph({
    nodes: ["a", "b", "c", "d", "e"].map((id) => ({ id, title: id, category: "topics", backlinks: 0 })),
    edges: [{ from: "a", to: "b" }, { from: "c", to: "a" }, { from: "b", to: "d" }, { from: "d", to: "e" }],
  });
  const l = localGraph(g, "a");
  expect(l.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "c"]);
  expect(l.edges.length).toBe(2);
  expect(localGraph(g, "missing").nodes).toEqual([]);
  // a copy: the canvas moves these nodes around
  expect(l.nodes[0]).not.toBe(g.nodes.find((n) => n.id === l.nodes[0].id));
});

test("the keyboard walks by category then title; labels go to the biggest pages first", () => {
  const g = shapeGraph(raw);
  expect(walkOrder(g)).toEqual(["b", "a", "d", "c"]);
  expect([...labelled(g, 1)]).toEqual(["a"]);
  expect(labelled(g, 0).size).toBe(0);
});

test("pointing finds the nearest node within reach, and nothing when the map is empty or unplaced", () => {
  const g = shapeGraph(raw);
  const [a, b] = g.nodes;
  expect(nodeAt(g.nodes, 0, 0)).toBeNull();
  a.x = 0; a.y = 0; b.x = 30; b.y = 0;
  expect(nodeAt(g.nodes, 2, 1)?.id).toBe("a");
  expect(nodeAt(g.nodes, 29, 0)?.id).toBe("b");
  expect(nodeAt(g.nodes, 300, 300)).toBeNull();
});

test("a pulse fades by itself and is forgotten", () => {
  const p = new PulseStore();
  let woke = 0;
  p.on(() => woke++);
  p.add(["x", "y"], 1000);
  expect(woke).toBe(1);
  expect(p.level("x", 1000)).toBe(1);
  expect(p.level("x", 1000 + PULSE_MS / 2)).toBeCloseTo(0.5);
  expect(p.level("x", 1000 + PULSE_MS + 1)).toBe(0);
  expect(p.level("nope", 1000)).toBe(0);
  p.add([]);
  expect(woke).toBe(1);
  p.level("y", 1000 + PULSE_MS + 1);
  expect(p.active).toBe(false);
});

test("names go to the important pages first: backlinks, then people and workstreams before the rest; pages with 2+ backlinks are all named", async () => {
  const { byImportance, labelledAtLeast } = await import("../src/wiki/graph");
  const g = shapeGraph({
    nodes: [
      { id: "t", title: "Topic", category: "topics", backlinks: 2 },
      { id: "p", title: "Person", category: "people", backlinks: 2 },
      { id: "w", title: "Work", category: "workstreams", backlinks: 2 },
      { id: "big", title: "Big", category: "repos", backlinks: 9 },
      ...["a", "b", "c"].map((id) => ({ id, title: id, category: "topics", backlinks: 0 })),
    ],
    edges: [],
  });
  expect(byImportance(g).map((n) => n.id).slice(0, 4)).toEqual(["big", "p", "w", "t"]);
  expect([...labelledAtLeast(g, 2, 1)].sort()).toEqual(["a", "big", "p", "t", "w"]);
  expect(labelledAtLeast(g, 2, 0).size).toBe(4);
});
