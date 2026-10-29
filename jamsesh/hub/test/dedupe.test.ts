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

// With voices on, matching embeddings are positive evidence about the voice, not about the words: a related
// sentence with extra words is still another line. The embeddings are stood in for here (same vector).
function withVoice(r: ReturnType<typeof room>) {
  const v = new Float32Array(256).fill(0.0625);
  (r.pipeline as any).voiceOf = () => ({ embedding: v, reason: "" });
  const hear = r.hear;
  return async (...a: Parameters<typeof hear>) => {
    await hear(...a);
    for (const g of (r.pipeline as any).open) for (const s of g.segments) s.embedding = v;
  };
}

test("the same voice on two laptops saying a longer version of a sentence keeps both lines", async () => {
  const r = room();
  const hear = withVoice(r);
  const t = base();
  await hear("lap-a", t, 1.5, "Make it blue now.", 11);
  await r.pipeline.flush();
  await hear("lap-b", t + 1500, 2.5, "Make it blue now after lunch.", 12);
  await r.pipeline.flush();
  expect(r.lines()).toEqual(["Make it blue now.", "Make it blue now after lunch."]);
});

test("the same voice heard twice with one word heard differently is one line", async () => {
  const r = room();
  const hear = withVoice(r);
  const t = base();
  await hear("lap-a", t, 2.5, "Move the header up a bit please.", 13);
  await r.pipeline.flush();
  await hear("lap-b", t + 1500, 2.5, "Move the header up a bit police.", 14);
  await r.pipeline.flush();
  expect(r.lines()).toEqual(["Move the header up a bit please."]);
});

test("the same voice with an added word is another line, not a twin", async () => {
  const r = room();
  const hear = withVoice(r);
  const t = base();
  await hear("lap-a", t, 2.5, "Move the header up a bit please.", 13);
  await r.pipeline.flush();
  await hear("lap-b", t + 1500, 3.4, "Move the header up a bit please then.", 15);
  await r.pipeline.flush();
  expect(r.lines()).toEqual(["Move the header up a bit please.", "Move the header up a bit please then."]);
});

/**
 * One moment of speech as a microphone hears it. `rhythm` is the moment itself: its syllables, and the voice's
 * wandering pitch and breath (the same words said again are another moment). The microphone adds its gain, its
 * own faint noise (`noise`), an echo off the room, and starts `leadMs` before the speech.
 */
function utterance(seconds: number, rhythm: number, noise: number, gain = 1, leadMs = 0, echo = 0) {
  const n = Math.round(16000 * seconds);
  const lead = Math.round(16 * leadMs);
  const voice = new Float32Array(n);
  const rand = mulberry(rhythm);
  let phase = 0;
  let pitch = 140;
  for (let i = lead; i < n; ) {
    const len = Math.round(16000 * (0.12 + 0.2 * rand()));
    for (let j = 0; j < len && i + j < n; j++) {
      pitch = Math.min(220, Math.max(90, pitch + (rand() - 0.5) * 2));
      phase += (2 * Math.PI * pitch) / 16000;
      voice[i + j] = Math.sin((Math.PI * j) / len) ** 2 * (Math.sin(phase) + 0.5 * Math.sin(2 * phase) + 0.3 * (rand() - 0.5));
    }
    i += len + Math.round(16000 * (0.04 + 0.22 * rand()));
  }
  const hiss = ((h) => () => h() - 0.5)(mulberry(noise + 7919));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = gain * 0.3 * (voice[i] + (echo && i >= 240 ? echo * voice[i - 240] : 0)) + 0.002 * hiss();
  return out;
}

/** A small, well-mixed seeded generator (nearby seeds give unrelated sequences). */
function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function acousticRoom() {
  const r = room();
  const said = new Map<string, string>();
  (r.pipeline as any).transcriber = { transcribe: async (wav: Uint8Array) => ({ text: said.get(String(Bun.hash(wav))) ?? "", engine: "stub" }) };
  const v = new Float32Array(256).fill(0.0625);
  (r.pipeline as any).voiceOf = () => ({ embedding: v, reason: "" });
  const hear = async (deviceId: string, t0: number, samples: Float32Array, text: string) => {
    const wav = encodeWav({ sampleRate: 16000, samples });
    said.set(String(Bun.hash(wav)), text);
    await r.pipeline.ingest({ deviceId, t0, t1: t0 + (samples.length / 16000) * 1000, wav });
    for (const g of (r.pipeline as any).open) for (const s of g.segments) s.embedding = v;
    await r.pipeline.flush();
  };
  return { ...r, hear };
}

test("one moment of speech on two laptops, quieter and a little later on one, with a word lost, is one line", async () => {
  const r = acousticRoom();
  const t = base();
  await r.hear("lap-a", t, utterance(2.6, 21, 1), "Move the header up a bit please then.");
  await r.hear("lap-b", t + 1500, utterance(2.6, 21, 2, 0.4, 120), "Move the header up a bit please.");
  expect(r.lines()).toEqual(["Move the header up a bit please then."]);
});

test("a close-length line with an added word, from the same voice, is its own line when it's another sound", async () => {
  const r = acousticRoom();
  const t = base();
  await r.hear("lap-a", t, utterance(2.5, 31, 1), "Move the header up a bit please.");
  await r.hear("lap-b", t + 1500, utterance(2.6, 32, 2), "Move the header up a bit please then.");
  expect(r.lines()).toEqual(["Move the header up a bit please.", "Move the header up a bit please then."]);
});

test("the same speaker saying the same words again within seconds, heard by another laptop, is said twice", async () => {
  const r = acousticRoom();
  const t = base();
  await r.hear("lap-a", t, utterance(1.4, 41, 1), "Looks good to me.");
  await r.hear("lap-b", t + 2000, utterance(1.4, 42, 2), "Looks good to me.");
  expect(r.lines()).toEqual(["Looks good to me.", "Looks good to me."]);
  // And after the first line's audio is gone, a late copy is checked against its kept contour, both ways.
  (r.pipeline as any).finalized = [];
  await r.hear("lap-c", t + 100, utterance(1.4, 41, 3, 0.6, 80), "Looks good to me.");
  expect(r.lines()).toHaveLength(2);
  await r.hear("lap-c", t + 2600, utterance(1.4, 43, 4), "Looks good to me.");
  expect(r.lines()).toHaveLength(3);
});

test("one sound matches itself across gain, noise, echo and offset; another moment of the same voice doesn't", async () => {
  const { narrow, sameSound } = await import("../src/audio/pipeline");
  const at8k = (x: Float32Array) => narrow({ sampleRate: 16000, samples: x });
  expect(sameSound(at8k(utterance(3, 51, 1)), at8k(utterance(3, 51, 2, 0.3, 300, 0.4)))).toBe(true);
  for (const [d, a, b] of [[3, 51, 52], [1.4, 41, 42], [1.4, 41, 43], [2.5, 31, 32], [1.4, 1, 2], [1.4, 5, 9], [1.4, 100, 200]] as const)
    expect([a, b, sameSound(at8k(utterance(d, a, 1)), at8k(utterance(d, b, 2)))]).toEqual([a, b, false]);
  // Too little overlap to say: not the same.
  expect(sameSound(at8k(utterance(0.2, 51, 1)), at8k(utterance(3, 51, 2)))).toBe(false);
});
