import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../src/hub";
import { encodeWav } from "../src/audio/wav";
import { voiceprintsAvailable } from "../src/audio/voiceprint";
import type { Utterance } from "../src/types";

const dir = mkdtempSync(join(tmpdir(), "jam-af-"));

function room() {
  const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, String(Math.random())) });
  const s = hub.session;
  const maya = s.upsertPerson({ name: "Maya" });
  const ben = s.upsertPerson({ name: "Ben" });
  s.touchDevice("mayaLaptop", { personId: maya.id, location: "room", micOn: true });
  return { hub, s, maya, ben };
}

let n = 0;
function line(hub: Hub, text: string, personId: string | null, t0: number, t1 = t0 + 1500): Utterance {
  const u: Utterance = {
    id: `af${++n}`, t0, t1, text, personId, speakerName: personId ?? "Someone", confidence: 0.9, method: "device", deviceId: "mayaLaptop",
    devices: [{ deviceId: "mayaLaptop", level: -20, snr: 20 }], location: "room", eventId: null, engine: "test",
  };
  hub.session.store.put("utterances", u);
  (hub as any).roomLine(u, true);
  return u;
}

const speech = (s: Hub["session"]) => s.store.recentEvents({ kinds: ["speech"], limit: 50 });

test("U1: a window that never gets Stop hands its held lines back to the room", () => {
  const { hub, s, maya } = room();
  const t0 = Date.now() - 60_000;
  hub.promptStart("mayaLaptop", t0);
  line(hub, "put the nav up", maya.id, t0 + 1000);
  expect(speech(s).length).toBe(0);
  // A second Record on the same laptop without a Stop in between.
  hub.promptStart("mayaLaptop", Date.now());
  expect(speech(s).map((e) => e.text)).toEqual(["put the nav up"]);
  hub.stop();
});

test("U2: Stop answers within the spec's 7 s even when transcription never finishes", async () => {
  const { hub, maya } = room();
  const t0 = Date.now() - 3000;
  hub.promptStart("mayaLaptop", t0);
  (hub.audio as any).pendingFor = () => 1;
  const began = Date.now();
  const r = await hub.promptWindow({ deviceId: "mayaLaptop", personId: maya.id, t0, t1: t0 + 2000, pointer: [], typed: "show the footer" });
  expect(Date.now() - began).toBeLessThan(8000);
  expect(r.ok).toBe(true);
  hub.stop();
}, 12000);

test("U3: relabeling a recorded prompt changes its speaker but not its text", async () => {
  const { hub, s, maya, ben } = room();
  const t0 = Date.now() - 6000;
  hub.promptStart("mayaLaptop", t0);
  const u = line(hub, "make it blue", maya.id, t0 + 500);
  const r: any = await hub.promptWindow({ deviceId: "mayaLaptop", personId: maya.id, t0, t1: t0 + 3000, pointer: [] });
  expect(s.store.event(r.eventId)?.authorName).toBe("Maya");
  hub.audio.assign(u.id, ben.id);
  const ev = s.store.event(r.eventId)!;
  expect(ev.authorName).toBe("Ben");
  expect(ev.authorId).toBe(ben.id);
  expect(ev.text).toBe("make it blue");
  hub.stop();
}, 12000);

test("U5: lines past the window cap are not also in the prompt", async () => {
  const { hub, maya } = room();
  const t0 = Date.now() - 4 * 60_000;
  hub.promptStart("mayaLaptop", t0);
  line(hub, "first part", maya.id, t0 + 1000);
  line(hub, "and then the footer", maya.id, t0 + 3 * 60_000 - 1000 - 60_000 + 61_000);
  const r: any = await hub.promptWindow({ deviceId: "mayaLaptop", personId: maya.id, t0, t1: t0 + 3.5 * 60_000, pointer: [] });
  expect(r.text).toBe("first part");
  hub.stop();
}, 12000);

test("R13: a window ending after a newer one started leaves the newer one open", async () => {
  const { hub, s, maya } = room();
  const t0 = Date.now() - 4000;
  hub.promptStart("mayaLaptop", t0);
  const first = hub.promptWindow({ deviceId: "mayaLaptop", personId: maya.id, t0, t1: t0 + 1000, pointer: [], typed: "one" });
  hub.promptStart("mayaLaptop", Date.now());
  await first;
  const second = Date.now() + 500;
  line(hub, "second recording words", maya.id, second);
  expect(speech(s).filter((e) => e.text.includes("second recording")).length).toBe(0);
  hub.stop();
}, 12000);

test("U6: remote laptops don't wait on each other", () => {
  const { hub, s } = room();
  s.touchDevice("r1", { location: "remote", micOn: true });
  s.touchDevice("r2", { location: "remote", micOn: true });
  expect(hub.audio.settleMs("remote")).toBeLessThan(400);
  hub.stop();
});

test("R1: a build notice lands in the feed without becoming room speech for the brain", () => {
  const { hub, s } = room();
  let heard = 0;
  (hub.brain as any).hear = () => void heard++;
  (hub.host as any).onBuilt("ios@main", false, "exit 65");
  expect(heard).toBe(0);
  expect(s.store.recentEvents({ kinds: ["system"], limit: 5 }).some((e) => e.text.includes("Preview build failed"))).toBe(true);
  hub.stop();
});

function tone(sec: number) {
  const len = Math.round(16000 * sec); const x = new Float32Array(len); let a = 1;
  for (let i = 0; i < len; i++) { a = (a * 1664525 + 1013904223) >>> 0; x[i] = 0.2 * (0.5 + 0.5 * Math.sin(i / 900)) * ((a / 4294967296) * 2 - 1 + Math.sin(i / 7)); }
  return encodeWav({ sampleRate: 16000, samples: x });
}

test("U4: relabeling twice removes the voice sample from the first, wrong, person", async () => {
  if (!voiceprintsAvailable()) return;
  const { hub, s, ben } = room();
  const cam = s.upsertPerson({ name: "Cam" });
  s.touchDevice("x", { location: "room", micOn: true });
  (hub.transcriber as any).transcribe = async () => ({ text: "hello there team", engine: "fake" });
  const t = Date.now() - 5000;
  await hub.audio.ingest({ deviceId: "x", t0: t, t1: t + 2000, wav: tone(2), levelDb: -25, noiseDb: -55 });
  await hub.audio.flush();
  const u = s.store.all("utterances")[0];
  hub.audio.assign(u.id, ben.id);
  hub.audio.assign(u.id, cam.id);
  expect(hub.audio.voiceprints.count(ben.id)).toBe(0);
  // A correction counts as many automatic samples, but it is still the one sample.
  expect(hub.audio.voiceprints.learnedFrom(cam.id).correction).toBe(1);
  expect(hub.audio.voiceprints.count(cam.id)).toBe(10);
  hub.stop();
}, 30000);
