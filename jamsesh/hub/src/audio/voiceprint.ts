// Voiceprints with a local speaker-embedding model (WeSpeaker ResNet34 through
// sherpa-onnx). A person's voiceprint is the mean of their labelled samples.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import { config } from "../config";
import type { Store, VoiceKind } from "../store";
import type { Pcm } from "./wav";

type Extractor = { createStream(): any; compute(s: any): Float32Array };

let extractor: Extractor | null | undefined;
/** Why the speaker model is off, when it is (kept so the host can be told, not just the log). */
let loadError = "";
let loadCode: VoiceStatus["code"] = "ok";

/** Where people get the speaker model; it is the file the app bundles as models/wespeaker_en.onnx. */
const MODEL_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx";

function getExtractor(): Extractor | null {
  if (extractor !== undefined) return extractor;
  try {
    if (!config.speakerModel) {
      loadCode = "missing-model";
      throw new Error("the speaker model (wespeaker_en.onnx) isn't in the models folder");
    }
    // Inside the Mac app the hub is one compiled program; the native library sits beside it.
    loadCode = "missing-library";
    const sherpa = config.nodeModules ? createRequire(join(config.nodeModules, "index.js"))("sherpa-onnx-node") : require("sherpa-onnx-node");
    loadCode = "load-failed";
    extractor = new sherpa.SpeakerEmbeddingExtractor({ model: config.speakerModel, numThreads: 2, debug: 0 });
    loadCode = "ok";
  } catch (e) {
    loadError = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 200);
    console.warn("voiceprints off:", loadError);
    extractor = null;
  }
  return extractor ?? null;
}

export function voiceprintsAvailable() {
  return getExtractor() !== null;
}

export interface VoiceStatus {
  available: boolean;
  reason: string;
  /** What kind of problem, so the screen can say the right thing. */
  code: "ok" | "missing-model" | "missing-library" | "load-failed";
  /** One sentence on how to fix it; empty when it works. */
  fix: string;
}

/** Whether voice matching works on this host, and if not, why and what to do about it. */
export function voiceprintStatus(): VoiceStatus {
  const available = getExtractor() !== null;
  if (available) return { available, reason: "", code: "ok", fix: "" };
  const folder = join(config.home, "models");
  const fixes: Record<VoiceStatus["code"], string> = {
    ok: "",
    "missing-model": `Download wespeaker_en_voxceleb_resnet34_LM.onnx from ${MODEL_URL}, save it as ${join(folder, "wespeaker_en.onnx")}, then restart JamSesh. The JamSesh app already includes it.`,
    "missing-library": "The voice library (sherpa-onnx-node) isn't installed next to the hub. Run JamSesh from the app, or install it in the hub's folder, then restart.",
    "load-failed": `The speaker model at ${config.speakerModel ?? join(folder, "wespeaker_en.onnx")} didn't load. Download it again from ${MODEL_URL} and restart JamSesh.`,
  };
  return { available, reason: loadError || "the speaker model didn't load", code: loadCode === "ok" ? "load-failed" : loadCode, fix: fixes[loadCode === "ok" ? "load-failed" : loadCode] };
}

/** What a speaker correction did for the voiceprint: it learned, or why it could not. */
export type Learning = { learned: true; cleaned?: number; relabelled?: number } | { learned: false; reason: string };

/** What to tell the person who corrected a line. */
export function learningNote(name: string, l: Learning) {
  if (!l.learned) return `Renamed, but couldn't learn from that line (${l.reason}).`;
  return `Learning ${name}'s voice.${l.relabelled ? ` Fixed ${l.relabelled} earlier line${l.relabelled === 1 ? "" : "s"} too.` : ""}`;
}

/** The shortest line that carries enough voice to learn from. */
export const MIN_VOICE_SECONDS = 0.8;

export function embed(pcm: Pcm): Float32Array | null {
  const ex = getExtractor();
  if (!ex || pcm.samples.length < pcm.sampleRate * MIN_VOICE_SECONDS) return null;
  const s = ex.createStream();
  s.acceptWaveform({ sampleRate: pcm.sampleRate, samples: pcm.samples });
  return normalize(ex.compute(s));
}

export function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d;
}

/** How much one sample of each kind counts toward a voiceprint. A correction is a person saying who it was. */
export const WEIGHT: Record<VoiceKind, number> = { auto: 1, enrol: 3, correction: 10, carried: 3 };
/** The speaker model this host uses; carried voiceprints must come from the same one. */
export const MODEL_ID = "wespeaker_en";
export const EMBED_DIM = 256;
export const MAX_CARRIED = 32;

export interface Carried {
  model: string;
  dim: number;
  samples: { kind: VoiceKind; embedding: number[] }[];
  /** A digest of every sample this host holds for the person: it changes whenever the voiceprint does. */
  version?: string;
  /** When this host last learned a sample for the person (ms), to tell which of two hosts' copies is newer. */
  updatedAt?: number;
  /** This host's seal on the copy it gave out: which reset generation it belongs to. Other hosts ignore it. */
  stamp?: Stamp;
}

export interface Stamp {
  gen: number;
  at: number;
  mac: string;
}

/** Where a carried copy may teach from: when its samples count as heard, or why it's refused. */
export type Provenance = { ok: true; heardAt: number } | { ok: false; stale: boolean; reason: string };

/** The seal binds the person, the generation, the moment and the exact samples, so it can't be moved onto others. */
function seal(secret: string, personId: string, gen: number, at: number, samples: { kind: unknown; embedding: unknown }[]) {
  const h = createHmac("sha256", secret).update(`jamsesh-voice-stamp:v1|${personId}|${gen}|${at}|${samples.length}`);
  for (const x of samples) {
    h.update(`|${String(x.kind)}|`);
    h.update(new Uint8Array(Float32Array.from(Array.isArray(x.embedding) ? (x.embedding as number[]) : []).buffer));
  }
  return h.digest("base64url");
}

/** A voiceprint arriving from a person's device, checked before it goes anywhere near the store. */
export function parseCarried(body: unknown): { ok: true; samples: Float32Array[] } | { ok: false; reason: string } {
  const b = body as Partial<Carried> | null;
  if (!b || typeof b !== "object") return { ok: false, reason: "That isn't a voiceprint." };
  if (b.model !== MODEL_ID || b.dim !== EMBED_DIM) return { ok: false, reason: `This host uses the ${MODEL_ID} voice model; that voiceprint is from another.` };
  if (!Array.isArray(b.samples) || !b.samples.length) return { ok: false, reason: "That voiceprint has no samples." };
  if (b.samples.length > MAX_CARRIED) return { ok: false, reason: `A voiceprint carries at most ${MAX_CARRIED} samples.` };
  const out: Float32Array[] = [];
  for (const x of b.samples) {
    const e = x?.embedding;
    if (!Array.isArray(e) || e.length !== EMBED_DIM || e.some((n) => typeof n !== "number" || !Number.isFinite(n))) return { ok: false, reason: "A sample in that voiceprint is malformed." };
    // Finite as JSON isn't finite as Float32 (1e100 becomes Infinity, and then NaN once normalized): check what is stored.
    const v = Float32Array.from(e);
    if (!v.every(Number.isFinite)) return { ok: false, reason: "A sample in that voiceprint is malformed." };
    if (!v.some((n) => n !== 0)) return { ok: false, reason: "A sample in that voiceprint is empty." };
    const unit = normalize(v);
    if (!unit.every(Number.isFinite) || Math.abs(Math.hypot(...unit) - 1) > 1e-3) return { ok: false, reason: "A sample in that voiceprint is malformed." };
    out.push(unit);
  }
  return { ok: true, samples: out };
}

export class Voiceprints {
  private centroids = new Map<string, Float32Array>();
  private weights = new Map<string, number>();
  private kinds = new Map<string, Record<VoiceKind, number>>();

  constructor(private store: Store) {
    this.reload();
  }

  reload() {
    const sums = new Map<string, Float32Array>();
    this.weights.clear();
    this.kinds.clear();
    for (const { personId, embedding, kind } of this.store.voiceSamples()) {
      if (embedding.length !== EMBED_DIM) continue;
      const e = normalize(embedding);
      const w = WEIGHT[kind] ?? 1;
      const s = sums.get(personId) ?? new Float32Array(e.length);
      for (let i = 0; i < e.length; i++) s[i] += e[i] * w;
      sums.set(personId, s);
      this.weights.set(personId, (this.weights.get(personId) ?? 0) + w);
      const k = this.kinds.get(personId) ?? { auto: 0, enrol: 0, correction: 0, carried: 0 };
      k[kind] = (k[kind] ?? 0) + 1;
      this.kinds.set(personId, k);
    }
    this.centroids = new Map([...sums].map(([k, v]) => [k, normalize(v)]));
  }

  /** Learns a sample heard at `heardAt` (this host's clock); the store refuses anything from before the person's reset. */
  add(personId: string, e: Float32Array, kind: VoiceKind, heardAt: number) {
    const kept = this.store.addVoiceSample(personId, e, kind, heardAt);
    if (kept) this.reload();
    return kept;
  }

  /** Replaces a person's join read with a new one, heard now. */
  replaceEnrol(personId: string, samples: Float32Array[], heardAt: number) {
    this.store.clearVoiceKind(personId, "enrol");
    for (const e of samples) this.store.addVoiceSample(personId, e, "enrol", heardAt);
    this.reload();
  }

  private secret() {
    let k = this.store.setting<string>("voiceStampSecret", "");
    if (!k) this.store.setSetting("voiceStampSecret", (k = randomBytes(32).toString("hex")));
    return k;
  }

  /**
   * Whether a copy a device brings may teach this host, and as heard when. Until the person's voice is reset
   * here, any well-formed copy may. After a reset only a copy this host sealed in the current generation may:
   * one sealed earlier is stale (made before the reset), and one it didn't seal can't show it isn't.
   */
  provenance(personId: string, body: unknown): Provenance {
    const reset = this.store.voiceReset(personId);
    if (!reset.gen) return { ok: true, heardAt: Date.now() };
    const st = (body as { stamp?: Partial<Stamp> } | null)?.stamp;
    const samples = (body as { samples?: { kind: unknown; embedding: unknown }[] } | null)?.samples;
    const sealed =
      !!st && Number.isInteger(st.gen) && Number.isFinite(st.at) && typeof st.mac === "string" && Array.isArray(samples) && macEqual(st.mac, seal(this.secret(), personId, st.gen!, st.at!, samples));
    if (sealed && st!.gen === reset.gen && st!.at! > reset.at) return { ok: true, heardAt: st!.at! };
    if (sealed && st!.gen! < reset.gen) return { ok: false, stale: true, reason: "Your voice was reset on this host after that copy was made." };
    return { ok: false, stale: false, reason: "Your voice was reset on this host. It learns it again from you here, not from a copy." };
  }


  /** Drops the sample that is this embedding (a line first filed under the wrong person). */
  remove(personId: string, e: Float32Array) {
    const hit = this.store.voiceSamples().find((x) => x.personId === personId && cosine(normalize(x.embedding), e) > 0.995);
    if (!hit) return;
    this.store.deleteVoiceSamples([hit.id]);
    this.reload();
  }

  /**
   * A correction said `e` was not `wrong`'s voice. The automatic samples the wrong label gave
   * that person then are suspect: drop the ones that sound like `e` more than like the rest of
   * what that person has (what they read aloud or were corrected on, else their other samples).
   */
  forgetLike(wrong: string, e: Float32Array): number {
    const mine = this.store.voiceSamples().filter((x) => x.personId === wrong && x.embedding.length === EMBED_DIM);
    const near = (x: { embedding: Float32Array }) => cosine(normalize(x.embedding), e) >= NEAR;
    const autos = mine.filter((x) => x.kind === "auto" && near(x));
    if (!autos.length) return 0;
    const anchors = mine.filter((x) => !autos.includes(x));
    const trusted = anchors.filter((x) => x.kind !== "auto");
    const base = trusted.length ? trusted : anchors;
    let doomed = autos;
    if (base.length) {
      const sum = new Float32Array(EMBED_DIM);
      for (const x of base) {
        const v = normalize(x.embedding);
        for (let i = 0; i < v.length; i++) sum[i] += v[i];
      }
      const anchor = normalize(sum);
      doomed = autos.filter((x) => cosine(normalize(x.embedding), e) > cosine(normalize(x.embedding), anchor));
    }
    if (!doomed.length) return 0;
    this.store.deleteVoiceSamples(doomed.map((x) => x.id));
    this.reload();
    return doomed.length;
  }

  clear(personId: string) {
    this.store.clearVoiceprint(personId);
    this.reload();
  }

  /** How much this person's voiceprint can be trusted: samples weighted by kind. */
  count(personId: string) {
    return this.weights.get(personId) ?? 0;
  }

  /** Samples by kind, for "learned from 3 corrections". */
  learnedFrom(personId: string): Record<VoiceKind, number> {
    return this.kinds.get(personId) ?? { auto: 0, enrol: 0, correction: 0, carried: 0 };
  }

  /** What a person's own device keeps: everything they read or were corrected on, and their latest automatic samples. */
  exportFor(personId: string): Carried {
    const mine = this.store.voiceSamples().filter((x) => x.personId === personId && x.embedding.length === EMBED_DIM);
    const trusted = mine.filter((x) => x.kind !== "auto");
    const autos = mine.filter((x) => x.kind === "auto").sort((a, b) => b.ts - a.ts);
    const pick = [...trusted.sort((a, b) => b.ts - a.ts), ...autos].slice(0, MAX_CARRIED);
    const version = mine.length ? Bun.hash(mine.map((x) => `${x.id}:${x.ts}:${x.kind}`).sort().join(",")).toString(36) : "";
    const updatedAt = mine.reduce((t, x) => Math.max(t, x.ts), 0);
    const samples = pick.map((x) => ({ kind: x.kind, embedding: [...x.embedding].map((n) => Math.round(n * 1e5) / 1e5) }));
    const { gen, at: resetAt } = this.store.voiceReset(personId);
    const at = Math.max(Date.now(), resetAt + 1);
    return { model: MODEL_ID, dim: EMBED_DIM, samples, version, updatedAt, stamp: { gen, at, mac: seal(this.secret(), personId, gen, at, samples) } };
  }

  /**
   * Brings a person's voiceprint from their own device, replacing the copy they brought before. Samples this
   * host already has (its own copy coming back from another host) aren't added twice. Returns how many were kept.
   */
  importCarried(personId: string, samples: Float32Array[], heardAt: number): number {
    if (!(heardAt > this.store.voiceReset(personId).at)) return 0;
    this.store.clearVoiceKind(personId, "carried");
    const own = this.store.voiceSamples().filter((x) => x.personId === personId && x.embedding.length === EMBED_DIM).map((x) => normalize(x.embedding));
    const fresh = samples.filter((e) => !own.some((o) => cosine(o, e) > 0.9999));
    const kept = fresh.filter((e) => this.store.addVoiceSample(personId, e, "carried", heardAt)).length;
    this.reload();
    return kept;
  }

  /** Similarity of an embedding to every enrolled person, best first. */
  match(e: Float32Array): { personId: string; similarity: number }[] {
    return [...this.centroids]
      .map(([personId, c]) => ({ personId, similarity: cosine(e, c) }))
      .sort((a, b) => b.similarity - a.similarity);
  }

  get enrolled() {
    return this.centroids.size;
  }
}

/** Two samples this alike (cosine) are the same voice for the purpose of undoing a mislabel. */
const NEAR = 0.5;

function macEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
