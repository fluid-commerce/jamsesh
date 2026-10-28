// Voiceprints with a local speaker-embedding model (WeSpeaker ResNet34 through
// sherpa-onnx). A person's voiceprint is the mean of their labelled samples.
import { createRequire } from "node:module";
import { join } from "node:path";
import { config } from "../config";
import type { Store } from "../store";
import type { Pcm } from "./wav";

type Extractor = { createStream(): any; compute(s: any): Float32Array };

let extractor: Extractor | null | undefined;

function getExtractor(): Extractor | null {
  if (extractor !== undefined) return extractor;
  try {
    if (!config.speakerModel) throw new Error("no speaker model in ~/.jamsesh/models");
    // Inside the Mac app the hub is one compiled program; the native library sits beside it.
    const sherpa = config.nodeModules ? createRequire(join(config.nodeModules, "index.js"))("sherpa-onnx-node") : require("sherpa-onnx-node");
    extractor = new sherpa.SpeakerEmbeddingExtractor({ model: config.speakerModel, numThreads: 2, debug: 0 });
  } catch (e) {
    console.warn("voiceprints off:", e instanceof Error ? e.message : e);
    extractor = null;
  }
  return extractor ?? null;
}

export function voiceprintsAvailable() {
  return getExtractor() !== null;
}

export function embed(pcm: Pcm): Float32Array | null {
  const ex = getExtractor();
  if (!ex || pcm.samples.length < pcm.sampleRate * 0.8) return null;
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

export class Voiceprints {
  private centroids = new Map<string, Float32Array>();
  private counts = new Map<string, number>();

  constructor(private store: Store) {
    this.reload();
  }

  reload() {
    const sums = new Map<string, Float32Array>();
    this.counts.clear();
    for (const { personId, embedding } of this.store.voiceSamples()) {
      const e = normalize(embedding);
      const s = sums.get(personId) ?? new Float32Array(e.length);
      for (let i = 0; i < e.length; i++) s[i] += e[i];
      sums.set(personId, s);
      this.counts.set(personId, (this.counts.get(personId) ?? 0) + 1);
    }
    this.centroids = new Map([...sums].map(([k, v]) => [k, normalize(v)]));
  }

  add(personId: string, e: Float32Array) {
    this.store.addVoiceSample(personId, e);
    this.reload();
  }

  /** Drops the sample that is this embedding (a line first filed under the wrong person). */
  remove(personId: string, e: Float32Array) {
    const mine = this.store.voiceSamples().filter((x) => x.personId === personId);
    const hit = mine.find((x) => cosine(normalize(x.embedding), e) > 0.995);
    if (!hit) return;
    this.store.clearVoiceprint(personId);
    for (const x of mine) if (x !== hit) this.store.addVoiceSample(personId, x.embedding);
    this.reload();
  }

  clear(personId: string) {
    this.store.clearVoiceprint(personId);
    this.reload();
  }

  count(personId: string) {
    return this.counts.get(personId) ?? 0;
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
