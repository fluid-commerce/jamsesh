// Room audio. Every device with its mic on sends speech segments stamped in host
// time. Copies of the same utterance from different devices are grouped by capture
// time, the clearest copy is transcribed once, and the speaker is identified from
// which device heard it loudest plus a voiceprint match.
//
// Network lag: a group waits an adaptive window (each device's recent lag) before it
// is finalized. A copy that arrives later still joins its utterance; if it is clearly
// better, the line is transcribed and attributed again in place.
import { bus } from "../bus";
import { newId } from "../store";
import type { Session } from "../session";
import type { Utterance } from "../types";
import type { Transcriber } from "./transcribe";
import { cosine, embed, Voiceprints } from "./voiceprint";
import { decodeWav, encodeWav, resample, speechLevelDb, type Pcm } from "./wav";

export interface Segment {
  id: string;
  deviceId: string;
  t0: number;
  t1: number;
  levelDb: number;
  noiseDb: number;
  snr: number;
  pcm: Pcm;
  wav: Uint8Array;
  arrivedAt: number;
  embedding?: Float32Array | null;
}

interface Group {
  id: string;
  segments: Segment[];
  t0: number;
  t1: number;
  lastArrival: number;
  timer: ReturnType<typeof setTimeout> | null;
  utteranceId: string | null;
  finalizedWith: string | null;
}

export interface SpeakerGuess {
  personId: string | null;
  confidence: number;
  method: string;
  scores: { personId: string; score: number; voice: number; device: number }[];
}

const MIN_OVERLAP = 0.45;
const BASE_SETTLE_MS = 700;
const MAX_SETTLE_MS = 3500;
const KEEP_FINAL_MS = 15_000;

export class AudioPipeline {
  private open: Group[] = [];
  private finalized: Group[] = [];
  private lag = new Map<string, number>();
  voiceprints: Voiceprints;
  /** Called with each new or updated room line. */
  onLine: ((u: Utterance, isNew: boolean) => void) | null = null;

  constructor(
    private session: Session,
    private transcriber: Transcriber,
  ) {
    this.voiceprints = new Voiceprints(session.store);
  }

  /** Settle window: long enough for the slowest active device's typical lag. */
  settleMs() {
    const lags = [...this.lag.values()];
    const worst = lags.length ? Math.max(...lags) : 0;
    return Math.min(MAX_SETTLE_MS, BASE_SETTLE_MS + worst * 1.25);
  }

  deviceLag(deviceId: string) {
    return this.lag.get(deviceId) ?? 0;
  }

  async ingest(input: { deviceId: string; t0: number; t1: number; wav: Uint8Array; levelDb?: number; noiseDb?: number }): Promise<Segment> {
    const raw = decodeWav(input.wav);
    const pcm = resample(raw, 16000);
    const measured = speechLevelDb(pcm);
    const levelDb = input.levelDb ?? measured.levelDb;
    const noiseDb = input.noiseDb ?? measured.noiseDb;
    const now = Date.now();
    const seg: Segment = {
      id: newId("seg"),
      deviceId: input.deviceId,
      t0: input.t0,
      t1: input.t1,
      levelDb,
      noiseDb,
      snr: levelDb - noiseDb,
      pcm,
      wav: pcm === raw ? input.wav : encodeWav(pcm),
      arrivedAt: now,
    };
    const lag = Math.max(0, now - seg.t1);
    const prev = this.lag.get(seg.deviceId);
    this.lag.set(seg.deviceId, prev == null ? lag : prev * 0.7 + lag * 0.3);
    this.session.touchDevice(seg.deviceId, { level: levelDb });

    // A late copy of an utterance that is already out.
    const done = this.finalized.find((g) => overlaps(g, seg));
    if (done) {
      done.segments.push(seg);
      await this.revisit(done, seg);
      return seg;
    }
    let g = this.open.find((x) => overlaps(x, seg));
    if (!g) {
      g = { id: newId("grp"), segments: [], t0: seg.t0, t1: seg.t1, lastArrival: now, timer: null, utteranceId: null, finalizedWith: null };
      this.open.push(g);
    }
    g.segments.push(seg);
    g.t0 = Math.min(g.t0, seg.t0);
    g.t1 = Math.max(g.t1, seg.t1);
    g.lastArrival = now;
    this.schedule(g);
    return seg;
  }

  private schedule(g: Group) {
    if (g.timer) clearTimeout(g.timer);
    const wait = Math.max(0, g.t1 + this.settleMs() - Date.now());
    g.timer = setTimeout(() => this.finalize(g).catch((e) => console.error("audio:", e)), Math.max(wait, 150));
  }

  /** Waits for every open group to finish (tests). */
  async flush() {
    for (const g of [...this.open]) {
      if (g.timer) clearTimeout(g.timer);
      await this.finalize(g);
    }
  }

  private async finalize(g: Group) {
    this.open = this.open.filter((x) => x !== g);
    g.timer = null;
    for (const part of this.splitCrosstalk(g)) await this.emit(part);
  }

  /** Two people talking over each other: copies whose voices clearly differ become separate lines. */
  private splitCrosstalk(g: Group): Group[] {
    if (g.segments.length < 2) return [g];
    for (const s of g.segments) if (s.embedding === undefined) s.embedding = embed(s.pcm);
    const best = pickBest(g.segments);
    if (!best.embedding) return [g];
    const keep: Segment[] = [];
    const split: Segment[] = [];
    for (const s of g.segments) {
      if (s === best || !s.embedding) keep.push(s);
      else if (cosine(s.embedding, best.embedding) < 0.3 && s.levelDb > best.levelDb - 4) split.push(s);
      else keep.push(s);
    }
    if (!split.length) return [g];
    const mk = (segments: Segment[]): Group => ({
      ...g,
      id: newId("grp"),
      segments,
      t0: Math.min(...segments.map((s) => s.t0)),
      t1: Math.max(...segments.map((s) => s.t1)),
    });
    return [mk(keep), mk(split)];
  }

  private hint() {
    const names = [...this.session.people().map((p) => p.name), ...this.session.agents().map((a) => a.name.split("'")[0])];
    return `JamSesh, FigCraft, canvas, mockup, variant, desktop, mobile. ${[...new Set(names)].join(", ")}.`;
  }

  private async emit(g: Group) {
    const best = pickBest(g.segments);
    const dur = (best.t1 - best.t0) / 1000;
    const { text, engine } = await this.transcriber.transcribe(best.wav, dur, this.hint());
    const guess = this.identify(g.segments, best);
    g.finalizedWith = best.id;
    if (!text) {
      this.keep(g);
      return;
    }
    const person = this.session.person(guess.personId);
    const u: Utterance = {
      id: newId("utt"),
      t0: g.t0,
      t1: g.t1,
      text,
      personId: guess.personId,
      speakerName: person?.name ?? "Someone",
      confidence: guess.confidence,
      method: guess.method,
      deviceId: best.deviceId,
      devices: g.segments.map((s) => ({ deviceId: s.deviceId, level: round(s.levelDb), snr: round(s.snr) })),
      eventId: null,
      engine,
    };
    g.utteranceId = u.id;
    this.autoEnroll(guess, best, g.segments);
    this.session.store.put("utterances", u);
    this.keep(g);
    this.onLine?.(u, true);
    bus.send({ type: "utterance", utterance: u });
  }

  private keep(g: Group) {
    this.finalized.push(g);
    const cutoff = Date.now() - KEEP_FINAL_MS;
    this.finalized = this.finalized.filter((x) => x.lastArrival > cutoff || x === g);
  }

  /** A late copy arrived. Re-run identification, and transcription if this copy is clearly better. */
  private async revisit(g: Group, late: Segment) {
    const u = g.utteranceId ? this.session.store.get("utterances", g.utteranceId) : undefined;
    const current = g.segments.find((s) => s.id === g.finalizedWith);
    const best = pickBest(g.segments);
    if (!u) {
      if (!current || best !== current) {
        // The first copy had no words in it; try the better one.
        this.finalized = this.finalized.filter((x) => x !== g);
        await this.emit(g);
      }
      return;
    }
    const guess = this.identify(g.segments, best);
    let text = u.text;
    let engine = u.engine;
    if (best === late && current && late.snr > current.snr + 6) {
      const r = await this.transcriber.transcribe(late.wav, (late.t1 - late.t0) / 1000, this.hint());
      if (r.text) ((text = r.text), (engine = r.engine));
      g.finalizedWith = late.id;
    }
    const manual = u.method === "manual";
    const person = manual ? this.session.person(u.personId) : this.session.person(guess.personId);
    const next: Utterance = {
      ...u,
      text,
      engine,
      personId: manual ? u.personId : guess.personId,
      speakerName: person?.name ?? "Someone",
      confidence: manual ? 1 : guess.confidence,
      method: manual ? "manual" : guess.method + "+late",
      deviceId: best.deviceId,
      devices: g.segments.map((s) => ({ deviceId: s.deviceId, level: round(s.levelDb), snr: round(s.snr) })),
    };
    if (next.text !== u.text || next.personId !== u.personId || next.devices.length !== u.devices.length) {
      this.session.store.put("utterances", next);
      this.onLine?.(next, false);
      bus.send({ type: "utterance", utterance: next });
    }
  }

  /**
   * Who spoke. Two signals:
   * - device: the loudest device's owner, weighted by how much louder it was than the next one;
   * - voice: similarity of the cleanest copy to each enrolled voiceprint.
   * A confident voice match outweighs the device, so someone who walks to another
   * laptop is still recognized.
   */
  identify(segments: Segment[], best = pickBest(segments)): SpeakerGuess {
    const s = this.session;
    const byLevel = [...segments].sort((a, b) => b.levelDb - a.levelDb);
    const loud = byLevel[0];
    const margin = byLevel.length > 1 ? loud.levelDb - byLevel[1].levelDb : 6;
    const deviceScores = new Map<string, number>();
    for (const seg of byLevel) {
      const owner = s.store.get("devices", seg.deviceId)?.personId;
      if (!owner || deviceScores.has(owner)) continue;
      const rel = seg === loud ? 0.55 + Math.min(Math.max(margin, 0), 12) / 26 : Math.max(0, 0.35 - (loud.levelDb - seg.levelDb) / 30);
      deviceScores.set(owner, rel);
    }
    if (best.embedding === undefined) best.embedding = embed(best.pcm);
    const voice = new Map<string, number>();
    if (best.embedding && this.voiceprints.enrolled) {
      for (const m of this.voiceprints.match(best.embedding)) voice.set(m.personId, Math.min(1, Math.max(0, (m.similarity - 0.3) / 0.4)));
    }
    const candidates = new Set([...deviceScores.keys(), ...voice.keys()]);
    const scores = [...candidates].map((personId) => {
      const v = voice.get(personId);
      const d = deviceScores.get(personId) ?? 0;
      const wVoice = v === undefined ? 0 : Math.min(0.75, 0.45 + 0.05 * this.voiceprints.count(personId));
      const score = v === undefined ? d * 0.85 : wVoice * v + (1 - wVoice) * d;
      return { personId, score, voice: v ?? -1, device: d };
    });
    scores.sort((a, b) => b.score - a.score);
    const top = scores[0];
    if (!top || top.score < 0.3) return { personId: null, confidence: top?.score ?? 0, method: "unknown", scores };
    const runnerUp = scores[1]?.score ?? 0;
    const confidence = Math.min(1, top.score * (0.7 + Math.min(0.3, top.score - runnerUp)));
    const method = top.voice >= 0 && top.device > 0 ? "voice+device" : top.voice >= 0 ? "voice" : "device";
    return { personId: top.personId, confidence, method, scores };
  }

  /** A confident line from someone at their own device teaches the voiceprint. */
  private autoEnroll(guess: SpeakerGuess, best: Segment, segments: Segment[]) {
    if (!guess.personId || guess.confidence < 0.72 || !best.embedding) return;
    const top = guess.scores[0];
    const owner = this.session.store.get("devices", best.deviceId)?.personId;
    const byLevel = [...segments].sort((a, b) => b.levelDb - a.levelDb);
    const margin = byLevel.length > 1 ? byLevel[0].levelDb - byLevel[1].levelDb : 99;
    const atOwnDevice = owner === guess.personId && byLevel[0].deviceId === best.deviceId && margin >= 6;
    const voiceAgrees = top.voice < 0 || top.voice >= 0.55;
    if (atOwnDevice && voiceAgrees && this.voiceprints.count(guess.personId) < 25 && best.snr > 12) {
      this.voiceprints.add(guess.personId, best.embedding);
    }
  }

  /** Someone says who said a line. The line's voice joins that person's voiceprint. */
  assign(utteranceId: string, personId: string) {
    const u = this.session.store.get("utterances", utteranceId);
    const person = this.session.person(personId);
    if (!u || !person) throw new Error("Unknown line or person");
    const g = this.finalized.find((x) => x.utteranceId === utteranceId);
    const best = g ? pickBest(g.segments) : null;
    if (best) {
      if (best.embedding === undefined) best.embedding = embed(best.pcm);
      if (best.embedding) this.voiceprints.add(personId, best.embedding);
    } else if (u.eventId) {
      const stored = this.session.store.event(u.eventId)?.data.embedding as number[] | undefined;
      if (stored) this.voiceprints.add(personId, new Float32Array(stored));
    }
    const next: Utterance = { ...u, personId, speakerName: person.name, confidence: 1, method: "manual" };
    this.session.store.put("utterances", next);
    this.onLine?.(next, false);
    bus.send({ type: "utterance", utterance: next });
    return next;
  }

  /** The embedding of an utterance's best copy, kept with its event so labels work after restarts. */
  embeddingFor(utteranceId: string): number[] | null {
    const g = [...this.finalized, ...this.open].find((x) => x.utteranceId === utteranceId);
    if (!g) return null;
    const best = pickBest(g.segments);
    if (best.embedding === undefined) best.embedding = embed(best.pcm);
    return best.embedding ? [...best.embedding] : null;
  }
}

function overlaps(g: { t0: number; t1: number }, s: { t0: number; t1: number }) {
  const ov = Math.min(g.t1, s.t1) - Math.max(g.t0, s.t0);
  const shorter = Math.min(g.t1 - g.t0, s.t1 - s.t0);
  return shorter > 0 && ov / shorter >= MIN_OVERLAP;
}

/** The clearest copy: signal-to-noise first, then loudness. */
export function pickBest(segments: Segment[]): Segment {
  return [...segments].sort((a, b) => b.snr * 0.7 + b.levelDb * 0.3 - (a.snr * 0.7 + a.levelDb * 0.3))[0];
}

const round = (n: number) => Math.round(n * 10) / 10;
