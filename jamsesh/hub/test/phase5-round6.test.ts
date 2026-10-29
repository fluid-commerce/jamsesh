// Phase 5, sixth review: who may change a voice by correcting a line, and what a Reset makes stale. Synthetic embeddings only; nothing makes sound.
import "./voices.env";
import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config";
import { Parakeet, PARAKEET, writeManifest } from "../src/audio/parakeet";
import { voiceprintStatus } from "../src/audio/voiceprint";
import { Hub } from "../src/hub";
import { startHttp } from "../src/http";
import { BadWav, decodeWav, encodeWav } from "../src/audio/wav";

const dir = mkdtempSync(join(tmpdir(), "jam-p5r6-"));
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
const unit = (seed: number) => {
  const v = Array.from({ length: 256 }, (_, i) => Math.sin(i * 0.37 + seed));
  const n = Math.hypot(...v);
  return Float32Array.from(v.map((x) => x / n));
};

let n = 0;
/** A spoken line labelled `personId`, whose voice already taught them (as an automatic sample would have). */
function taughtLine(personId: string, seed: number) {
  const s = hub.session;
  const id = `utt_r6_${++n}`;
  const heardAt = Date.now() - 1000;
  const e = unit(seed);
  const ev = s.store.addEvent({ kind: "speech", authorType: "person", authorId: personId, authorName: s.person(personId)!.name, text: `line ${id}`, data: { utteranceId: id, embedding: [...e], heardAt } });
  s.store.put("utterances", { id, t0: heardAt, t1: heardAt + 2000, text: `line ${id}`, personId, speakerName: s.person(personId)!.name, confidence: 0.8, method: "device", deviceId: "d", devices: [], location: "room", eventId: ev.id, engine: "stub" } as any);
  hub.audio.voiceprints.add(personId, e, "auto", heardAt);
  return { id, eventId: ev.id };
}
const people = (tag: string) => ["Ana", "Bob", "Cam"].map((name) => hub.session.upsertPerson({ name: `${name} ${tag}` }));
const count = (id: string) => hub.audio.voiceprints.count(id);

const voiced = test.skipIf(!voiceprintStatus().available);

voiced("someone else's correction relabels only: the new label learns nothing and the old one keeps its sample", () => {
  const [ana, bob, cam] = people("1");
  const { id } = taughtLine(ana.id, 1);
  const before = count(ana.id);
  const r = hub.audio.assign(id, cam.id, { host: false, personId: bob.id });
  expect(r.utterance).toMatchObject({ personId: cam.id, method: "manual" });
  expect(r.learning).toMatchObject({ learned: false });
  expect((r.learning as { reason: string }).reason).toContain(`only ${cam.name} or the host`);
  expect(count(cam.id)).toBe(0);
  expect(count(ana.id)).toBe(before);
});

voiced("the person named teaches their own voice, but can't take a sample back from the one wrongly labelled", () => {
  const [ana, , cam] = people("2");
  const { id } = taughtLine(ana.id, 2);
  const before = count(ana.id);
  expect(hub.audio.assign(id, cam.id, { host: false, personId: cam.id }).learning).toMatchObject({ learned: true, cleaned: 0 });
  expect(count(cam.id)).toBeGreaterThan(0);
  expect(count(ana.id)).toBe(before);
});

voiced("the person wrongly labelled takes their sample back, without teaching the person they name", () => {
  const [ana, , cam] = people("3");
  const { id } = taughtLine(ana.id, 3);
  const r = hub.audio.assign(id, cam.id, { host: false, personId: ana.id });
  expect(r.learning).toMatchObject({ learned: false });
  expect(count(ana.id)).toBe(0);
  expect(count(cam.id)).toBe(0);
});

voiced("the host's correction does both", () => {
  const [ana, , cam] = people("4");
  const { id } = taughtLine(ana.id, 4);
  expect(hub.audio.assign(id, cam.id, { host: true, personId: null }).learning).toMatchObject({ learned: true });
  expect(count(ana.id)).toBe(0);
  expect(count(cam.id)).toBeGreaterThan(0);
});

voiced("a relabel said aloud to the brain relabels the line and changes no voice", () => {
  const [ana, , cam] = people("5");
  const { id, eventId } = taughtLine(ana.id, 5);
  const before = count(ana.id);
  expect(hub.brain.relabel!(eventId, cam.name)).toContain(`now ${cam.name}'s`);
  expect(hub.session.store.get("utterances", id)).toMatchObject({ personId: cam.id });
  expect(count(cam.id)).toBe(0);
  expect(count(ana.id)).toBe(before);
});

voiced("over HTTP: another paired browser relabels only; the named person's own browser and the host's window teach", async () => {
  const [ana, bob, cam] = people("6");
  const bobs = hub.auth.issue({ kind: "browser", label: "Bob's laptop", ip: "10.0.0.31" });
  const cams = hub.auth.issue({ kind: "browser", label: "Cam's laptop", ip: "10.0.0.32" });
  expect((await call(bobs.token, "POST", "/devices", { deviceId: "d-bob6", personId: bob.id })).status).toBe(200);
  expect((await call(cams.token, "POST", "/devices", { deviceId: "d-cam6", personId: cam.id })).status).toBe(200);
  const first = taughtLine(ana.id, 6);
  const anaBefore = count(ana.id);
  const r = await call(bobs.token, "POST", `/utterances/${first.id}/assign`, { personId: cam.id });
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({ personId: cam.id, learning: { learned: false } });
  expect([count(cam.id), count(ana.id)]).toEqual([0, anaBefore]);
  // Naming a new person by name from someone else's laptop teaches them nothing either.
  const named = await (await call(bobs.token, "POST", `/utterances/${first.id}/assign`, { name: "Dee 6" })).json();
  expect(named.learning).toMatchObject({ learned: false });
  expect(count(named.personId)).toBe(0);

  expect(await (await call(cams.token, "POST", `/utterances/${first.id}/assign`, { personId: cam.id })).json()).toMatchObject({ learning: { learned: true } });
  expect(count(cam.id)).toBeGreaterThan(0);
  const second = taughtLine(ana.id, 7);
  expect(await (await asHostWindow("POST", `/utterances/${second.id}/assign`, { personId: bob.id })).json()).toMatchObject({ personId: bob.id, learning: { learned: true } });
  expect(count(bob.id)).toBeGreaterThan(0);
});

// ---- the reset epoch: issued by the hub at read start and stamped on each segment; older ones teach nothing

/** Something the speaker model embeds and the read's level check takes: a buzzy voice in syllables. */
function readWav(seconds: number) {
  const x = new Float32Array(16000 * seconds);
  for (let i = 0; i < x.length; i++) {
    const t = i / 16000;
    x[i] = 0.3 * Math.max(0, Math.sin(2 * Math.PI * 3.3 * t)) ** 2 * (Math.sin(2 * Math.PI * (130 + 20 * Math.sin(t)) * t) + 0.4 * Math.sin(2 * Math.PI * 390 * t));
  }
  return encodeWav({ sampleRate: 16000, samples: x });
}
const upload = (token: string, personId: string, epoch: number | null) =>
  fetch(`${base}/api/people/${personId}/voice${epoch === null ? "" : `?epoch=${epoch}`}`, { method: "POST", headers: { ...remote, "content-type": "audio/wav", authorization: `Bearer ${token}` }, body: readWav(8) as unknown as BodyInit });

voiced("a read started before Reset and finished after it teaches nothing; one started after does", async () => {
  const p = hub.session.upsertPerson({ name: "Rae" });
  const rae = hub.auth.issue({ kind: "browser", label: "Rae's laptop", ip: "10.0.0.41" });
  expect((await call(rae.token, "POST", "/devices", { deviceId: "d-rae", personId: p.id })).status).toBe(200);
  const before = (await (await call(rae.token, "POST", `/people/${p.id}/voice/start`, {})).json()).epoch;
  expect(before).toBe(hub.session.store.voiceEpoch());
  expect((await call(rae.token, "DELETE", `/people/${p.id}/voiceprint`)).status).toBe(200);
  const stale = await (await upload(rae.token, p.id, before)).json();
  expect(stale).toMatchObject({ ok: false });
  expect(stale.reason).toContain("reset while you read");
  expect(count(p.id)).toBe(0);
  // No epoch at all (an old page) counts as before every reset.
  expect(await (await upload(rae.token, p.id, null)).json()).toMatchObject({ ok: false });
  const after = (await (await call(rae.token, "POST", `/people/${p.id}/voice/start`, {})).json()).epoch;
  expect(after).toBe(before + 1);
  expect(await (await upload(rae.token, p.id, after)).json()).toMatchObject({ ok: true });
  expect(count(p.id)).toBeGreaterThan(0);
});

test("a segment captured in an older epoch counts as heard before the reset that ended it, whatever its timestamp says", async () => {
  const store = hub.session.store;
  const p = hub.session.upsertPerson({ name: "Ola" });
  hub.session.touchDevice("d-ola", { personId: p.id, location: "room" });
  const old = store.voiceEpoch();
  const resetAt = store.markVoiceReset(p.id);
  expect(store.voiceEpoch()).toBe(old + 1);
  const wav = readWav(1);
  // Buffered across the Reset with a device clock an hour ahead: still before it.
  const ahead = await hub.audio.ingest({ deviceId: "d-ola", t0: Date.now() + 3_600_000, t1: Date.now() + 3_601_000, wav, epoch: old });
  expect(ahead.heardAt).toBe(resetAt);
  expect(hub.audio.voiceprints.add(p.id, unit(30), "auto", ahead.heardAt)).toBe(false);
  // Not an epoch this host issued (garbage, the future, none): the oldest.
  for (const epoch of [-1, Number.NaN, 1.5, old + 99]) expect(store.heardBy(epoch)).toBe(store.heardBy(0));
  // Captured in the current epoch: heard when it says (or when it arrived), and it may teach.
  await new Promise((r) => setTimeout(r, 5));
  const now = await hub.audio.ingest({ deviceId: "d-ola", t0: resetAt + 1, t1: resetAt + 1001, wav, epoch: old + 1 });
  expect(now.heardAt).toBeGreaterThan(resetAt);
  expect(hub.audio.voiceprints.add(p.id, unit(31), "auto", now.heardAt)).toBe(true);
  await hub.audio.flush();
});

test("over HTTP, a segment's epoch comes from the device, and one without counts as the oldest", async () => {
  const p = hub.session.upsertPerson({ name: "Uma" });
  const uma = hub.auth.issue({ kind: "browser", label: "Uma's laptop", ip: "10.0.0.42" });
  expect((await call(uma.token, "POST", "/devices", { deviceId: "d-uma", personId: p.id })).status).toBe(200);
  const store = hub.session.store;
  store.markVoiceReset(p.id);
  const heard: number[] = [];
  const ingest = hub.audio.ingest.bind(hub.audio);
  hub.audio.ingest = async (input) => {
    const seg = await ingest(input);
    heard.push(seg.heardAt);
    return seg;
  };
  try {
    await new Promise((r) => setTimeout(r, 5));
    const t0 = store.voiceResetAt(p.id) + 1;
    const send = (q: string, t: number) => fetch(`${base}/api/audio?deviceId=d-uma&t0=${t}&t1=${t + 1000}${q}`, { method: "POST", headers: { ...remote, "content-type": "audio/wav", authorization: `Bearer ${uma.token}` }, body: readWav(1) as unknown as BodyInit });
    expect((await send("", t0)).status).toBe(200);
    expect((await send(`&epoch=${store.voiceEpoch()}`, t0 + 1)).status).toBe(200);
    expect(heard[0]).toBe(store.heardBy(0));
    expect(heard[0]).toBeLessThanOrEqual(store.voiceResetAt(p.id));
    expect(heard[1]).toBe(t0 + 1);
  } finally {
    hub.audio.ingest = ingest;
    await hub.audio.flush();
  }
});

// ---- a WAV is read only once its structure is whole

/** RIFF/WAVE around the given chunks, each [id, body]. */
function riff(...chunks: [string, Uint8Array][]) {
  const parts = chunks.map(([id, body]) => {
    const c = new Uint8Array(8 + body.length + (body.length % 2));
    c.set([...id].map((ch) => ch.charCodeAt(0)));
    new DataView(c.buffer).setUint32(4, body.length, true);
    c.set(body, 8);
    return c;
  });
  const out = new Uint8Array(12 + parts.reduce((a, p) => a + p.length, 0));
  out.set([..."RIFF"].map((ch) => ch.charCodeAt(0)));
  new DataView(out.buffer).setUint32(4, out.length - 8, true);
  out.set([..."WAVE"].map((ch) => ch.charCodeAt(0)), 8);
  let at = 12;
  for (const p of parts) (out.set(p, at), (at += p.length));
  return out;
}
const fmt16 = encodeWav({ sampleRate: 16000, samples: new Float32Array(0) }).slice(20, 36);
const pcm = (n: number) => new Uint8Array(n);

test("a WAV with a missing, late, short or doubled fmt, a chunk past its end or a partial sample is refused as bad audio", () => {
  const good = riff(["LIST", pcm(5)], ["fmt ", fmt16], ["data", pcm(3200)]);
  expect(decodeWav(good).samples.length).toBe(1600);
  const bad: [string, Uint8Array][] = [
    ["not WAVE", (() => { const w = good.slice(); w.set([65, 86, 73, 32], 8); return w; })()],
    ["no fmt", riff(["data", pcm(3200)])],
    ["data first", riff(["data", pcm(3200)], ["fmt ", fmt16])],
    ["short fmt", riff(["fmt ", fmt16.slice(0, 8)], ["data", pcm(3200)])],
    ["fmt cut off", riff(["fmt ", fmt16]).slice(0, 28)],
    ["two fmt", riff(["fmt ", fmt16], ["fmt ", fmt16], ["data", pcm(32)])],
    ["data past the end", riff(["fmt ", fmt16], ["data", pcm(3200)]).slice(0, 1000)],
    ["half a sample", riff(["fmt ", fmt16], ["data", pcm(3201)])],
    ["only a header", new Uint8Array([..."RIFF"].map((c) => c.charCodeAt(0)))],
    // Office review 6: the declared RIFF size, and every chunk after data.
    ["RIFF size zero", (() => { const w = good.slice(); new DataView(w.buffer).setUint32(4, 0, true); return w; })()],
    ["RIFF size too big", (() => { const w = good.slice(); new DataView(w.buffer).setUint32(4, w.length + 100, true); return w; })()],
    ["junk chunk after data", riff(["fmt ", fmt16], ["data", pcm(320)], ["\u0000\u0001\u0002\u0003", pcm(4)])],
    ["chunk after data runs past the end", (() => { const w = riff(["fmt ", fmt16], ["data", pcm(320)], ["LIST", pcm(40)]).slice(0, -20); new DataView(w.buffer).setUint32(4, w.length - 8, true); return w; })()],
    ["half a chunk header after data", (() => { const a = riff(["fmt ", fmt16], ["data", pcm(320)]); const w = new Uint8Array(a.length + 5); w.set(a); new DataView(w.buffer).setUint32(4, w.length - 8, true); return w; })()],
    ["two data", riff(["fmt ", fmt16], ["data", pcm(320)], ["data", pcm(320)])],
  ];
  // A chunk after data that is whole is fine (LIST metadata), and so is a last odd chunk without its pad byte.
  expect(decodeWav(riff(["fmt ", fmt16], ["data", pcm(320)], ["LIST", pcm(6)])).samples.length).toBe(160);
  expect(decodeWav(riff(["fmt ", fmt16], ["data", pcm(320)], ["LIST", pcm(5)]).slice(0, -1)).samples.length).toBe(160);
  for (const [what, w] of bad) {
    let thrown: unknown;
    try {
      decodeWav(w);
    } catch (e) {
      thrown = e;
    }
    expect([what, thrown instanceof BadWav]).toEqual([what, true]);
  }
});

test("over HTTP a malformed WAV is a 400 for a segment and for a read, never a 500", async () => {
  const p = hub.session.upsertPerson({ name: "Wes" });
  const wes = hub.auth.issue({ kind: "browser", label: "Wes's laptop", ip: "10.0.0.43" });
  expect((await call(wes.token, "POST", "/devices", { deviceId: "d-wes", personId: p.id })).status).toBe(200);
  const post = (path: string, body: Uint8Array) => fetch(`${base}/api${path}`, { method: "POST", headers: { ...remote, "content-type": "audio/wav", authorization: `Bearer ${wes.token}` }, body: body as unknown as BodyInit });
  const t0 = Date.now() - 5000;
  const zeroRiff = riff(["fmt ", fmt16], ["data", pcm(320)]);
  new DataView(zeroRiff.buffer).setUint32(4, 0, true);
  const junkAfter = riff(["fmt ", fmt16], ["data", pcm(320)], ["\u0000\u0001\u0002\u0003", pcm(4)]);
  for (const [i, w] of [riff(["fmt ", fmt16.slice(0, 4)], ["data", pcm(320)]), riff(["data", pcm(320)], ["fmt ", fmt16]), riff(["fmt ", fmt16]).slice(0, 26), zeroRiff, junkAfter].entries()) {
    expect((await post(`/audio?deviceId=d-wes&t0=${t0 + i}&t1=${t0 + i + 1000}&epoch=0`, w)).status).toBe(400);
    expect((await post(`/people/${p.id}/voice?epoch=${hub.session.store.voiceEpoch()}`, w)).status).toBe(400);
  }
});

// ---- the managed Parakeet model is checked however its path is spelled

test("a changed managed Parakeet model is caught when it's chosen by another spelling of its path or through a link", async () => {
  const own = join(config.home, "models", PARAKEET.name);
  const link = join(dir, "pk-link");
  const was = process.env.JAMSESH_PARAKEET_DIR;
  try {
    for (const alias of [join(config.home, "models", ".", PARAKEET.name), link]) {
      mkdirSync(own, { recursive: true });
      for (const f of PARAKEET.files) writeFileSync(join(own, f), `contents of ${f}`);
      await writeManifest(own);
      writeFileSync(join(own, PARAKEET.files[0]), "swapped");
      rmSync(link, { force: true });
      symlinkSync(own, link);
      process.env.JAMSESH_PARAKEET_DIR = alias;
      const p = new Parakeet();
      expect(await p.start(false)).toBeNull();
      expect([alias, p.status().state, existsSync(own)]).toEqual([alias, "missing", false]);
    }
  } finally {
    if (was === undefined) delete process.env.JAMSESH_PARAKEET_DIR;
    else process.env.JAMSESH_PARAKEET_DIR = was;
    rmSync(own, { recursive: true, force: true });
    rmSync(link, { force: true });
  }
});

test("a changed managed Parakeet model that can't be removed is a failed status, never a rejected start (office review 9)", async () => {
  const models = join(config.home, "models");
  const own = join(models, PARAKEET.name);
  const was = process.env.JAMSESH_PARAKEET_DIR;
  try {
    mkdirSync(own, { recursive: true });
    for (const f of PARAKEET.files) writeFileSync(join(own, f), `contents of ${f}`);
    await writeManifest(own);
    writeFileSync(join(own, PARAKEET.files[0]), "swapped");
    delete process.env.JAMSESH_PARAKEET_DIR;
    // Its folder can't be changed: the removal fails.
    chmodSync(models, 0o555);
    const p = new Parakeet();
    expect(await p.start(false)).toBeNull();
    expect(p.status()).toMatchObject({ state: "failed", detail: expect.stringContaining("couldn't be removed") });
  } finally {
    chmodSync(models, 0o755);
    if (was === undefined) delete process.env.JAMSESH_PARAKEET_DIR;
    else process.env.JAMSESH_PARAKEET_DIR = was;
    rmSync(own, { recursive: true, force: true });
  }
});
