import "fake-indexeddb/auto";
import { expect, test } from "bun:test";

(globalThis as any).location ??= { origin: "http://127.0.0.1:4790", pathname: "/client", search: "" };
(globalThis as any).navigator ??= {};
Object.defineProperty(globalThis.navigator, "onLine", { value: true, configurable: true });

const { hub } = await import("../src/shared/hub");

test("lines the room deleted leave the state and are listed for the feed to forget", () => {
  const ev = (id: number) => ({ id, ts: id, kind: "join", authorType: "agent", authorId: null, authorName: "A", text: "x", relevance: null, workstreamId: null, data: {} });
  (hub as any).snap = { ...(hub as any).snap, state: { events: [ev(1), ev(2), ev(3)] } };
  (hub as any).handle({ type: "events-removed", ids: [2, 3] });
  const snap = hub.get();
  expect(snap.state!.events.map((e) => e.id)).toEqual([1]);
  expect(snap.removed).toEqual([2, 3]);
});
