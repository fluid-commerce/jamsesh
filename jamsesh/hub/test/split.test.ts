// Copies grouped by time that could be someone else talking at the same moment are transcribed too, and are
// their own line when their words aren't the clearest copy's. Voice matching off (no speaker model); synthetic
// audio only; transcription stubbed per copy. Nothing makes sound.
import "./dedupe.env";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { AudioPipeline } from "../src/audio/pipeline";
import { encodeWav } from "../src/audio/wav";
import { Session } from "../src/session";
import { Store } from "../src/store";

const RATE = 16000;
/** A buzzy voice in syllables: `rate` syllables a second at `pitch` Hz, from `from` to `to` seconds. */
function voice(seconds: number, pitch: number, rate: number, from = 0, to = seconds) {
  const out = new Float32Array(Math.round(RATE * seconds));
  for (let i = Math.round(from * RATE); i < Math.min(out.length, Math.round(to * RATE)); i++) {
    const t = i / RATE;
    out[i] = 0.3 * Math.max(0, Math.sin(2 * Math.PI * rate * t)) ** 2 * (Math.sin(2 * Math.PI * pitch * t) + 0.5 * Math.sin(2 * Math.PI * 2 * pitch * t));
  }
  return out;
}
const A = (s: number) => voice(s, 140, 3.5);
const B = (s: number, from?: number, to?: number) => voice(s, 210, 2.7, from, to);
/** What one laptop hears: each voice at its own gain, over the same faint noise floor. */
function mix(seed: number, ...parts: [Float32Array, number][]) {
  const n = Math.max(...parts.map(([x]) => x.length));
  const out = new Float32Array(n);
  let r = seed;
  for (let i = 0; i < n; i++) {
    out[i] = 0.002 * (((r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) - 0.5);
    for (const [x, g] of parts) out[i] += (x[i] ?? 0) * g;
  }
  return out;
}
const dB = (x: number) => 10 ** (x / 20);

function room(laptops = ["lap-a", "lap-b", "lap-c", "lap-d"]) {
  const session = new Session(new Store(mkdtempSync(join(tmpdir(), "jam-split-"))));
  const ana = session.upsertPerson({ name: "Ana" });
  const bob = session.upsertPerson({ name: "Bob" });
  for (const id of laptops) session.touchDevice(id, { label: id, micOn: true, location: "room", kind: "client" });
  session.touchDevice("lap-a", { personId: ana.id });
  session.touchDevice("lap-b", { personId: bob.id });
  const said = new Map<string, string>();
  const asked: string[] = [];
  /** While set, every transcription waits for it (a slow whisper). */
  const slow: { until: Promise<void> | null } = { until: null };
  const transcriber = {
    transcribe: async (wav: Uint8Array) => {
      if (slow.until) await slow.until;
      const text = said.get(String(Bun.hash(wav))) ?? "";
      asked.push(text);
      return { text, engine: "stub" };
    },
  } as any;
  const pipeline = new AudioPipeline(session, transcriber);
  const taught: string[] = [];
  const enroll = (pipeline as any).autoEnroll.bind(pipeline);
  (pipeline as any).autoEnroll = (guess: any, best: any, segs: any) => (taught.push(best.deviceId), enroll(guess, best, segs));
  /** One copy, heard by `deviceId` over the same span as every other copy, transcribed as `text`. */
  const hear = async (deviceId: string, t0: number, samples: Float32Array, text: string, t1?: number) => {
    const wav = encodeWav({ sampleRate: RATE, samples });
    said.set(String(Bun.hash(wav)), text);
    await pipeline.ingest({ deviceId, t0, t1: t1 ?? t0 + (samples.length / RATE) * 1000, wav });
  };
  /** Holds every transcription until the returned function is called. */
  const hold = () => {
    let release = () => {};
    slow.until = new Promise<void>((r) => (release = r));
    return () => ((slow.until = null), release());
  };
  const lines = () => session.store.all("utterances").sort((a, b) => a.t0 - b.t0 || a.id.localeCompare(b.id));
  return { pipeline, hear, hold, lines, asked, taught, ana, bob, session };
}
const t = () => Date.now() - 120_000;

test("two people talking over the same span at their own laptops are two lines (review 6's room case)", async () => {
  const r = room(["lap-a", "lap-b"]);
  const t0 = t();
  await r.hear("lap-a", t0, mix(1, [A(3), 1], [B(3), 0.3]), "Put the pricing page up.");
  await r.hear("lap-b", t0, mix(2, [B(3), 1], [A(3), 0.3]), "I think the header is too tall.");
  await r.pipeline.flush();
  const lines = r.lines();
  expect(lines.map((u) => u.text).sort()).toEqual(["I think the header is too tall.", "Put the pricing page up."]);
  const split = lines.find((u) => u.deviceId === "lap-b")!;
  const main = lines.find((u) => u.deviceId === "lap-a")!;
  // The line heard best keeps the device's speaker; the split line is named by a voice only (none here), and teaches nobody.
  expect(main.personId).toBe(r.ana.id);
  expect(main.devices.map((d) => d.deviceId)).toEqual(["lap-a"]);
  expect(split).toMatchObject({ personId: null, speakerName: "Someone" });
  expect(r.taught).toEqual(["lap-a"]);
  expect(r.asked).toHaveLength(2);
});

test("a quieter copy within the threshold is transcribed: the same words stay one line, other words are another", async () => {
  for (const [other, count] of [["Put the pricing page up", 1], ["Put the pricing page cup", 2]] as const) {
    const r = room();
    const t0 = t();
    await r.hear("lap-a", t0, mix(3, [A(3), 1]), "Put the pricing page up.");
    await r.hear("lap-c", t0, mix(4, [A(3), dB(-9)]), other);
    await r.pipeline.flush();
    expect(r.asked).toHaveLength(2);
    expect(r.lines()).toHaveLength(count);
  }
});

test("a copy further down than the threshold is the same voice across the room: not transcribed, one line", async () => {
  const r = room();
  const t0 = t();
  await r.hear("lap-a", t0, mix(5, [A(3), 1]), "Put the pricing page up.");
  await r.hear("lap-c", t0, mix(6, [A(3), dB(-11)]), "Something else entirely.");
  await r.pipeline.flush();
  expect(r.asked).toEqual(["Put the pricing page up."]);
  expect(r.lines().map((u) => u.text)).toEqual(["Put the pricing page up."]);
  expect(r.lines()[0].devices).toHaveLength(2);
});

test("a short reply over a long sentence, quiet overall but loudest at its own laptop for a moment, is its own line", async () => {
  const r = room(["lap-a", "lap-b"]);
  const t0 = t();
  await r.hear("lap-a", t0, mix(7, [A(4), 1], [B(4, 2.5, 3.5), 0.05]), "Let's move the footer to the left side.");
  await r.hear("lap-b", t0, mix(8, [A(4), 0.05], [B(4, 2.5, 3.5), 1.5]), "Yes.");
  await r.pipeline.flush();
  const [a, b] = (r.pipeline as any).finalized.flatMap((g: any) => g.segments);
  // This case is the loudest-for-a-moment rule's, not the level rule's.
  expect(Math.abs(a.levelDb - b.levelDb)).toBeGreaterThan(10);
  expect(r.lines().map((u) => u.text).sort()).toEqual(["Let's move the footer to the left side.", "Yes."]);
  // Without the reply that laptop only hears the room: never the loudest, never transcribed.
  const q = room(["lap-a", "lap-b"]);
  await q.hear("lap-a", t0, mix(7, [A(4), 1]), "Let's move the footer to the left side.");
  await q.hear("lap-b", t0, mix(8, [A(4), 0.05]), "Yes.");
  await q.pipeline.flush();
  expect(q.asked).toHaveLength(1);
  expect(q.lines()).toHaveLength(1);
});

test("a late copy with other words, from a laptop that could have heard someone else, becomes its own line", async () => {
  const r = room(["lap-a", "lap-b"]);
  const t0 = t();
  await r.hear("lap-a", t0, mix(9, [A(3), 1], [B(3), 0.3]), "Put the pricing page up.");
  await r.pipeline.flush();
  await r.hear("lap-b", t0, mix(10, [B(3), 1], [A(3), 0.3]), "I think the header is too tall.");
  await r.pipeline.flush();
  expect(r.lines().map((u) => u.text).sort()).toEqual(["I think the header is too tall.", "Put the pricing page up."]);
  expect(r.lines().find((u) => u.deviceId === "lap-b")).toMatchObject({ personId: null });
  expect(r.taught).toEqual(["lap-a"]);
});

test("whisper load with 4 laptops: one transcription before; after, one per copy within the threshold", async () => {
  const load = async (gains: number[]) => {
    const r = room();
    const t0 = t();
    await Promise.all(gains.map((g, i) => r.hear(["lap-a", "lap-b", "lap-c", "lap-d"][i], t0, mix(20 + i, [A(3), dB(g)]), "Put the pricing page up.")));
    await r.pipeline.flush();
    expect(r.lines()).toHaveLength(1);
    return r.asked.length;
  };
  // Spread across a room (6 dB apart) and around one table (2 to 3 dB apart).
  expect(await load([0, -6, -12, -18])).toBe(2);
  expect(await load([0, -3, -6, -8])).toBe(4);
});

test("a split line is named when a voice match names it", async () => {
  const r = room(["lap-a", "lap-b"]);
  const unit = (k: number) => Float32Array.from({ length: 256 }, (_, i) => Math.sin(i * 0.37 + k) / 8);
  r.pipeline.voiceprints.add(r.ana.id, unit(1), "enrol", Date.now());
  r.pipeline.voiceprints.add(r.bob.id, unit(4), "enrol", Date.now());
  const t0 = t();
  await r.hear("lap-a", t0, mix(11, [A(3), 1], [B(3), 0.3]), "Put the pricing page up.");
  await r.hear("lap-b", t0, mix(12, [B(3), 1], [A(3), 0.3]), "I think the header is too tall.");
  for (const g of (r.pipeline as any).open) for (const s of g.segments) s.embedding = s.deviceId === "lap-a" ? unit(1) : unit(4);
  await r.pipeline.flush();
  expect(r.lines().find((u) => u.deviceId === "lap-b")).toMatchObject({ personId: r.bob.id, speakerName: "Bob", method: "voice" });
});

// The one rule for copies: every copy becomes exactly one line or joins exactly one, never lost or counted twice,
// however late it comes. Each path into AudioPipeline.admit (the only way into a transcribed group) is tested here.
/** Every copy's device, across every line: each copy must appear exactly once. */
const copies = (r: ReturnType<typeof room>) => r.lines().flatMap((u) => u.devices.map((d) => d.deviceId)).sort();

test("a late copy that is cleaner than the line and says other words is its own line; the line keeps its words (office review 2)", async () => {
  const r = room(["lap-a", "lap-b"]);
  const t0 = t();
  // Ana, heard faintly at her own laptop; Bob, much clearer at his, arriving after Ana's line is out.
  await r.hear("lap-a", t0, mix(31, [A(3), 0.25], [B(3), 0.05]), "Put the pricing page up.");
  await r.pipeline.flush();
  await r.hear("lap-b", t0, mix(32, [B(3), 1], [A(3), 0.08]), "I think the header is too tall.");
  await r.pipeline.flush();
  expect(r.lines().map((u) => u.text).sort()).toEqual(["I think the header is too tall.", "Put the pricing page up."]);
  expect(copies(r)).toEqual(["lap-a", "lap-b"]);
  expect(r.lines().find((u) => u.deviceId === "lap-b")).toMatchObject({ personId: null });
});

test("a late, much cleaner copy with the line's words joins it and only rewords it", async () => {
  const r = room(["lap-a", "lap-b"]);
  const t0 = t();
  await r.hear("lap-a", t0, mix(33, [A(3), 0.25]), "put the pricing page up");
  await r.pipeline.flush();
  await r.hear("lap-b", t0, mix(34, [A(3), 1]), "Put the pricing page up.");
  await r.pipeline.flush();
  expect(r.lines().map((u) => u.text)).toEqual(["Put the pricing page up."]);
  expect(copies(r)).toEqual(["lap-a", "lap-b"]);
});

test("a copy that arrives while its line is still being transcribed waits for it, then is decided once (office review 3)", async () => {
  for (const [late, want] of [["I think the header is too tall.", 2], ["Put the pricing page up.", 1]] as const) {
    const r = room(["lap-a", "lap-b"]);
    const t0 = t();
    await r.hear("lap-a", t0, mix(35, [A(3), 1], [B(3), 0.3]), "Put the pricing page up.");
    const release = r.hold();
    const flushed = r.pipeline.flush();
    const arriving = r.hear("lap-b", t0, mix(36, [B(3), late.startsWith("Put") ? 0 : 1], [A(3), late.startsWith("Put") ? 0.6 : 0.3]), late);
    await Bun.sleep(20);
    expect(r.lines()).toHaveLength(0);
    release();
    await Promise.all([flushed, arriving]);
    await r.pipeline.flush();
    expect(r.lines()).toHaveLength(want);
    expect(copies(r)).toEqual(["lap-a", "lap-b"]);
  }
});

test("split crosstalk: a late copy of the second part during a slow first transcription is not shown twice (office review 3)", async () => {
  const r = room(["lap-a", "lap-b", "lap-c", "lap-d"]);
  const t0 = t();
  // Bob starts 1.2 s after Ana. lap-c's copy of Ana, 0.6 s off, bridges them into one group; splitCrosstalk then
  // splits Bob's shifted, clean copy into a second part.
  await r.hear("lap-a", t0, mix(37, [A(3), 1]), "Put the pricing page up.");
  await r.hear("lap-c", t0 + 600, mix(47, [A(3), 0.5]), "Put the pricing page up.");
  await r.hear("lap-b", t0 + 1200, mix(38, [B(3), 0.8]), "I think the header is too tall.");
  expect((r.pipeline as any).open).toHaveLength(1);
  const release = r.hold();
  const flushed = r.pipeline.flush();
  await Bun.sleep(10);
  // A fourth laptop's copy of Bob (it overlaps only Bob's part), arriving while Ana's part is still with whisper.
  const arriving = r.hear("lap-d", t0 + 1700, mix(39, [B(3), 0.7]), "I think the header is too tall.");
  await Bun.sleep(20);
  release();
  await Promise.all([flushed, arriving]);
  await r.pipeline.flush();
  expect(r.lines().map((u) => u.text)).toEqual(["Put the pricing page up.", "I think the header is too tall."]);
  expect(copies(r)).toEqual(["lap-a", "lap-b", "lap-c", "lap-d"]);
});

test("a late third laptop's copy of a split line joins that line, not a third one", async () => {
  const r = room(["lap-a", "lap-b", "lap-c"]);
  const t0 = t();
  await r.hear("lap-a", t0, mix(40, [A(3), 1], [B(3), 0.3]), "Put the pricing page up.");
  await r.hear("lap-b", t0, mix(41, [B(3), 1], [A(3), 0.3]), "I think the header is too tall.");
  await r.pipeline.flush();
  await r.hear("lap-c", t0, mix(42, [B(3), 0.9], [A(3), 0.3]), "I think the header is too tall.");
  await r.pipeline.flush();
  expect(r.lines()).toHaveLength(2);
  expect(r.lines().find((u) => u.text.startsWith("I think"))!.devices.map((d) => d.deviceId).sort()).toEqual(["lap-b", "lap-c"]);
  expect(copies(r)).toEqual(["lap-a", "lap-b", "lap-c"]);
});

test("a late copy of a line that had no words, saying something, becomes a line; silence after it adds nothing", async () => {
  const r = room(["lap-a", "lap-b"]);
  const t0 = t();
  await r.hear("lap-a", t0, mix(43, [A(3), 1]), "");
  await r.pipeline.flush();
  expect(r.lines()).toHaveLength(0);
  await r.hear("lap-b", t0, mix(44, [B(3), 1], [A(3), 0.5]), "I think the header is too tall.");
  await r.pipeline.flush();
  expect(r.lines().map((u) => u.text)).toEqual(["I think the header is too tall."]);
});

test("a group still being transcribed is kept past the keep window, so a copy arriving then can't start a second line", async () => {
  const r = room(["lap-a", "lap-b"]);
  const t0 = t();
  await r.hear("lap-a", t0, mix(45, [A(3), 1]), "Put the pricing page up.");
  const release = r.hold();
  const flushed = r.pipeline.flush();
  await Bun.sleep(10);
  // Every other group's arrival is long past the keep window.
  const realNow = Date.now;
  Date.now = () => realNow() + 60_000;
  try {
    const arriving = r.hear("lap-b", t0, mix(46, [A(3), 0.7]), "Put the pricing page up.");
    await Bun.sleep(20);
    release();
    await Promise.all([flushed, arriving]);
    await r.pipeline.flush();
  } finally {
    Date.now = realNow;
  }
  expect(r.lines()).toHaveLength(1);
  expect(copies(r)).toEqual(["lap-a", "lap-b"]);
});

test("the same words from two laptops whose clocks are too far apart to group, transcribed at the same time, are one line", async () => {
  const r = room(["lap-a", "lap-b"]);
  const t0 = t();
  await r.hear("lap-a", t0, mix(48, [A(3), 1]), "Put the pricing page up.");
  await r.hear("lap-b", t0 + 1500, mix(49, [A(3), 0.7]), "Put the pricing page up.");
  expect((r.pipeline as any).open).toHaveLength(2);
  const release = r.hold();
  const flushed = r.pipeline.flush();
  await Bun.sleep(10);
  release();
  await flushed;
  expect(r.lines()).toHaveLength(1);
  expect(copies(r)).toEqual(["lap-a", "lap-b"]);
});

test("a copy flushed so late its line's group is gone still joins that line (its devices), and isn't shown twice", async () => {
  const r = room(["lap-a", "lap-b"]);
  const t0 = t();
  await r.hear("lap-a", t0, mix(50, [A(3), 1]), "Put the pricing page up.");
  await r.pipeline.flush();
  const first = r.lines()[0];
  // The line's group has been let go (the keep window passed).
  (r.pipeline as any).finalized = [];
  await r.hear("lap-b", t0 + 200, mix(51, [A(3), 0.7]), "Put the pricing page up.");
  await r.pipeline.flush();
  expect(r.lines()).toHaveLength(1);
  expect(r.lines()[0]).toMatchObject({ id: first.id, personId: first.personId, text: first.text });
  expect(copies(r)).toEqual(["lap-a", "lap-b"]);
});

test("after a pruned line takes a late copy, still later copies join it too: one after another, or while that copy is still being heard", async () => {
  for (const mode of ["sequential", "queued", "apart"] as const) {
    const r = room(["lap-a", "lap-b", "lap-c"]);
    const t0 = t();
    await r.hear("lap-a", t0, mix(52, [A(3), 1]), "Put the pricing page up.");
    await r.pipeline.flush();
    const first = r.lines()[0];
    (r.pipeline as any).finalized = [];
    if (mode === "queued") {
      await r.hear("lap-b", t0 + 200, mix(53, [A(3), 0.7]), "Put the pricing page up.");
      const release = r.hold();
      const flushed = r.pipeline.flush();
      await Bun.sleep(10);
      const arriving = r.hear("lap-c", t0 + 200, mix(54, [A(3), 0.6]), "Put the pricing page up.");
      await Bun.sleep(20);
      release();
      await Promise.all([flushed, arriving]);
    } else {
      await r.hear("lap-b", t0 + 200, mix(53, [A(3), 0.7]), "Put the pricing page up.");
      await r.pipeline.flush();
      // "apart": too far in time from lap-b's copy to group with it, still within a line's twin window.
      await r.hear("lap-c", mode === "apart" ? t0 + 1400 : t0 + 200, mix(54, [A(3), 0.6]), "Put the pricing page up.");
    }
    await r.pipeline.flush();
    expect([mode, r.lines().length]).toEqual([mode, 1]);
    expect(r.lines()[0]).toMatchObject({ id: first.id, personId: first.personId, speakerName: first.speakerName, text: first.text, deviceId: first.deviceId });
    expect([mode, copies(r)]).toEqual([mode, ["lap-a", "lap-b", "lap-c"]]);
  }
});

test("an adopted late copy is never its line's voice sample (voiceOf, voiceFor): the line's event sample is, or none once it is scrubbed", async () => {
  const r = room(["lap-a", "lap-b"]);
  const t0 = t();
  await r.hear("lap-a", t0, mix(55, [A(3), 1]), "Put the pricing page up.");
  await r.pipeline.flush();
  const line = r.lines()[0];
  // The line's own sample, kept with its event (as the hub does).
  const own = Float32Array.from({ length: 256 }, (_, i) => (i === 0 ? 1 : 0));
  const ev = r.session.store.addEvent({ kind: "speech", authorType: "person", text: line.text, authorId: null, authorName: "Ana", data: { embedding: [...own], heardAt: Date.now() - 1000 } } as any);
  r.session.store.put("utterances", { ...line, eventId: ev.id });
  (r.pipeline as any).finalized = [];
  await r.hear("lap-b", t0 + 200, mix(56, [A(3), 0.7]), "Put the pricing page up.");
  await r.pipeline.flush();
  const adopted = (r.pipeline as any).finalized.find((g: any) => g.adopted);
  expect(adopted).toBeDefined();
  for (const s of adopted.segments) s.embedding = Float32Array.from({ length: 256 }, (_, i) => (i === 1 ? 1 : 0));
  const voice = (r.pipeline as any).voiceOf(r.session.store.get("utterances", line.id));
  expect([...voice.embedding.slice(0, 2)]).toEqual([1, 0]);
  expect(r.pipeline.voiceFor(line.id).embedding).toBeNull();
  // After a Reset scrubbed the event's sample, the line has none: the adopted copy doesn't bring one back.
  r.session.store.updateEvent(ev.id, { data: { embedding: null } });
  r.pipeline.forgetVoice(r.ana.id);
  expect((r.pipeline as any).voiceOf(r.session.store.get("utterances", line.id)).embedding).toBeNull();
});
