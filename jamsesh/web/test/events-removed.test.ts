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

test("a purge of any size is listed in full, so an open feed forgets every line of it", () => {
  const ids = Array.from({ length: 1200 }, (_, i) => 1000 + i);
  (hub as any).snap = { ...(hub as any).snap, removed: [], state: { events: [] } };
  (hub as any).handle({ type: "events-removed", ids: ids.slice(0, 700) });
  (hub as any).handle({ type: "events-removed", ids: ids.slice(700) });
  expect(hub.get().removed).toEqual(ids);
});

test("a state from another room drops the old room's purge ids, so reused ids show", () => {
  const state = (roomId: string, ids: number[]) => ({ session: { roomId }, events: ids.map((id) => ({ id })) });
  (hub as any).snap = { ...(hub as any).snap, removed: [], state: state("room-a", [1, 2, 3]) };
  (hub as any).handle({ type: "events-removed", ids: [2] });
  // The same room re-announcing itself (a reconnect) keeps what it purged.
  (hub as any).handle({ type: "state", state: state("room-a", [1, 3]) });
  expect(hub.get().removed).toEqual([2]);
  // A new room: event 2 there is a different line.
  (hub as any).handle({ type: "state", state: state("room-b", [1, 2]) });
  expect(hub.get().removed).toEqual([]);
  expect(hub.get().state!.events.map((e: any) => e.id)).toEqual([1, 2]);
});

test("the HTTP fallback drops the old room's purge ids too", async () => {
  const state = (roomId: string, ids: number[]) => ({ session: { roomId }, events: ids.map((id) => ({ id })) });
  (hub as any).snap = { ...(hub as any).snap, removed: [2], state: state("room-a", [1, 3]) };
  const real = globalThis.fetch;
  globalThis.fetch = (async () => Response.json(state("room-b", [1, 2]))) as any;
  try {
    await hub.refreshState();
  } finally {
    globalThis.fetch = real;
  }
  expect(hub.get().removed).toEqual([]);
  expect(hub.get().state!.events.map((e: any) => e.id)).toEqual([1, 2]);
});

test("a slow HTTP answer from the old room can't replace the room the socket moved to", async () => {
  const state = (roomId: string, ids: number[]) => ({ session: { roomId }, events: ids.map((id) => ({ id })) });
  (hub as any).snap = { ...(hub as any).snap, removed: [], state: state("room-a", [1]) };
  let answer: (r: Response) => void = () => {};
  const real = globalThis.fetch;
  globalThis.fetch = (() => new Promise<Response>((res) => (answer = res))) as any;
  try {
    const pending = hub.refreshState();
    (hub as any).handle({ type: "state", state: state("room-b", [7, 8]) });
    answer(Response.json(state("room-a", [1, 2, 3])));
    await pending;
  } finally {
    globalThis.fetch = real;
  }
  expect(hub.get().state!.session.roomId).toBe("room-b");
  expect(hub.get().state!.events.map((e: any) => e.id)).toEqual([7, 8]);
});

test("a room change clears the old room's thinking, speaking, levels and toasts", () => {
  const state = (roomId: string) => ({ session: { roomId }, events: [] });
  (hub as any).snap = { ...(hub as any).snap, state: state("room-a"), thinking: "Thinking", speaking: "hi", levels: { d: 1 }, toasts: [{ id: 1 }] };
  (hub as any).handle({ type: "state", state: state("room-b") });
  const s = hub.get();
  expect([s.thinking, s.speaking, s.levels, s.toasts]).toEqual([null, null, {}, []]);
});
