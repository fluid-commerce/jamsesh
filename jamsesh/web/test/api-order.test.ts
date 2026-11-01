// Edits go out one at a time in the order they were made, and a direct send is saved before it leaves and removed
// once the hub answers, so a window closed mid-request still has it next time. fetch is stubbed; nothing plays.
import "fake-indexeddb/auto";
import { afterEach, expect, test } from "bun:test";
import { api } from "../src/shared/hub";
import { outbox } from "../src/shared/offline";

const realFetch = globalThis.fetch;
afterEach(() => (globalThis.fetch = realFetch));

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
