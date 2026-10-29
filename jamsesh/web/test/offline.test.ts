import "fake-indexeddb/auto";
import { beforeEach, describe, expect, test } from "bun:test";
import { AudioBuffer, AUDIO_MAX_SECONDS, AUDIO_MAX_SEGMENTS, type AudioSeg } from "../src/shared/mic";
import { backoffMs, idbTable, Outbox, resetDbHandle, type OutboxEntry, type SendResult } from "../src/shared/offline";

const wav = (seconds: number) => new ArrayBuffer(44 + Math.round(seconds * 32000));
const settle = () => new Promise((r) => setTimeout(r, 5));

function make(send: (e: OutboxEntry) => Promise<SendResult>, extra: Partial<ConstructorParameters<typeof Outbox>[0]> = {}) {
  const timers: { fn: () => void; ms: number }[] = [];
  const ob = new Outbox({
    table: idbTable<OutboxEntry>("outbox"),
    send,
    random: () => 0.5,
    setTimer: (fn, ms) => (timers.push({ fn, ms }), timers.length),
    clearTimer: () => {},
    ...extra,
  });
  return { ob, timers };
}

beforeEach(async () => {
  await idbTable("outbox").clear();
  await idbTable("audio").clear();
  resetDbHandle();
});

describe("outbox", () => {
  test("sends FIFO with a unique idempotency key per call", async () => {
    const seen: OutboxEntry[] = [];
    let online = false;
    const { ob, timers } = make(async (e) => {
      if (!online) return { kind: "retry" };
      seen.push(e);
      return { kind: "ok" };
    });
    await ob.enqueue("POST", "/say", { text: "one" });
    await ob.enqueue("POST", "/annotations", { x: 1 });
    await ob.enqueue("DELETE", "/people/p1");
    await settle();
    expect(ob.get().pending).toBe(3);
    expect(seen).toHaveLength(0);
    online = true;
    await ob.kick();
    expect(seen.map((e) => e.path)).toEqual(["/say", "/annotations", "/people/p1"]);
    expect(new Set(seen.map((e) => e.idem)).size).toBe(3);
    expect(ob.get().pending).toBe(0);
    expect(ob.get().synced).toBe(3);
    expect(timers.length).toBeGreaterThan(0);
  });

  test("a retried call keeps the same idempotency key", async () => {
    const keys: string[] = [];
    let n = 0;
    const { ob } = make(async (e) => {
      keys.push(e.idem);
      return ++n < 3 ? { kind: "retry" } : { kind: "ok" };
    });
    await ob.enqueue("POST", "/say", { text: "x" });
    await settle();
    await ob.kick();
    await ob.kick();
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
    expect(ob.get().pending).toBe(0);
  });

  test("survives a reload", async () => {
    const a = make(async () => ({ kind: "retry" }));
    await a.ob.enqueue("POST", "/say", { text: "kept" });
    await a.ob.enqueue("POST", "/say", { text: "kept 2" });
    resetDbHandle(); // the page is gone; a new one opens the same database
    const got: string[] = [];
    const b = make(async (e) => (got.push((e.body as any).text), { kind: "ok" }));
    await b.ob.load();
    expect(b.ob.get().pending).toBe(2);
    await b.ob.kick();
    expect(got).toEqual(["kept", "kept 2"]);
  });

  test("caps the queue by count, oldest dropped first", async () => {
    const { ob } = make(async () => ({ kind: "retry" }), { maxItems: 3 });
    for (let i = 0; i < 5; i++) await ob.enqueue("POST", "/say", { i });
    expect(ob.get().items.map((x: any) => x.body.i)).toEqual([2, 3, 4]);
    expect(ob.get().dropped).toBe(2);
  });

  test("drops entries older than the max age on load", async () => {
    let clock = 1_000_000;
    const a = make(async () => ({ kind: "retry" }), { now: () => clock });
    await a.ob.enqueue("POST", "/say", { old: true });
    clock += 8 * 24 * 3600 * 1000;
    await a.ob.enqueue("POST", "/say", { fresh: true });
    resetDbHandle();
    const b = make(async () => ({ kind: "retry" }), { now: () => clock });
    await b.ob.load();
    expect(b.ob.get().items.map((x: any) => x.body)).toEqual([{ fresh: true }]);
  });

  test("backoff grows, is capped, and is jittered", () => {
    expect(backoffMs(0, () => 1)).toBe(1000);
    expect(backoffMs(0, () => 0)).toBe(500);
    expect(backoffMs(3, () => 1)).toBe(8000);
    expect(backoffMs(20, () => 1)).toBe(30000);
    expect(backoffMs(20, () => 0)).toBe(15000);
  });

  test("failed sends schedule increasing backoff timers", async () => {
    const { ob, timers } = make(async () => ({ kind: "retry" }));
    await ob.enqueue("POST", "/say", { a: 1 });
    await settle();
    expect(timers).toHaveLength(1);
    timers[0].fn();
    await settle();
    timers[1].fn();
    await settle();
    expect(timers.map((t) => t.ms)).toEqual([750, 1500, 3000]);
  });

  test("a call the hub refuses (4xx) is dropped and does not block the queue", async () => {
    const sent: string[] = [];
    const { ob } = make(async (e) => {
      sent.push(e.path);
      return e.path === "/bad" ? { kind: "drop", status: 400 } : { kind: "ok" };
    });
    await ob.enqueue("POST", "/bad", {});
    await ob.enqueue("POST", "/good", {});
    await settle();
    expect(sent).toEqual(["/bad", "/good"]);
    expect(ob.get().dropped).toBe(1);
    expect(ob.get().synced).toBe(1);
  });

  test("401 stops the queue and keeps the work", async () => {
    let unauthorized = 0;
    const { ob } = make(async () => ({ kind: "unauthorized" }));
    ob.onUnauthorized = () => unauthorized++;
    await ob.enqueue("POST", "/say", { text: "x" });
    await settle();
    expect(unauthorized).toBe(1);
    expect(ob.get().pending).toBe(1);
  });
});

describe("outbox flush loop", () => {
  test("two flushes started together send each call once", async () => {
    await idbTable<OutboxEntry>("outbox").add({ idem: "a", method: "POST", path: "/say", body: {}, createdAt: Date.now(), serverFails: 0, hostId: "" });
    const sent: string[] = [];
    // A fresh page: nothing loaded yet when a kick and a timer both flush.
    const { ob } = make(async (e) => {
      sent.push(e.idem);
      await settle();
      return { kind: "ok" };
    });
    await Promise.all([ob.flush(), ob.flush()]);
    expect(sent).toEqual(["a"]);
    expect(ob.get().synced).toBe(1);
  });

  test("a flush that something re-arms on every pass still lets timers run", async () => {
    let passes = 0;
    let timerRan = false;
    const holder: { ob?: Outbox } = {};
    const { ob } = make(async () => ({ kind: "ok" }), {
      // Stands in for a store listener that calls flush() each time the outbox changes.
      canSend: () => {
        passes++;
        if (!timerRan && passes < 5000) void holder.ob?.flush();
        return true;
      },
    });
    holder.ob = ob;
    setTimeout(() => (timerRan = true), 0);
    await ob.flush();
    // Back-to-back microtask passes never reach the timer: the loop would run all 5000 first.
    expect(timerRan).toBe(true);
    expect(passes).toBeLessThan(5000);
  });
});

describe("audio buffer", () => {
  const seg = (t0: number, secs = 2): AudioSeg => ({ deviceId: "d1", t0, t1: t0 + secs * 1000, level: -30, noise: -60, wav: wav(secs) });

  test("buffers while offline, then uploads oldest first with original timestamps", async () => {
    let up = false;
    const posted: AudioSeg[] = [];
    const ab = new AudioBuffer(idbTable<AudioSeg>("audio"), async (s) => (up ? (posted.push(s), "ok") : "retry"), () => up);
    await ab.submit(seg(5000));
    await ab.submit(seg(1000));
    await ab.submit(seg(3000));
    expect(ab.get().segments).toBe(3);
    expect(ab.get().seconds).toBe(6);
    up = true;
    await ab.kick();
    expect(posted.map((p) => p.t0)).toEqual([1000, 3000, 5000]);
    expect(posted.map((p) => p.t1)).toEqual([3000, 5000, 7000]);
    expect(ab.get().segments).toBe(0);
    expect(ab.get().uploaded).toBe(3);
  });

  test("goes straight to the hub when it is reachable", async () => {
    const posted: number[] = [];
    const ab = new AudioBuffer(idbTable<AudioSeg>("audio"), async (s) => (posted.push(s.t0), "ok"), () => true);
    await ab.submit(seg(100));
    expect(posted).toEqual([100]);
    expect(ab.get().segments).toBe(0);
  });

  test("caps at 60 segments and about 3 minutes, dropping the oldest", async () => {
    const ab = new AudioBuffer(idbTable<AudioSeg>("audio"), async () => "retry", () => false);
    for (let i = 0; i < 70; i++) await ab.submit(seg(i * 1000, 1));
    expect(ab.get().segments).toBe(AUDIO_MAX_SEGMENTS);
    const ab2 = new AudioBuffer(idbTable<AudioSeg>("audio"), async () => "retry", () => false);
    await idbTable("audio").clear();
    for (let i = 0; i < 20; i++) await ab2.submit(seg(i * 20000, 20));
    expect(ab2.get().seconds).toBeLessThanOrEqual(AUDIO_MAX_SECONDS);
    expect(ab2.get().segments).toBe(9);
  });

  test("survives a reload", async () => {
    const a = new AudioBuffer(idbTable<AudioSeg>("audio"), async () => "retry", () => false);
    await a.submit(seg(1000));
    resetDbHandle();
    const posted: number[] = [];
    const b = new AudioBuffer(idbTable<AudioSeg>("audio"), async (s) => (posted.push(s.t0), "ok"), () => true);
    await b.drain();
    expect(posted).toEqual([1000]);
  });
});

describe("outbox host safety", () => {
  test("nothing replays while the host is unconfirmed", async () => {
    const seen: string[] = [];
    let confirmed = false;
    const { ob } = make(async (e) => (seen.push(e.path), { kind: "ok" }), { hostId: () => "hostA", canSend: () => confirmed });
    await ob.enqueue("POST", "/say", { t: 1 });
    await settle();
    expect(seen).toHaveLength(0);
    confirmed = true;
    await ob.kick();
    expect(seen).toEqual(["/say"]);
  });

  test("calls stamped for another host never replay", async () => {
    const seen: string[] = [];
    let host = "hostA";
    const { ob } = make(async (e) => (seen.push(e.path), { kind: "ok" }), { hostId: () => host, canSend: () => false });
    await ob.enqueue("POST", "/a", {});
    host = "hostB";
    const b = make(async (e) => (seen.push(e.path), { kind: "ok" }), { hostId: () => host, canSend: () => true });
    await b.ob.load();
    await b.ob.enqueue("POST", "/b", {});
    await settle();
    expect(seen).toEqual(["/b"]);
    expect(b.ob.get().pending).toBe(1);
    expect(b.ob.get().items[0].path).toBe("/a");
  });

  test("a 409 from a host switch keeps the call and delivers it once its host is back", async () => {
    const seen: string[] = [];
    let relay = "hostB"; // the relay already points at another host when the call goes out
    const { ob, timers } = make(async (e) => (relay !== e.hostId ? { kind: "otherHost" } : (seen.push(e.path), { kind: "ok" })), { hostId: () => "hostA", canSend: () => true });
    await ob.enqueue("POST", "/a", {});
    await settle();
    expect(seen).toEqual([]);
    expect(ob.get().pending).toBe(1);
    expect(ob.get().dropped).toBe(0);
    expect(timers.length).toBeGreaterThan(0); // retried later with backoff, not in a tight loop
    relay = "hostA";
    await ob.kick();
    expect(seen).toEqual(["/a"]);
    expect(ob.get().pending).toBe(0);
    expect(ob.get().synced).toBe(1);
  });
});
