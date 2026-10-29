import { expect, test } from "bun:test";
import { mergeInto, pinWords, sendSummary, type RecordNote } from "../src/shared/notes";

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
});

test("a send is told in words: who got how many, and what went to the brain", () => {
  expect(sendSummary({ ok: true, sent: [{ agentName: "Atlas", notes: 2 }, { agentName: "Juno", notes: 1 }], brain: 1 }, "Computah").text).toBe("2 notes to Atlas, 1 note to Juno, 1 note to Computah");
  expect(sendSummary({ ok: true, sent: [], brain: 3 }, "Computah").text).toBe("3 notes to Computah");
});
