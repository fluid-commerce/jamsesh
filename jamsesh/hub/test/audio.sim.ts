// Room-audio simulator for the pipeline bench. Takes real LibriSpeech voices (fetched
// by test/audio-fetch.py into /tmp/jam-audio), renders one copy per device through
// ffmpeg (distance, noise, muffling, cheap mics, reverb, clipping, trimmed edges) and
// feeds them to a real AudioPipeline with a real Store, Session and whisper-server.
import "./audio.env";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AudioPipeline } from "../src/audio/pipeline";
import { Transcriber } from "../src/audio/transcribe";
import { decodeWav, encodeWav, type Pcm } from "../src/audio/wav";
import { Session } from "../src/session";
import { Store } from "../src/store";
import type { Person, Utterance } from "../src/types";

export const FFMPEG = "/opt/homebrew/bin/ffmpeg";
const DATA = "/tmp/jam-audio";
const CACHE = join(DATA, "render");
const NOISE_DIR = join(DATA, "noise");
mkdirSync(CACHE, { recursive: true });
mkdirSync(NOISE_DIR, { recursive: true });

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- corpus

export interface Clip {
  id: string;
  speaker: string; // LibriSpeech speaker id
  text: string;
  file: string;
  durMs: number;
}

export function loadCorpus(): Map<string, Clip[]> {
  const f = join(DATA, "meta.json");
  if (!existsSync(f)) throw new Error("No corpus in /tmp/jam-audio. Run: python3 -I test/audio-fetch.py");
  const out = new Map<string, Clip[]>();
  for (const m of JSON.parse(readFileSync(f, "utf8"))) {
    const c: Clip = { id: m.id, speaker: m.speaker, text: m.text, file: m.file, durMs: Math.round(m.dur * 1000) };
    out.set(c.speaker, [...(out.get(c.speaker) ?? []), c]);
  }
  return out;
}

/** The four people in the room and the real voice each one has. */
export const CAST = [
  { key: "ana", name: "Ana", voice: "84", sex: "F" },
  { key: "ben", name: "Ben", voice: "1272", sex: "M" },
  { key: "cam", name: "Cam", voice: "174", sex: "M" },
  { key: "dee", name: "Dee", voice: "1462", sex: "F" },
] as const;
export type Key = (typeof CAST)[number]["key"];
export type DeviceKey = Key | "host";
/** Voices that are never in the room: used as background babble and as a guest. */
export const BABBLE_VOICES = ["251", "2277"];

// ---------------------------------------------------------------- rng, wer

export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const between = (lo: number, hi: number) => lo + (hi - lo) * next();
  return { next, between, chance: (p: number) => next() < p, pick: <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)] };
}
export type Rng = ReturnType<typeof rng>;

function words(s: string) {
  return s
    .toLowerCase()
    .replace(/\bmr\.?(?=\s)/g, "mister")
    .replace(/\bmrs\.?(?=\s)/g, "missus")
    .replace(/[-–—]/g, " ")
    .replace(/[^a-z0-9' ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Word error rate: word-level edit distance over reference length. */
export function wer(ref: string, hyp: string): number {
  const r = words(ref);
  const h = words(hyp);
  if (!r.length) return h.length ? 1 : 0;
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...new Array(h.length).fill(0)]);
  for (let j = 0; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++)
    for (let j = 1; j <= h.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
  return d[r.length][h.length] / r.length;
}

export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

// ---------------------------------------------------------------- noise sources

export type NoiseKind = "pink" | "room" | "babble";
const NOISE_SEC = 30;

function pinkSamples(n: number, r: Rng): Float32Array {
  const out = new Float32Array(n);
  let b0 = 0,
    b1 = 0,
    b2 = 0,
    b3 = 0,
    b4 = 0,
    b5 = 0,
    b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = r.next() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    out[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
  }
  return out;
}

function rmsDb(x: Float32Array) {
  let a = 0;
  for (const v of x) a += v * v;
  return 10 * Math.log10(a / Math.max(1, x.length) + 1e-12);
}

function setRms(x: Float32Array, db: number) {
  const g = 10 ** ((db - rmsDb(x)) / 20);
  for (let i = 0; i < x.length; i++) x[i] *= g;
  return x;
}

/** Noise bed rendered once at -30 dBFS RMS; ffmpeg scales it to each device's floor. */
function noiseFile(kind: NoiseKind): string {
  const f = join(NOISE_DIR, `${kind}-v2.wav`);
  if (existsSync(f)) return f;
  const r = rng(kind.length * 7919);
  const n = 16000 * NOISE_SEC;
  let x: Float32Array;
  if (kind === "pink") x = pinkSamples(n, r);
  else if (kind === "room") {
    // HVAC rumble: low-passed pink plus mains hum.
    x = pinkSamples(n, r);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      lp += 0.08 * (x[i] - lp);
      x[i] = lp * 3 + 0.15 * Math.sin((2 * Math.PI * 60 * i) / 16000) + 0.05 * Math.sin((2 * Math.PI * 120 * i) / 16000);
    }
  } else {
    // Background chatter: four talkers (voices that are not in the room) speaking back to
    // back for the whole bed, so there are no gaps for a noise-floor estimate to hide in.
    const corpus = loadCorpus();
    const clips = BABBLE_VOICES.flatMap((v) => corpus.get(v) ?? []);
    x = new Float32Array(n);
    for (let stream = 0; stream < 4; stream++) {
      let at = -Math.floor(r.between(0, 40000));
      for (let k = stream * 5; at < n; k++) {
        const c = clips[k % clips.length];
        const s = setRms(decodeWav(new Uint8Array(readFileSync(c.file))).samples.slice(), -30);
        for (let i = 0; i < s.length; i++) if (at + i >= 0 && at + i < n) x[at + i] += s[i];
        at += s.length + Math.floor(r.between(1000, 5000));
      }
    }
  }
  setRms(x, -30);
  writeFileSync(f, encodeWav({ sampleRate: 16000, samples: x }));
  return f;
}

/** A segment that contains no speech at all. */
export function noiseOnly(kind: "silence" | "pink" | "room" | "clicks" | "hum", seconds: number, db: number): Uint8Array {
  const n = Math.round(16000 * seconds);
  const r = rng(db * 31 + seconds);
  let x: Float32Array = new Float32Array(n);
  if (kind === "pink") x = setRms(pinkSamples(n, r), db);
  else if (kind === "room") {
    const p = pinkSamples(n, r);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      lp += 0.08 * (p[i] - lp);
      x[i] = lp;
    }
    setRms(x, db);
  } else if (kind === "hum") {
    for (let i = 0; i < n; i++) x[i] = Math.sin((2 * Math.PI * 60 * i) / 16000) + 0.4 * Math.sin((2 * Math.PI * 180 * i) / 16000);
    setRms(x, db);
  } else if (kind === "clicks") {
    // Keyboard clatter: short decaying noise bursts at random times.
    for (let t = 0; t < seconds * 7; t++) {
      const at = Math.floor(r.between(0, n - 1500));
      for (let i = 0; i < 1200; i++) x[at + i] += (r.next() * 2 - 1) * Math.exp(-i / 160);
    }
    // ... on top of an office noise floor, never digital silence.
    const floor = pinkSamples(n, r);
    setRms(x, db);
    setRms(floor, db - 18);
    for (let i = 0; i < n; i++) x[i] += floor[i];
  }
  return encodeWav({ sampleRate: 16000, samples: x });
}

// ---------------------------------------------------------------- rendering

export interface Src {
  file: string;
  delayMs?: number;
  gainDb: number;
}
export interface Spec {
  srcs: Src[];
  noise?: { kind: NoiseKind; db: number };
  muffleHz?: number; // acoustic: phone in a pocket, speaker turned away
  reverb?: boolean;
  micHp?: number; // cheap microphone response
  micLp?: number;
  boostDb?: number; // preamp too hot: pushes past full scale and clips
  headMs?: number; // the device's VAD started late / ended early
  tailMs?: number;
}
export interface Rendered {
  wav: Uint8Array;
  durMs: number;
  headMs: number;
}

let running = 0;
const queue: (() => void)[] = [];
async function slot() {
  if (running >= 4) await new Promise<void>((r) => queue.push(r));
  running++;
}
function release() {
  running--;
  queue.shift()?.();
}

export async function render(spec: Spec): Promise<Rendered> {
  const key = createHash("sha1").update("v4" + JSON.stringify(spec)).digest("hex").slice(0, 16);
  const out = join(CACHE, `${key}.wav`);
  if (!existsSync(out)) {
    const args: string[] = [];
    const parts: string[] = [];
    spec.srcs.forEach((s, i) => {
      args.push("-i", s.file);
      const d = Math.round(s.delayMs ?? 0);
      parts.push(`[${i}:a]${spec.muffleHz ? `lowpass=f=${spec.muffleHz},` : ""}${d > 0 ? `adelay=${d}:all=1,` : ""}volume=${s.gainDb.toFixed(1)}dB[s${i}]`);
    });
    const n = spec.srcs.length;
    parts.push(n > 1 ? `${spec.srcs.map((_, i) => `[s${i}]`).join("")}amix=inputs=${n}:normalize=0:duration=longest[sp]` : "[s0]anull[sp]");
    let cur = "sp";
    if (spec.reverb) (parts.push(`[${cur}]aecho=0.8:0.85:35|70|110:0.3|0.2|0.12[rv]`), (cur = "rv"));
    if (spec.noise) {
      args.push("-i", noiseFile(spec.noise.kind));
      parts.push(`[${n}:a]volume=${(spec.noise.db + 30).toFixed(1)}dB[nz]`);
      parts.push(`[${cur}][nz]amix=inputs=2:normalize=0:duration=first[mx]`);
      cur = "mx";
    }
    const post = [spec.micHp ? `highpass=f=${spec.micHp}` : "", spec.micLp ? `lowpass=f=${spec.micLp}` : "", spec.boostDb ? `volume=${spec.boostDb}dB` : ""].filter(Boolean);
    if (post.length) (parts.push(`[${cur}]${post.join(",")}[pp]`), (cur = "pp"));
    await slot();
    try {
      const p = Bun.spawn([FFMPEG, "-y", "-loglevel", "error", ...args, "-filter_complex", parts.join(";"), "-map", `[${cur}]`, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", out], { stdout: "ignore", stderr: "pipe" });
      if ((await p.exited) !== 0) throw new Error(`ffmpeg failed: ${await new Response(p.stderr).text()}\n${parts.join(";")}`);
    } finally {
      release();
    }
  }
  const pcm = decodeWav(new Uint8Array(readFileSync(out)));
  const head = Math.round(((spec.headMs ?? 0) * 16000) / 1000);
  const tail = Math.round(((spec.tailMs ?? 0) * 16000) / 1000);
  const samples = head || tail ? pcm.samples.slice(head, Math.max(head + 1, pcm.samples.length - tail)) : pcm.samples;
  const wav = encodeWav({ sampleRate: 16000, samples });
  return { wav, durMs: Math.round((samples.length / 16000) * 1000), headMs: spec.headMs ?? 0 };
}

// ---------------------------------------------------------------- acoustic plans

export interface PlanOpts {
  /** Where the voice is: a laptop, or only the host room mic. */
  near: DeviceKey;
  /** 'bad' = a poor recording overall: far, noisy, muffled, reverberant. */
  quality?: "normal" | "bad";
  /** Devices that can hear (default: all four laptops and the host). */
  devices?: DeviceKey[];
  /** Devices forced to miss the line entirely. */
  miss?: DeviceKey[];
  /** Devices that must hear it (never randomly miss). */
  keep?: DeviceKey[];
  /** Skip random "device missed it" draws. */
  noMiss?: boolean;
}

/** Fixed character of each mic: laptops differ, the host mic sits in the middle of the room. */
const MIC: Record<DeviceKey, Partial<Spec>> = {
  ana: { micHp: 120 },
  ben: { micHp: 320, micLp: 3600 }, // cheap headset
  cam: {},
  dee: { reverb: true, micHp: 100 }, // tiled kitchen
  host: { reverb: true, micHp: 80 },
};

/** Per-device acoustics for one line, seeded so reruns hear the same room. */
type PlanEntry = Omit<Spec, "srcs"> & { gainDb: number; gainNear: number; gainFar: number };
export function plan(r: Rng, opts: PlanOpts): Record<string, PlanEntry> {
  const devices = opts.devices ?? ["ana", "ben", "cam", "dee", "host"];
  const bad = opts.quality === "bad";
  const out: Record<string, PlanEntry> = {};
  for (const d of devices) {
    if (opts.miss?.includes(d)) continue;
    const isNear = d === opts.near;
    const penNear = bad ? r.between(6, 9) : 0;
    const penFar = bad ? r.between(3, 6) : 0;
    const gainNear = -r.between(3, 6) - penNear;
    const gainFar = (d === "host" ? -r.between(9, 16) : -r.between(14, 24)) - penFar;
    const gain = isNear ? gainNear : gainFar;
    // A device far from the speaker sometimes does not trigger its VAD at all.
    if (!isNear && !opts.keep?.includes(d) && !opts.noMiss && gain < -19 && r.chance(0.35)) continue;
    const noiseDb = bad ? -r.between(38, 44) : isNear ? -r.between(48, 56) : -r.between(38, 54);
    const spec: PlanEntry = {
      gainDb: gain,
      gainNear,
      gainFar,
      noise: { kind: r.pick(d === "host" ? (["babble", "room", "pink"] as const) : (["room", "pink", "babble"] as const)), db: noiseDb },
      ...MIC[d],
    };
    if (r.chance(bad ? 0.7 : 0.25)) spec.muffleHz = Math.round(r.between(2000, 4000));
    if (bad && r.chance(0.5)) spec.reverb = true;
    if (isNear && !bad && r.chance(0.15)) spec.boostDb = 22; // too-hot preamp: clips
    spec.headMs = r.chance(0.5) ? Math.round(r.between(0, 140)) : 0;
    spec.tailMs = r.chance(0.5) ? Math.round(r.between(0, 140)) : 0;
    out[d] = spec;
  }
  if (!Object.keys(out).length) throw new Error("plan: nobody hears this line");
  return out;
}

export interface Copy {
  device: DeviceKey;
  wav: Uint8Array;
  durMs: number;
  /** Offset of this copy's first sample from the start of the earliest source. */
  headMs: number;
  /** Clock skew between this device and the host, ms (tens of ms in real life). */
  clockMs: number;
}

/** Renders a plan for one or more simultaneous sources. */
export async function renderPlan(p: ReturnType<typeof plan>, sources: { file: string; delayMs?: number; gainOffsetDb?: number; near?: DeviceKey }[], r: Rng): Promise<Copy[]> {
  const copies: Copy[] = [];
  for (const [device, spec] of Object.entries(p)) {
    const srcs = sources.map((s) => {
      // Each voice is loud at its own device and quiet everywhere else.
      const gain = s.near ? (s.near === device ? spec.gainNear : spec.gainFar) : spec.gainDb;
      return { file: s.file, delayMs: s.delayMs, gainDb: gain + (s.gainOffsetDb ?? 0) };
    });
    const { gainDb: _g, gainNear: _n, gainFar: _f, ...rest } = spec;
    const rd = await render({ ...rest, srcs });
    copies.push({ device: device as DeviceKey, wav: rd.wav, durMs: rd.durMs, headMs: rd.headMs, clockMs: Math.round(r.between(-30, 30)) });
  }
  return copies;
}

// ---------------------------------------------------------------- virtual clock

const realNow = Date.now.bind(Date);
export const clock = {
  skew: 0,
  installed: false,
  install() {
    if (this.installed) return;
    this.installed = true;
    Date.now = () => realNow() + this.skew;
  },
  /** Jump forward (only while nothing is pending) so the next line sits after the last one. */
  advanceTo(t: number) {
    const gap = t - Date.now();
    if (gap > 0) this.skew += gap;
  },
  uninstall() {
    Date.now = realNow;
    this.installed = false;
    this.skew = 0;
  },
};

// ---------------------------------------------------------------- the room

export interface Truth {
  key: string;
  speaker: Key | "guest";
  text: string;
  t0: number;
  t1: number;
}
export interface LineEvent {
  u: Utterance;
  isNew: boolean;
  at: number;
}

export class SimRoom {
  store: Store;
  session: Session;
  pipeline: AudioPipeline;
  people = {} as Record<Key, Person>;
  deviceId = {} as Record<DeviceKey, string>;
  events: LineEvent[] = [];
  truths: Truth[] = [];
  private lastEnd = 0;
  private pending: Promise<unknown>[] = [];

  constructor(transcriber: Transcriber, session: Session) {
    this.session = session;
    this.store = session.store;
    this.pipeline = new AudioPipeline(session, transcriber);
    this.pipeline.onLine = (u, isNew) => this.events.push({ u: structuredClone(u), isNew, at: Date.now() });
    for (const c of CAST) {
      this.people[c.key] = session.upsertPerson({ name: c.name, role: "designer" });
      this.deviceId[c.key] = `dev-${c.key}`;
      session.touchDevice(this.deviceId[c.key], { label: `${c.name}'s laptop`, personId: this.people[c.key].id, kind: "client", micOn: true });
    }
    this.deviceId.host = "dev-host";
    session.touchDevice("dev-host", { label: "Room mic", personId: null, kind: "host", micOn: true });
  }

  static newSession() {
    return new Session(new Store(mkdtempSync(join(tmpdir(), "jam-audio-room-"))));
  }

  nameOf(personId: string | null) {
    return personId ? this.session.person(personId)?.name ?? null : null;
  }

  /** The latest version of every line. */
  lines(): Utterance[] {
    const m = new Map<string, Utterance>();
    for (const e of this.events) m.set(e.u.id, e.u);
    return [...m.values()].sort((a, b) => a.t0 - b.t0);
  }

  /** Lines whose time span overlaps a real utterance. */
  linesFor(t: Truth): Utterance[] {
    return this.lines().filter((u) => Math.min(u.t1, t.t1) - Math.max(u.t0, t.t0) > 0.4 * Math.min(u.t1 - u.t0, t.t1 - t.t0));
  }

  /**
   * One real utterance, heard by several devices. `immediate`: all copies are handed to
   * the pipeline at once. Otherwise each copy is delivered after its own lag (real
   * timers). Returns the truth record and a promise that resolves when every copy was
   * delivered.
   */
  async say(
    speaker: Key | "guest",
    clip: Clip,
    copies: Copy[],
    opts: { lagMs?: Partial<Record<DeviceKey, number>>; jitterMs?: number; startAt?: number; r?: Rng; wait?: boolean } = {},
  ): Promise<{ truth: Truth; delivered: Promise<void> }> {
    clock.install();
    const maxDur = Math.max(...copies.map((c) => c.headMs + c.durMs), clip.durMs);
    const start = opts.startAt ?? Math.max(this.lastEnd + 1500, Date.now() - maxDur);
    // The utterance is over by "now": jump the clock to its end.
    clock.advanceTo(start + maxDur);
    this.lastEnd = start + maxDur;
    const truth: Truth = { key: clip.id, speaker, text: clip.text, t0: start, t1: start + clip.durMs };
    this.truths.push(truth);
    const r = opts.r ?? rng(1);
    const deliver = async (c: Copy) => {
      const lag = (opts.lagMs?.[c.device] ?? 0) + (opts.jitterMs ? r.between(0, opts.jitterMs) : 0);
      if (lag > 0) await sleep(lag);
      const t0 = start + c.headMs + c.clockMs;
      await this.pipeline.ingest({ deviceId: this.deviceId[c.device], t0, t1: t0 + c.durMs, wav: c.wav });
    };
    const run = Promise.all(copies.map(deliver)).then(() => {});
    this.pending.push(run);
    if (opts.wait !== false) await run;
    return { truth, delivered: run };
  }

  async settle() {
    await Promise.all(this.pending);
    this.pending = [];
    await this.pipeline.flush();
  }

  /** Waits (real time) until no new line event has appeared for `quietMs`. */
  async quiet(quietMs = 1500, maxMs = 20_000) {
    const t0 = realNow();
    let last = this.events.length;
    let since = realNow();
    while (realNow() - t0 < maxMs) {
      await sleep(100);
      if (this.events.length !== last || this.pipeline.pending > 0) ((last = this.events.length), (since = realNow()));
      else if (realNow() - since > quietMs) break;
    }
  }
}

// ---------------------------------------------------------------- reporting

export interface Row {
  scenario: string;
  metric: string;
  value: string;
  criterion: string;
  pass: boolean;
}
export const rows: Row[] = [];
export function record(scenario: string, metric: string, value: string, criterion: string, pass: boolean) {
  rows.push({ scenario, metric, value, criterion, pass });
}
export const pct = (n: number, d: number) => `${n}/${d} (${d ? Math.round((100 * n) / d) : 0}%)`;

export function printTable() {
  const w = (k: keyof Row) => Math.max(k.length, ...rows.map((r) => String(r[k]).length));
  const cols: (keyof Row)[] = ["scenario", "metric", "value", "criterion"];
  const widths = cols.map(w);
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ") + "  ";
  const out = ["", "ROOM AUDIO BENCH", line(cols.map((c) => c.toUpperCase())) + "RESULT", ...rows.map((r) => line(cols.map((c) => String(r[c]))) + (r.pass ? "pass" : "FAIL")), ""];
  console.log(out.join("\n"));
  writeFileSync(join(DATA, "bench-results.json"), JSON.stringify(rows, null, 1));
}

/** JAM_DEBUG=1: print every line event of a room (who, how sure, which copies, text). */
export function dump(label: string, room: SimRoom) {
  if (!process.env.JAM_DEBUG) return;
  const t0 = Math.min(...room.events.map((e) => e.u.t0), Infinity);
  console.log(`--- ${label}`);
  for (const e of room.events)
    console.log(`${e.isNew ? "new " : "upd "} [${((e.u.t0 - t0) / 1000).toFixed(1)}-${((e.u.t1 - t0) / 1000).toFixed(1)}] ${(room.nameOf(e.u.personId) ?? "?").padEnd(5)} ${e.u.method.padEnd(18)} ${e.u.confidence.toFixed(2)} ${e.u.devices.map((d) => d.deviceId.replace("dev-", "") + ":" + d.level + "/" + d.snr).join(" ")} | ${e.u.text}`);
  for (const t of room.truths) console.log(`    truth ${t.speaker} [${((t.t0 - t0) / 1000).toFixed(1)}-${((t.t1 - t0) / 1000).toFixed(1)}] ${t.text.slice(0, 70)}`);
}
