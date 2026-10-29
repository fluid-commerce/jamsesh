// One line, once, with voice matching off: no speaker model, so no embeddings. Synthetic audio only
// (no macOS voices needed), so these run anywhere. Transcription is stubbed per copy.
import "./dedupe.env";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { AudioPipeline } from "../src/audio/pipeline";
import { voiceprintsAvailable } from "../src/audio/voiceprint";
import { encodeWav } from "../src/audio/wav";
import { Session } from "../src/session";
import { Store } from "../src/store";

/** Something that sounds like speech to the gate: a buzzy voice in syllables, with pauses, over faint noise. */
function speech(seconds: number, seed: number) {
  const n = Math.round(16000 * seconds);
  const out = new Float32Array(n);
  let r = seed;
  const rand = () => ((r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) - 0.5;
  for (let i = 0; i < n; i++) {
    const t = i / 16000;
    const syllable = Math.max(0, Math.sin(2 * Math.PI * 3.5 * t)) ** 2;
    out[i] = 0.3 * syllable * (Math.sin(2 * Math.PI * 140 * t) + 0.5 * Math.sin(2 * Math.PI * 280 * t)) + 0.002 * rand();
  }
  return out;
}

function room() {
  const session = new Session(new Store(mkdtempSync(join(tmpdir(), "jam-dedupe-"))));
  for (const id of ["lap-a", "lap-b", "lap-c"]) session.touchDevice(id, { label: id, micOn: true, location: "room", kind: "client" });
  const said = new Map<string, string>();
  const transcriber = { transcribe: async (wav: Uint8Array) => ({ text: said.get(String(Bun.hash(wav))) ?? "", engine: "stub" }) } as any;
  const pipeline = new AudioPipeline(session, transcriber);
  /** One copy of a line, heard by `deviceId` with its own clock, transcribed as `text`. */
  const hear = async (deviceId: string, t0: number, seconds: number, text: string, seed: number) => {
    const wav = encodeWav({ sampleRate: 16000, samples: speech(seconds, seed) });
    said.set(String(Bun.hash(wav)), text);
    await pipeline.ingest({ deviceId, t0, t1: t0 + seconds * 1000, wav });
  };
  const lines = () => session.store.all("utterances").sort((a, b) => a.t0 - b.t0).map((u) => u.text);
  return { pipeline, hear, lines };
}
const base = () => Date.now() - 120_000;

test("voice matching is off here, so these cases have no voice to go on", () => {
  expect(existsSync(join(process.env.JAMSESH_HOME!, "models", "wespeaker_en.onnx"))).toBe(false);
  expect(voiceprintsAvailable()).toBe(false);
});

test("related sentences on two laptops a moment apart stay two lines when nothing says it's one voice", async () => {
  const r = room();
  const t = base();
  await r.hear("lap-a", t, 1.5, "Make it blue now.", 1);
  await r.pipeline.flush();
  await r.hear("lap-b", t + 1500, 2.5, "Make it blue now after lunch.", 2);
  await r.pipeline.flush();
  expect(r.lines()).toEqual(["Make it blue now.", "Make it blue now after lunch."]);
});

test("the exact same words from another laptop a moment apart are one line, short ones too", async () => {
  const r = room();
  const t = base();
  // "Looks good" is too short to embed, and 1.5 seconds of clock skew keeps the copies apart in time.
  await r.hear("lap-a", t, 0.7, "Looks good.", 3);
  await r.pipeline.flush();
  await r.hear("lap-b", t + 1500, 0.7, "looks good", 4);
  await r.pipeline.flush();
  await r.hear("lap-c", t - 1300, 0.7, "Looks good", 5);
  await r.pipeline.flush();
  expect(r.lines()).toEqual(["Looks good."]);
  // The same laptop saying it again is someone saying it again.
  await r.hear("lap-a", t + 2500, 0.7, "Looks good.", 6);
  await r.pipeline.flush();
  expect(r.lines()).toEqual(["Looks good.", "Looks good."]);
});

test("after a line's group is gone, a copy at the same moment with other words is shown; the same words aren't shown twice", async () => {
  const r = room();
  const t = base();
  await r.hear("lap-a", t, 3, "Put the pricing page on the big screen.", 7);
  await r.pipeline.flush();
  (r.pipeline as any).finalized = [];
  // Someone else, at the same moment, at another laptop: only time lines it up with the first line.
  await r.hear("lap-b", t + 200, 3, "I still think the header is too tall.", 8);
  await r.pipeline.flush();
  // A laptop's buffered copy of the first line, flushed after a reconnect.
  await r.hear("lap-c", t - 100, 3, "Put the pricing page on the big screen.", 9);
  await r.pipeline.flush();
  expect(r.lines()).toEqual(["Put the pricing page on the big screen.", "I still think the header is too tall."]);
});
