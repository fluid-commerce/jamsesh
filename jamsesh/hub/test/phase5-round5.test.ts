// Phase 5, fifth review: a WAV header can't make the host allocate more than JamSesh would record, and a corrupt
// model next to the managed folder is never deleted. Synthetic audio only; nothing makes sound.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config";
import { Hub } from "../src/hub";
import { startHttp } from "../src/http";
import { inManagedFolder } from "../src/audio/whisper";
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

test("only files inside the managed models folder are deleted, not a sibling that shares its name's start", () => {
  const models = join(config.home, "models");
  expect(inManagedFolder(join(models, "ggml-base.en.bin"))).toBe(true);
  expect(inManagedFolder(join(models, "sub", "x.bin"))).toBe(true);
  expect(inManagedFolder(`${models}-backup/ggml-base.en.bin`)).toBe(false);
  expect(inManagedFolder(`${models}backup.bin`)).toBe(false);
  expect(inManagedFolder(models)).toBe(false);
  expect(inManagedFolder(join(models, "..", "elsewhere.bin"))).toBe(false);
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
