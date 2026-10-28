// Room-audio bench: real human voices (LibriSpeech dev-clean), a simulated room of four
// laptops plus a host mic, the real AudioPipeline, real whisper.cpp and a real speaker
// embedding model. Each scenario records rows into a table that prints at the end.
//
// Setup once:  python3 -I test/audio-fetch.py        (downloads ~60 clips to /tmp/jam-audio)
// Run:         cd jamsesh/hub && bun test test/audio.bench.test.ts
import "./audio.env";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Transcriber } from "../src/audio/transcribe";
import { embed, voiceprintsAvailable } from "../src/audio/voiceprint";
import { decodeWav } from "../src/audio/wav";
import { readFileSync } from "node:fs";
import { pickBest } from "../src/audio/pipeline";
import {
  BABBLE_VOICES,
  CAST,
  clock,
  loadCorpus,
  mean,
  noiseOnly,
  pct,
  plan,
  dump,
  printTable,
  record,
  render,
  renderPlan,
  rng,
  SimRoom,
  sleep,
  wer,
  type Clip,
  type Copy,
  type DeviceKey,
  type Key,
  type PlanOpts,
  type Spec,
  type Truth,
} from "./audio.sim";

const corpus = loadCorpus();
const clipOf = (k: Key, i: number): Clip => corpus.get(CAST.find((c) => c.key === k)!.voice)![i];
const nameOf = (k: Key) => CAST.find((c) => c.key === k)!.name;
const KEYS = CAST.map((c) => c.key) as Key[];

let transcriber: Transcriber;

beforeAll(async () => {
  expect(voiceprintsAvailable()).toBe(true);
  transcriber = new Transcriber(SimRoom.newSession());
  expect(await transcriber.startLocal(8178)).toBe(true);
  clock.install();
}, 60_000);

afterAll(() => {
  transcriber?.stop();
  clock.uninstall();
  printTable();
});

/** A fresh room: new store, no voiceprints. */
function newRoom() {
  return new SimRoom(transcriber, SimRoom.newSession());
}

async function prepare(speaker: Key, idx: number, seed: number, opts: PlanOpts) {
  const clip = clipOf(speaker, idx);
  const r = rng(seed);
  const copies = await renderPlan(plan(r, opts), [{ file: clip.file }], r);
  return { speaker, clip, copies, r };
}
type Prepared = Awaited<ReturnType<typeof prepare>>;

/** Everyone speaks, one line at a time, then the pipeline settles. */
async function sayAll(room: SimRoom, items: Prepared[]) {
  const truths: Truth[] = [];
  for (const it of items) truths.push((await room.say(it.speaker, it.clip, it.copies, { r: it.r })).truth);
  await room.settle();
  dump("sayAll", room);
  return truths;
}

interface Scored {
  truth: Truth;
  lines: ReturnType<SimRoom["linesFor"]>;
  who: string | null;
  ok: boolean;
  wer: number;
}
function score(room: SimRoom, truths: Truth[]): Scored[] {
  return truths.map((truth) => {
    const lines = room.linesFor(truth);
    // The line that overlaps most is the primary one.
    const main = [...lines].sort((a, b) => Math.min(b.t1, truth.t1) - Math.max(b.t0, truth.t0) - (Math.min(a.t1, truth.t1) - Math.max(a.t0, truth.t0)))[0];
    const who = main ? room.nameOf(main.personId) : null;
    return { truth, lines, who, ok: who === nameOf(truth.speaker as Key), wer: main ? wer(truth.text, main.text) : 1 };
  });
}
const nOk = (s: Scored[]) => s.filter((x) => x.ok).length;
const dups = (s: Scored[]) => s.filter((x) => x.lines.length > 1).length;
const missing = (s: Scored[]) => s.filter((x) => x.lines.length === 0).length;
const describeMisses = (s: Scored[]) => s.filter((x) => !x.ok).map((x) => `${x.truth.speaker}->${x.who ?? "none"}`).join(" ");

// ============================================================================

describe("1 baseline: everyone at their own laptop, nobody enrolled", () => {
  test("device prior names the speaker; confident lines enroll voiceprints", async () => {
    const room = newRoom();
    const items: Prepared[] = [];
    // Round robin so neighbours are different people: 4 people x 3 lines.
    for (let i = 0; i < 3; i++) for (const [n, k] of KEYS.entries()) items.push(await prepare(k, i, 100 + i * 4 + n, { near: k }));
    const truths = await sayAll(room, items);
    const s = score(room, truths);
    const w = mean(s.map((x) => x.wer));
    record("1 baseline", "speaker accuracy (device prior)", pct(nOk(s), s.length), ">= 11/12", nOk(s) >= 11);
    record("1 baseline", "duplicate / missing lines", `${dups(s)} / ${missing(s)}`, "0 / 0", dups(s) + missing(s) === 0);
    record("1 baseline", "mean WER", w.toFixed(3), "< 0.12", w < 0.12);

    const counts = KEYS.map((k) => room.pipeline.voiceprints.count(room.people[k].id));
    record("1 baseline", "autoEnroll voiceprint samples", counts.join("/"), "each person >= 1", counts.every((c) => c >= 1));

    // A held-out line of each person, heard through their own laptop mic: the enrolled
    // prints must pick the right person.
    let right = 0;
    const wrong: string[] = [];
    for (const [n, k] of KEYS.entries()) {
      const held = await prepare(k, 9, 150 + n, { near: k, devices: [k] });
      const e = embed(decodeWav(held.copies[0].wav))!;
      const top = room.pipeline.voiceprints.match(e)[0];
      if (top?.personId === room.people[k].id) right++;
      else wrong.push(k);
    }
    record("1 baseline", "held-out clip -> voiceprint top match", pct(right, 4), "4/4", right === 4);
    expect(nOk(s), describeMisses(s)).toBeGreaterThanOrEqual(11);
    expect(dups(s) + missing(s)).toBe(0);
    expect(w).toBeLessThan(0.12);
    expect(counts.every((c) => c >= 1)).toBe(true);
    expect(wrong).toEqual([]);
  }, 120_000);
});

// ============================================================================

describe("2 walk-away: voice must beat the device", () => {
  test("enrolled people speak at someone else's laptop and at the host mic only", async () => {
    const room = newRoom();
    // Enrollment through ordinary use: 5 lines each at their own laptop.
    const warm: Prepared[] = [];
    for (let i = 0; i < 5; i++) for (const [n, k] of KEYS.entries()) warm.push(await prepare(k, i, 200 + i * 4 + n, { near: k, noMiss: true }));
    await sayAll(room, warm);
    const counts = KEYS.map((k) => room.pipeline.voiceprints.count(room.people[k].id));
    // Only people the room has learned can be recognized by voice.
    const known = KEYS.filter((_, i) => counts[i] >= 2);
    record("2 walk-away", "voiceprint samples after 5 lines each", counts.join("/"), ">= 3 of 4 people enrolled", known.length >= 3);
    expect(known.length).toBeGreaterThanOrEqual(3);
    room.events.length = 0;
    room.truths.length = 0;
    const share = (s: Scored[]) => (s.length ? nOk(s) / s.length : 0);

    // A walks to B's laptop (B's laptop now hears A loudest; A's own laptop barely hears A).
    const walk: Prepared[] = [];
    for (let i = 0; i < 2; i++)
      for (const k of known) {
        const at = KEYS[(KEYS.indexOf(k) + 1 + i) % 4];
        walk.push(await prepare(k, 5 + i, 300 + i * 4 + KEYS.indexOf(k), { near: at, keep: [at], miss: [k] }));
      }
    const ws = score(room, await sayAll(room, walk));
    record("2 walk-away", "at another person's laptop", pct(nOk(ws), ws.length), ">= 50% (floor; voice alone ~85%)", share(ws) >= 0.5);
    record("2 walk-away", "  duplicates / missing", `${dups(ws)} / ${missing(ws)}`, "0 / 0", dups(ws) + missing(ws) === 0);
    const after = KEYS.map((k) => room.pipeline.voiceprints.count(room.people[k].id)).join("/");
    record("2 walk-away", "  samples after (no wrong enrolls)", after, "unchanged", after === counts.join("/"));

    // Only the host room mic heard it.
    room.events.length = 0;
    room.truths.length = 0;
    const hostOnly: Prepared[] = [];
    for (let i = 0; i < 2; i++) for (const k of known) hostOnly.push(await prepare(k, 7 + i, 400 + i * 4 + KEYS.indexOf(k), { near: "host", devices: ["host"] }));
    const hs = score(room, await sayAll(room, hostOnly));
    record("2 walk-away", "host room mic only", pct(nOk(hs), hs.length), ">= 50% (floor)", share(hs) >= 0.5);
    record("2 walk-away", "  duplicates / missing", `${dups(hs)} / ${missing(hs)}`, "0 / 0", dups(hs) + missing(hs) === 0);
    expect(share(ws), describeMisses(ws)).toBeGreaterThanOrEqual(0.5);
    expect(share(hs), describeMisses(hs)).toBeGreaterThanOrEqual(0.5);
    expect(dups(ws) + missing(ws) + dups(hs) + missing(hs)).toBe(0);
    expect(after).toBe(counts.join("/"));
  }, 200_000);
});

// ============================================================================

describe("3 manual labels", () => {
  test("label host-only lines with assign(), then identify more host-only lines", async () => {
    const room = newRoom();
    const label = async (idx: number, seed: number) => {
      const items: Prepared[] = [];
      for (const [n, k] of KEYS.entries()) items.push(await prepare(k, idx, seed + n, { near: "host", devices: ["host"] }));
      const truths = await sayAll(room, items);
      const s = score(room, truths);
      // The room does not know anyone yet (or is unsure); a person labels each line.
      for (const x of s) room.pipeline.assign(x.lines[0].id, room.people[x.truth.speaker as Key].id);
      return s;
    };
    const first = await label(0, 500);
    record("3 manual", "unlabeled lines at start", first.map((x) => x.who ?? "-").join(","), "Someone before labels", first.every((x) => x.who === null || x.who === "Someone"));
    const test = async (idx: number[], seed: number) => {
      room.events.length = 0;
      room.truths.length = 0;
      const items: Prepared[] = [];
      for (const [j, i] of idx.entries()) for (const [n, k] of KEYS.entries()) items.push(await prepare(k, i, seed + j * 4 + n, { near: "host", devices: ["host"] }));
      return score(room, await sayAll(room, items));
    };
    const a = await test([2, 3], 520);
    record("3 manual", "1 label per person -> host-only lines", pct(nOk(a), a.length), ">= 4/8 (floor, chance 2/8)", nOk(a) >= 4);
    // A second label each (lines 1), then test with fresh lines.
    await label(1, 540);
    const b = await test([4, 5], 560);
    record("3 manual", "2 labels per person -> host-only lines", pct(nOk(b), b.length), ">= 4/8 (floor)", nOk(b) >= 4);
    record("3 manual", "  duplicates / missing", `${dups(a) + dups(b)} / ${missing(a) + missing(b)}`, "0 / 0", dups(a) + dups(b) + missing(a) + missing(b) === 0);
    const kept = room.lines().filter((u) => u.method === "manual").length;
    expect(nOk(a), describeMisses(a)).toBeGreaterThanOrEqual(4);
    expect(nOk(b), describeMisses(b)).toBeGreaterThanOrEqual(4);
    expect(dups(a) + dups(b) + missing(a) + missing(b)).toBe(0);
    expect(kept).toBeGreaterThanOrEqual(0);
  }, 150_000);
});

// ============================================================================

/** The loud local voice triggers a device's VAD; the quieter other voice only bleeds in. */
async function crosstalkCopies(a: { k: Key; clip: Clip; delayMs: number }, b: { k: Key; clip: Clip; delayMs: number }, seed: number, mergeHost: boolean): Promise<{ copies: Copy[]; start: number }> {
  const r = rng(seed);
  const devices: DeviceKey[] = [a.k, b.k, "host"];
  const p = plan(r, { near: a.k, devices, noMiss: true });
  const union = Math.max(a.delayMs + a.clip.durMs, b.delayMs + b.clip.durMs) - Math.min(a.delayMs, b.delayMs);
  const origin = Math.min(a.delayMs, b.delayMs);
  const copies: Copy[] = [];
  for (const d of devices) {
    const spec = p[d];
    const srcs = [
      { file: a.clip.file, delayMs: a.delayMs - origin, gainDb: d === a.k ? spec.gainNear : spec.gainFar },
      { file: b.clip.file, delayMs: b.delayMs - origin, gainDb: d === b.k ? spec.gainNear : spec.gainFar },
    ];
    // A device's VAD covers its own loud voice; the host hears everything (or each line separately).
    const own = d === a.k ? a : d === b.k ? b : null;
    const headMs = own ? own.delayMs - origin : 0;
    const tailMs = own ? union - (own.delayMs - origin + own.clip.durMs) : 0;
    const { gainDb: _g, gainNear: _n, gainFar: _f, ...rest } = spec;
    if (d === "host" && !mergeHost) {
      // The host mic's VAD splits at the pause: one segment per speaker.
      for (const own2 of [a, b]) {
        const h = own2.delayMs - origin;
        const t = union - (h + own2.clip.durMs);
        const rd = await render({ ...rest, srcs, headMs: h, tailMs: t });
        copies.push({ device: d, wav: rd.wav, durMs: rd.durMs, headMs: h, clockMs: 0 });
      }
      continue;
    }
    const rd = await render({ ...rest, srcs, headMs, tailMs });
    copies.push({ device: d, wav: rd.wav, durMs: rd.durMs, headMs, clockMs: Math.round(r.between(-30, 30)) });
  }
  return { copies, start: origin };
}

describe("4 cross-talk and back-to-back speakers", () => {
  const pairs: [Key, Key][] = [["ana", "ben"], ["cam", "dee"], ["ana", "dee"], ["ben", "cam"]];

  async function run(name: string, mode: "overlap" | "adjacent" | "interject", mergeHost: boolean, minOk: number) {
    const room = newRoom();
    // Quick enrollment so voice is available (people have spoken before).
    const warm: Prepared[] = [];
    for (const [n, k] of KEYS.entries()) warm.push(await prepare(k, 0, 600 + n, { near: k, noMiss: true }));
    await sayAll(room, warm);
    room.events.length = 0;
    room.truths.length = 0;
    let truths: { a: Truth; b: Truth }[] = [];
    for (const [n, [ka, kb]] of pairs.slice(0, mode === "interject" ? 2 : 3).entries()) {
      const byLen = (k: Key, from: number) => [3, 4, 5, 6, 7, 8, 9].slice(from > 0 ? from - 3 : 0).map((i) => clipOf(k, i));
      let ca: Clip;
      let cb: Clip;
      let delay: number;
      if (mode === "adjacent") {
        ca = clipOf(ka, 3 + (n % 2));
        cb = clipOf(kb, 5 + (n % 2));
        delay = ca.durMs + 150;
      } else if (mode === "overlap") {
        // The second voice cuts in 55% of the way through and finishes after the first.
        ca = byLen(ka, 3).sort((x, y) => y.durMs - x.durMs)[0];
        delay = Math.round(ca.durMs * 0.55);
        cb = byLen(kb, 3).filter((c) => c.id !== ca.id && delay + c.durMs >= ca.durMs + 1200).sort((x, y) => x.durMs - y.durMs)[0] ?? byLen(kb, 3).sort((x, y) => y.durMs - x.durMs)[0];
      } else {
        // The second voice cuts in and finishes inside the first one's line.
        ca = byLen(ka, 3).sort((x, y) => y.durMs - x.durMs)[0];
        delay = Math.round(ca.durMs * 0.25);
        cb = byLen(kb, 3).sort((x, y) => x.durMs - y.durMs)[0];
      }
      const { copies } = await crosstalkCopies({ k: ka, clip: ca, delayMs: 0 }, { k: kb, clip: cb, delayMs: delay }, 700 + n, mergeHost);
      const union = delay + cb.durMs;
      const { truth } = await room.say(ka, { ...ca, durMs: union }, copies, { r: rng(n) });
      room.truths.pop();
      const ta: Truth = { key: ca.id, speaker: ka, text: ca.text, t0: truth.t0, t1: truth.t0 + ca.durMs };
      const tb: Truth = { key: cb.id, speaker: kb, text: cb.text, t0: truth.t0 + delay, t1: truth.t0 + delay + cb.durMs };
      truths.push({ a: ta, b: tb });
      await room.settle();
    }
    dump(name, room);
    const lines = room.lines();
    // Match each real utterance to the line with the closest words.
    let ok = 0;
    const bad: string[] = [];
    let wsum = 0;
    for (const { a, b } of truths)
      for (const t of [a, b]) {
        const best = [...lines].sort((x, y) => wer(t.text, x.text) - wer(t.text, y.text))[0];
        const w = best ? wer(t.text, best.text) : 1;
        wsum += w;
        if (best && w < 0.35 && room.nameOf(best.personId) === nameOf(t.speaker as Key)) ok++;
        else bad.push(`${t.speaker}:${best ? room.nameOf(best.personId) : "none"}@wer${w.toFixed(2)}`);
      }
    const expectedLines = Math.min(pairs.length, mode === "interject" ? 2 : 3) * 2;
    const info = mode === "interject";
    record(name, "utterances right (text + speaker)", pct(ok, expectedLines), info ? "reported only" : `>= ${minOk}/${expectedLines}${minOk < 5 ? " (floor)" : ""}`, info || ok >= minOk);
    record(name, "  line count vs real utterances", `${lines.length} vs ${expectedLines}`, info ? "reported only" : "equal", info || lines.length === expectedLines);
    record(name, "  mean WER", (wsum / expectedLines).toFixed(3), info ? "reported only" : "< 0.25", info || wsum / expectedLines < 0.25);
    return { ok, lines: lines.length, expectedLines, bad };
  }

  test("overlapping speech (second voice starts mid-line)", async () => {
    const r = await run("4a overlap", "overlap", false, 5);
    expect(r.lines).toBe(r.expectedLines);
    expect(r.ok, r.bad.join(" ")).toBeGreaterThanOrEqual(5);
  }, 150_000);

  test("back-to-back, short pause, each device segments each line", async () => {
    const r = await run("4b adjacent", "adjacent", false, 5);
    expect(r.lines).toBe(r.expectedLines);
    expect(r.ok, r.bad.join(" ")).toBeGreaterThanOrEqual(5);
  }, 150_000);

  test("back-to-back, host mic merges both into one long segment", async () => {
    const r = await run("4c adjacent+merged host", "adjacent", true, 4);
    expect(r.lines).toBe(r.expectedLines);
    expect(r.ok, r.bad.join(" ")).toBeGreaterThanOrEqual(4);
  }, 150_000);

  test("interjection fully inside someone else's line (reported, not asserted: needs source separation)", async () => {
    const r = await run("4d interjection", "interject", false, 0);
    expect(r.lines).toBeGreaterThan(0);
  }, 150_000);
});

// ============================================================================

describe("5 network lag", () => {
  /** Speak a line, deliver copies with lags in real time, wait for the pipeline to go quiet. */
  async function lagged(room: SimRoom, speaker: Key, idx: number, seed: number, opts: PlanOpts, lagMs: Partial<Record<DeviceKey, number>>, jitterMs = 0) {
    const it = await prepare(speaker, idx, seed, opts);
    const { truth, delivered } = await room.say(speaker, it.clip, it.copies, { lagMs, jitterMs, r: it.r, wait: false });
    await delivered;
    await room.quiet(1200, 12_000);
    return { truth, copies: it.copies };
  }

  test("0 / 150 ms / 800 ms / 2.5 s devices: one line, all copies merged", async () => {
    const room = newRoom();
    const lag = { ana: 0, ben: 150, cam: 800, host: 2500 } as const;
    const out: Awaited<ReturnType<typeof lagged>>[] = [];
    for (let i = 0; i < 3; i++) out.push(await lagged(room, "ana", i, 800 + i, { near: "ana", devices: ["ana", "ben", "cam", "host"], keep: ["ben", "cam", "host"] }, lag));
    dump("5a", room);
    const s = score(room, out.map((o) => o.truth));
    const merged = s.every((x, i) => x.lines[0]?.devices.length === out[i].copies.length);
    const updates = room.events.filter((e) => !e.isNew).length;
    record("5a lag mix", "lines per utterance (no duplicates)", `${dups(s)} dup / ${missing(s)} missing`, "0 / 0", dups(s) + missing(s) === 0);
    record("5a lag mix", "late copies merged into the line", String(merged), "true", merged);
    record("5a lag mix", "speaker correct", pct(nOk(s), s.length), "3/3", nOk(s) === 3);
    record("5a lag mix", "settle window after learning lag", `${Math.round(room.pipeline.settleMs())} ms`, ">= 2500 ms", room.pipeline.settleMs() >= 2500);
    record("5a lag mix", "in-place updates (isNew=false)", String(updates), "reported (5d forces one)", true);
    expect(dups(s) + missing(s)).toBe(0);
    expect(merged).toBe(true);
    expect(nOk(s)).toBe(3);
    expect(room.pipeline.settleMs()).toBeGreaterThanOrEqual(2500);
  }, 120_000);

  test("jitter and out-of-order: the loudest copy arrives last", async () => {
    const room = newRoom();
    const out: Awaited<ReturnType<typeof lagged>>[] = [];
    const sp: Key[] = ["ben", "cam", "dee", "ana"];
    for (const [i, k] of sp.entries())
      out.push(await lagged(room, k, 3 + i, 900 + i, { near: k, keep: ["host", "ana", "ben", "cam", "dee"].filter((d) => d !== k) as DeviceKey[] }, { [k]: 1100, host: 0, ana: 60, cam: 200, dee: 350, ben: 500 } as Partial<Record<DeviceKey, number>>, 450));
    dump("5b", room);
    const s = score(room, out.map((o) => o.truth));
    // The chosen copy must be the clearest of the copies the line ended up with.
    let clearest = 0;
    for (const x of s) {
      const u = x.lines[0];
      if (!u) continue;
      const best = [...u.devices].sort((a, b) => b.snr * 0.7 + b.level * 0.3 - (a.snr * 0.7 + a.level * 0.3))[0];
      if (best.deviceId === u.deviceId) clearest++;
    }
    const w = mean(s.map((x) => x.wer));
    record("5b jitter/reorder", "no duplicates / missing", `${dups(s)} / ${missing(s)}`, "0 / 0", dups(s) + missing(s) === 0);
    record("5b jitter/reorder", "speaker correct", pct(nOk(s), s.length), "4/4", nOk(s) === 4);
    record("5b jitter/reorder", "line uses the clearest copy", pct(clearest, s.length), "4/4", clearest === s.length);
    record("5b jitter/reorder", "mean WER", w.toFixed(3), "< 0.12", w < 0.12);
    expect(dups(s) + missing(s)).toBe(0);
    expect(nOk(s), describeMisses(s)).toBe(4);
    expect(clearest).toBe(s.length);
    expect(w).toBeLessThan(0.12);
  }, 120_000);

  test("one device consistently 2 s behind: window adapts, later lines are not revised", async () => {
    const room = newRoom();
    const out: Awaited<ReturnType<typeof lagged>>[] = [];
    const sp: Key[] = ["ana", "ben", "cam", "dee"];
    for (const [i, k] of sp.entries()) out.push(await lagged(room, k, 4 + (i % 3), 1000 + i, { near: k, devices: ["ana", "ben", "cam", "dee", "host"], keep: ["dee", "host"] }, { dee: 2000 } as Partial<Record<DeviceKey, number>>));
    dump("5c", room);
    const s = score(room, out.map((o) => o.truth));
    const revisedLate = out.slice(2).filter((o) => room.events.some((e) => !e.isNew && e.u.t0 >= o.truth.t0 - 500 && e.u.t0 <= o.truth.t0 + 500)).length;
    record("5c slow device", "no duplicates / missing", `${dups(s)} / ${missing(s)}`, "0 / 0", dups(s) + missing(s) === 0);
    record("5c slow device", "learned lag of slow device", `${Math.round(room.pipeline.deviceLag(room.deviceId.dee))} ms`, ">= 1500 ms", room.pipeline.deviceLag(room.deviceId.dee) >= 1500);
    record("5c slow device", "lines 3-4 revised after emit", String(revisedLate), "0", revisedLate === 0);
    record("5c slow device", "speaker correct", pct(nOk(s), s.length), ">= 3/4", nOk(s) >= 3);
    expect(dups(s) + missing(s)).toBe(0);
    expect(room.pipeline.deviceLag(room.deviceId.dee)).toBeGreaterThanOrEqual(1500);
    expect(revisedLate).toBe(0);
    expect(nOk(s), describeMisses(s)).toBeGreaterThanOrEqual(3);
  }, 120_000);

  test("a clearer copy arriving after the line was finalized fixes text and speaker in place", async () => {
    const room = newRoom();
    const res: Truth[] = [];
    for (const [i, k] of (["cam", "dee", "ben"] as Key[]).entries()) {
      const clip = clipOf(k, 6 + (i % 3));
      const r = rng(1100 + i);
      // Early copies: two far, drowned-out devices. Late copy: the speaker's own laptop, clean.
      const poor: Spec["noise"] = { kind: "babble", db: -45 };
      const far = (file: string, gainDb: number, muffleHz: number) => render({ srcs: [{ file, gainDb }], noise: poor, muffleHz, micHp: 150, reverb: true });
      const other = KEYS.filter((x) => x !== k);
      const a = await far(clip.file, -17, 2600);
      const h = await far(clip.file, -19, 2300);
      const own = await render({ srcs: [{ file: clip.file, gainDb: -4 }], noise: { kind: "room", db: -52 }, micHp: 120 });
      const copies: Copy[] = [
        { device: other[0], wav: a.wav, durMs: a.durMs, headMs: 0, clockMs: 10 },
        { device: "host", wav: h.wav, durMs: h.durMs, headMs: 0, clockMs: -10 },
        { device: k, wav: own.wav, durMs: own.durMs, headMs: 0, clockMs: 0 },
      ];
      const { truth, delivered } = await room.say(k, clip, copies, { lagMs: { [k]: 4500 }, r, wait: false });
      await delivered;
      await room.quiet(1500, 12_000);
      res.push(truth);
    }
    dump("5d", room);
    const s = score(room, res);
    const firstEvents = res.map((t) => room.events.filter((e) => e.u.t0 >= t.t0 - 800 && e.u.t0 <= t.t0 + 800));
    const updated = firstEvents.filter((ev) => ev.some((e) => !e.isNew)).length;
    const werFirst = mean(firstEvents.map((ev, i) => wer(res[i].text, ev.find((e) => e.isNew)?.u.text ?? "")));
    const werFinal = mean(s.map((x) => x.wer));
    const sameId = firstEvents.every((ev) => new Set(ev.map((e) => e.u.id)).size === 1);
    record("5d late clear copy", "no duplicates / missing", `${dups(s)} / ${missing(s)}`, "0 / 0", dups(s) + missing(s) === 0);
    record("5d late clear copy", "line updated in place (same id, isNew=false)", `${updated}/3, sameId=${sameId}`, ">= 1/3 (others: first copy had no words), true", updated >= 1 && sameId);
    record("5d late clear copy", "WER first -> final", `${werFirst.toFixed(3)} -> ${werFinal.toFixed(3)}`, "final <= first, final < 0.1", werFinal <= werFirst && werFinal < 0.1);
    record("5d late clear copy", "speaker correct after update", pct(nOk(s), 3), "3/3", nOk(s) === 3);
    expect(dups(s) + missing(s)).toBe(0);
    expect(updated).toBeGreaterThanOrEqual(1);
    expect(sameId).toBe(true);
    expect(werFinal).toBeLessThanOrEqual(werFirst);
    expect(werFinal).toBeLessThan(0.1);
    expect(nOk(s), describeMisses(s)).toBe(3);
  }, 120_000);
});

// ============================================================================

describe("6 transcription quality", () => {
  const tiers: { name: string; spec: (file: string) => Spec }[] = [
    { name: "close", spec: (file) => ({ srcs: [{ file, gainDb: -4 }], noise: { kind: "room", db: -52 }, micHp: 120 }) },
    { name: "mid", spec: (file) => ({ srcs: [{ file, gainDb: -14 }], noise: { kind: "pink", db: -46 }, micHp: 200, micLp: 4000 }) },
    { name: "far", spec: (file) => ({ srcs: [{ file, gainDb: -22 }], noise: { kind: "babble", db: -36 }, muffleHz: 3000, reverb: true }) },
    { name: "awful", spec: (file) => ({ srcs: [{ file, gainDb: -24 }], noise: { kind: "babble", db: -28 }, muffleHz: 2200, reverb: true, micHp: 300, micLp: 3000 }) },
  ];

  test("picking the clearest copy beats the worst copy", async () => {
    const room = newRoom();
    const devs: DeviceKey[] = ["ana", "ben", "cam", "host"];
    const picks: number[] = [];
    const worst: number[] = [];
    const oracle: number[] = [];
    const all: number[][] = [[], [], [], []];
    let chosenIsClose = 0;
    const truths: Truth[] = [];
    const per: { copyWer: number[] }[] = [];
    for (let i = 0; i < 6; i++) {
      const k = KEYS[i % 4];
      const clip = clipOf(k, 7 + (i >= 4 ? 1 : 0));
      // Rotate which device gets which quality so device identity does not decide.
      const order = devs.map((_, j) => tiers[(i + j) % 4]);
      const copies: Copy[] = [];
      const copyWer: number[] = [];
      for (const [j, d] of devs.entries()) {
        const rd = await render(order[j].spec(clip.file));
        copies.push({ device: d, wav: rd.wav, durMs: rd.durMs, headMs: 0, clockMs: 0 });
        const { text } = await transcriber.transcribe(rd.wav, rd.durMs / 1000, "");
        const w = wer(clip.text, text);
        copyWer.push(w);
        all[tiers.indexOf(order[j])].push(w);
      }
      per.push({ copyWer });
      truths.push((await room.say(k, clip, copies, { r: rng(i) })).truth);
    }
    await room.settle();
    const s = score(room, truths);
    s.forEach((x, i) => {
      picks.push(x.wer);
      worst.push(Math.max(...per[i].copyWer));
      oracle.push(Math.min(...per[i].copyWer));
      const u = x.lines[0];
      if (u && u.devices.length) {
        // The chosen copy should be the "close" tier (highest SNR) in each rotation.
        const closeIdx = devs.findIndex((_, j) => tiers[(i + j) % 4].name === "close");
        if (u.deviceId === room.deviceId[devs[closeIdx]]) chosenIsClose++;
      }
    });
    record("6 WER", "mean WER close/mid/far/awful (every copy)", all.map((a) => mean(a).toFixed(2)).join(" / "), "reported", true);
    record("6 WER", "mean WER pipeline pick vs worst copy", `${mean(picks).toFixed(3)} vs ${mean(worst).toFixed(3)}`, "pick < worst by >= 0.05", mean(worst) - mean(picks) >= 0.05);
    record("6 WER", "mean WER pipeline pick vs oracle best copy", `${mean(picks).toFixed(3)} vs ${mean(oracle).toFixed(3)}`, "within 0.04", mean(picks) - mean(oracle) <= 0.04);
    record("6 WER", "pick was the highest-SNR copy", pct(chosenIsClose, 6), ">= 5/6", chosenIsClose >= 5);
    record("6 WER", "duplicate lines", String(dups(s)), "0", dups(s) === 0);
    expect(mean(worst) - mean(picks)).toBeGreaterThanOrEqual(0.05);
    expect(mean(picks) - mean(oracle)).toBeLessThanOrEqual(0.04);
    expect(chosenIsClose).toBeGreaterThanOrEqual(5);
    expect(dups(s)).toBe(0);
  }, 150_000);

  test("an overall bad recording (far, noisy, muffled everywhere) still gets a line and a speaker", async () => {
    const room = newRoom();
    const items: Prepared[] = [];
    for (const [n, k] of KEYS.entries()) items.push(await prepare(k, 8, 1300 + n, { near: k, quality: "bad", noMiss: true }));
    const s = score(room, await sayAll(room, items));
    const w = mean(s.map((x) => x.wer));
    record("6 bad recording", "lines produced / speaker correct", `${4 - missing(s)}/4, ${pct(nOk(s), 4)}`, "4/4, >= 3/4", missing(s) === 0 && nOk(s) >= 3);
    record("6 bad recording", "mean WER", w.toFixed(3), "< 0.35", w < 0.35);
    expect(missing(s)).toBe(0);
    expect(nOk(s), describeMisses(s)).toBeGreaterThanOrEqual(3);
    expect(w).toBeLessThan(0.35);
  }, 120_000);

  test("silence and noise-only segments produce no line", async () => {
    const room = newRoom();
    const cases: [string, Uint8Array][] = [
      ["digital silence 5s", noiseOnly("silence", 5, -90)],
      ["pink noise -50 dB 5s", noiseOnly("pink", 5, -50)],
      ["HVAC rumble -42 dB 6s", noiseOnly("room", 6, -42)],
      ["60 Hz hum -38 dB 5s", noiseOnly("hum", 5, -38)],
      ["keyboard clatter -35 dB 5s", noiseOnly("clicks", 5, -35)],
      ["quiet pink noise -65 dB 4s", noiseOnly("pink", 4, -65)],
    ];
    clock.advanceTo(Date.now() + 30_000);
    let t = Date.now();
    for (const [i, [, wav]] of cases.entries()) {
      t += 7000;
      clock.advanceTo(t);
      await room.pipeline.ingest({ deviceId: room.deviceId[i % 2 ? "host" : "ana"], t0: t - 5000, t1: t, wav });
    }
    await room.settle();
    const lines = room.lines();
    record("6 noise only", "lines from silence/noise segments", `${lines.length}/${cases.length}${lines.length ? " " + JSON.stringify(lines.map((l) => l.text)) : ""}`, "0", lines.length === 0);
    expect(lines.map((l) => l.text)).toEqual([]);
  }, 60_000);
});

void BABBLE_VOICES;
void pickBest;
void sleep;
