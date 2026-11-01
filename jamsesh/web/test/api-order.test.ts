// Edits go out one at a time in the order they were made, and a direct send is saved before it leaves and removed
// once the hub answers, so a window closed mid-request still has it next time. fetch is stubbed; nothing plays.
import "fake-indexeddb/auto";
import { afterAll, afterEach, expect, test } from "bun:test";
import { api } from "../src/shared/hub";
import { outbox } from "../src/shared/offline";

const realFetch = globalThis.fetch;
afterEach(() => (globalThis.fetch = realFetch));
// Nothing this file queued is left for a test in another file (they share the process and its outbox).
afterAll(async () => {
  outbox.stop();
  await (outbox as any).d.table.clear();
  (outbox as any).entries = [];
  (outbox as any).publish();
});

test("two edits made back to back reach the hub in the order they were made, even when the first is slow", async () => {
  const seen: string[] = [];
  globalThis.fetch = (async (_u: string, init: any) => {
    const b = JSON.parse(init.body);
    if (b.n === 1) await Bun.sleep(60);
    seen.push(`n${b.n}`);
    return new Response("{}");
  }) as any;
  await Promise.all([api("/tasks/a", { n: 1 }, "PATCH"), api("/tasks/a", { n: 2 }, "PATCH")]);
  expect(seen).toEqual(["n1", "n2"]);
});

test("a call that is out is already saved on this laptop, and is gone once the hub has answered", async () => {
  await outbox.load();
  let during = -1;
  globalThis.fetch = (async () => {
    during = (await (outbox as any).d.table.all()).length;
    return new Response("{}");
  }) as any;
  await api("/tasks/b", { n: 1 }, "PATCH");
  expect(during).toBe(1);
  expect((await (outbox as any).d.table.all()).length).toBe(0);
});

test("a call whose request never finishes stays saved to be sent again with the same key", async () => {
  await outbox.load();
  const keys: string[] = [];
  globalThis.fetch = (async (_u: string, init: any) => {
    keys.push(init.headers["x-jam-idem"]);
    throw new Error("down");
  }) as any;
  const r: any = await api("/tasks/c", { n: 1 }, "PATCH");
  expect(r.queued).toBe(true);
  expect(keys[0]).toBe(r.idem);
  const rows = await (outbox as any).d.table.all();
  expect(rows.filter((x: any) => x.idem === r.idem).length).toBe(1); // queued once; the held copy is gone
  outbox.stop();
});

test("a speech segment is saved before its upload starts and removed after the hub took it", async () => {
  const { AudioBuffer } = await import("../src/shared/mic");
  const rows = new Map<number, any>();
  let n = 0;
  const table: any = { all: async () => [...rows.values()], add: async (r: any) => (rows.set(++n, r), n), delete: async (k: number) => void rows.delete(k) };
  let during = -1;
  const buf = new AudioBuffer(table, async () => ((during = rows.size), "ok"), () => true);
  await buf.submit({ deviceId: "d", t0: 1, t1: 2, level: 1, noise: 0, wav: new ArrayBuffer(44) });
  expect(during).toBe(1);
  expect(rows.size).toBe(0);
  // An upload that never finishes (the window closes) leaves the segment for the next load.
  const stuck = new AudioBuffer(table, () => new Promise(() => {}), () => true);
  void stuck.submit({ deviceId: "d", t0: 3, t1: 4, level: 1, noise: 0, wav: new ArrayBuffer(44) });
  await Bun.sleep(20);
  expect(rows.size).toBe(1);
});

test("editing an annotation's text sends only the text, so a queued edit can't reopen a pin someone else finished", async () => {
  await (outbox as any).d.table.clear();
  (outbox as any).entries = [];
  (outbox as any).publish();
  const sent: any[] = [];
  globalThis.fetch = (async (_u: string, init: any) => (sent.push(JSON.parse(init.body)), new Response("{}"))) as any;
  const { patchPinForTest } = await import("../src/shared/annotate");
  await patchPinForTest({ id: "a1", text: "old", status: "open" } as any, { text: "new" });
  await patchPinForTest({ id: "a1", text: "new", status: "open" } as any, { status: "done" });
  expect(sent).toEqual([{ text: "new" }, { status: "done" }]);
});

test("two speech segments reach the hub oldest first even when the first upload is slow", async () => {
  const { AudioBuffer } = await import("../src/shared/mic");
  const rows = new Map<number, any>();
  let n = 0;
  const table: any = { all: async () => [...rows.values()], add: async (r: any) => (rows.set(++n, r), n), delete: async (k: number) => void rows.delete(k) };
  const done: number[] = [];
  const post = async (s: any) => {
    if (s.t0 === 1) await Bun.sleep(50);
    done.push(s.t0);
    return "ok" as const;
  };
  const buf = new AudioBuffer(table, post, () => true);
  const seg = (t0: number) => ({ deviceId: "d", t0, t1: t0 + 1, level: 1, noise: 0, wav: new ArrayBuffer(44) });
  await Promise.all([buf.submit(seg(1)), buf.submit(seg(2))]);
  expect(done).toEqual([1, 2]);
});

test("an answer that breaks off while it is being read is an unknown outcome: the held copy becomes a queued retry with the same key", async () => {
  await (outbox as any).d.table.clear();
  (outbox as any).entries = [];
  (outbox as any).publish();
  const keys: string[] = [];
  globalThis.fetch = (async (_u: string, init: any) => {
    keys.push(init.headers["x-jam-idem"]);
    return { ok: true, status: 200, text: async () => Promise.reject(new Error("reset")), headers: new Headers() } as any;
  }) as any;
  const r: any = await api("/tasks/d", { n: 1 }, "PATCH");
  expect(r.queued).toBe(true);
  expect(r.idem).toBe(keys[0]);
  outbox.stop();
});

test("a speech segment carries the host it was captured for, and one refused by another host stays buffered", async () => {
  const { AudioBuffer } = await import("../src/shared/mic");
  const rows = new Map<number, any>();
  let n = 0;
  const table: any = { all: async () => [...rows.values()], add: async (r: any) => (rows.set(++n, r), n), delete: async (k: number) => void rows.delete(k) };
  const seen: (string | undefined)[] = [];
  const post = async (s: any) => (seen.push(s.hostId), "retry" as const);
  const buf = new AudioBuffer(table, post, () => true);
  await buf.submit({ deviceId: "d", t0: 1, t1: 2, level: 1, noise: 0, wav: new ArrayBuffer(44), hostId: "hostA" });
  expect(seen[0]).toBe("hostA");
  expect(rows.size).toBe(1); // refused for now: kept
  buf.kick();
});

test("a segment captured before the clock synced is sent with the same times on every attempt, even if the offset changes between them", async () => {
  const { AudioBuffer } = await import("../src/shared/mic");
  const { hub } = await import("../src/shared/hub");
  const rows = new Map<number, any>();
  let n = 0;
  const table: any = { all: async () => [...rows.values()], add: async (r: any) => (rows.set(++n, { ...r, seq: n }), n), delete: async (k: number) => void rows.delete(k) };
  const times: number[] = [];
  let tries = 0;
  const post = async (s: any) => (times.push(s.t0), ++tries === 1 ? ("retry" as const) : ("ok" as const));
  (hub as any).set({ clockOffset: 100 });
  const buf = new AudioBuffer(table, post, () => true);
  await buf.submit({ deviceId: "d", t0: 1000, t1: 1100, level: 1, noise: 0, wav: new ArrayBuffer(44), unsynced: true });
  (hub as any).set({ clockOffset: 250 }); // a later sync moves the offset
  await buf.kick();
  expect(times).toEqual([1100, 1100]);
  (hub as any).set({ clockOffset: 0 });
});

test("queued work carries the session it was made in, and one the hub says belongs to another session is dropped, not retried", async () => {
  const { sendEntry, setRoomSource } = await import("../src/shared/offline");
  setRoomSource(() => "room_today");
  const seen: (string | null)[] = [];
  globalThis.fetch = (async (_u: string, init: any) => (seen.push(new Headers(init.headers).get("x-jam-room")), new Response("That change was made for a different JamSesh session.", { status: 409 }))) as any;
  const r = await sendEntry({ idem: "i1", method: "POST", path: "/say", body: {}, createdAt: Date.now(), serverFails: 0, hostId: "", roomId: "room_yesterday" } as any);
  expect(seen).toEqual(["room_yesterday"]);
  expect(r.kind).toBe("drop");
  setRoomSource(() => "");
});

test("an edit keeps the session it was made in while it waits its turn, and when it has to be queued", async () => {
  const { setRoomSource } = await import("../src/shared/offline");
  await (outbox as any).d.table.clear();
  (outbox as any).entries = [];
  (outbox as any).publish();
  setRoomSource(() => "room_A");
  const rooms: (string | null)[] = [];
  globalThis.fetch = (async (_u: string, init: any) => {
    const b = JSON.parse(init.body);
    rooms.push(new Headers(init.headers).get("x-jam-room"));
    if (b.n === 1) await Bun.sleep(60); // the first edit is slow, so the second waits its turn
    if (b.n === 2) throw new Error("down");
    return new Response("{}");
  }) as any;
  const first = api("/tasks/e", { n: 1 }, "PATCH");
  const second = api("/tasks/e", { n: 2 }, "PATCH"); // made in room A, waiting
  setRoomSource(() => "room_B"); // the window moves to another session meanwhile
  await Promise.all([first, second]);
  expect(rooms[1]).toBe("room_A");
  const queued = (outbox as any).entries.find((e: any) => e.body?.n === 2);
  expect(queued?.roomId).toBe("room_A"); // queued under the room it was made in
  setRoomSource(() => "");
  outbox.stop();
});

test("a segment whose adjusted copy can't be saved isn't sent, and keeps its saved original", async () => {
  const { AudioBuffer } = await import("../src/shared/mic");
  const { hub } = await import("../src/shared/hub");
  const rows = new Map<number, any>();
  let n = 0;
  const table: any = {
    all: async () => [...rows.values()],
    add: async (r: any) => (rows.set(++n, { ...r, seq: n }), n),
    delete: async (k: number) => void rows.delete(k),
    replace: async () => {
      throw new Error("quota");
    },
  };
  let posted = 0;
  (hub as any).set({ clockOffset: 100 });
  const buf = new AudioBuffer(table, async () => (posted++, "ok" as const), () => true);
  await buf.submit({ deviceId: "d", t0: 1000, t1: 1100, level: 1, noise: 0, wav: new ArrayBuffer(44), unsynced: true });
  expect(posted).toBe(0);
  const saved = [...rows.values()][0];
  expect([saved.t0, saved.unsynced]).toEqual([1000, true]); // the original, untouched
  (hub as any).set({ clockOffset: 0 });
});
