// Copies grouped by time that could be someone else talking at the same moment are transcribed too, and are
// their own line when their words aren't the clearest copy's. Voice matching off (no speaker model); synthetic
// audio only; transcription stubbed per copy. Nothing makes sound.
import "./dedupe.env";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { AudioPipeline } from "../src/audio/pipeline";
import { encodeWav } from "../src/audio/wav";
import { Session } from "../src/session";
import { Store } from "../src/store";

const RATE = 16000;
/** A buzzy voice in syllables: `rate` syllables a second at `pitch` Hz, from `from` to `to` seconds. */
function voice(seconds: number, pitch: number, rate: number, from = 0, to = seconds) {
  const out = new Float32Array(Math.round(RATE * seconds));
  for (let i = Math.round(from * RATE); i < Math.min(out.length, Math.round(to * RATE)); i++) {
    const t = i / RATE;
    out[i] = 0.3 * Math.max(0, Math.sin(2 * Math.PI * rate * t)) ** 2 * (Math.sin(2 * Math.PI * pitch * t) + 0.5 * Math.sin(2 * Math.PI * 2 * pitch * t));
  }
  return out;
}
const A = (s: number) => voice(s, 140, 3.5);
const B = (s: number, from?: number, to?: number) => voice(s, 210, 2.7, from, to);
/** What one laptop hears: each voice at its own gain, over the same faint noise floor. */
function mix(seed: number, ...parts: [Float32Array, number][]) {
  const n = Math.max(...parts.map(([x]) => x.length));
  const out = new Float32Array(n);
  let r = seed;
  for (let i = 0; i < n; i++) {
    out[i] = 0.002 * (((r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) - 0.5);
    for (const [x, g] of parts) out[i] += (x[i] ?? 0) * g;
  }
  return out;
}
const dB = (x: number) => 10 ** (x / 20);

function room(laptops = ["lap-a", "lap-b", "lap-c", "lap-d"]) {
  const session = new Session(new Store(mkdtempSync(join(tmpdir(), "jam-split-"))));
  const ana = session.upsertPerson({ name: "Ana" });
  const bob = session.upsertPerson({ name: "Bob" });
  for (const id of laptops) session.touchDevice(id, { label: id, micOn: true, location: "room", kind: "client" });
  session.touchDevice("lap-a", { personId: ana.id });
  session.touchDevice("lap-b", { personId: bob.id });
  const said = new Map<string, string>();
  const asked: string[] = [];
  const transcriber = {
    transcribe: async (wav: Uint8Array) => {
      const text = said.get(String(Bun.hash(wav))) ?? "";
      asked.push(text);
      return { text, engine: "stub" };
    },
  } as any;
  const pipeline = new AudioPipeline(session, transcriber);
  const taught: string[] = [];
  const enroll = (pipeline as any).autoEnroll.bind(pipeline);
  (pipeline as any).autoEnroll = (guess: any, best: any, segs: any) => (taught.push(best.deviceId), enroll(guess, best, segs));
  /** One copy, heard by `deviceId` over the same span as every other copy, transcribed as `text`. */
  const hear = async (deviceId: string, t0: number, samples: Float32Array, text: string) => {
    const wav = encodeWav({ sampleRate: RATE, samples });
    said.set(String(Bun.hash(wav)), text);
    await pipeline.ingest({ deviceId, t0, t1: t0 + (samples.length / RATE) * 1000, wav });
  };
  const lines = () => session.store.all("utterances").sort((a, b) => a.t0 - b.t0 || a.id.localeCompare(b.id));
  return { pipeline, hear, lines, asked, taught, ana, bob };
}
const t = () => Date.now() - 120_000;

test("two people talking over the same span at their own laptops are two lines (review 6's room case)", async () => {
  const r = room(["lap-a", "lap-b"]);
  const t0 = t();
  await r.hear("lap-a", t0, mix(1, [A(3), 1], [B(3), 0.3]), "Put the pricing page up.");
  await r.hear("lap-b", t0, mix(2, [B(3), 1], [A(3), 0.3]), "I think the header is too tall.");
  await r.pipeline.flush();
  const lines = r.lines();
  expect(lines.map((u) => u.text).sort()).toEqual(["I think the header is too tall.", "Put the pricing page up."]);
  const split = lines.find((u) => u.deviceId === "lap-b")!;
  const main = lines.find((u) => u.deviceId === "lap-a")!;
  // The line heard best keeps the device's speaker; the split line is named by a voice only (none here), and teaches nobody.
  expect(main.personId).toBe(r.ana.id);
  expect(main.devices.map((d) => d.deviceId)).toEqual(["lap-a"]);
  expect(split).toMatchObject({ personId: null, speakerName: "Someone" });
  expect(r.taught).toEqual(["lap-a"]);
  expect(r.asked).toHaveLength(2);
});

test("a quieter copy within the threshold is transcribed: the same words stay one line, other words are another", async () => {
  for (const [other, count] of [["Put the pricing page up", 1], ["Put the pricing page cup", 2]] as const) {
    const r = room();
    const t0 = t();
    await r.hear("lap-a", t0, mix(3, [A(3), 1]), "Put the pricing page up.");
    await r.hear("lap-c", t0, mix(4, [A(3), dB(-9)]), other);
    await r.pipeline.flush();
    expect(r.asked).toHaveLength(2);
    expect(r.lines()).toHaveLength(count);
  }
});

test("a copy further down than the threshold is the same voice across the room: not transcribed, one line", async () => {
  const r = room();
  const t0 = t();
  await r.hear("lap-a", t0, mix(5, [A(3), 1]), "Put the pricing page up.");
  await r.hear("lap-c", t0, mix(6, [A(3), dB(-11)]), "Something else entirely.");
  await r.pipeline.flush();
  expect(r.asked).toEqual(["Put the pricing page up."]);
  expect(r.lines().map((u) => u.text)).toEqual(["Put the pricing page up."]);
  expect(r.lines()[0].devices).toHaveLength(2);
});

test("a short reply over a long sentence, quiet overall but loudest at its own laptop for a moment, is its own line", async () => {
  const r = room(["lap-a", "lap-b"]);
  const t0 = t();
  await r.hear("lap-a", t0, mix(7, [A(4), 1], [B(4, 2.5, 3.5), 0.05]), "Let's move the footer to the left side.");
  await r.hear("lap-b", t0, mix(8, [A(4), 0.05], [B(4, 2.5, 3.5), 1.5]), "Yes.");
  await r.pipeline.flush();
  const [a, b] = (r.pipeline as any).finalized.flatMap((g: any) => g.segments);
  // This case is the loudest-for-a-moment rule's, not the level rule's.
  expect(Math.abs(a.levelDb - b.levelDb)).toBeGreaterThan(10);
  expect(r.lines().map((u) => u.text).sort()).toEqual(["Let's move the footer to the left side.", "Yes."]);
  // Without the reply that laptop only hears the room: never the loudest, never transcribed.
  const q = room(["lap-a", "lap-b"]);
  await q.hear("lap-a", t0, mix(7, [A(4), 1]), "Let's move the footer to the left side.");
  await q.hear("lap-b", t0, mix(8, [A(4), 0.05]), "Yes.");
  await q.pipeline.flush();
  expect(q.asked).toHaveLength(1);
  expect(q.lines()).toHaveLength(1);
});

test("a late copy with other words, from a laptop that could have heard someone else, becomes its own line", async () => {
  const r = room(["lap-a", "lap-b"]);
  const t0 = t();
  await r.hear("lap-a", t0, mix(9, [A(3), 1], [B(3), 0.3]), "Put the pricing page up.");
  await r.pipeline.flush();
  await r.hear("lap-b", t0, mix(10, [B(3), 1], [A(3), 0.3]), "I think the header is too tall.");
  await r.pipeline.flush();
  expect(r.lines().map((u) => u.text).sort()).toEqual(["I think the header is too tall.", "Put the pricing page up."]);
  expect(r.lines().find((u) => u.deviceId === "lap-b")).toMatchObject({ personId: null });
  expect(r.taught).toEqual(["lap-a"]);
});

test("whisper load with 4 laptops: one transcription before; after, one per copy within the threshold", async () => {
  const load = async (gains: number[]) => {
    const r = room();
    const t0 = t();
    await Promise.all(gains.map((g, i) => r.hear(["lap-a", "lap-b", "lap-c", "lap-d"][i], t0, mix(20 + i, [A(3), dB(g)]), "Put the pricing page up.")));
    await r.pipeline.flush();
    expect(r.lines()).toHaveLength(1);
    return r.asked.length;
  };
  // Spread across a room (6 dB apart) and around one table (2 to 3 dB apart).
  expect(await load([0, -6, -12, -18])).toBe(2);
  expect(await load([0, -3, -6, -8])).toBe(4);
});

test("a split line is named when a voice match names it", async () => {
  const r = room(["lap-a", "lap-b"]);
  const unit = (k: number) => Float32Array.from({ length: 256 }, (_, i) => Math.sin(i * 0.37 + k) / 8);
  r.pipeline.voiceprints.add(r.ana.id, unit(1), "enrol", Date.now());
  r.pipeline.voiceprints.add(r.bob.id, unit(4), "enrol", Date.now());
  const t0 = t();
  await r.hear("lap-a", t0, mix(11, [A(3), 1], [B(3), 0.3]), "Put the pricing page up.");
  await r.hear("lap-b", t0, mix(12, [B(3), 1], [A(3), 0.3]), "I think the header is too tall.");
  for (const g of (r.pipeline as any).open) for (const s of g.segments) s.embedding = s.deviceId === "lap-a" ? unit(1) : unit(4);
  await r.pipeline.flush();
  expect(r.lines().find((u) => u.deviceId === "lap-b")).toMatchObject({ personId: r.bob.id, speakerName: "Bob", method: "voice" });
});
