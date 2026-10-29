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

test("Expand goes out through the real api() helper to the hub's expand route, is never queued for later, and says when it fails", async () => {
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
    // ...and the person is told rather than left wondering.
    expect(await expandTile("art_1")).toBe("Not connected to the host. Try again when you're back.");
    expect(seen).toEqual([]);
    // The hub refusing (a tile that's gone) is said in its words.
    Object.defineProperty(globalThis.navigator, "onLine", { value: true, configurable: true });
    globalThis.fetch = (async (url: string) => (url === "/api/pair/info" ? Response.json({ hostId: "h" }) : Response.json({ error: "That isn't on the screen right now." }, { status: 404 }))) as typeof fetch;
    expect(await expandTile("art_gone")).toBe("That isn't on the screen right now.");
  } finally {
    globalThis.fetch = realFetch;
    Object.defineProperty(globalThis.navigator, "onLine", { value: true, configurable: true });
  }
});

test("a cast resolves with what the hub said, not with the click, and the failure note has a place to show on host screens", async () => {
  (globalThis as any).location ??= { origin: "http://127.0.0.1:4790", pathname: "/client", search: "" };
  (globalThis as any).navigator ??= {};
  Object.defineProperty(globalThis.navigator, "onLine", { value: true, configurable: true });
  const { cast, putOnScreen } = await import("../src/client/CastPicker");
  const realFetch = globalThis.fetch;
  let reply: Response = Response.json({});
  globalThis.fetch = (async (url: string) => (url === "/api/pair/info" ? Response.json({ hostId: "h" }) : reply.clone())) as typeof fetch;
  try {
    expect(await putOnScreen({ mode: "agents" })).toBe(true);
    expect(await cast({ mode: "agents" })).toBe(true);
    reply = Response.json({ error: "Chey has this screen locked." }, { status: 409 });
    expect(await putOnScreen({ mode: "agents" })).toBe(false);
    expect(await cast({ mode: "agents" })).toBe(false);
  } finally {
    globalThis.fetch = realFetch;
  }
  // The note's listener is mounted on host windows too (only the picker is people's apps' alone).
  const main = await Bun.file(new URL("../src/main.tsx", import.meta.url)).text();
  expect(main).toMatch(/<CastHost picker=\{!isHost\} \/>/);
  expect(main).not.toMatch(/!isHost && <CastHost/);
});
