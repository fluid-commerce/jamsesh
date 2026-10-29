import { expect, test } from "bun:test";
import { closeUnattended, pointerOrNone, stopWithRetry, newRecordToken, mergeInto, pinWords, sendSummary, type RecordNote } from "../src/shared/notes";

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

test("a recording that began after its page was gone is closed by id, with the words alone; a failed close is swallowed", async () => {
  const calls: [string, object][] = [];
  await closeUnattended(async (path, body) => void calls.push([path, body]), "dev1", "p1", "rec9");
  expect(calls).toEqual([["/prompt-window", { deviceId: "dev1", personId: "p1", recordingId: "rec9", pointer: [] }]]);
  await closeUnattended(async () => { throw new Error("offline"); }, "dev1", null, "rec9");
});

test("a recording token is made before Start, is unique, and is one the hub accepts", () => {
  const a = newRecordToken();
  expect(a).toMatch(/^[\w-]{8,64}$/);
  expect(newRecordToken()).not.toBe(a);
});

test("a Stop is sent again until confirmed: a lost reply is retried with backoff, a refusal is final, and running out of tries cancels", async () => {
  const waits: number[] = [];
  const wait = async (ms: number) => void waits.push(ms);
  let n = 0;
  const flaky = async () => (++n < 3 ? Promise.reject(new Error("offline")) : "ok");
  expect(await stopWithRetry(flaky, async () => { throw new Error("must not cancel"); }, 4, wait)).toBe("ok");
  expect(waits).toEqual([1000, 2000]);
  // A 4xx is the hub's answer: no retry, no cancel.
  let calls = 0;
  await expect(stopWithRetry(async () => (calls++, Promise.reject(Object.assign(new Error("ended"), { status: 409 }))), async () => { throw new Error("no"); }, 4, wait)).rejects.toThrow("ended");
  expect(calls).toBe(1);
  // Never confirmed: cancelled by token, then the failure is reported.
  let cancelled = 0;
  await expect(stopWithRetry(() => Promise.reject(new Error("offline")), async () => void cancelled++, 3, wait)).rejects.toThrow("offline");
  expect(cancelled).toBe(1);
});

test("a Stop and a cancel that both fail leave the recording marked as possibly still running, so the page keeps its id", async () => {
  const wait = async () => {};
  const err = await stopWithRetry(() => Promise.reject(new Error("offline")), () => stopWithRetry(() => Promise.reject(new Error("still offline")), async () => {}, 2, wait), 2, wait).catch((e) => e);
  expect(err.unended).toBe(true);
  expect(err.message).toBe("still offline");
  // A cancel that gets through (on its second try) ends it: the Stop's own failure is what is reported, and it is not "unended".
  let n = 0;
  const e2 = await stopWithRetry(() => Promise.reject(new Error("offline")), () => stopWithRetry(async () => (++n < 2 ? Promise.reject(new Error("blip")) : "ok"), async () => {}, 3, wait), 2, wait).catch((e) => e);
  expect(e2.message).toBe("offline");
  expect(e2.unended).toBeUndefined();
});

test("a pointer that can't be read becomes no marks, so the Stop still goes out", async () => {
  expect(await pointerOrNone(async () => { throw new Error("bad gesture"); })).toEqual([]);
  expect(await pointerOrNone(async () => "nope" as any)).toEqual([]);
  expect(await pointerOrNone(async () => [1, 2])).toEqual([1, 2]);
});
