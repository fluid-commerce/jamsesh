import "fake-indexeddb/auto";
import { beforeEach, expect, test } from "bun:test";

const store = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };

const { beginRead, endRead, forgetCopy, carryAllowed, carriesToOtherHosts, localCopy, pushCopy, pullCopy, setCarryAllowed, syncVoiceprint } = await import("../src/shared/voiceprint");
// This page is on host "hostB" (passed in, so the identity module's own state is left alone).
const H = "hostB";

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
  await syncVoiceprint({ id: "p1" }, H);
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
  await syncVoiceprint({ id: "p1" }, H);
  expect(calls.map((c) => c.method)).toEqual(["GET", "PUT", "GET"]);
  expect(Object.keys(calls[1].body).sort()).toEqual(["dim", "model", "samples", "updatedAt"]);
  expect(JSON.stringify(calls[1].body)).not.toMatch(/audio|wav|blob/i);
  expect(await localCopy("p1")).toMatchObject({ host: "hostB", version: "b1" });
});

test("on the same host, a changed version replaces the copy and an unchanged one leaves it, whatever the counts", async () => {
  await setCarryAllowed("p1", true);
  // Same number of samples, different ones: the version says so.
  store.set(key("p1"), JSON.stringify(copy({ host: "hostB", version: "b1", updatedAt: 10 })));
  reply = () => ({ status: 200, body: copy({ samples: [{ kind: "correction", embedding: emb(0.03) }], version: "b2", updatedAt: 30 }) });
  await syncVoiceprint({ id: "p1" }, H);
  expect(calls.map((c) => c.method)).toEqual(["GET"]);
  expect((await localCopy("p1"))?.version).toBe("b2");
  calls = [];
  await syncVoiceprint({ id: "p1" }, H);
  expect(calls.map((c) => c.method)).toEqual(["GET"]);
});

test("a newer copy from another host is given to this host, never replaced by this host's older one", async () => {
  await setCarryAllowed("p1", true);
  const mine = copy({ samples: Array.from({ length: 32 }, (_, i) => ({ kind: "enrol", embedding: emb(i / 100) })), host: "hostA", version: "a9", updatedAt: 500 });
  store.set(key("p1"), JSON.stringify(mine));
  reply = (m) => (m === "PUT" ? { status: 200, body: { ok: true } } : { status: 200, body: copy({ version: "b1", updatedAt: 100 }) });
  await syncVoiceprint({ id: "p1" }, H);
  expect(calls[1]).toMatchObject({ method: "PUT", path: "/people/p1/voiceprint" });
  expect(calls[1].body.samples).toHaveLength(32);
});

test("an older copy from another host gives way to this host's newer one", async () => {
  await setCarryAllowed("p1", true);
  store.set(key("p1"), JSON.stringify(copy({ host: "hostA", version: "a1", updatedAt: 50 })));
  reply = () => ({ status: 200, body: copy({ version: "b7", updatedAt: 900 }) });
  await syncVoiceprint({ id: "p1" }, H);
  expect(calls.map((c) => c.method)).toEqual(["GET"]);
  expect(await localCopy("p1")).toMatchObject({ host: "hostB", version: "b7" });
});

test("a refused or failed call changes nothing, and the sync throws so it's tried again rather than marked done", async () => {
  await setCarryAllowed("p1", true);
  store.set(key("p1"), JSON.stringify(copy()));
  store.set(key("someone-else"), JSON.stringify(copy()));
  await setCarryAllowed("someone-else", true);
  reply = () => ({ status: 403, body: { error: "A voice is only for its own person to give." } });
  await expect(pushCopy("someone-else")).rejects.toThrow("only for its own person");
  expect(await pullCopy("someone-else")).toBe(false);
  await expect(syncVoiceprint({ id: "p1" }, H)).rejects.toThrow("only for its own person");
  (globalThis as any).fetch = async () => {
    throw new TypeError("network down");
  };
  await expect(syncVoiceprint({ id: "p1" }, H)).rejects.toThrow();
  expect(await localCopy("p1")).toEqual(copy());
  expect(await localCopy("someone-else")).toEqual(copy());
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
      // The app's dialog, stubbed: this test's person says Share only when `share` is true.
      if (cmd === "voiceprint_share") return share ? k.copy : null;
    },
  };
  let share = false;
  expect(carriesToOtherHosts()).toBe(true);
  await setCarryAllowed("p1", true);
  reply = () => ({ status: 200, body: copy({ version: "b1", updatedAt: 5 }) });
  expect(await pullCopy("p1", H)).toBe(true);
  expect(kept.get("p1")?.copy).toMatchObject({ host: "hostB", version: "b1" });
  expect(store.size).toBe(0);
  // Asking for someone else's: refused by the app, so nothing at all.
  expect(await localCopy("p2")).toBeNull();
  expect(await carryAllowed("p2")).toBe(false);
  expect(invoked.every((c) => typeof c.args.personId === "string")).toBe(true);
  // A host with nothing gets the copy only after a Share in the app.
  calls = [];
  reply = (m) => ({ status: 200, body: m === "PUT" ? { ok: true } : copy({ samples: [], version: "", updatedAt: 0 }) });
  await syncVoiceprint({ id: "p1" }, "hostC");
  expect(calls.map((c) => c.method)).toEqual(["GET"]);
  share = true;
  calls = [];
  await syncVoiceprint({ id: "p1" }, "hostC");
  expect(calls.map((c) => c.method)).toEqual(["GET", "PUT", "GET"]);
  expect(calls[1].body.samples).toHaveLength(1);
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

test("a copy the host sealed before the person reset their voice there is deleted here; one from elsewhere is only not taken", async () => {
  await setCarryAllowed("p1", true);
  const stamp = { gen: 0, at: 5, mac: "m" };
  store.set(key("p1"), JSON.stringify(copy({ host: "hostA", version: "a1", updatedAt: 10, stamp })));
  let stale = true;
  reply = (m) => (m === "PUT" ? { status: 409, body: { error: "Your voice was reset on this host.", reset: true, stale } } : { status: 200, body: copy({ samples: [], version: "", updatedAt: 0 }) });
  await syncVoiceprint({ id: "p1" }, H);
  expect(calls.map((c) => c.method)).toEqual(["GET", "PUT"]);
  expect(calls[1].body).toMatchObject({ updatedAt: 10, stamp });
  expect(await localCopy("p1")).toBeNull();
  expect(await carryAllowed("p1")).toBe(true);
  // Not provably stale (another host's copy): kept on the device, just not given to this host.
  stale = false;
  store.set(key("p1"), JSON.stringify(copy({ host: "hostA", updatedAt: 10 })));
  await syncVoiceprint({ id: "p1" }, H);
  expect(await localCopy("p1")).toMatchObject({ host: "hostA" });
});

test("Reset and a failed read reach the host, never queued; saving the choice can fail out loud", async () => {
  store.set(key("p1"), JSON.stringify(copy()));
  await forgetCopy("p1");
  expect(await localCopy("p1")).toBeNull();
  await endRead("p1", false);
  expect(calls.at(-1)).toMatchObject({ method: "POST", path: "/people/p1/voice/end", body: { read: false } });
  (globalThis as any).__TAURI_INTERNALS__ = { invoke: async () => Promise.reject("Couldn't save your voice in the app: disk full") };
  await expect(setCarryAllowed("p1", true)).rejects.toBe("Couldn't save your voice in the app: disk full");
});

test("a copy that can't be deleted is an error, so Reset can say so", async () => {
  store.set(key("p1"), JSON.stringify(copy()));
  const remove = (globalThis as any).localStorage.removeItem;
  // A browser that refuses the delete (blocked storage) or silently keeps the copy.
  (globalThis as any).localStorage.removeItem = () => {
    throw new Error("blocked");
  };
  await expect(forgetCopy("p1")).rejects.toThrow("blocked");
  (globalThis as any).localStorage.removeItem = () => {};
  await expect(forgetCopy("p1")).rejects.toThrow("kept the copy");
  (globalThis as any).localStorage.removeItem = remove;
  expect(await localCopy("p1")).not.toBeNull();
  // The Mac app's person declined the delete in its dialog.
  (globalThis as any).__TAURI_INTERNALS__ = { invoke: async () => Promise.reject("You kept the copy on this Mac.") };
  await expect(forgetCopy("p1")).rejects.toBe("You kept the copy on this Mac.");
  // And a stale copy the host refused (409) that can't be deleted fails the sync out loud: it isn't settled.
  delete (globalThis as any).__TAURI_INTERNALS__;
  await setCarryAllowed("p1", true);
  (globalThis as any).localStorage.removeItem = () => {
    throw new Error("blocked");
  };
  reply = (m) => (m === "PUT" ? { status: 409, body: { error: "reset", reset: true, stale: true } } : { status: 200, body: copy({ samples: [], version: "", updatedAt: 0 }) });
  await expect(pushCopy("p1", H)).rejects.toThrow("blocked");
  await expect(syncVoiceprint({ id: "p1" }, H)).rejects.toThrow("blocked");
  (globalThis as any).localStorage.removeItem = remove;
});

test("saving the choice or the copy can't fail quietly: a write the browser didn't keep throws, and no leaves no copy", async () => {
  const set = (globalThis as any).localStorage.setItem;
  (globalThis as any).localStorage.setItem = () => {};
  await expect(setCarryAllowed("p1", true)).rejects.toThrow("didn't keep");
  (globalThis as any).localStorage.setItem = () => {
    throw new Error("quota");
  };
  store.set(key("p1"), JSON.stringify(copy()));
  store.set("jamsesh.voiceCarry.v2::p1", "true");
  await expect(setCarryAllowed("p1", false)).rejects.toThrow("quota");
  // The copy went first, so a "no" that couldn't be written still left nothing to carry.
  expect(await localCopy("p1")).toBeNull();
  (globalThis as any).localStorage.setItem = set;
  // A copy taken from the host that the browser didn't keep fails the sync too.
  await setCarryAllowed("p1", true);
  (globalThis as any).localStorage.setItem = () => {};
  reply = () => ({ status: 200, body: copy({ version: "b1", updatedAt: 9 }) });
  await expect(syncVoiceprint({ id: "p1" }, H)).rejects.toThrow("didn't keep");
  (globalThis as any).localStorage.setItem = set;
});

test("after the host takes the device's copy, a failed read-back leaves the sync unsettled instead of keeping the stale copy", async () => {
  await setCarryAllowed("p1", true);
  const mine = copy({ host: "hostA", version: "a1", updatedAt: 10 });
  store.set(key("p1"), JSON.stringify(mine));
  let gets = 0;
  reply = (m) => (m === "PUT" ? { status: 200, body: { ok: true } } : ++gets === 1 ? { status: 200, body: copy({ samples: [], version: "", updatedAt: 0 }) } : { status: 503, body: { error: "busy" } });
  await expect(syncVoiceprint({ id: "p1" }, H)).rejects.toThrow();
  expect(calls.map((c) => c.method)).toEqual(["GET", "PUT", "GET"]);
  expect(await localCopy("p1")).toEqual(mine);
  // The profile's best-effort pull still just says no.
  expect(await pullCopy("p1", H)).toBe(false);
});
