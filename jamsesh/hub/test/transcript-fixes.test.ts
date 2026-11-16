// Three audio fixes: one sentence heard by two mics is one line even when the words differ a little; a line is
// named only when the hub is sure; the brain's own spoken reply coming back through a mic is not a person's line.
// Synthetic audio, transcription stubbed per copy, no voice model (see dedupe.test.ts).
import "./dedupe.env";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, test } from "bun:test";
import { AudioPipeline } from "../src/audio/pipeline";
import { encodeWav } from "../src/audio/wav";
import { recentReplies, resetSpeechState, speak } from "../src/brain/speech";
import { Session } from "../src/session";
import { quotesReply, sameWords } from "../src/similarity";
import { Store } from "../src/store";

function speech(seconds: number, seed: number, gain = 1) {
  const n = Math.round(16000 * seconds);
  const out = new Float32Array(n);
  let r = seed;
  const rand = () => ((r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) - 0.5;
  for (let i = 0; i < n; i++) {
    const t = i / 16000;
    const syllable = Math.max(0, Math.sin(2 * Math.PI * 3.5 * t)) ** 2;
    out[i] = gain * 0.3 * syllable * (Math.sin(2 * Math.PI * 140 * t) + 0.5 * Math.sin(2 * Math.PI * 280 * t)) + 0.002 * rand();
  }
  return out;
}

/** Two laptops, each with an owner. */
function room() {
  const session = new Session(new Store(mkdtempSync(join(tmpdir(), "jam-transcript-"))));
  const chey = session.upsertPerson({ name: "Chey" });
  const sam = session.upsertPerson({ name: "Sam" });
  session.touchDevice("lap-a", { label: "lap-a", micOn: true, location: "room", kind: "client", personId: chey.id });
  session.touchDevice("lap-b", { label: "lap-b", micOn: true, location: "room", kind: "client", personId: sam.id });
  const said = new Map<string, string>();
  const transcriber = { transcribe: async (wav: Uint8Array) => ({ text: said.get(String(Bun.hash(wav))) ?? "", engine: "stub" }) } as any;
  const pipeline = new AudioPipeline(session, transcriber);
  const hear = async (deviceId: string, t0: number, seconds: number, text: string, seed: number, gain = 1) => {
    const wav = encodeWav({ sampleRate: 16000, samples: speech(seconds, seed, gain) });
    said.set(String(Bun.hash(wav)), text);
    await pipeline.ingest({ deviceId, t0, t1: t0 + seconds * 1000, wav });
  };
  const lines = () => session.store.all("utterances").sort((a, b) => a.t0 - b.t0);
  return { session, chey, sam, pipeline, hear, lines };
}
const base = () => Date.now() - 120_000;

beforeEach(() => resetSpeechState());

// Fix 1: duplicate lines.

const PAIRS: [string, string][] = [
  ["Where's the freaking control for saying?", "Where's the freaking..."],
  ["How do I tell it where to play audio from?", "Wait, tell it where to play audio from."],
  ["Did you just click the sound? Oh, it's this, yeah.", "Did you just click the sound?"],
];

for (const [a, b] of PAIRS) {
  test(`two mics hearing the same sentence differently is one line: ${b}`, async () => {
    const r = room();
    const t = base();
    await r.hear("lap-a", t, 3, a, 1);
    await r.hear("lap-b", t + 100, 3, b, 2);
    await r.pipeline.flush();
    expect(r.lines().length).toBe(1);
  });
}

test("a copy that arrives after the line was shown joins it, and the longer wording is the line's", async () => {
  const r = room();
  const t = base();
  await r.hear("lap-a", t, 3, "Where's the freaking...", 1);
  await r.pipeline.flush();
  await r.hear("lap-b", t + 100, 3, "Where's the freaking control for saying?", 2);
  await r.pipeline.flush();
  const lines = r.lines();
  expect(lines.length).toBe(1);
  expect(lines[0].text).toBe("Where's the freaking control for saying?");
});

test("a short reply over someone's sentence is still its own line", async () => {
  const r = room();
  const t = base();
  await r.hear("lap-a", t, 3, "Put the pricing page on the big screen.", 1);
  await r.hear("lap-b", t + 500, 1, "Yes.", 2);
  await r.pipeline.flush();
  expect(r.lines().map((u) => u.text).sort()).toEqual(["Put the pricing page on the big screen.", "Yes."]);
});

test("different sentences at the same moment stay two lines", async () => {
  const r = room();
  const t = base();
  await r.hear("lap-a", t, 3, "Put the pricing page on the big screen.", 1);
  await r.hear("lap-b", t + 100, 3, "I still think the header is too tall.", 2);
  await r.pipeline.flush();
  expect(r.lines().length).toBe(2);
});

test("sameWords: cut-short, prefix and mostly-shared copies match; a lone reply or other words don't", () => {
  expect(sameWords("Looks good.", "looks good")).toBe(true);
  expect(sameWords("Where's the freaking control for saying?", "Where's the freaking...")).toBe(true);
  expect(sameWords("Yes", "Yes please do that now")).toBe(false);
  expect(sameWords("Yes please", "Yes please do that now")).toBe(false);
  expect(sameWords("Make it blue now", "Move the header up a bit")).toBe(false);
});

test("a copy in another voice is its own line even with matching words", () => {
  const r = room();
  const seg = (embedding: Float32Array) => ({ embedding, pcm: { sampleRate: 16000, samples: new Float32Array(10) } }) as any;
  const a = new Float32Array(8).fill(0.35);
  const b = new Float32Array(8);
  b[0] = 1;
  const same = (r.pipeline as any).sameLine("where s the freaking", "where s the freaking control", seg(a), seg(a));
  const other = (r.pipeline as any).sameLine("where s the freaking", "where s the freaking control", seg(a), seg(b));
  expect(same).toBe(true);
  expect(other).toBe(false);
});

// Fix 2: names only when sure.

test("a mic clearly the loudest names its owner", async () => {
  const r = room();
  await r.hear("lap-a", base(), 3, "Put the pricing page on the big screen.", 1, 1);
  await r.hear("lap-b", base(), 3, "Put the pricing page on the big screen.", 2, 0.2);
  await r.pipeline.flush();
  const [u] = r.lines();
  expect(u.personId).toBe(r.chey.id);
  expect(u.speakerName).toBe("Chey");
});

test("two mics about as loud: the line is Someone, with the likelier person suggested", async () => {
  const r = room();
  await r.hear("lap-a", base(), 3, "Put the pricing page on the big screen.", 1, 1);
  await r.hear("lap-b", base(), 3, "Put the pricing page on the big screen.", 2, 0.9);
  await r.pipeline.flush();
  const [u] = r.lines();
  expect(u.personId).toBeNull();
  expect(u.speakerName).toBe("Someone");
  expect(u.suggestedPersonId).toBeTruthy();
  // One tap on the chip is the assign route: the line is theirs then.
  const { utterance } = r.pipeline.assign(u.id, r.chey.id, { host: true, personId: null });
  expect(utterance.personId).toBe(r.chey.id);
  expect(utterance.suggestedPersonId).toBeNull();
});

// Fix 3: the brain's own voice.

test("what the brain said out loud, heard back through a mic, is not a person's line", async () => {
  const r = room();
  const reply = "I can't reassign a line to myself, so that echo means fixing in the audio setup, like turning the TV down or using headphones.";
  await speak(r.session, reply);
  expect(recentReplies.length).toBe(1);
  const t = base();
  await r.hear("lap-a", t, 4, "I can't reassign a line to myself, so that echo means fixing in the audio setup", 1);
  await r.pipeline.flush();
  expect(r.lines()).toEqual([]);
  // A person saying something else, and a short answer, are not affected.
  await r.hear("lap-a", t + 10_000, 3, "Yes.", 2);
  await r.hear("lap-b", t + 20_000, 3, "Can we move the header up a bit please?", 3);
  await r.pipeline.flush();
  expect(r.lines().map((u) => u.text)).toEqual(["Yes.", "Can we move the header up a bit please?"]);
});

test("a reply older than thirty seconds is not remembered", async () => {
  const r = room();
  await speak(r.session, "The pricing page is on the big screen now.");
  recentReplies[0].at -= 31_000;
  await r.hear("lap-a", base(), 3, "The pricing page is on the big screen now.", 1);
  await r.pipeline.flush();
  expect(r.lines().length).toBe(1);
});

test("quotesReply: most of the words, or a run of five, but never a short answer", () => {
  const reply = "I can't reassign a line to myself, so that echo means fixing in the audio setup";
  expect(quotesReply("a line to myself so that echo means fixing", reply)).toBe(true);
  expect(quotesReply("well I think the audio setup is fine, you know what, I can't reassign a line to myself", reply)).toBe(true);
  expect(quotesReply("Yes", "yes it is")).toBe(false);
  expect(quotesReply("Can we move the header up", reply)).toBe(false);
});
