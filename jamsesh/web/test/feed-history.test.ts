import "fake-indexeddb/auto";
import { expect, test } from "bun:test";

(globalThis as any).location ??= { origin: "http://127.0.0.1:4790", pathname: "/client", search: "" };
(globalThis as any).navigator ??= {};

const { historyCursor, capFeed, feedAdmits } = await import("../src/shared/ui");
const { hub } = await import("../src/shared/hub");

test("history pages from the oldest event the window has, even when the feed shows none of them", () => {
  // The state's window: only canvas and system events, none the feed shows.
  expect(historyCursor([910, 905, 930])).toBe(905);
  expect(historyCursor(new Map([[40, {}], [12, {}]]).keys())).toBe(12);
  expect(historyCursor([])).toBeUndefined();
});

test("the feed's size cap always applies and the list stays contiguous: following cuts the oldest end, scrolled away the newest", () => {
  const mk = (n: number) => new Map(Array.from({ length: n }, (_, i) => [i + 1, {}] as [number, unknown]));
  const a = mk(20);
  expect(capFeed(a, true, 10)).toBe("oldest");
  expect([...a.keys()]).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  const b = mk(20);
  expect(capFeed(b, false, 10)).toBe("newest"); // scrolled away: still capped, still an unbroken run
  expect([...b.keys()].sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  expect(capFeed(mk(10), false, 10)).toBeNull();
});

test("while the reader is away nothing newer than the line they left is added, so the list never has a gap", () => {
  expect(feedAdmits(true, 0, 500)).toBe(true);
  expect(feedAdmits(false, 100, 101)).toBe(false);
  expect(feedAdmits(false, 100, 100)).toBe(true);
  expect(feedAdmits(false, 100, 40)).toBe(true);
});

test("the hub client announces each new event as it arrives, so a burst past the 400-event window is still counted", () => {
  const h = hub as any;
  h.handle({ type: "state", state: { events: [], utterances: [] } });
  let n = 0;
  const off = hub.onEvent(() => void n++);
  for (let id = 1; id <= 650; id++) h.handle({ type: "event", event: { id, kind: "speech", text: "x", data: {} } });
  expect(n).toBe(650);
  expect(hub.get().state!.events.length).toBe(400); // the window dropped 250, the listener saw them all
  h.handle({ type: "event", event: { id: 650, kind: "speech", text: "again", data: {} } }); // an update, not a new event
  expect(n).toBe(650);
  off();
  h.handle({ type: "event", event: { id: 651, kind: "speech", text: "x", data: {} } });
  expect(n).toBe(650);
});

test("lines that arrived while the client was disconnected are announced when the snapshot replaces the state", () => {
  const h = hub as any;
  h.handle({ type: "state", state: { events: [{ id: 5, kind: "speech", text: "a", data: {} }], utterances: [] } });
  const seen: number[] = [];
  const off = hub.onEvent((e) => void seen.push(e.id));
  h.handle({ type: "state", state: { events: [5, 6, 7, 8].map((id) => ({ id, kind: "speech", text: "x", data: {} })), utterances: [] } });
  expect(seen).toEqual([6, 7, 8]);
  off();
});

test("an HTTP state answer that was in flight while the socket delivered newer state is ignored", async () => {
  const h = hub as any;
  h.handle({ type: "state", state: { events: [{ id: 2, kind: "speech", text: "a", data: {} }], utterances: [] } });
  const realFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => {
    h.handle({ type: "event", event: { id: 3, kind: "speech", text: "newer", data: {} } }); // the socket moves on while the request is out
    return new Response(JSON.stringify({ events: [{ id: 2, kind: "speech", text: "a", data: {} }], utterances: [] }), { headers: { "content-type": "application/json" } });
  };
  try {
    await hub.refreshState();
  } finally {
    globalThis.fetch = realFetch;
  }
  expect(hub.get().state!.events.map((e: any) => e.id)).toEqual([2, 3]); // not regressed to [2]
});

test("a reconnect while an HTTP state request is out also discards that answer", async () => {
  const h = hub as any;
  h.handle({ type: "state", state: { events: [{ id: 2, kind: "speech", text: "a", data: {} }], utterances: [] } });
  const realFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => {
    h.set({ epoch: h.snap.epoch + 1 }); // the socket reconnected; state identity is untouched
    return new Response(JSON.stringify({ events: [], utterances: [] }), { headers: { "content-type": "application/json" } });
  };
  try {
    await hub.refreshState();
  } finally {
    globalThis.fetch = realFetch;
  }
  expect(hub.get().state!.events.map((e: any) => e.id)).toEqual([2]);
});
