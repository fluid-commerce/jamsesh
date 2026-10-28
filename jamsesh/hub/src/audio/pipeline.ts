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
import { clippedShare, decodeWav, encodeWav, resample, speechLevelDb, type Pcm } from "./wav";

export interface Segment {
  id: string;
  deviceId: string;
  t0: number;
  t1: number;
  levelDb: number;
  noiseDb: number;
  snr: number;
  /** Share of the segment that is near its loudest: low for clicks and knocks. */
  active: number;
  /** Share of samples at full scale. */
  clipped: number;
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
  /** Set while the group is being transcribed, so a copy arriving now still joins it. */
  busy: Promise<void> | null;
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
const CLEAN_SNR = 12;
/** Below these a segment is silence or steady noise, not a voice. */
const MIN_SPEECH_DB = -62;
const MIN_SPEECH_SNR = 4;
const MIN_ACTIVE = 0.3;
/** Every frame near the peak and barely above the floor: a hum or rumble, not words. */
const STEADY_ACTIVE = 0.9;
const STEADY_SNR = 8;
const MAX_PRINT_SAMPLES = 40;
/** A copy with more than this share of clipped samples does not teach a voiceprint. */
const MAX_CLIPPED = 0.005;
/** How far a copy's span may slide before it is another utterance. */
const SPLIT_SPAN_MS = 1000;
/** Softmax temperature over voiceprint similarities (cosine units). */
const VOICE_TEMP = 0.05;

export class AudioPipeline {
  private open: Group[] = [];
  private finalized: Group[] = [];
  private lag = new Map<string, number>();
  /** Unconfirmed first voice samples per person (see autoEnroll). */
  private candidates = new Map<string, Float32Array[][]>();
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

  /** Utterances still waiting out their settle window or being transcribed. */
  get pending() {
    return this.open.length + this.finalized.filter((g) => g.busy).length;
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
      active: measured.active,
      clipped: clippedShare(pcm),
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
      done.lastArrival = now;
      if (done.busy) await done.busy;
      await this.revisit(done, seg);
      return seg;
    }
    let g = this.open.find((x) => overlaps(x, seg));
    if (!g) {
      g = { id: newId("grp"), segments: [], t0: seg.t0, t1: seg.t1, lastArrival: now, timer: null, utteranceId: null, finalizedWith: null, busy: null };
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
    const groups = [...this.open];
    // Stop every timer first: one that fires while an earlier group is transcribing
    // would finalize its group a second time.
    for (const g of groups) {
      if (g.timer) clearTimeout(g.timer);
      g.timer = null;
    }
    for (const g of groups) if (this.open.includes(g)) await this.finalize(g);
  }

  private async finalize(g: Group) {
    this.open = this.open.filter((x) => x !== g);
    g.timer = null;
    const parts = this.splitCrosstalk(g);
    // Visible to late copies from now on, including while whisper is still working.
    for (const part of parts) this.keep(part);
    for (const part of parts) {
      part.busy = this.emit(part).finally(() => (part.busy = null));
      await part.busy;
    }
  }

  /**
   * Two people talking over each other. Every device hears one utterance start and end
   * together, so a clean copy whose span is shifted a second or more against the best
   * copy's is someone else speaking, however its voice embeds (the two voices bleed into
   * each other's laptops, so embeddings of the copies are alike).
   */
  private splitCrosstalk(g: Group): Group[] {
    if (g.segments.length < 2) return [g];
    const out: Group[] = [];
    let rest = g.segments;
    while (rest.length) {
      const best = pickBest(rest);
      const keep = rest.filter((s) => s === best || !(shifted(best, s) && s.snr >= CLEAN_SNR));
      const split = rest.filter((s) => !keep.includes(s));
      out.push(keep.length === g.segments.length ? g : this.regroup(g, keep));
      rest = split;
    }
    return out;
  }

  private regroup(g: Group, segments: Segment[]): Group {
    return { ...g, id: newId("grp"), busy: null, utteranceId: null, finalizedWith: null, segments, t0: Math.min(...segments.map((s) => s.t0)), t1: Math.max(...segments.map((s) => s.t1)) };
  }

  private hint() {
    const names = [...this.session.people().map((p) => p.name), ...this.session.agents().map((a) => a.name.split("'")[0])];
    return `JamSesh, FigCraft, canvas, mockup, variant, desktop, mobile. ${[...new Set(names)].join(", ")}.`;
  }

  private async emit(g: Group) {
    const best = pickBest(g.segments);
    const dur = (best.t1 - best.t0) / 1000;
    // Nothing to transcribe in near-silence, steady noise (no pauses against a floor) or
    // a few knocks and clicks.
    if (best.levelDb < MIN_SPEECH_DB || best.snr < MIN_SPEECH_SNR || best.active < MIN_ACTIVE || (best.active > STEADY_ACTIVE && best.snr < STEADY_SNR)) {
      g.finalizedWith = best.id;
      return;
    }
    const { text, engine } = await this.transcriber.transcribe(best.wav, dur, this.hint(), best.snr);
    const guess = this.identify(g.segments, best);
    g.finalizedWith = best.id;
    if (!text) return;
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
        g.busy = this.emit(g).finally(() => (g.busy = null));
        await g.busy;
      }
      return;
    }
    const guess = this.identify(g.segments, best);
    let text = u.text;
    let engine = u.engine;
    if (best === late && current && late.snr > current.snr + 6) {
      const r = await this.transcriber.transcribe(late.wav, (late.t1 - late.t0) / 1000, this.hint(), late.snr);
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
    const byLevel = [...segments].sort((a, b) => speechDb(b) - speechDb(a));
    const loud = byLevel[0];
    const margin = byLevel.length > 1 ? speechDb(loud) - speechDb(byLevel[1]) : 6;
    const deviceScores = new Map<string, number>();
    for (const seg of byLevel) {
      const owner = s.store.get("devices", seg.deviceId)?.personId;
      if (!owner || deviceScores.has(owner)) continue;
      const rel = seg === loud ? 0.55 + Math.min(Math.max(margin, 0), 12) / 26 : Math.max(0, 0.35 - (speechDb(loud) - speechDb(seg)) / 30);
      deviceScores.set(owner, rel);
    }
    if (best.embedding === undefined) best.embedding = embed(best.pcm);
    const voice = new Map<string, number>();
    if (best.embedding && this.voiceprints.enrolled) {
      const m = this.voiceprints.match(best.embedding);
      const topSim = m[0].similarity;
      if (m.length === 1) voice.set(m[0].personId, clamp((topSim - 0.35) / 0.35));
      else {
        // Closed-set: who of the enrolled people does it sound most like? Absolute
        // similarity drifts with mic and noise (every print "matches" a reverberant
        // room), so compare people with each other, and trust the result only as far as
        // someone sounds like the voice at all.
        const w = m.map((x) => Math.exp((x.similarity - topSim) / VOICE_TEMP));
        const sum = w.reduce((a, b) => a + b, 0);
        const informative = clamp((topSim - 0.35) / 0.2);
        m.forEach((x, i) => voice.set(x.personId, (informative * w[i]) / sum));
      }
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

  /**
   * A confident line from someone at their own device teaches the voiceprint, with
   * every clear copy of it: the same voice heard through the other laptops and the room
   * mic is what a later walk-away or host-only line will sound like, and a print made
   * of one device's channel alone matches that channel more than the person.
   * The very first samples are held back until two lines from that device sound alike:
   * one line from a visitor at someone's laptop must not become that owner's voice.
   */
  private autoEnroll(guess: SpeakerGuess, best: Segment, segments: Segment[]) {
    if (!guess.personId || !best.embedding) return;
    const pid = guess.personId;
    const enrolled = this.voiceprints.count(pid);
    const top = guess.scores[0];
    const owner = this.session.store.get("devices", best.deviceId)?.personId;
    const byLevel = [...segments].sort((a, b) => speechDb(b) - speechDb(a));
    const margin = byLevel.length > 1 ? speechDb(byLevel[0]) - speechDb(byLevel[1]) : 99;
    const atOwnDevice = owner === pid && byLevel[0].deviceId === best.deviceId;
    if (!atOwnDevice || best.snr <= CLEAN_SNR || best.clipped > MAX_CLIPPED || enrolled >= MAX_PRINT_SAMPLES) return;
    const voices = [best.embedding];
    for (const s of segments) {
      if (s === best || s.snr < 10 || s.clipped > MAX_CLIPPED) continue;
      if (s.embedding === undefined) s.embedding = embed(s.pcm);
      // Skip copies that carry someone else's voice (cross-talk bleed).
      if (s.embedding && cosine(s.embedding, best.embedding) >= 0.35) voices.push(s.embedding);
    }
    if (enrolled > 0) {
      // Either the device is clearly the loudest, or it is a bit closer than the rest and
      // the voice says the same: two weak signals that agree are enough to learn from.
      const sure = guess.confidence >= 0.72 && margin >= 6 && (top.voice < 0 || top.voice >= 0.5);
      const agreed = guess.confidence >= 0.55 && margin >= 3 && top.voice >= 0.6;
      if (sure || agreed) for (const v of voices) this.voiceprints.add(pid, v);
      return;
    }
    if (guess.confidence < 0.5 || margin < 3) return;
    const held = this.candidates.get(pid) ?? [];
    const twin = held.find((c) => cosine(c[0], best.embedding!) >= 0.4);
    if (twin) {
      for (const v of [...twin, ...voices]) this.voiceprints.add(pid, v);
      this.candidates.delete(pid);
    } else {
      this.candidates.set(pid, [...held, voices].slice(-4));
    }
  }

  /** Someone says who said a line. The line's voice joins that person's voiceprint. */
  assign(utteranceId: string, personId: string) {
    const u = this.session.store.get("utterances", utteranceId);
    const person = this.session.person(personId);
    if (!u || !person) throw new Error("Unknown line or person");
    const g = this.finalized.find((x) => x.utteranceId === utteranceId);
    // Teach from the clearest copy that did not clip.
    const usable = g?.segments.filter((s) => s.clipped <= MAX_CLIPPED) ?? [];
    const best = g ? (usable.length ? pickBest(usable) : null) : null;
    if (best) {
      if (best.embedding === undefined) best.embedding = embed(best.pcm);
      if (best.embedding) this.voiceprints.add(personId, best.embedding);
    } else if (!g && u.eventId) {
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

function overlaps(g: Group, s: { t0: number; t1: number }) {
  return g.segments.some((m) => sameUtterance(m, s));
}

/** Copies of one utterance overlap heavily and are not slid along the timeline. */
function sameUtterance(a: { t0: number; t1: number }, b: { t0: number; t1: number }) {
  const ov = Math.min(a.t1, b.t1) - Math.max(a.t0, b.t0);
  const shorter = Math.min(a.t1 - a.t0, b.t1 - b.t0);
  return shorter > 0 && ov / shorter >= MIN_OVERLAP && !shifted(a, b);
}

/** Both ends moved the same way by a second or more: a different utterance, not a trimmed copy. */
function shifted(a: { t0: number; t1: number }, b: { t0: number; t1: number }) {
  const d0 = b.t0 - a.t0;
  const d1 = b.t1 - a.t1;
  return Math.abs(d0) >= SPLIT_SPAN_MS && Math.abs(d1) >= SPLIT_SPAN_MS && Math.sign(d0) === Math.sign(d1);
}

/**
 * How loud the voice itself was at a device: the measured level with the noise floor's
 * power taken out. A device in a noisy corner hears a loud room, not a loud speaker.
 */
function speechDb(s: Segment) {
  const p = 10 ** (s.levelDb / 10) - 10 ** (s.noiseDb / 10);
  return Math.max(s.levelDb - 10, 10 * Math.log10(Math.max(p, 1e-12)));
}

/** The clearest copy: signal-to-noise first, then loudness. */
export function pickBest(segments: Segment[]): Segment {
  return [...segments].sort((a, b) => b.snr * 0.7 + b.levelDb * 0.3 - (a.snr * 0.7 + a.levelDb * 0.3))[0];
}

const round = (n: number) => Math.round(n * 10) / 10;
const clamp = (n: number) => Math.min(1, Math.max(0, n));
