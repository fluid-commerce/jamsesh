import { expect, test } from "bun:test";
import { groupArtifacts, keyAction, settle, step } from "../src/client/viewerNav";
import { fullSize } from "../src/shared/frames";
import type { Artifact } from "../src/shared/hub";

const art = (id: string, over: Partial<Artifact> = {}): Artifact =>
  ({ id, ts: 0, updatedAt: 0, kind: "frame", stage: "mockup", agentId: null, agentName: "", title: id, group: "", variant: "", platform: null, nodeId: null, url: null, image: null, width: null, height: null, workstreamId: null, note: "", ...over }) as Artifact;

test("the arrows stop at the ends of the group", () => {
  expect(step(0, 3, -1)).toBe(0);
  expect(step(0, 3, 1)).toBe(1);
  expect(step(2, 3, 1)).toBe(2);
  expect(step(1, 1, 1)).toBe(0);
});

test("keys: arrows step, Esc closes, Space zooms, and modified keys are left to the browser", () => {
  expect(keyAction({ key: "ArrowLeft" })).toBe("prev");
  expect(keyAction({ key: "ArrowRight" })).toBe("next");
  expect(keyAction({ key: "Escape" })).toBe("close");
  expect(keyAction({ key: " " })).toBe("zoom");
  expect(keyAction({ key: "ArrowLeft", metaKey: true })).toBeNull();
  expect(keyAction({ key: "m" })).toBeNull();
});

test("groups gather by group or title, variants read A, B, C, and the filter applies", () => {
  const list = [art("b", { group: "Login", variant: "B" }), art("a", { group: "Login", variant: "A" }), art("s", { title: "Solo" }), art("w", { group: "Login", stage: "built" })];
  const all = groupArtifacts(list);
  expect(all.map(([g]) => g)).toEqual(["Login", "Solo"]);
  // One item has no variant, so the group keeps the order it landed in.
  expect(all[0][1].map((a) => a.id)).toEqual(["b", "a", "w"]);
  const mock = groupArtifacts(list, "mockup");
  expect(mock[0][1].map((a) => a.id)).toEqual(["a", "b"]);
  expect(groupArtifacts(list, "built").map(([g]) => g)).toEqual(["Login"]);
});

test("the viewer keeps its item when the group changes, and lands nearby when it's gone", () => {
  const items = [art("a"), art("b"), art("c")];
  expect(settle(items, "b", 0)).toBe(1);
  expect(settle(items, "gone", 2)).toBe(2);
  expect(settle(items, "gone", 9)).toBe(2);
  expect(settle([], "gone", 0)).toBe(0);
});

test("a frame is drawn larger only when its box would upscale the stored 1600 px render", () => {
  const frame = { kind: "frame" as const, width: 1440, height: 900, nodeId: "1:2" };
  expect(fullSize(frame, { w: 800, h: 500 }, 1)).toBeNull();
  expect(fullSize(frame, { w: 1800, h: 1000 }, 1)).toBeNull();
  // A 1080p TV in a browser at 2x: the picture is ~2000 device px wide.
  expect(fullSize(frame, { w: 1700, h: 900 }, 2)).toBe(3200);
  expect(fullSize(frame, { w: 1100, h: 900 }, 2)).toBe(2400);
  // A 4K TV at 1x pixel ratio.
  expect(fullSize(frame, { w: 3600, h: 2000 }, 1)).toBe(3200);
  expect(fullSize(frame, { w: 2400, h: 1400 }, 2)).toBe(4096);
  expect(fullSize({ ...frame, kind: "screenshot" as const }, { w: 3600, h: 2000 }, 1)).toBeNull();
  expect(fullSize({ ...frame, nodeId: null }, { w: 3600, h: 2000 }, 1)).toBeNull();
});

test("Expand goes out through the real api() helper to the hub's expand route, and is never queued for later", async () => {
  (globalThis as any).location ??= { origin: "http://127.0.0.1:4790", pathname: "/client", search: "" };
  (globalThis as any).navigator ??= {};
  Object.defineProperty(globalThis.navigator, "onLine", { value: true, configurable: true });
  const { expandTile } = await import("../src/host/Stage");
  const seen: { url: string; body: unknown }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    if (url === "/api/pair/info") return Response.json({ hostId: "h" });
    seen.push({ url, body: JSON.parse(String(init.body ?? "null")) });
    return Response.json({});
  }) as typeof fetch;
  try {
    await expandTile("art_1", "screen-2");
    await expandTile(null);
    expect(seen).toEqual([
      { url: "/api/stage/expand", body: { tile: "art_1", screen: "screen-2" } },
      { url: "/api/stage/expand", body: { tile: null, screen: "main" } },
    ]);
    // Offline, nothing is held back to replay minutes later over a screen that has moved on.
    Object.defineProperty(globalThis.navigator, "onLine", { value: false, configurable: true });
    seen.length = 0;
    await expandTile("art_1");
    expect(seen).toEqual([]);
  } finally {
    globalThis.fetch = realFetch;
    Object.defineProperty(globalThis.navigator, "onLine", { value: true, configurable: true });
  }
});
