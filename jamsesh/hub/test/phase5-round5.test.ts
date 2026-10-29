// Phase 5, fifth review: a WAV header can't make the host allocate more than JamSesh would record, and a corrupt
// model next to the managed folder is never deleted. Synthetic audio only; nothing makes sound.
import "./dedupe.env";
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config";
import { Hub } from "../src/hub";
import { startHttp } from "../src/http";
import { LocalWhisper, mayReplace, ownDownload, recordDownload, WHISPER_MODEL } from "../src/audio/whisper";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { BadWav, decodeWav, encodeWav, resample } from "../src/audio/wav";

const dir = mkdtempSync(join(tmpdir(), "jam-p5r5-"));
const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, "d") });
const server = startHttp(hub, 0);
const base = `http://127.0.0.1:${server.port}`;
afterAll(() => {
  server.stop(true);
  hub.devproxy.stop();
  rmSync(dir, { recursive: true, force: true });
});

/** A WAV as encodeWav makes it, with its header's rate, channels, bits or format rewritten. */
function wav(seconds: number, rate = 16000, edit: (v: DataView) => void = () => {}) {
  const w = encodeWav({ sampleRate: rate, samples: new Float32Array(Math.round(seconds * rate)) });
  edit(new DataView(w.buffer));
  return w;
}

test("a header claiming a rate JamSesh doesn't record, a format it doesn't make, or too long is refused before decoding", () => {
  // The reviewer's case: 244 bytes at 1 Hz would resample to 1.6 million samples.
  const tiny = wav(0.01, 16000, (v) => v.setUint32(24, 1, true));
  expect(tiny.length).toBeLessThan(400);
  expect(() => decodeWav(tiny)).toThrow(BadWav);
  for (const rate of [0, 7999, 48001, 192000, 0xffffffff]) expect(() => decodeWav(wav(0.1, 16000, (v) => v.setUint32(24, rate, true)))).toThrow("sample rate");
  expect(() => decodeWav(wav(0.1, 16000, (v) => v.setUint16(22, 6, true)))).toThrow("unsupported");
  expect(() => decodeWav(wav(0.1, 16000, (v) => v.setUint16(34, 24, true)))).toThrow("unsupported");
  expect(() => decodeWav(wav(0.1, 16000, (v) => v.setUint16(20, 2, true)))).toThrow("unsupported");
  expect(() => decodeWav(wav(3, 16000), 2)).toThrow("longer than 2 seconds");
  // What browsers and the Mac record decodes, and resampling never makes more than twice the input.
  for (const rate of [8000, 16000, 44100, 48000]) {
    const p = decodeWav(wav(1, rate));
    expect(p.sampleRate).toBe(rate);
    expect(resample(p, 16000).samples.length).toBeLessThanOrEqual(2 * p.samples.length);
  }
  expect(() => resample({ sampleRate: 1, samples: new Float32Array(10) }, 16000)).toThrow(BadWav);
});

test("over HTTP a hostile header is the sender's error (400), for a segment and for the join read", async () => {
  const p = hub.session.upsertPerson({ name: "Sender" });
  const laptop = hub.auth.issue({ kind: "browser", label: "Sender's laptop", ip: "10.0.0.30", personId: p.id });
  const headers = { "x-forwarded-for": "9.9.9.9", authorization: `Bearer ${laptop.token}`, "content-type": "application/json" };
  expect((await fetch(`${base}/api/devices`, { method: "POST", headers, body: JSON.stringify({ deviceId: "d-send", personId: p.id }) })).status).toBe(200);
  const tiny = wav(0.01, 16000, (v) => v.setUint32(24, 1, true));
  const t0 = Date.now() - 5000;
  const started = Date.now();
  const r = await fetch(`${base}/api/audio?deviceId=d-send&t0=${t0}&t1=${t0 + 1000}`, { method: "POST", headers: { ...headers, "content-type": "audio/wav" }, body: tiny as unknown as BodyInit });
  expect([r.status, (await r.json()).error]).toEqual([400, expect.stringContaining("sample rate")]);
  expect(Date.now() - started).toBeLessThan(2000);
  // Refused, not received: the same segment can be sent again (properly) without being taken as a repeat.
  expect((await fetch(`${base}/api/audio?deviceId=d-send&t0=${t0}&t1=${t0 + 1000}`, { method: "POST", headers: { ...headers, "content-type": "audio/wav" }, body: wav(1) as unknown as BodyInit })).status).toBe(200);
  const read = await fetch(`${base}/api/people/${p.id}/voice`, { method: "POST", headers: { ...headers, "content-type": "audio/wav" }, body: tiny as unknown as BodyInit });
  expect([read.status, (await read.json()).error]).toEqual([400, expect.stringContaining("sample rate")]);
});

test("a rejected Whisper model is deleted only when it is the very file JamSesh downloaded, never a chosen one", () => {
  const models = join(config.home, "models");
  mkdirSync(models, { recursive: true });
  const own = join(models, WHISPER_MODEL.name);
  // Never a real install's model: this test writes and deletes the managed file.
  if (!config.home.startsWith(tmpdir()) || existsSync(own)) throw new Error(`run with JAMSESH_HOME set to a throwaway folder (${config.home})`);
  const was = process.env.JAMSESH_WHISPER_MODEL;
  try {
    writeFileSync(own, "model");
    // Put there by someone else (no record of a download): left alone.
    expect(ownDownload(own)).toBe(false);
    recordDownload(true);
    expect(ownDownload(own)).toBe(true);
    expect(ownDownload(join(models, ".", WHISPER_MODEL.name))).toBe(true);
    for (const other of [join(models, "ggml-base.en.bin"), join(models, "sub", WHISPER_MODEL.name), `${models}-backup/${WHISPER_MODEL.name}`, models, join(models, "..", WHISPER_MODEL.name)]) expect([other, ownDownload(other)]).toEqual([other, false]);
    // Chosen by the person, even by another spelling of the same path: never deleted.
    process.env.JAMSESH_WHISPER_MODEL = join(models, "..", "models", WHISPER_MODEL.name);
    expect(ownDownload(own)).toBe(false);
    delete process.env.JAMSESH_WHISPER_MODEL;
    // The managed name pointing at someone's file elsewhere: not JamSesh's to delete.
    const theirs = join(dir, "theirs.bin");
    writeFileSync(theirs, "model");
    rmSync(own);
    symlinkSync(theirs, own);
    expect(ownDownload(own)).toBe(false);
    expect(ownDownload(theirs)).toBe(false);
    recordDownload(false);
    rmSync(own);
    writeFileSync(own, "model");
    expect(ownDownload(own)).toBe(false);
    // Office review 7: provenance is the very file, not its name. Recorded, then replaced by another file: not ours.
    recordDownload(true);
    expect(ownDownload(own)).toBe(true);
    rmSync(own);
    writeFileSync(own, "someone else's model");
    expect([ownDownload(own), mayReplace(own)]).toEqual([false, false]);
    // An earlier build's name-only manifest proves nothing.
    writeFileSync(join(models, "downloaded.json"), JSON.stringify([WHISPER_MODEL.name]));
    expect(ownDownload(own)).toBe(false);
    for (const junk of ["{", "null", "{}", JSON.stringify({ [WHISPER_MODEL.name]: { ino: "x" } })]) {
      writeFileSync(join(models, "downloaded.json"), junk);
      expect([junk, ownDownload(own)]).toEqual([junk, false]);
    }
    // Nothing there: free to write. Chosen by the person, even before it exists: never.
    rmSync(own);
    expect(mayReplace(own)).toBe(true);
    process.env.JAMSESH_WHISPER_MODEL = own;
    expect(mayReplace(own)).toBe(false);
    delete process.env.JAMSESH_WHISPER_MODEL;
  } finally {
    if (was === undefined) delete process.env.JAMSESH_WHISPER_MODEL;
    else process.env.JAMSESH_WHISPER_MODEL = was;
    // Only what this test made: the folder may hold real models.
    for (const f of [own, join(models, "downloaded.json")]) rmSync(f, { force: true });
  }
});

test("a voice brought from another host by an earlier build is gone when the host opens its store", async () => {
  const { Store } = await import("../src/store");
  const where = mkdtempSync(join(tmpdir(), "jam-p5r5-store-"));
  const first = new Store(where);
  const e = new Uint8Array(new Float32Array(256).fill(0.0625).buffer);
  (first as any).db.query("INSERT INTO voiceprints (person_id, ts, embedding, kind) VALUES (?, ?, ?, ?)").run("p_a", 1, e, "carried");
  (first as any).db.query("INSERT INTO voiceprints (person_id, ts, embedding, kind) VALUES (?, ?, ?, ?)").run("p_a", 2, e, "enrol");
  (first as any).db.close();
  expect(new Store(where).voiceSamples().map((x) => x.kind)).toEqual(["enrol"]);
  rmSync(where, { recursive: true, force: true });
});

test("a download never lands over a model file JamSesh didn't download, there before it started or put there meanwhile", async () => {
  const models = join(config.home, "models");
  mkdirSync(models, { recursive: true });
  const own = join(models, WHISPER_MODEL.name);
  if (!config.home.startsWith(tmpdir()) || existsSync(own)) throw new Error(`run with JAMSESH_HOME set to a throwaway folder (${config.home})`);
  const body = new Uint8Array(4096).fill(7);
  const pinned = { sha256: WHISPER_MODEL.sha256, bytes: WHISPER_MODEL.bytes };
  Object.assign(WHISPER_MODEL, { sha256: createHash("sha256").update(body).digest("hex"), bytes: body.length });
  const realFetch = globalThis.fetch;
  let asked = 0;
  let meanwhile: (() => void) | null = null;
  globalThis.fetch = (async (url: any, init?: any) => (String(url) === WHISPER_MODEL.url ? (asked++, meanwhile?.(), new Response(body)) : realFetch(url, init))) as typeof fetch;
  const download = () => (new LocalWhisper() as any).download() as Promise<string>;
  try {
    // Someone's file at the managed path (a wrong size, so it was passed over): refused before downloading.
    writeFileSync(own, "a model someone put here");
    await expect(download()).rejects.toThrow("JamSesh didn't download");
    expect([asked, readFileSync(own, "utf8")]).toEqual([0, "a model someone put here"]);
    // Put there while JamSesh downloaded: refused at the last moment, theirs kept, no partial file left.
    rmSync(own);
    meanwhile = () => writeFileSync(own, "appeared meanwhile");
    await expect(download()).rejects.toThrow("JamSesh didn't download");
    expect([asked, readFileSync(own, "utf8")]).toEqual([1, "appeared meanwhile"]);
    expect(existsSync(`${own}.part`)).toBe(false);
    // Nothing there: it lands and is recorded as JamSesh's own; its own may be replaced by a later download.
    rmSync(own);
    meanwhile = null;
    expect(await download()).toBe(own);
    expect(ownDownload(own)).toBe(true);
    expect(await download()).toBe(own);
    expect(ownDownload(own)).toBe(true);
  } finally {
    globalThis.fetch = realFetch;
    Object.assign(WHISPER_MODEL, pinned);
    for (const f of [own, `${own}.part`, join(models, "downloaded.json")]) rmSync(f, { force: true });
  }
});
