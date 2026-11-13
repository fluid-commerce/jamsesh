// Lines that show at once and settle in place, and the "<Name> is talking" indicator.
import "fake-indexeddb/auto";
import { enterDom, leaveDom } from "./dom-setup";
import { afterAll, afterEach, expect, test } from "bun:test";

enterDom();
const { act, cleanup, render } = await import("@testing-library/react");
const { RoomFeed, earlyLines, feedKey, barHeight } = await import("../src/shared/ui");
const { hub } = await import("../src/shared/hub");
const { TalkSignal } = await import("../src/shared/mic");

afterAll(() => leaveDom());
afterEach(cleanup);

const utt = (over: Record<string, unknown> = {}) => ({ id: "utt_1", t0: 1000, t1: 3000, text: "put the pricing page up", personId: "p1", speakerName: "Ana", confidence: 0.8, method: "device", deviceId: "d1", devices: [], location: "room", eventId: null, engine: "stub", settled: false, ...over }) as any;
const speech = (id: number, text: string, utteranceId: string) => ({ id, ts: id, kind: "speech", authorType: "person", authorId: "p1", authorName: "Ana", text, relevance: null, workstreamId: null, data: { utteranceId, confidence: 0.9, method: "device", source: "overheard" } }) as any;
const person = (id: string, name: string, color: string) => ({ id, name, color, role: "", weight: 1, hasVoiceprint: false, voiceSamples: 0, createdAt: 0 });
const baseState = (events: any[], utterances: any[]) => ({
  session: { roomId: "room-live", name: "t" },
  settings: { brainName: "Computah" },
  people: [person("p1", "Ana", "#3E8BFF")],
  agents: [],
  events,
  utterances,
  totals: { events: events.length },
  voiceprints: null,
});
const feed = (state: unknown) => {
  (hub as any).snap = { ...(hub as any).snap, state, connected: true, status: "connected", talkers: [], removed: [] };
};

test("an early line shows with its words, and goes when the settled line is in the list or the hub took it back", () => {
  const early = utt();
  expect(earlyLines([early], []).map((e) => [e.text, e.authorName, e.data.early])).toEqual([["put the pricing page up", "Ana", true]]);
  // Settled: the event carries the same utterance id, so the early copy is not shown next to it.
  expect(earlyLines([early], [speech(10, "Put the pricing page up.", "utt_1")])).toEqual([]);
  // Taken back (settled, no words) or already settled: nothing.
  expect(earlyLines([utt({ text: "", settled: true })], [])).toEqual([]);
  expect(earlyLines([utt({ settled: undefined })], [])).toEqual([]);
  // The early copy and its settled line are one row to the page.
  expect(feedKey(earlyLines([early], [])[0])).toBe(feedKey(speech(10, "x", "utt_1")));
});

test("the hub client updates an early line in place: one utterance per id, in the order it was said", () => {
  const h = hub as any;
  h.handle({ type: "state", state: baseState([], []) });
  h.handle({ type: "utterance", utterance: utt({ id: "a", t0: 1 }) });
  h.handle({ type: "utterance", utterance: utt({ id: "b", t0: 2, text: "second" }) });
  h.handle({ type: "utterance", utterance: utt({ id: "a", t0: 1, text: "Put the pricing page up.", speakerName: "Bob", settled: undefined }) });
  const list = hub.get().state!.utterances;
  expect(list.map((u) => [u.id, u.text])).toEqual([["a", "Put the pricing page up."], ["b", "second"]]);
});

test("the feed shows the early line, then the settled one in the same row, with no flicker", async () => {
  feed(baseState([], [utt()]));
  const { container } = render(<RoomFeed big />);
  const rows = () => [...container.querySelectorAll(".feed .line")] as HTMLElement[];
  expect(rows()).toHaveLength(1);
  const row = rows()[0];
  expect(row.className).toContain("early");
  expect(row.textContent).toContain("put the pricing page up");
  // The settled line arrives (the event first, then the utterance update): the same element is kept.
  await act(async () => {
    feed(baseState([speech(10, "Put the pricing page up.", "utt_1")], [utt({ settled: undefined, text: "Put the pricing page up." })]));
    (hub as any).set({});
  });
  expect(rows()).toHaveLength(1);
  expect(rows()[0]).toBe(row);
  expect(row.className).not.toContain("early");
  expect(row.textContent).toContain("Put the pricing page up.");
});

test("the talking strip shows name and bars, is always there, and clears when the talkers go", async () => {
  feed(baseState([], []));
  const { container } = render(<RoomFeed editable />);
  const strip = () => container.querySelector(".feed-talking") as HTMLElement;
  expect(strip()).toBeTruthy();
  expect(strip().textContent).toBe("");
  await act(async () => (hub as any).handle({ type: "talking", talkers: [{ deviceId: "d1", personId: "p1", name: "Ana", color: "#3E8BFF", level: 0.8, live: true }] }));
  expect(strip().textContent!.replace(/\s+/g, " ").trim()).toBe("Ana is talking");
  expect(strip().querySelectorAll(".bars i")).toHaveLength(4);
  await act(async () => (hub as any).handle({ type: "talking", talkers: [] }));
  expect(strip().textContent).toBe("");
  // Bars follow the level; a talker who stopped is flat.
  expect(barHeight(1, true)).toBeGreaterThan(barHeight(0.1, true));
  expect(barHeight(1, false)).toBe(3);
});

test("a microphone tells the room when speech starts and ends, five times a second at most, and nothing when quiet", () => {
  const s = new TalkSignal();
  expect(s.step(false, -70, 0)).toBeNull();
  expect(s.step(false, -70, 20)).toBeNull();
  expect(s.step(true, -40, 40)).toEqual({ on: true, level: -40 });
  // 20 ms frames for a second: a start, then a level every 200 ms.
  let sent = 0;
  for (let t = 60; t < 1040; t += 20) if (s.step(true, -35 + ((t / 20) % 5), t)) sent++;
  expect(sent).toBeLessThanOrEqual(5);
  expect(sent).toBeGreaterThanOrEqual(4);
  expect(s.step(false, -60, 1100)).toEqual({ on: false, level: -90 });
  expect(s.step(false, -60, 1120)).toBeNull();
  // The level is the loudest frame since the last message.
  const p = new TalkSignal();
  p.step(true, -50, 0);
  p.step(true, -20, 40);
  p.step(true, -45, 100);
  expect(p.step(true, -45, 200)).toEqual({ on: true, level: -20 });
});

test("retractions remove the line by id: any number of them leave real lines in the capped list", () => {
  const h = hub as any;
  h.handle({ type: "state", state: baseState([], []) });
  h.handle({ type: "utterance", utterance: utt({ id: "real", settled: undefined, t0: 1 }) });
  for (let i = 0; i < 700; i++) {
    h.handle({ type: "utterance", utterance: utt({ id: `e${i}`, t0: 10 + i }) });
    h.handle({ type: "utterance-retracted", id: `e${i}` });
  }
  expect(hub.get().state!.utterances.map((u) => u.id)).toEqual(["real"]);
});

test("the empty-feed note is not shown while an early line is", () => {
  feed(baseState([], [utt()]));
  const { container } = render(<RoomFeed big />);
  expect(container.querySelector(".empty-note")).toBeNull();
  cleanup();
  feed(baseState([], []));
  expect(render(<RoomFeed big />).container.querySelector(".empty-note")).not.toBeNull();
});
