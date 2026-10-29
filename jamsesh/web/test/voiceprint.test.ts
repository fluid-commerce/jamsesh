import "fake-indexeddb/auto";
import { beforeEach, expect, test } from "bun:test";

const store = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
(globalThis as any).location = { origin: "http://10.0.0.2:4747" };

const { beginRead, carryAllowed, carriesToOtherHosts, localCopy, pushCopy, pullCopy, setCarryAllowed, syncVoiceprint } = await import("../src/shared/voiceprint");
const { setHostKey } = await import("../src/shared/identity");
setHostKey("hostB");

const emb = (v: number) => new Array(256).fill(v);
const copy = (over: Record<string, unknown> = {}) => ({ model: "wespeaker_en", dim: 256, samples: [{ kind: "enrol", embedding: emb(0.0625) }], ...over });
const key = (p: string) => `jamsesh.voiceprint.v2::${p}`;
let calls: { method: string; path: string; body: any }[] = [];
let reply: (method: string, path: string) => { status: number; body: unknown } = () => ({ status: 200, body: { ok: true } });

beforeEach(() => {
  store.clear();
  calls = [];
  reply = () => ({ status: 200, body: { ok: true } });
  delete (globalThis as any).__TAURI_INTERNALS__;
  (globalThis as any).fetch = async (url: string, init: RequestInit = {}) => {
    const path = String(url).replace(/^\/api/, "");
    const method = init.method ?? "GET";
    calls.push({ method, path, body: typeof init.body === "string" ? JSON.parse(init.body) : init.body });
    const r = reply(method, path);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  };
});

test("nothing leaves the device until the person agrees, and the choice is that person's alone", async () => {
  expect(await carryAllowed("p1")).toBe(false);
  store.set(key("p1"), JSON.stringify(copy()));
  await syncVoiceprint({ id: "p1" });
  expect(calls).toHaveLength(0);
  await setCarryAllowed("p1", true);
  expect(await carryAllowed("p1")).toBe(true);
  // Someone else on this browser: no copy, no yes.
  expect(await carryAllowed("p2")).toBe(false);
  expect(await localCopy("p2")).toBeNull();
});

test("an old copy that wasn't kept per person is never used", async () => {
  store.set("jamsesh.voiceprint.v1", JSON.stringify(copy()));
  store.set("jamsesh.voiceCarry", "true");
  expect(await carryAllowed("p1")).toBe(false);
  expect(await localCopy("p1")).toBeNull();
  expect(store.has("jamsesh.voiceprint.v1")).toBe(false);
});

test("a host that doesn't know the voice gets the device's copy, embeddings only, then the device keeps the host's", async () => {
  await setCarryAllowed("p1", true);
  store.set(key("p1"), JSON.stringify(copy({ host: "hostA", version: "a1", updatedAt: 10 })));
  let pushed = false;
  reply = (m) => (m === "PUT" ? ((pushed = true), { status: 200, body: { ok: true } }) : { status: 200, body: pushed ? copy({ version: "b1", updatedAt: 20 }) : copy({ samples: [], version: "", updatedAt: 0 }) });
  await syncVoiceprint({ id: "p1" });
  expect(calls.map((c) => c.method)).toEqual(["GET", "PUT", "GET"]);
  expect(Object.keys(calls[1].body).sort()).toEqual(["dim", "model", "samples"]);
  expect(JSON.stringify(calls[1].body)).not.toMatch(/audio|wav|blob/i);
  expect(await localCopy("p1")).toMatchObject({ host: "hostB", version: "b1" });
});

test("on the same host, a changed version replaces the copy and an unchanged one leaves it, whatever the counts", async () => {
  await setCarryAllowed("p1", true);
  // Same number of samples, different ones: the version says so.
  store.set(key("p1"), JSON.stringify(copy({ host: "hostB", version: "b1", updatedAt: 10 })));
  reply = () => ({ status: 200, body: copy({ samples: [{ kind: "correction", embedding: emb(0.03) }], version: "b2", updatedAt: 30 }) });
  await syncVoiceprint({ id: "p1" });
  expect(calls.map((c) => c.method)).toEqual(["GET"]);
  expect((await localCopy("p1"))?.version).toBe("b2");
  calls = [];
  await syncVoiceprint({ id: "p1" });
  expect(calls.map((c) => c.method)).toEqual(["GET"]);
});

test("a newer copy from another host is given to this host, never replaced by this host's older one", async () => {
  await setCarryAllowed("p1", true);
  const mine = copy({ samples: Array.from({ length: 32 }, (_, i) => ({ kind: "enrol", embedding: emb(i / 100) })), host: "hostA", version: "a9", updatedAt: 500 });
  store.set(key("p1"), JSON.stringify(mine));
  reply = (m) => (m === "PUT" ? { status: 200, body: { ok: true } } : { status: 200, body: copy({ version: "b1", updatedAt: 100 }) });
  await syncVoiceprint({ id: "p1" });
  expect(calls[1]).toMatchObject({ method: "PUT", path: "/people/p1/voiceprint" });
  expect(calls[1].body.samples).toHaveLength(32);
});

test("an older copy from another host gives way to this host's newer one", async () => {
  await setCarryAllowed("p1", true);
  store.set(key("p1"), JSON.stringify(copy({ host: "hostA", version: "a1", updatedAt: 50 })));
  reply = () => ({ status: 200, body: copy({ version: "b7", updatedAt: 900 }) });
  await syncVoiceprint({ id: "p1" });
  expect(calls.map((c) => c.method)).toEqual(["GET"]);
  expect(await localCopy("p1")).toMatchObject({ host: "hostB", version: "b7" });
});

test("a refused or failed call changes nothing and never throws", async () => {
  await setCarryAllowed("p1", true);
  store.set(key("p1"), JSON.stringify(copy()));
  reply = () => ({ status: 403, body: { error: "A voice is only for its own person to give." } });
  expect(await pushCopy("someone-else")).toBe(false);
  expect(await pullCopy("someone-else")).toBe(false);
  (globalThis as any).fetch = async () => {
    throw new TypeError("network down");
  };
  await syncVoiceprint({ id: "p1" });
  expect(await localCopy("p1")).toEqual(copy());
});

test("turning it off forgets the copy on this device", async () => {
  await setCarryAllowed("p1", true);
  store.set(key("p1"), JSON.stringify(copy()));
  await setCarryAllowed("p1", false);
  expect(await localCopy("p1")).toBeNull();
  expect(await carryAllowed("p1")).toBe(false);
});

test("in the Mac app the app keeps the copy, for the person the page says, and a refusal keeps nothing", async () => {
  const invoked: { cmd: string; args: any }[] = [];
  const kept = new Map<string, { consent: boolean | null; copy: unknown }>();
  (globalThis as any).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args: any) => {
      invoked.push({ cmd, args });
      // The app checks with the host which person this window is.
      if (args.personId !== "p1") throw "This window is someone else now.";
      const k = kept.get(args.personId) ?? { consent: null, copy: null };
      if (cmd === "voiceprint_get") return k;
      if (cmd === "voiceprint_consent") return void kept.set(args.personId, { consent: args.on, copy: args.on ? k.copy : null });
      if (cmd === "voiceprint_put") return void kept.set(args.personId, { ...k, copy: args.copy });
    },
  };
  expect(carriesToOtherHosts()).toBe(true);
  await setCarryAllowed("p1", true);
  reply = () => ({ status: 200, body: copy({ version: "b1", updatedAt: 5 }) });
  expect(await pullCopy("p1")).toBe(true);
  expect(kept.get("p1")?.copy).toMatchObject({ host: "hostB", version: "b1" });
  expect(store.size).toBe(0);
  // Asking for someone else's: refused by the app, so nothing at all.
  expect(await localCopy("p2")).toBeNull();
  expect(await carryAllowed("p2")).toBe(false);
  expect(invoked.every((c) => typeof c.args.personId === "string")).toBe(true);
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
