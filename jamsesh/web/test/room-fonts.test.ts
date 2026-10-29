// Fonts for everyone, page side (6.5): a canvas gets the room's fonts, then its own Mac's, then asks;
// the person with a font is asked once; and a font file never goes into the offline outbox.
import "fake-indexeddb/auto";
import { expect, test } from "bun:test";
import { bytesToBase64, FACE_TRIES, familyKey, loadFonts, lookUpFonts, newFontMemory, openQuestions, type RoomFonts } from "../src/shared/roomFonts";
import { api } from "../src/shared/hub";
import { idbTable, outbox } from "../src/shared/offline";

/** A canvas that reports these families missing until a font for them is loaded. */
function canvas(missing: string[], loadable: Record<string, string> = {}) {
  const loaded: string[] = [];
  const fc = {
    async execute(cmd: string, p: any) {
      if (cmd === "text.missingFonts") return { families: missing.filter((f) => !loaded.includes(f)).map((family) => ({ family })) };
      if (cmd === "text.loadFont") {
        const family = loadable[p.data];
        if (!family) throw new Error("not a font file");
        loaded.push(family);
        return { families: [family] };
      }
      throw new Error(cmd);
    },
  };
  return { fc, loaded };
}
const info = (family: string, faces = 1, kind: "open" | "borrowed" = "open") => ({ key: familyKey(family), family, kind, source: "", license: null, faces, bytes: 10 });
const room = (available: ReturnType<typeof info>[], faces: Record<string, string> = {}) => {
  const asked: string[][] = [];
  const fetched: string[] = [];
  const r: RoomFonts = {
    available,
    fetchFace: async (key, n) => (fetched.push(`${key}/${n}`), faces[`${key}/${n}`] ?? null),
    want: async (families) => void asked.push(families),
  };
  return { r, asked, fetched };
};

test("a canvas takes the room's fonts first and asks for nothing it was given", async () => {
  const { fc, loaded } = canvas(["Inter", "Gotham"], { AAA: "Inter" });
  const { r, asked, fetched } = room([info("Inter")], { "inter/0": "AAA" });
  const left = await loadFonts(fc, newFontMemory(), r);
  expect(loaded).toEqual(["Inter"]);
  expect(fetched).toEqual(["inter/0"]);
  expect(left).toEqual(["Gotham"]);
  expect(asked).toEqual([["Gotham"]]);
});

test("every face of a font loads, and a font loads into a canvas once", async () => {
  const { fc } = canvas(["Inter"], { A: "Inter", B: "Inter" });
  const { r, fetched } = room([info("Inter", 2)], { "inter/0": "A", "inter/1": "B" });
  const memory = newFontMemory();
  await loadFonts(fc, memory, r);
  await loadFonts(fc, memory, r);
  expect(fetched).toEqual(["inter/0", "inter/1"]);
});

test("a font that didn't come, or that the canvas refuses, is tried again; the room is asked only once per family", async () => {
  const { fc, loaded } = canvas(["Inter", "Gotham"], { GOOD: "Inter" });
  const memory = newFontMemory();
  const bad = room([info("Inter")], { "inter/0": "NOPE" });
  await loadFonts(fc, memory, bad.r);
  expect(loaded).toEqual([]);
  // Held fonts aren't asked for (they are on their way).
  expect(bad.asked).toEqual([["Gotham"]]);
  const good = room([info("Inter")], { "inter/0": "GOOD" });
  await loadFonts(fc, memory, good.r);
  expect(loaded).toEqual(["Inter"]);
  // Gotham was already asked about in this canvas.
  expect(good.asked).toEqual([]);
  // A fetch that fails outright is the same.
  const down = room([info("Inter")]);
  down.r.fetchFace = async () => {
    throw new Error("offline");
  };
  await expect(loadFonts(canvas(["Inter"]).fc, newFontMemory(), down.r)).resolves.toEqual(["Inter"]);
});

test("a failed ask is made again on the next pass", async () => {
  const { fc } = canvas(["Gotham"]);
  const memory = newFontMemory();
  let calls = 0;
  const r: RoomFonts = { available: [], fetchFace: async () => null, want: async () => (++calls === 1 ? Promise.reject(new Error("offline")) : undefined) };
  await loadFonts(fc, memory, r);
  await loadFonts(fc, memory, r);
  await loadFonts(fc, memory, r);
  expect(calls).toBe(2);
});

test("a face that fails is tried again on later passes, even after its family's other faces filled in, up to a limit", async () => {
  // Bold fails at first; Regular loads, so the family is no longer missing, but Bold is still fetched again.
  const { fc, loaded } = canvas(["Inter"], { REG: "Inter", BOLD: "Inter" });
  const memory = newFontMemory();
  const faces: Record<string, string> = { "inter/0": "REG", "inter/1": "BROKEN" };
  const { r, fetched } = room([info("Inter", 2)], faces);
  await loadFonts(fc, memory, r);
  expect(loaded).toEqual(["Inter"]);
  expect(fetched).toEqual(["inter/0", "inter/1"]);
  faces["inter/1"] = "BOLD";
  await loadFonts(fc, memory, r);
  expect(loaded).toEqual(["Inter", "Inter"]);
  expect(fetched).toEqual(["inter/0", "inter/1", "inter/1"]);
  // Loaded faces aren't fetched again.
  await loadFonts(fc, memory, r);
  expect(fetched.length).toBe(3);
  // A face that keeps failing stops being asked for after FACE_TRIES passes.
  const stuck = room([info("Gotham", 1)], { "gotham/0": "NOPE" });
  const c2 = canvas(["Gotham"]);
  const m2 = newFontMemory();
  for (let i = 0; i < FACE_TRIES + 3; i++) await loadFonts(c2.fc, m2, stuck.r);
  expect(stuck.fetched.length).toBe(FACE_TRIES);
  // A dropped connection isn't a failure: it is tried again whenever the network is back.
  const flaky = room([info("Avenir", 1)], { "avenir/0": "AV" });
  let down = true;
  const realFetch = flaky.r.fetchFace;
  flaky.r.fetchFace = (k, n) => (down ? Promise.reject(new Error("offline")) : realFetch(k, n));
  const c3 = canvas(["Avenir"], { AV: "Avenir" });
  const m3 = newFontMemory();
  for (let i = 0; i < FACE_TRIES + 2; i++) await loadFonts(c3.fc, m3, flaky.r);
  down = false;
  await loadFonts(c3.fc, m3, flaky.r);
  expect(c3.loaded).toEqual(["Avenir"]);
});

test("no page reads this Mac's fonts: loading asks only the room", async () => {
  const { fc, loaded } = canvas(["Helvetica Neue"], { MAC: "Helvetica Neue" });
  const { r, asked } = room([]);
  const left = await loadFonts(fc, newFontMemory(), r);
  expect(loaded).toEqual([]);
  expect(left).toEqual(["Helvetica Neue"]);
  expect(asked).toEqual([["Helvetica Neue"]]);
});

test("a canvas with nothing missing does no work", async () => {
  const { fc } = canvas([]);
  const { r, asked, fetched } = room([info("Inter")]);
  expect(await loadFonts(fc, newFontMemory(), r)).toEqual([]);
  expect([asked, fetched]).toEqual([[], []]);
});

test("a person is asked about a font once: not after they answer, decline, or someone else lends it; never without a person", () => {
  const w = (family: string, declinedBy: string[] = []) => ({ key: familyKey(family), family, askedBy: ["p2"], declinedBy, since: 1 });
  const wanted = [w("Gotham"), w("Avenir", ["p1"]), w("Futura")];
  expect(openQuestions(wanted, [], "p1", new Set()).map((x) => x.family)).toEqual(["Gotham", "Futura"]);
  expect(openQuestions(wanted, [], "p1", new Set(["gotham"])).map((x) => x.family)).toEqual(["Futura"]);
  expect(openQuestions(wanted, [info("Futura", 1, "borrowed")], "p1", new Set()).map((x) => x.family)).toEqual(["Gotham"]);
  expect(openQuestions(wanted, [], null, new Set())).toEqual([]);
});

test("bytes become base64 for any size", () => {
  const big = new Uint8Array(100_000).map((_, i) => i % 251);
  expect(Buffer.from(bytesToBase64(big), "base64").equals(Buffer.from(big))).toBe(true);
  expect(bytesToBase64(new Uint8Array(0))).toBe("");
});

test("a font file is never saved on this laptop for later: with the network down it fails instead of joining the outbox", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => Promise.reject(new TypeError("network down"))) as any;
  try {
    await idbTable("outbox").clear();
    await outbox.load();
    for (const [path, body] of [["/fonts/lend", { family: "Gotham", files: ["AAAA"] }], ["/fonts/lend-ticket", { family: "Gotham" }], ["/fonts/want", { families: ["Gotham"] }], ["/fonts/decline", { family: "Gotham" }], ["/fonts/withdraw", { family: "Gotham" }]] as const) {
      await expect(api(path, body, "POST", { queue: false })).rejects.toThrow();
      // And not even by forgetting the option: fonts are never queued.
      await expect(api(path, body)).rejects.toThrow();
    }
    expect(outbox.get().pending).toBe(0);
    expect(await idbTable("outbox").all()).toEqual([]);
    // Anything else still waits for the network, as before.
    const kept = await api("/say", { text: "hi" });
    expect((kept as any).queued).toBe(true);
    expect(outbox.get().pending).toBe(1);
  } finally {
    globalThis.fetch = realFetch;
    await idbTable("outbox").clear();
  }
});

test("a failed lookup of which fonts this Mac has can be asked again; a good one stays checked", async () => {
  const checked = new Set<string>();
  expect(await lookUpFonts(async () => { throw new Error("native call failed"); }, ["Inter"], checked)).toBeNull();
  expect(checked.size).toBe(0);
  expect(await lookUpFonts(async () => ["Inter"], ["Inter"], checked)).toEqual(["Inter"]);
  expect(checked.size).toBe(1);
});
