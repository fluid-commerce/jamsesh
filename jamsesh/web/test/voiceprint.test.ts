import "fake-indexeddb/auto";
import { beforeEach, expect, test } from "bun:test";

// The device's copy of a voice, through the real api() helper against a stubbed network.
const store = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };

const { carryAllowed, localCopy, pushCopy, pullCopy, setCarryAllowed, syncVoiceprint } = await import("../src/shared/voiceprint");

const copy = { model: "wespeaker_en", dim: 256, samples: [{ kind: "enrol", embedding: new Array(256).fill(0.0625) }] };
let calls: { method: string; path: string; body: unknown }[] = [];
let reply: (method: string, path: string) => { status: number; body: unknown } = () => ({ status: 200, body: { ok: true } });

beforeEach(() => {
  store.clear();
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

test("nothing leaves the device until the person agrees", async () => {
  expect(carryAllowed()).toBe(false);
  store.set("jamsesh.voiceprint.v1", JSON.stringify(copy));
  await syncVoiceprint({ id: "p1", voiceSamples: 0 });
  expect(calls).toHaveLength(0);
});

test("a host that doesn't know the voice gets the device's copy, embeddings only", async () => {
  setCarryAllowed(true);
  store.set("jamsesh.voiceprint.v1", JSON.stringify(copy));
  await syncVoiceprint({ id: "p1", voiceSamples: 0 });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ method: "PUT", path: "/people/p1/voiceprint", body: copy });
  expect(JSON.stringify(calls[0].body)).not.toMatch(/audio|wav|blob/i);
});

test("a host that has learned more gives its copy back to the device", async () => {
  setCarryAllowed(true);
  store.set("jamsesh.voiceprint.v1", JSON.stringify(copy));
  const newer = { ...copy, samples: [...copy.samples, { kind: "correction", embedding: new Array(256).fill(0.03) }] };
  reply = (m) => ({ status: 200, body: m === "GET" ? newer : { ok: true } });
  await syncVoiceprint({ id: "p1", voiceSamples: 4 });
  expect(calls.map((c) => c.method)).toEqual(["GET"]);
  expect(localCopy()?.samples).toHaveLength(2);
});

test("a new device takes the host's copy when there is none here", async () => {
  setCarryAllowed(true);
  reply = (m) => ({ status: 200, body: m === "GET" ? copy : { ok: true } });
  await syncVoiceprint({ id: "p1", voiceSamples: 3 });
  expect(localCopy()).toEqual(copy);
});

test("a refused or failed call changes nothing and never throws", async () => {
  setCarryAllowed(true);
  store.set("jamsesh.voiceprint.v1", JSON.stringify(copy));
  reply = () => ({ status: 403, body: { error: "A voice is only for its own person to give." } });
  expect(await pushCopy("someone-else")).toBe(false);
  expect(await pullCopy("someone-else")).toBe(false);
  (globalThis as any).fetch = async () => {
    throw new TypeError("network down");
  };
  await syncVoiceprint({ id: "p1", voiceSamples: 0 });
  expect(localCopy()).toEqual(copy);
});

test("turning it off forgets the copy on this device", () => {
  setCarryAllowed(true);
  store.set("jamsesh.voiceprint.v1", JSON.stringify(copy));
  setCarryAllowed(false);
  expect(localCopy()).toBeNull();
  expect(carryAllowed()).toBe(false);
});
