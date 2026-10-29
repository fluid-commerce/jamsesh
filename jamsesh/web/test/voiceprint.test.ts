import "fake-indexeddb/auto";
import { beforeEach, expect, test } from "bun:test";

const { beginRead, endRead, forgetDeviceCopies } = await import("../src/shared/voiceprint");
let calls: { method: string; path: string; body: any }[] = [];
let reply: (method: string, path: string) => { status: number; body: unknown } = () => ({ status: 200, body: { ok: true } });

beforeEach(() => {
  calls = [];
  reply = () => ({ status: 200, body: { ok: true } });
  (globalThis as any).fetch = async (url: string, init: RequestInit = {}) => {
    const path = String(url).replace(/^\/api/, "");
    const method = init.method ?? "GET";
    calls.push({ method, path, body: typeof init.body === "string" ? JSON.parse(init.body) : init.body });
    const r = reply(method, path);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  };
});

test("starting the join read fails out loud when the host didn't take it, and is never queued for later", async () => {
  reply = () => ({ status: 403, body: { error: "A voice is only for its own person to give." } });
  await expect(beginRead("p2")).rejects.toThrow("A voice is only for its own person to give.");
  (globalThis as any).fetch = async () => {
    throw new TypeError("network down");
  };
  await expect(beginRead("p1")).rejects.toThrow();
  reply = () => ({ status: 200, body: { ok: true } });
  (globalThis as any).fetch = async (url: string, init: RequestInit = {}) => (calls.push({ method: init.method ?? "GET", path: String(url), body: null }), new Response('{"ok":true,"epoch":3}', { status: 200 }));
  // The host's reset epoch, which the recording goes back with.
  await expect(beginRead("p1")).resolves.toBe(3);
  expect(calls.at(-1)).toMatchObject({ method: "POST", path: "/api/people/p1/voice/start" });
});

test("a failed read is ended on the host, never queued, and never throws", async () => {
  await endRead("p1", false);
  expect(calls.at(-1)).toMatchObject({ method: "POST", path: "/people/p1/voice/end", body: { read: false } });
  (globalThis as any).fetch = async () => {
    throw new TypeError("network down");
  };
  await expect(endRead("p1", true)).resolves.toBeUndefined();
});

/** A Storage that behaves like the browser's, for what the module reads and writes. */
function storage(entries: Record<string, string>) {
  const m = new Map(Object.entries(entries));
  return {
    m,
    get length() {
      return m.size;
    },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  };
}

test("copies of a voice that earlier builds kept in the browser are deleted, and nothing else is", () => {
  const s = storage({
    "jamsesh.voiceprint.v1": "{}",
    "jamsesh.voiceprint.v2::p1": '{"samples":[[0.1]]}',
    "jamsesh.voiceCarry": "true",
    "jamsesh.voiceCarry.v2::p1": "true",
    "jamsesh.identity": '{"name":"Ana"}',
    "jamsesh.voiceprintsHint": "x",
    other: "1",
  });
  expect(forgetDeviceCopies(s)).toBe(4);
  expect([...s.m.keys()].sort()).toEqual(["jamsesh.identity", "jamsesh.voiceprintsHint", "other"]);
  expect(forgetDeviceCopies(s)).toBe(0);
});

test("a whole read keeps nothing about the voice on the device", async () => {
  const s = storage({});
  (globalThis as any).localStorage = s;
  try {
    reply = () => ({ status: 200, body: { ok: true, epoch: 1 } });
    expect(await beginRead("p1")).toBe(1);
    await endRead("p1", true);
    expect(s.m.size).toBe(0);
    const dbs = await indexedDB.databases();
    expect(dbs.filter((d) => /voice/i.test(d.name ?? ""))).toEqual([]);
  } finally {
    delete (globalThis as any).localStorage;
  }
});
