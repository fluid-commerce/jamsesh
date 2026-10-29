import "fake-indexeddb/auto";
import { beforeEach, expect, test } from "bun:test";

const { beginRead, endRead } = await import("../src/shared/voiceprint");
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
  (globalThis as any).fetch = async (url: string, init: RequestInit = {}) => (calls.push({ method: init.method ?? "GET", path: String(url), body: null }), new Response('{"ok":true}', { status: 200 }));
  await expect(beginRead("p1")).resolves.toMatchObject({ ok: true });
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

test("nothing about a voice is kept on the device", async () => {
  const mod = await import("../src/shared/voiceprint");
  expect(Object.keys(mod).sort()).toEqual(["beginRead", "endRead"]);
});
