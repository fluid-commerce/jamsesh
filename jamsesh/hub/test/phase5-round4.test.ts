// Phase 5, fourth review: one rule for who a browser may become (so whose voice it reads aloud for or resets),
// and a reset that nothing heard before it can undo. Synthetic embeddings only; nothing makes sound.
import "./voices.env";
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { voiceprintStatus } from "../src/audio/voiceprint";
import { Hub } from "../src/hub";
import { startHttp } from "../src/http";

const dir = mkdtempSync(join(tmpdir(), "jam-p5r4-"));
const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, "d") });
const server = startHttp(hub, 0);
const base = `http://127.0.0.1:${server.port}`;
afterAll(() => {
  server.stop(true);
  hub.devproxy.stop();
  rmSync(dir, { recursive: true, force: true });
});

const remote = { "x-forwarded-for": "9.9.9.9", "content-type": "application/json" };
const call = (token: string, method: string, path: string, body?: unknown) =>
  fetch(`${base}/api${path}`, { method, headers: { ...remote, authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
const asHostWindow = (method: string, path: string, body?: unknown) =>
  fetch(`${base}/api${path}`, { method, headers: { "content-type": "application/json", cookie: `jam_window=${hub.auth.windows.take(hub.auth.windows.mint())}` }, body: body === undefined ? undefined : JSON.stringify(body) });
const browser = (label: string) => hub.auth.issue({ kind: "browser", label, ip: "10.0.0.20" });
const unit = (seed: number) => {
  const v = Array.from({ length: 256 }, (_, i) => Math.sin(i * 0.37 + seed));
  const n = Math.hypot(...v);
  return Float32Array.from(v.map((x) => x / n));
};
/** What a window may do with a person's voice: start their join read, and reset it. */
const voiceStatuses = async (token: string, personId: string) => [
  (await call(token, "POST", `/people/${personId}/voice/start`, {})).status,
  (await call(token, "DELETE", `/people/${personId}/voiceprint`)).status,
];

test("after its laptop is disconnected, a person can't be claimed by another pairing: the host lets one in", async () => {
  const sam = hub.session.upsertPerson({ name: "Sam" });
  const first = browser("Sam's laptop");
  expect((await call(first.token, "POST", "/devices", { deviceId: "d-sam", personId: sam.id })).status).toBe(200);
  hub.audio.voiceprints.add(sam.id, unit(1), "enrol", Date.now());
  hub.auth.revoke(first.device.id);

  const hostile = browser("Hostile");
  const claim = await call(hostile.token, "POST", "/devices", { deviceId: "d-hostile", personId: sam.id });
  expect(claim.status).toBe(403);
  expect((await claim.json()).error).toContain("Ask the host to let this laptop in as Sam");
  expect(hub.auth.get(hostile.device.id)).toMatchObject({ personId: null, wants: sam.id });
  expect(await voiceStatuses(hostile.token, sam.id)).toEqual([403, 403]);
  expect(hub.audio.voiceprints.count(sam.id)).toBeGreaterThan(0);

  // Only the host's own window lets a laptop in: not the laptop itself, another laptop, or loopback without the window key.
  const bystander = browser("Bystander");
  for (const r of [await call(hostile.token, "POST", `/paired/${hostile.device.id}/allow`, {}), await call(bystander.token, "POST", `/paired/${hostile.device.id}/allow`, {}), await fetch(`${base}/api/paired/${hostile.device.id}/allow`, { method: "POST" })])
    expect(r.status).toBe(403);
  expect(hub.auth.get(hostile.device.id)?.personId).toBeNull();
  // A laptop that isn't asking can't be let in as anyone.
  expect((await asHostWindow("POST", `/paired/${bystander.device.id}/allow`, {})).status).toBe(404);
});

test("the host letting a laptop in moves the person: their other laptops are disconnected and lose their voice", async () => {
  const kim = hub.session.upsertPerson({ name: "Kim" });
  const old = browser("Kim's old laptop");
  expect((await call(old.token, "POST", "/devices", { deviceId: "d-kim-old", personId: kim.id })).status).toBe(200);
  const fresh = browser("Kim's new laptop");
  expect((await call(fresh.token, "POST", "/devices", { deviceId: "d-kim-new", personId: kim.id })).status).toBe(403);
  expect((await asHostWindow("POST", `/paired/${fresh.device.id}/allow`, {})).status).toBe(200);
  expect(hub.auth.get(old.device.id)).toBeNull();
  expect(hub.auth.get(fresh.device.id)).toMatchObject({ personId: kim.id, wants: null });
  expect((await call(fresh.token, "POST", "/devices", { deviceId: "d-kim-new", personId: kim.id })).status).toBe(200);
  expect((await call(fresh.token, "POST", `/people/${kim.id}/voice/start`, {})).status).toBe(200);
  expect((await call(old.token, "POST", `/people/${kim.id}/voice/start`, {})).status).not.toBe(200);
  // Not the person at the host's own window, though.
  const hostP = hub.session.upsertPerson({ name: "Hosty" });
  hub.session.store.setSetting("hostPersonId", hostP.id);
  const wanna = browser("Wanna");
  expect((await call(wanna.token, "POST", "/devices", { deviceId: "d-wanna", personId: hostP.id })).status).toBe(403);
  expect((await asHostWindow("POST", `/paired/${wanna.device.id}/allow`, {})).status).toBe(409);
  hub.session.store.setSetting("hostPersonId", "");
});

test("someone a browser made itself is its to be; someone with a voice here that nobody held isn't", async () => {
  const maker = browser("Maker");
  const made = await (await call(maker.token, "POST", "/people", { name: "Newcomer" })).json();
  const other = browser("Other");
  // A second browser naming the same person (by name, or by id) right after doesn't get them.
  expect((await call(other.token, "POST", "/devices", { deviceId: "d-other", personId: made.id })).status).toBe(403);
  expect((await call(maker.token, "POST", "/devices", { deviceId: "d-maker", personId: made.id })).status).toBe(200);
  hub.audio.voiceprints.add(made.id, unit(10), "enrol", Date.now());
  expect(await voiceStatuses(maker.token, made.id)).toEqual([200, 200]);

  // Taught by the room (the host's microphone, a correction), held by no browser: the host decides.
  const voiced = hub.session.upsertPerson({ name: "Voiced" });
  hub.audio.voiceprints.add(voiced.id, unit(2), "correction", Date.now());
  const claimer = browser("Claimer");
  expect((await call(claimer.token, "POST", "/devices", { deviceId: "d-claimer", personId: voiced.id })).status).toBe(403);
  expect(await voiceStatuses(claimer.token, voiced.id)).toEqual([403, 403]);
});

test("removing a person (which erases their voice) is for the host or that person, not any laptop", async () => {
  const pat = hub.session.upsertPerson({ name: "Pat" });
  const mine = browser("Pat's laptop");
  expect((await call(mine.token, "POST", "/devices", { deviceId: "d-pat", personId: pat.id })).status).toBe(200);
  hub.audio.voiceprints.add(pat.id, unit(3), "enrol", Date.now());
  const someone = browser("Someone");
  expect((await call(someone.token, "DELETE", `/people/${pat.id}`)).status).toBe(403);
  expect(hub.session.person(pat.id)).toBeDefined();
  expect(hub.audio.voiceprints.count(pat.id)).toBeGreaterThan(0);
  expect((await call(mine.token, "DELETE", `/people/${pat.id}`)).status).toBe(200);
  expect(hub.session.person(pat.id)).toBeUndefined();
  const gone = hub.session.upsertPerson({ name: "Gone" });
  expect((await asHostWindow("DELETE", `/people/${gone.id}`)).status).toBe(200);
});

test("nothing heard before a reset teaches the voice: a line still in flight, a held first sample, a stored line", () => {
  const lee = hub.session.upsertPerson({ name: "Lee" });
  hub.session.touchDevice("d-lee", { label: "Lee's laptop", personId: lee.id, kind: "client", location: "room", micOn: true });
  const heardBefore = Date.now() - 2000;
  hub.resetVoice(lee.id);
  const e = unit(8);
  const seg = (heardAt: number) => ({ id: "s", deviceId: "d-lee", t0: heardAt, t1: heardAt + 2000, levelDb: -20, noiseDb: -60, snr: 40, active: 0.5, clipped: 0, pcm: { sampleRate: 16000, samples: new Float32Array(0) }, wav: new Uint8Array(), arrivedAt: heardAt, heardAt, embedding: e });
  const guess = { personId: lee.id, confidence: 0.9, method: "device", scores: [{ personId: lee.id, score: 0.9, voice: -1, device: 1 }] };
  const audio = hub.audio as any;
  // In flight at the reset: its first sample is held after it, and a second line pairs with it. Neither teaches.
  audio.autoEnroll(guess, seg(heardBefore), [seg(heardBefore)]);
  audio.autoEnroll(guess, seg(heardBefore), [seg(heardBefore)]);
  expect(hub.audio.voiceprints.count(lee.id)).toBe(0);
  // The same, heard after: it does.
  audio.candidates.delete(lee.id);
  audio.autoEnroll(guess, seg(Date.now() + 1), [seg(Date.now() + 1)]);
  audio.autoEnroll(guess, seg(Date.now() + 2), [seg(Date.now() + 2)]);
  expect(hub.audio.voiceprints.count(lee.id)).toBeGreaterThan(0);
});

test("ingest dates a segment by when it was heard: its synced start, or its arrival if that's earlier", async () => {
  const n = 16000;
  const x = new Float32Array(n);
  const { encodeWav } = await import("../src/audio/wav");
  const wav = encodeWav({ sampleRate: 16000, samples: x });
  const before = Date.now();
  const early = await hub.audio.ingest({ deviceId: "d-lee", t0: before - 30_000, t1: before - 29_000, wav });
  expect(early.heardAt).toBe(before - 30_000);
  const late = await hub.audio.ingest({ deviceId: "d-lee", t0: Date.now() + 3_600_000, t1: Date.now() + 3_601_000, wav });
  expect(late.heardAt).toBeLessThanOrEqual(Date.now());
});

const voiced = test.skipIf(!voiceprintStatus().available);
voiced("correcting an old unlabelled line to someone after their reset doesn't teach them; a newer line does", () => {
  const s = hub.session;
  const kai = s.upsertPerson({ name: "Kai" });
  const old = Date.now() - 60_000;
  const e = [...unit(9)];
  const line = (id: string, heardAt: number) => {
    const ev = s.store.addEvent({ kind: "speech", authorType: "person", authorId: null, authorName: "Someone", text: `line ${id}`, data: { embedding: e, heardAt } });
    s.store.put("utterances", { id, t0: heardAt, t1: heardAt + 2000, text: `line ${id}`, personId: null, speakerName: "Someone", confidence: 0, method: "none", deviceId: "d", devices: [], location: "room", eventId: ev.id, engine: "stub" } as any);
  };
  line("utt_old", old);
  hub.resetVoice(kai.id);
  const r = hub.audio.assign("utt_old", kai.id, { host: true, personId: null });
  expect(r.learning).toMatchObject({ learned: false });
  expect(hub.audio.voiceprints.count(kai.id)).toBe(0);
  line("utt_new", Date.now() + 1);
  expect(hub.audio.assign("utt_new", kai.id, { host: true, personId: null }).learning).toMatchObject({ learned: true });
  expect(hub.audio.voiceprints.count(kai.id)).toBeGreaterThan(0);
});
