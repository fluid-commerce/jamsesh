// A room of four voices on three laptops, for speaker labels and de-duplication.
// Voices are macOS `say` renders written to files (`say -o`; nothing is played). Each line is
// rendered once per laptop with its own loudness, noise, edge trim, clock skew and upload delay,
// then fed to a real AudioPipeline with a real Store and Session. Transcription is stubbed.
import "./voices.env";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { AudioPipeline } from "../src/audio/pipeline";
import { ENROL_SCRIPT } from "../src/audio/enrol";
import { decodeWav, encodeWav } from "../src/audio/wav";
import { voiceprintsAvailable } from "../src/audio/voiceprint";
import { Session } from "../src/session";
import { Store } from "../src/store";
import type { Person, Utterance } from "../src/types";

export const CAN_SIM = existsSync("/usr/bin/say") && voiceprintsAvailable();
const CACHE = join(tmpdir(), "jam-voices-sim");
mkdirSync(CACHE, { recursive: true });

export const CAST = [
  { key: "ana", name: "Ana", voice: "Karen" },
  { key: "ben", name: "Ben", voice: "Daniel" },
  { key: "cam", name: "Cam", voice: "Rishi" },
  { key: "dee", name: "Dee", voice: "Moira" },
] as const;
export type Key = (typeof CAST)[number]["key"];

/** Three laptops. The third is the room's shared Mac: nobody's, so a line it hears loudest has no owner. */
export const LAPTOPS = [
  { id: "lap-a", owner: "ana" as Key | null, skew: 0, delay: 150 },
  { id: "lap-b", owner: "ben" as Key | null, skew: 180, delay: 900 },
  { id: "lap-c", owner: null as Key | null, skew: -120, delay: 2400 },
];
/** How loud each person sounds at each laptop. Cam and Dee sit at the shared Mac. */
const GAIN: Record<Key, Record<string, number>> = {
  ana: { "lap-a": 1, "lap-b": 0.3, "lap-c": 0.25 },
  ben: { "lap-a": 0.3, "lap-b": 1, "lap-c": 0.35 },
  cam: { "lap-a": 0.25, "lap-b": 0.35, "lap-c": 1 },
  dee: { "lap-a": 0.3, "lap-b": 0.25, "lap-c": 0.8 },
};

const TEXT: Record<Key, string[]> = {
  ana: [
    "I think the header should be taller so the logo has some room to breathe.",
    "Can we try the blue button on the settings page before the demo this afternoon.",
    "The onboarding flow needs one fewer step, people keep dropping off at the second screen.",
    "Let me check the spacing on the pricing cards and send a screenshot to the room.",
    "I would move the search box to the top right and make it a little wider.",
    "That animation feels too slow, can we shorten it to about two hundred milliseconds.",
  ],
  ben: [
    "The build finished on my side, so I can push the new checkout screen now.",
    "We should ship option A on mobile today and look at desktop after lunch.",
    "I am going to rename the project workstream so it matches what the customers call it.",
    "There is a bug in the cart total when a discount code is applied twice.",
    "Let us put the dashboard on the big screen and walk through the numbers together.",
    "My agent is working on the profile page and should have a first version soon.",
  ],
  cam: [
    "Remind me which of these two layouts we agreed on last week for the portal.",
    "The customer asked for a way to export the report as a spreadsheet file.",
    "I will take the notifications task unless somebody else already has it.",
    "Can you share your screen so we can look at the mobile menu together.",
    "The contrast on the grey text is too low, it is hard to read in sunlight.",
    "We need a decision on the icon set before the end of the day tomorrow.",
  ],
  dee: [
    "The empty state needs a friendlier message and a button to create the first item.",
    "I tested the signup form and the error text overlaps the input on small phones.",
    "Could we use a softer shadow under the cards, the current one looks heavy.",
    "Let me write down what we decided about the navigation so nobody forgets it.",
    "The tablet layout is mostly fine, only the footer links wrap in a strange way.",
    "I can record a short walkthrough of the checkout flow for the team tonight.",
  ],
};

/** The sentence read aloud when joining; the pipeline must keep it out of the transcript. */
export const ENROL_TEXT: Record<Key, string> = { ana: ENROL_SCRIPT.join(" "), ben: ENROL_SCRIPT.join(" "), cam: ENROL_SCRIPT.join(" "), dee: ENROL_SCRIPT.join(" ") };

export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, between: (lo: number, hi: number) => lo + (hi - lo) * next(), chance: (p: number) => next() < p };
}
export type Rng = ReturnType<typeof rng>;

/** One person saying one thing, 16 kHz mono, normalised to a peak of 0.5. Cached on disk. */
export function say(key: Key, text: string, rate = 175): Float32Array {
  const voice = CAST.find((c) => c.key === key)!.voice;
  const file = join(CACHE, `${voice}-${rate}-${Bun.hash(text).toString(36)}.wav`);
  if (!existsSync(file)) {
    const r = spawnSync("/usr/bin/say", ["-v", voice, "-r", String(rate), "--file-format=WAVE", "--data-format=LEI16@16000", "-o", file, text]);
    if (r.status !== 0) throw new Error(`say failed: ${r.stderr}`);
  }
  const pcm = decodeWav(new Uint8Array(readFileSync(file)));
  let peak = 0;
  for (const x of pcm.samples) peak = Math.max(peak, Math.abs(x));
  return pcm.samples.map((x) => (x / (peak || 1)) * 0.5);
}

export interface Spoken {
  speaker: Key;
  text: string;
  /** Epoch ms of the speaker's own start and end. */
  t0: number;
  t1: number;
  samples: Float32Array;
}

/** What the room's recent speech looks like once heard by one laptop. */
function hear(samples: Float32Array, gain: number, r: Rng, trim: boolean): Float32Array {
  const lead = trim ? Math.floor(r.between(0, 0.25) * 16000) : 0;
  const tail = trim ? Math.floor(r.between(0, 0.3) * 16000) : 0;
  const body = samples.subarray(lead, samples.length - tail);
  const g = gain * r.between(0.9, 1.1);
  const out = new Float32Array(body.length + 16000);
  const pad = 8000;
  // Far copies lose their highs: a one-pole low-pass, harder as the gain falls.
  const a = Math.min(0.9, Math.max(0, 0.75 - gain));
  let lp = 0;
  for (let i = 0; i < out.length; i++) {
    const s = i >= pad && i - pad < body.length ? body[i - pad] * g : 0;
    lp = a * lp + (1 - a) * s;
    out[i] = lp + (r.next() - 0.5) * 0.004;
  }
  return out;
}

export interface Copy {
  laptop: string;
  /** Epoch ms the laptop reports for the start and end of its segment. */
  t0: number;
  t1: number;
  wav: Uint8Array;
  delay: number;
  text: string;
}

/** Every laptop's copy of a spoken line. `skew` overrides a laptop's clock error. */
export function copiesOf(line: Spoken, r: Rng, opts: { skew?: Record<string, number>; textNoise?: boolean } = {}): Copy[] {
  return LAPTOPS.map((l) => {
    const samples = hear(line.samples, GAIN[line.speaker][l.id], r, true);
    const dur = (samples.length / 16000) * 1000;
    const skew = opts.skew?.[l.id] ?? l.skew;
    const t0 = line.t0 - 500 + skew;
    const words = line.text.split(" ");
    // A far, muffled copy mishears a word or two.
    const text = opts.textNoise && GAIN[line.speaker][l.id] < 0.5 && words.length > 6 ? words.slice(0, words.length - 1 - Math.floor(r.between(0, 2))).join(" ") : line.text;
    return { laptop: l.id, t0, t1: t0 + dur, wav: encodeWav({ sampleRate: 16000, samples }), delay: l.delay, text };
  });
}

export interface Room {
  session: Session;
  pipeline: AudioPipeline;
  people: Record<Key, Person>;
  /** Text the stub transcriber returns for a given copy. */
  say: Map<string, string>;
  heard: Utterance[];
}

export function makeRoom(opts: { owners?: boolean } = {}): Room {
  const dir = join(tmpdir(), `jam-voices-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const session = new Session(new Store(dir));
  const people = {} as Record<Key, Person>;
  for (const c of CAST) people[c.key] = session.upsertPerson({ name: c.name });
  for (const l of LAPTOPS) session.touchDevice(l.id, { label: l.id, personId: opts.owners === false || !l.owner ? null : people[l.owner].id, micOn: true, location: "room", kind: l.owner ? "client" : "host" });
  const texts = new Map<string, string>();
  const transcriber = { transcribe: async (wav: Uint8Array) => ({ text: texts.get(String(Bun.hash(wav))) ?? "", engine: "stub" }) } as any;
  const pipeline = new AudioPipeline(session, transcriber);
  const heard: Utterance[] = [];
  pipeline.onLine = (u, isNew) => isNew && heard.push(u);
  return { session, pipeline, people, say: texts, heard };
}

/**
 * One line played into the room. Copies from laptops with a short upload delay arrive before the
 * line settles; slower ones arrive after it was already emitted (the late-copy path).
 */
export async function play(room: Room, line: Spoken, r: Rng, opts: { skew?: Record<string, number>; textNoise?: boolean; settleMs?: number } = {}) {
  const copies = copiesOf(line, r, opts).sort((a, b) => a.delay - b.delay);
  for (const c of copies) room.say.set(String(Bun.hash(c.wav)), c.text);
  // The hub waits out the slowest laptop it knows of, so most copies are in before a line is shown.
  // One line in five has a copy delayed past that (a Wi-Fi stall), and arrives after it was shown.
  const settle = opts.settleMs ?? 3000;
  if (r.chance(0.2)) copies[copies.length - 1].delay += 2500;
  for (const c of copies.filter((x) => x.delay <= settle)) await room.pipeline.ingest({ deviceId: c.laptop, t0: c.t0, t1: c.t1, wav: c.wav });
  await room.pipeline.flush();
  for (const c of copies.filter((x) => x.delay > settle)) await room.pipeline.ingest({ deviceId: c.laptop, t0: c.t0, t1: c.t1, wav: c.wav });
  await room.pipeline.flush();
}

/** A seeded run of lines from everyone, alternating turns, a few seconds apart. */
export function script(seed: number, rounds: number, base = Date.now() - 400_000, leaves?: { key: Key; after: number }): Spoken[] {
  const r = rng(seed);
  const out: Spoken[] = [];
  let t = base;
  const used = new Map<Key, number>();
  for (let i = 0; i < rounds * CAST.length; i++) {
    const here = CAST.filter((c) => !(leaves && i >= leaves.after && c.key === leaves.key));
    let who = here[Math.floor(r.next() * here.length)].key;
    if (i > 0 && out[i - 1].speaker === who && r.chance(0.6)) who = here[(here.findIndex((c) => c.key === who) + 1) % here.length].key;
    const n = used.get(who) ?? 0;
    used.set(who, n + 1);
    const text = TEXT[who][n % TEXT[who].length];
    const samples = say(who, text, Math.round(r.between(160, 190)));
    t += Math.round(r.between(2500, 5000));
    out.push({ speaker: who, text, t0: t, t1: t + Math.round((samples.length / 16000) * 1000), samples });
    t += Math.round((samples.length / 16000) * 1000);
  }
  return out;
}

export interface Score {
  lines: number;
  right: number;
  wrong: number;
  someone: number;
  lost: number;
  /** Utterances beyond one per spoken line. */
  dupes: number;
}

/** The first line shown for each spoken line (what score() judges), for looking at misses. */
export function outcomes(room: Room, spoken: Spoken[]) {
  const utts = room.session.store.all("utterances");
  const claimed = new Set<string>();
  return spoken.map((l) => {
    const mine = utts.filter((u) => u.t0 < l.t1 + 1500 && u.t1 > l.t0 - 1500 && !claimed.has(u.id));
    mine.forEach((u) => claimed.add(u.id));
    return { speaker: l.speaker, u: mine[0], extra: mine.length - 1 };
  });
}

export function score(room: Room, spoken: Spoken[]): Score {
  const utts = room.session.store.all("utterances");
  const s: Score = { lines: spoken.length, right: 0, wrong: 0, someone: 0, lost: 0, dupes: 0 };
  const claimed = new Set<string>();
  for (const l of spoken) {
    const mine = utts.filter((u) => u.t0 < l.t1 + 1500 && u.t1 > l.t0 - 1500 && !claimed.has(u.id));
    mine.forEach((u) => claimed.add(u.id));
    if (!mine.length) s.lost++;
    else {
      s.dupes += mine.length - 1;
      const u = mine[0];
      if (!u.personId) s.someone++;
      else if (u.personId === room.people[l.speaker].id) s.right++;
      else s.wrong++;
    }
  }
  return s;
}

export const pct = (n: number, of: number) => `${((100 * n) / (of || 1)).toFixed(0)}%`;

/** A person reads the join sentence into a mic. Uses the pipeline's own enrolment when it has one. */
export function enrol(room: Room, key: Key) {
  const p = room.pipeline as any;
  const samples = say(key, ENROL_TEXT[key], 165);
  if (typeof p.enrol === "function") return p.enrol(room.people[key].id, { sampleRate: 16000, samples });
  // Before 5.3: what Hub.enrollVoice did, three-second chunks added one by one.
  const { embed } = require("../src/audio/voiceprint");
  const chunk = 16000 * 3;
  for (let i = 0; i + chunk / 2 <= samples.length; i += chunk) {
    const e = embed({ sampleRate: 16000, samples: samples.subarray(i, Math.min(samples.length, i + chunk)) });
    if (e) p.voiceprints.add(room.people[key].id, e, "enrol", Date.now());
  }
}
