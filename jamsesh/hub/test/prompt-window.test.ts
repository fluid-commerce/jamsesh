import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../src/hub";
import { quietRoom } from "../src/brain/speech";
import { cleanTranscript } from "../src/audio/transcribe";
import type { Utterance } from "../src/types";

const dir = mkdtempSync(join(tmpdir(), "jam-pw-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function room() {
  const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, String(Math.random())) });
  const s = hub.session;
  const maya = s.upsertPerson({ name: "Maya" });
  const ben = s.upsertPerson({ name: "Ben" });
  s.touchDevice("mayaLaptop", { personId: maya.id, location: "room", micOn: true });
  s.touchDevice("benLaptop", { personId: ben.id, location: "room", micOn: true });
  return { hub, s, maya, ben };
}

let n = 0;
function line(hub: Hub, text: string, personId: string | null, loudest: string, t0: number, t1 = t0 + 1500): Utterance {
  const u: Utterance = {
    id: `utt${++n}`,
    t0,
    t1,
    text,
    personId,
    speakerName: personId ?? "Someone",
    confidence: 0.9,
    method: "device",
    deviceId: loudest,
    devices: [
      { deviceId: "mayaLaptop", level: loudest === "mayaLaptop" ? -20 : -35, snr: 20 },
      { deviceId: "benLaptop", level: loudest === "benLaptop" ? -20 : -35, snr: 20 },
    ],
    location: "room",
    eventId: null,
    engine: "test",
  };
  hub.session.store.put("utterances", u);
  (hub as any).roomLine(u, true);
  return u;
}

test("a recorded prompt holds only the recorder's words; others keep flowing as room speech", async () => {
  const { hub, s, maya, ben } = room();
  const t0 = Date.now() - 6000;
  hub.promptStart("mayaLaptop", t0);
  line(hub, "put the nav on the big screen", maya.id, "mayaLaptop", t0 + 500);
  line(hub, "I think the footer is wrong", ben.id, "benLaptop", t0 + 2200);
  line(hub, "and make it blue", maya.id, "mayaLaptop", t0 + 4000);
  const r = await hub.promptWindow({ deviceId: "mayaLaptop", personId: maya.id, t0, t1: t0 + 5500, pointer: [] });
  expect(r.ok).toBe(true);
  expect((r as any).text).toBe("put the nav on the big screen and make it blue");
  const speech = s.store.recentEvents({ kinds: ["speech"], limit: 20 });
  // Ben's line is in the feed as his own; Maya's words appear once, in the prompt.
  expect(speech.filter((e) => e.text.includes("footer")).length).toBe(1);
  expect(speech.filter((e) => e.text.includes("nav on the big screen")).length).toBe(1);
  hub.stop();
});

test("a line the recording laptop heard but nobody it owns said is not the recorder's", async () => {
  const { hub, maya, ben } = room();
  const t0 = Date.now() - 6000;
  hub.promptStart("mayaLaptop", t0);
  // Ben is loudest at his own laptop, and Maya's laptop also heard him.
  line(hub, "we should ship friday", ben.id, "benLaptop", t0 + 1000);
  const r = await hub.promptWindow({ deviceId: "mayaLaptop", personId: maya.id, t0, t1: t0 + 5500, pointer: [], typed: "show the footer" });
  expect((r as any).text).toBe("show the footer");
  hub.stop();
});

test("quiet-room notes cover how people actually say it", () => {
  for (const n of ["only talk when someone asks you something", "only speak when asked", "be quieter", "talk less", "don't talk unless asked", "Talk only when asked"]) expect(quietRoom([n])).toBe(true);
  for (const n of ["the nav should be blue", "speak up please", "ask Ben about the footer"]) expect(quietRoom([n])).toBe(false);
});

test("with one microphone there is nothing to wait for; with two the slowest sets the window", () => {
  const { hub, s } = room();
  s.touchDevice("benLaptop", { micOn: false });
  expect(hub.audio.settleMs("room")).toBeLessThan(400);
  s.touchDevice("benLaptop", { micOn: true });
  expect(hub.audio.settleMs("room")).toBeGreaterThanOrEqual(700);
  hub.stop();
});

test("with no engine and no gateway the room says it can't hear", () => {
  const { hub } = room();
  expect(hub.transcriber.problem()).toMatch(/can't be turned into text/);
  hub.stop();
});

test("whisper noise is still cleaned", () => {
  expect(cleanTranscript("Thank you.", 1)).toBe("");
});
