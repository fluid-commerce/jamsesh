import { expect, test } from "bun:test";
import { quietRoom, speechDecision, trimForSpeech } from "../src/brain/speech";
import { speechSource } from "../src/brain/brain";

const d = (o: Partial<Parameters<typeof speechDecision>[0]>) => speechDecision({ voiceReplies: true, source: "voice", kind: "answer", quietRoom: false, sinceLastMs: 60_000, ...o });

test("spoken questions get spoken answers", () => expect(d({})).toBe("speak"));
test("problems are spoken when asked by voice", () => expect(d({ kind: "problem" })).toBe("speak"));
test("a spoken request is confirmed out loud in a few words", () => {
  expect(d({ kind: "confirm" })).toBe("speak");
  expect(d({ kind: "confirm", source: "recorded" })).toBe("speak");
});
test("typed and overheard confirmations stay text", () => {
  expect(d({ kind: "confirm", source: "typed" })).toBe("text");
  expect(d({ kind: "confirm", source: "ambient" })).toBe("text");
});
test("a quiet room doesn't get confirmations out loud", () => expect(d({ kind: "confirm", quietRoom: true })).toBe("text"));
test("typed requests get text", () => expect(d({ source: "typed" })).toBe("text"));
test("overheard work never makes the brain talk", () => expect(d({ source: "ambient", kind: "problem" })).toBe("text"));
test("a quiet room still gets answers, but not problems", () => {
  expect(d({ quietRoom: true })).toBe("speak");
  expect(d({ quietRoom: true, kind: "problem" })).toBe("text");
});
test("no back-to-back talking", () => expect(d({ sinceLastMs: 1500 })).toBe("text"));
test("voice replies off means text", () => expect(d({ voiceReplies: false })).toBe("text"));
test("quiet notes are recognized", () => {
  expect(quietRoom(["Don't speak out loud unless someone asks a question directly."])).toBe(true);
  expect(quietRoom(["Keep replies short."])).toBe(false);
});
test("spoken replies are two sentences at most", () => expect(trimForSpeech("One. Two! Three? Four.")).toBe("One. Two!"));
test("sources", () => {
  const ev = (data: any) => ({ id: 1, ts: 0, kind: "speech", authorType: "person", authorId: null, authorName: "A", text: "x", relevance: null, workstreamId: null, data }) as any;
  expect(speechSource([ev({ typed: true, direct: true })])).toBe("typed");
  expect(speechSource([ev({ typed: true })])).toBe("ambient");
  expect(speechSource([ev({ recorded: true, direct: true })])).toBe("recorded");
  expect(speechSource([ev({ direct: true })])).toBe("voice");
  expect(speechSource([ev({})])).toBe("ambient");
  expect(speechSource([])).toBe("ambient");
});

