// The brain answers to every name it's given, and says honestly what a speaker correction taught.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addressesBrain, brainNames, nameForms, onlyTheName, verdictFor } from "../src/brain/brain";
import { speechSource } from "../src/brain/brain";
import { learningNote, voiceprintStatus } from "../src/audio/voiceprint";
import { DEFAULT_MODELS } from "../src/session";
import { Hub } from "../src/hub";
import { bus } from "../src/bus";
import { config } from "../src/config";
import { resetSpeechState, speak } from "../src/brain/speech";
import type { Utterance } from "../src/types";

const dir = mkdtempSync(join(tmpdir(), "jam-vn-"));
const room = () => new Hub({ canvas: false, whisper: false, dataDir: join(dir, String(Math.random())) });

test("a line addressed to an alias addresses the brain", () => {
  const names = ["JamSesh", "Computah"];
  expect(addressesBrain("Computah, bring up the nav options", names)).toBe(true);
  expect(addressesBrain("can you do that, computer?", ["JamSesh", "computer"])).toBe(true);
  expect(addressesBrain("Computadora, muéstrame el tablero", ["JamSesh", "computadora"])).toBe(true);
  // the transcriber hears the alias as a near spelling
  expect(addressesBrain("Computer, bring up the nav options", names)).toBe(true);
  expect(addressesBrain("hey comput ah what's the code", names)).toBe(true);
});
test("an alias used as a thing is not an address", () => {
  const names = ["JamSesh", "computer"];
  expect(addressesBrain("my computer is on the fritz again today", names)).toBe(false);
  expect(addressesBrain("open the computer app", names)).toBe(false);
});
test("a name split by the transcriber still counts, and the old default is unchanged", () => {
  expect(addressesBrain("hey com puter, show the board", ["JamSesh", "computer"])).toBe(true);
  expect(addressesBrain("Jam session, show the board", "JamSesh")).toBe(true);
  expect(addressesBrain("update the jamsesh skill", "JamSesh")).toBe(false);
});
test("name forms", () => {
  expect(nameForms("Computah")).toEqual(expect.arrayContaining(["computah", "computer", "computa"]));
  expect(nameForms("hi")).toEqual([]);
});
test("just the alias is a call, and approvals ignore it", () => {
  expect(onlyTheName("Hey Computah", ["JamSesh", "Computah"])).toBe(true);
  const ev = { id: 1, ts: 2000, kind: "speech", authorType: "person", authorName: "A", text: "Computah, approve", data: {} } as any;
  expect(verdictFor([ev], { id: "r", createdAt: 1000, agentName: "x", ownerName: "y", repo: "r", branch: "" }, [{ id: "r", createdAt: 1000, agentName: "x", ownerName: "y", repo: "r", branch: "" }], ["JamSesh", "Computah"])?.approve).toBe(true);
});
test("brainNames lists the display name first", () => expect(brainNames({ brainName: "JamSesh", brainAliases: ["Computah"] })).toEqual(["JamSesh", "Computah"]));

test("adding a name keeps the display name; renaming keeps the old one as an alias", () => {
  const hub = room();
  const s = hub.session;
  expect(s.settings().brainAliases).toEqual([]);
  s.addBrainName("Computah");
  s.addBrainName("computah");
  expect(s.settings().brainAliases).toEqual(["Computah"]);
  s.addBrainName("Computer", true);
  expect(s.settings().brainName).toBe("Computer");
  expect(s.settings().brainAliases).toEqual(expect.arrayContaining(["JamSesh", "Computah"]));
  hub.stop();
});

test("rooms on the old default speech model move to the new one; explicit choices stay", () => {
  const hub = room();
  const s = hub.session;
  s.updateSettings({ models: { speech: "openai/tts-1" } as any });
  expect(s.settings().models.speech).toBe(DEFAULT_MODELS.speech);
  s.updateSettings({ models: { speech: "google/gemini-3.8-flash-tts" } as any });
  expect(s.settings().models.speech).toBe("google/gemini-3.8-flash-tts");
  hub.stop();
});

test("a triaged question counts as spoken-to for speech", () => {
  const ev = (data: any) => ({ id: 1, ts: 0, kind: "speech", authorType: "person", authorId: null, authorName: "A", text: "x", relevance: null, workstreamId: null, data }) as any;
  expect(speechSource([ev({ direct: true })])).toBe("voice");
});

test("correction feedback says what it learned, or why not", () => {
  expect(learningNote("Ben", { learned: true })).toBe("Learning Ben's voice.");
  expect(learningNote("Ben", { learned: false, reason: "the line is under 0.8 seconds" })).toBe("Renamed, but couldn't learn from that line (the line is under 0.8 seconds).");
});

let n = 0;
function line(hub: Hub, personId: string): Utterance {
  const u: Utterance = { id: `vn${++n}`, t0: Date.now() - 3000, t1: Date.now() - 1500, text: "hello there", personId: null, speakerName: "Someone", confidence: 0.5, method: "device", deviceId: "d", devices: [], location: "room", eventId: null, engine: "test" } as any;
  hub.session.store.put("utterances", u);
  return u;
}

test("a correction with no voice sample says so", () => {
  const hub = room();
  const ben = hub.session.upsertPerson({ name: "Ben" });
  const u = line(hub, ben.id);
  const { learning } = hub.audio.assign(u.id, ben.id);
  expect(learning.learned).toBe(false);
  if (!learning.learned) expect(learning.reason).toMatch(voiceprintStatus().available ? /no voice sample/ : /voice matching is off/);
  hub.stop();
});

test("voice matching status is in hub state and says why when it is off", () => {
  const hub = room();
  const v = hub.session.state().voiceprints;
  expect(v.available).toBe(voiceprintStatus().available);
  if (!v.available) expect(v.reason.length).toBeGreaterThan(0);
  expect(v.enrolled).toBe(0);
  hub.stop();
});

test("when speech falls back to the Mac's voice, the room is told why", async () => {
  process.env.JAMSESH_SILENT = "1";
  // No key, so no call leaves this machine.
  const key = config.envGatewayKey;
  (config as any).envGatewayKey = "";
  resetSpeechState();
  const hub = room();
  hub.session.updateSettings({ voiceReplies: true });
  const toasts: any[] = [];
  const off = bus.on((m) => m.type === "toast" && toasts.push(m));
  await speak(hub.session, "Sent to Felipe's agent.", { source: "voice", kind: "confirm" });
  off();
  (config as any).envGatewayKey = key;
  expect(toasts.some((m) => /built-in voice|No good voice/.test(m.text) && m.detail)).toBe(true);
  hub.stop();
});
