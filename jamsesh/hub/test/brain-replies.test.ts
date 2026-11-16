// Replies to spoken lines: housekeeping notices stay on screen, spoken requests are answered aloud, half-sentences wait.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { halfSentence, speechSource } from "../src/brain/brain";
import { resetSpeechState, speechDecision } from "../src/brain/speech";
import { Hub } from "../src/hub";
import { bus } from "../src/bus";
import type { BusMessage } from "../src/types";

const dir = mkdtempSync(join(tmpdir(), "jam-replies-"));
const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, "hub") });
const sent: BusMessage[] = [];
const off = bus.on((m) => sent.push(m));
afterAll(() => {
  off();
  hub.stop();
});

const ev = (data: any, over: any = {}) => ({ id: 1, ts: 0, kind: "speech", authorType: "person", authorId: "p1", authorName: "Chey", text: "x", relevance: null, workstreamId: null, data, ...over }) as any;

// ---- 1. housekeeping notices
test("a learning notice is shown, never spoken, and not posted twice within 30 s", async () => {
  resetSpeechState();
  hub.session.updateSettings({ voiceReplies: true });
  sent.length = 0;
  hub.confirmLearning("Chey", { learned: true });
  hub.confirmLearning("Chey", { learned: true });
  await Bun.sleep(20);
  const posted = hub.session.store.recentEvents({ kinds: ["brain"], limit: 10 }).filter((e) => e.text === "Learning Chey's voice.");
  expect(posted.length).toBe(1);
  expect(posted[0].data.spoken).toBe(false);
  expect(sent.filter((m) => m.type === "speak")).toEqual([]);
  expect(sent.filter((m) => m.type === "toast").length).toBe(1);
  // A different notice isn't suppressed.
  hub.confirmLearning("Chey", { learned: false, reason: "voice matching is off on this host" });
  await Bun.sleep(20);
  expect(hub.session.store.recentEvents({ kinds: ["brain"], limit: 10 }).some((e) => e.text.startsWith("Renamed, but"))).toBe(true);
});

test("the relabel tool answers briefly, so the brain doesn't restate the notice", () => {
  (hub.audio as any).assign = () => ({ learning: { learned: false, reason: "voice matching is off on this host" } });
  const line = hub.session.store.addEvent({ kind: "speech", authorType: "person", authorName: "Someone", text: "hello there", data: { utteranceId: "u1" } });
  expect(hub.brain.relabel!(line.id, "Dana")).toBe("Done.");
});

// ---- 2. spoken requests are answered aloud
test("speechSource: every line in the batch counts, a spoken question at any confidence, typed stays typed", () => {
  expect(speechSource([ev({ direct: true }), ev({})])).toBe("voice");
  expect(speechSource([ev({ intent: "question", confidence: 0.2 })])).toBe("voice");
  expect(speechSource([ev({ asked: true }), ev({ intent: "statement" })])).toBe("voice");
  expect(speechSource([ev({ intent: "statement", confidence: 0.9 })])).toBe("ambient");
  expect(speechSource([ev({ intent: "question" }, { kind: "prompt" })])).toBe("ambient");
  expect(speechSource([ev({ typed: true, intent: "question" })])).toBe("ambient");
  expect(speechSource([ev({ typed: true, direct: true })])).toBe("typed");
  expect(speechSource([ev({ typed: true, direct: true }), ev({ intent: "question" })])).toBe("voice");
});
test("a spoken reply is still text when voice replies are off or it just spoke", () => {
  const base = { voiceReplies: true, source: speechSource([ev({ direct: true })]), kind: "answer" as const, quietRoom: false, sinceLastMs: 60_000 };
  expect(speechDecision(base)).toBe("speak");
  expect(speechDecision({ ...base, voiceReplies: false })).toBe("text");
  expect(speechDecision({ ...base, sinceLastMs: 1000 })).toBe("text");
});

// ---- 3. half-sentences that mention the name
test("halfSentence", () => {
  const n = "JamSesh";
  expect(halfSentence("JamSesh said this, but.", n)).toBe(true);
  expect(halfSentence("so JamSesh went and", n)).toBe(true);
  expect(halfSentence("Hey JamSesh", n)).toBe(true);
  expect(halfSentence("JamSesh, stop", n)).toBe(false);
  expect(halfSentence("JamSesh, mute", n)).toBe(false);
  expect(halfSentence("JamSesh, which one?", n)).toBe(false);
  expect(halfSentence("JamSesh, put the mockup on the screen", n)).toBe(false);
  expect(halfSentence("JamSesh, put the mockup on the screen", n, 0.2)).toBe(false);
  expect(halfSentence("JamSesh show it now", n, 0.3)).toBe(true);
});

test("a half-sentence is held like the bare name: the same speaker's next line is the request", () => {
  const brain = hub.brain as any;
  const direct: number[] = [];
  brain.direct = (e: any) => void direct.push(e.id);
  const said = (text: string, data: any = {}) => hub.session.store.addEvent({ kind: "speech", authorType: "person", authorId: "p9", authorName: "Chey", text, data });
  const half = said("JamSesh said this, but.");
  hub.brain.hear(half);
  expect(direct).toEqual([]);
  expect(brain.calledBy?.authorId).toBe("p9");
  const next = said("put the mockup on the screen");
  hub.brain.hear(next);
  expect(direct).toEqual([next.id]);
  // A clear request is direct at once, and typed lines are never held.
  brain.calledBy = null;
  const clear = said("JamSesh, put the mockup on the screen");
  hub.brain.hear(clear);
  const typed = said("JamSesh said this, but.", { typed: true });
  hub.brain.hear(typed);
  expect(direct).toEqual([next.id, clear.id, typed.id]);
});
