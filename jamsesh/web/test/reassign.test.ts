// The Reassign button reaches the hub's real route (the api() helper adds /api itself) and names the tile's agent.
import "fake-indexeddb/auto";
import { expect, test } from "bun:test";

(globalThis as any).location ??= { origin: "http://127.0.0.1:4790", pathname: "/client", search: "" };
(globalThis as any).navigator ??= {};
Object.defineProperty(globalThis.navigator, "onLine", { value: true, configurable: true });

const { reassignTask } = await import("../src/shared/ui");

test("reassign posts to /api/directives/:id/reassign for the tile's agent, and a refusal reaches the caller", async () => {
  const realFetch = globalThis.fetch;
  const seen: { url: string; body: any }[] = [];
  let status = 200;
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    seen.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
    return status === 200 ? Response.json({ id: "d_2" }) : Response.json({ error: "Nobody else is free to take it" }, { status: 400 });
  }) as any;
  try {
    await reassignTask("d_1", "a_1");
    expect(seen[0].url).toBe("/api/directives/d_1/reassign");
    expect(seen[0].body.agentId).toBe("a_1");
    status = 400;
    await expect(reassignTask("d_1", "a_1")).rejects.toThrow("Nobody else is free");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a tile shows every task offered for reassignment, even past the ones it has room for", async () => {
  const { tasksToShow } = await import("../src/shared/ui");
  const task = (id: string, offered = false) => ({ id, ts: Number(id.slice(2)), text: id, targets: ["a_1"], progress: { a_1: "acked" }, ...(offered ? { reassignOfferedAt: { a_1: 1 } } : {}) }) as any;
  const four = [task("d_1"), task("d_2"), task("d_3"), task("d_4", true)];
  expect(tasksToShow(four, "a_1", 3).map((d) => d.id)).toEqual(["d_4", "d_1", "d_2"]);
  expect(tasksToShow(four, "a_1", 1).map((d) => d.id)).toEqual(["d_4"]);
  // Two offers in a compact tile (room for one): both show.
  const two = [task("d_1", true), task("d_2"), task("d_3", true)];
  expect(tasksToShow(two, "a_1", 1).map((d) => d.id)).toEqual(["d_1", "d_3"]);
  // An offer to another target of the same task doesn't count for this tile.
  expect(tasksToShow([task("d_1"), { ...task("d_2"), reassignOfferedAt: { a_9: 1 } }], "a_1", 1).map((d) => d.id)).toEqual(["d_1"]);
});
