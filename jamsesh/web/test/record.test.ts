import { expect, test } from "bun:test";
import { notesToSend, closeRecording, leaveActions, newRecordToken, pointerOrNone, reapOrphans, type RecStatus, mergeInto, pinWords, sendSummary, type RecordNote } from "../src/shared/notes";

const note = (id: string, text: string, over: Partial<RecordNote> = {}): RecordNote => ({ id, text, t0: 0, t1: 1, personId: "p", pin: null, ...over });
const pin = (ref: string, x = 0.2, y = 0.1) => ({ target: { kind: "artifact" as const, ref, label: "Login" }, x, y, kind: "click" as const });

test("joining a note with the one above keeps the words in order and the earlier spot", () => {
  const out = mergeInto([note("a", "make it bigger", { pin: pin("a1"), ownerName: "Atlas" }), note("b", "and bluer", { t1: 9, pin: pin("a2", 0.9, 0.9), ownerName: "Juno" })], 1);
  expect(out.length).toBe(1);
  expect(out[0]).toMatchObject({ text: "make it bigger and bluer", t1: 9, ownerName: "Atlas" });
  expect(out[0].pin?.target.ref).toBe("a1");
});

test("an unpinned note joined onto a pinned one, or under an unpinned one, takes the pin that exists", () => {
  expect(mergeInto([note("a", "one", { pin: pin("a1") }), note("b", "two")], 1)[0].pin?.target.ref).toBe("a1");
  const under = mergeInto([note("a", "one"), note("b", "two", { pin: pin("a2"), ownerName: "Juno" })], 1)[0];
  expect(under.pin?.target.ref).toBe("a2");
  expect(under.ownerName).toBe("Juno");
});

test("joining the first note, or one that isn't there, changes nothing", () => {
  const ns = [note("a", "one"), note("b", "two")];
  expect(mergeInto(ns, 0)).toBe(ns);
  expect(mergeInto(ns, 5)).toBe(ns);
});

test("a spot reads in words", () => {
  expect(pinWords(note("a", "x", { pin: pin("a1", 0.1, 0.1) }))).toBe("Login, top left");
  expect(pinWords(note("a", "x", { pin: pin("a1", 0.5, 0.5) }))).toBe("Login, center");
  expect(pinWords(note("a", "x"))).toBeNull();
  expect(pinWords(note("a", "x", { pin: pin("a1", 0.9, 0.1), screenId: "main" }))).toBe("Login, top right · big screen");
});

test("a send is told in words: who got how many, and what went to the brain", () => {
  expect(sendSummary({ ok: true, sent: [{ agentName: "Atlas", notes: 2 }, { agentName: "Juno", notes: 1 }], brain: 1 }, "Computah").text).toBe("2 notes to Atlas, 1 note to Juno, 1 note to Computah");
  expect(sendSummary({ ok: true, sent: [], brain: 3 }, "Computah").text).toBe("3 notes to Computah");
});

test("a recording token is made before Start, is unique, and is one the hub accepts", () => {
  const a = newRecordToken();
  expect(a).toMatch(/^[\w-]{8,64}$/);
  expect(newRecordToken()).not.toBe(a);
});

// ---- closing a recording: only the hub's word ends it ----
const noWait = async () => {};
const endedStop: RecStatus = { state: "ended", outcome: { kind: "stop", result: { ok: true, recordingId: "r1", notes: [{ id: "n" }] } } };

test("a Stop whose reply was lost is recovered by asking: the committed notes come back, and no cancel is sent", async () => {
  let cancels = 0;
  const out = await closeRecording({ stop: () => Promise.reject(new Error("offline")), status: async () => endedStop, cancel: async () => (cancels++, endedStop) }, noWait);
  expect(out).toMatchObject({ ended: true, result: { ok: true, recordingId: "r1" } });
  expect(cancels).toBe(0);
});

test("a cancel that lands after a committed finish returns that finish's notes, not an empty ending", async () => {
  const out = await closeRecording({ stop: () => Promise.reject(new Error("offline")), status: () => Promise.reject(new Error("offline")), cancel: async () => endedStop }, noWait);
  expect(out).toMatchObject({ ended: true, result: { recordingId: "r1" } });
});

test("a 403 Stop is not an ending: the hub is asked, and a recording it still has live is cancelled", async () => {
  const calls: string[] = [];
  const out = await closeRecording(
    {
      stop: () => Promise.reject(Object.assign(new Error("someone else's"), { status: 403 })),
      status: async () => (calls.push("status"), { state: "live" as const }),
      cancel: async () => (calls.push("cancel"), { state: "ended" as const, outcome: { kind: "cancel" } }),
    },
    noWait,
  );
  expect(calls).toEqual(["status", "cancel"]);
  expect(out).toEqual({ ended: true });
});

test("nothing acknowledged is not ended: the page keeps its id; a status it can't read doesn't count as ended either", async () => {
  const out = await closeRecording({ stop: () => Promise.reject(new Error("offline")), status: () => Promise.reject(new Error("offline")), cancel: () => Promise.reject(new Error("offline")) }, noWait);
  expect(out.ended).toBe(false);
});

test("another close under way is waited for, not cancelled over", async () => {
  let asks = 0;
  const out = await closeRecording({ stop: () => Promise.reject(new Error("busy")), status: async () => (++asks < 3 ? { state: "ending" as const } : endedStop), cancel: async () => { throw new Error("must not cancel"); } }, noWait);
  expect(out.ended && (out as any).result?.recordingId).toBe("r1");
  expect(asks).toBe(3);
});

test("a recording a page let go of is reaped later: asked after, cancelled if still live, forgotten once the hub says ended, kept if the hub can't be reached", async () => {
  const orphans = new Map([["a", { token: "ta" }], ["b", { token: "tb" }], ["c", { token: "tc" }]]);
  const cancelled: string[] = [];
  await reapOrphans(orphans, {
    status: async (id) => (id === "a" ? { state: "ended" } : id === "b" ? { state: "live" } : Promise.reject(new Error("offline"))),
    cancel: async (t) => (cancelled.push(t), { state: "ended" }),
  });
  expect(cancelled).toEqual(["tb"]);
  expect([...orphans.keys()]).toEqual(["c"]);
});

test("leaving hands every kind of recording to the hub, including one waiting on its Stop or a Start in flight, and gives back a mic it turned on", () => {
  expect(leaveActions({ id: "r1", token: "t1" }, null, true)).toEqual({ cancel: { token: "t1", orphanId: "r1" }, restoreMic: true });
  expect(leaveActions(null, "t2", true)).toEqual({ cancel: { token: "t2" }, restoreMic: true });
  expect(leaveActions(null, "t2", false).restoreMic).toBe(false);
  expect(leaveActions(null, null, true)).toEqual({ restoreMic: false });
});

test("a send carries the notes as first submitted: edits made after it began, or on a retry, don't change what is sent", () => {
  const first = [note("a", "make it bigger")];
  const review: { notes: RecordNote[]; submitted?: RecordNote[] } = { notes: [note("a", "make it bigger"), note("b", "  ")] };
  expect(notesToSend(review).map((n) => n.id)).toEqual(["a"]);
  review.submitted = notesToSend(review);
  review.notes = [note("a", "make it much bigger")];
  expect(notesToSend(review)).toEqual(first);
});
