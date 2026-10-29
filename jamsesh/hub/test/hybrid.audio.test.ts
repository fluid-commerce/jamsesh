// Hybrid sessions: room devices and remote laptops are different rooms.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AudioPipeline } from "../src/audio/pipeline";
import { encodeWav } from "../src/audio/wav";
import { Session } from "../src/session";
import { Store } from "../src/store";

/** A speech-like signal: syllable bursts with pauses, at a given level. */
function speech(seconds: number, gain: number, seed: number) {
  const n = Math.floor(16000 * seconds);
  const out = new Float32Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    const syllable = Math.sin((i / 16000) * Math.PI * 4) > -0.3 ? 1 : 0.02;
    out[i] = (Math.sin(i * 0.07) * 0.6 + ((x / 0x7fffffff) - 0.5) * 0.4) * syllable * gain + ((x % 97) / 97 - 0.5) * 0.0005;
  }
  return encodeWav({ sampleRate: 16000, samples: out });
}

function setup(lines: Map<number, string>) {
  const s = new Session(new Store(mkdtempSync(join(tmpdir(), "jam-hybrid-"))));
  const chey = s.upsertPerson({ name: "Chey", role: "Design lead" });
  const felipe = s.upsertPerson({ name: "Felipe", role: "CPO" });
  s.touchDevice("chey-laptop", { personId: chey.id, location: "room" });
  s.touchDevice("host", { kind: "host", location: "room" });
  s.touchDevice("felipe-laptop", { personId: felipe.id, location: "remote" });
  // Transcription is stubbed: each test clip's length maps to the words in it.
  const transcriber = { transcribe: async (wav: Uint8Array) => ({ text: lines.get(wav.length) ?? "", engine: "stub" }) } as any;
  const p = new AudioPipeline(s, transcriber);
  const out: { text: string; who: string; location: string }[] = [];
  p.onLine = (u, isNew) => isNew && out.push({ text: u.text, who: u.speakerName, location: u.location });
  return { s, p, out, chey, felipe };
}

test("a remote voice played into the room is one line, from the remote person", async () => {
  const clean = speech(2.0, 0.3, 1);
  const echo = speech(2.02, 0.05, 2); // through the room speaker: quieter, slightly longer
  const lines = new Map([[clean.length, "Let's ship option A on mobile today"], [echo.length, "let's ship option A on mobile today"]]);
  const { p, out } = setup(lines);
  const t = Date.now() - 4000;
  await p.ingest({ deviceId: "felipe-laptop", t0: t, t1: t + 2000, wav: clean });
  await p.ingest({ deviceId: "host", t0: t + 250, t1: t + 2270, wav: echo });
  await p.ingest({ deviceId: "chey-laptop", t0: t + 260, t1: t + 2280, wav: echo });
  await p.flush();
  expect(out).toHaveLength(1);
  expect(out[0].who).toBe("Felipe");
  expect(out[0].location).toBe("remote");
});

test("remote and room speakers talking at the same time stay separate", async () => {
  const remote = speech(2.0, 0.3, 3);
  const room = speech(2.1, 0.3, 4);
  const lines = new Map([[remote.length, "Can you hear me okay"], [room.length, "The pill should be taller"]]);
  const { p, out } = setup(lines);
  const t = Date.now() - 4000;
  await p.ingest({ deviceId: "felipe-laptop", t0: t, t1: t + 2000, wav: remote });
  await p.ingest({ deviceId: "chey-laptop", t0: t + 50, t1: t + 2150, wav: room });
  await p.flush();
  expect(out.map((o) => o.text).sort()).toEqual(["Can you hear me okay", "The pill should be taller"]);
  expect(out.find((o) => o.text.startsWith("The pill"))?.who).toBe("Chey");
});

test("two remote people never merge into one line", async () => {
  const a = speech(2.0, 0.3, 5);
  const b = speech(2.05, 0.3, 6);
  const lines = new Map([[a.length, "I'm dialing in from home"], [b.length, "Same here from the office"]]);
  const { s, p, out } = setup(lines);
  const britain = s.upsertPerson({ name: "Britain" });
  s.touchDevice("britain-laptop", { personId: britain.id, location: "remote" });
  const t = Date.now() - 4000;
  await p.ingest({ deviceId: "felipe-laptop", t0: t, t1: t + 2000, wav: a });
  await p.ingest({ deviceId: "britain-laptop", t0: t + 30, t1: t + 2080, wav: b });
  await p.flush();
  expect(out).toHaveLength(2);
});

test("an echo is only the very same words: a room reply that adds a word to the remote line stays", async () => {
  const remote = speech(1.0, 0.3, 7);
  const reply = speech(1.3, 0.3, 8);
  const lines = new Map([[remote.length, "Yes."], [reply.length, "Yes please"]]);
  const { p, out } = setup(lines);
  const t = Date.now() - 4000;
  await p.ingest({ deviceId: "felipe-laptop", t0: t, t1: t + 1000, wav: remote });
  await p.ingest({ deviceId: "chey-laptop", t0: t + 100, t1: t + 1400, wav: reply });
  await p.flush();
  expect(out.map((o) => `${o.who}: ${o.text}`).sort()).toEqual(["Chey: Yes please", "Felipe: Yes."]);
});

test("a short remote line played into the room, word for word, is still one line", async () => {
  const clean = speech(1.0, 0.3, 9);
  const echo = speech(1.02, 0.05, 10);
  const lines = new Map([[clean.length, "Yes."], [echo.length, "yes"]]);
  const { p, out } = setup(lines);
  const t = Date.now() - 4000;
  await p.ingest({ deviceId: "felipe-laptop", t0: t, t1: t + 1000, wav: clean });
  await p.ingest({ deviceId: "chey-laptop", t0: t + 250, t1: t + 1270, wav: echo });
  await p.flush();
  expect(out).toEqual([{ text: "Yes.", who: "Felipe", location: "remote" }]);
});
