// Room audio. Every device with its mic on sends speech segments stamped in host
// time. Copies of the same utterance from different devices are grouped by capture
// time, the clearest copy is transcribed once, and the speaker is identified from
// which device heard it loudest plus a voiceprint match.
//
// Network lag: a group waits an adaptive window (each device's recent lag) before it
// is finalized. A copy that arrives later still joins its utterance; if it is clearly
// better, the line is transcribed and attributed again in place.
import { brainNames } from "../names";
import { bus } from "../bus";
import { newId } from "../store";
import type { Session } from "../session";
import type { Utterance } from "../types";
import type { Transcriber } from "./transcribe";
import { ENROL_GRACE_MS, ENROL_WINDOW_MS, scriptShare } from "./enrol";
import { cosine, embed, MIN_VOICE_SECONDS, normalize, voiceprintStatus, Voiceprints, type Learning } from "./voiceprint";
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
  /** When it was heard, on this host's clock: its synced start, or its arrival if that's earlier. */
  heardAt: number;
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
  /** Copies from the room and from remote laptops never group: they are different rooms. */
  location: "room" | "remote";
  /** Its speaker's voice was reset since: nothing is learned from it. */
  forgotten?: boolean;
}

/** A voice sample and when it was heard. */
type Heard = { e: Float32Array; at: number };

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
/** Settle when no other microphone could have heard it: nothing to wait for. */
const SOLO_SETTLE_MS = 250;
/** A device that has not sent speech for this long no longer sets the settle window. */
const LAG_TTL_MS = 90_000;
/** Copies this late came out of an offline buffer; their lag says nothing about the network. */
const LAG_OUTLIER_MS = 10_000;
const CLEAN_SNR = 12;
/** Below these a segment is silence or steady noise, not a voice. */
const MIN_SPEECH_DB = -62;
/** A noise floor below this is a muted or paused mic, not a room. */
const BROKEN_FLOOR_DB = -85;
/** Loud enough to be someone speaking whatever the floor says. */
const LOUD_DB = -42;
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
/** Copies of one line, as clocks and microphones see it, start within this of each other. */
const TWIN_MS = 3000;
/** Copies of one voice on two microphones compare at 0.7 to 0.9; two voices saying the same words, about 0.4 to 0.55. */
const SAME_VOICE = 0.6;
/** Two microphones hearing one sound give loudness contours that match this well (gain and room shift them, not reshape them). */
const SAME_SOUND = 0.8;
/** And their waveforms line up at one offset: the phase-only cross-correlation peaks this many deviations above the rest. */
const COHERENT = 10;
/** How long a line's sound is kept (8 kHz, 16-bit), so a copy flushed late can still be checked against it. */
const KEEP_SOUND_MS = 5 * 60_000;
const KEEP_SOUNDS = 300;
/** An unnamed line is the corrected voice's when it sounds this much like it, among the last few dozen. */
const RELABEL_SIM = 0.75;
const RELABEL_LOOKBACK = 60;
/** Softmax temperature over voiceprint similarities (cosine units). */
const VOICE_TEMP = 0.05;
/** A voice match this clear, with no close second, may teach the voiceprint at a shared laptop. */
const DECISIVE_VOICE = 0.75;

export class AudioPipeline {
  private open: Group[] = [];
  private finalized: Group[] = [];
  private lag = new Map<string, { ms: number; at: number; location: "room" | "remote" }>();
  /** Each recent line's sound (its best copy, 8 kHz), the acoustic evidence mergeTwin needs. */
  private sounds = new Map<string, { pcm: Float32Array; at: number }>();
  /** Unconfirmed first voice samples per person (see autoEnroll). */
  private candidates = new Map<string, Heard[][]>();
  voiceprints: Voiceprints;
  /** People reading the join sentence right now: what the room's laptops hear of it is not conversation. */
  private enrolling = new Map<string, { since: number; until: number }>();
  /** How lines have been labelled since the host started (a host that never uses the voice should say so). */
  stats = { lines: 0, voice: 0, someone: 0 };
  /** Called with each new or updated room line. */
  onLine: ((u: Utterance, isNew: boolean) => void) | null = null;

  constructor(
    private session: Session,
    private transcriber: Transcriber,
  ) {
    this.voiceprints = new Voiceprints(session.store);
  }

  /**
   * Settle window: long enough for the slowest active device in that location (room and
   * remote laptops are different rooms), and almost none when it is the only microphone
   * that could have heard the line.
   */
  settleMs(location: "room" | "remote" = "room") {
    // Remote segments are only grouped within one device, so there is never another copy to wait for.
    if (location === "remote") return SOLO_SETTLE_MS;
    const now = Date.now();
    const live = [...this.lag.entries()].filter(([, l]) => l.location === location && now - l.at < LAG_TTL_MS);
    const listening = new Set(live.map(([id]) => id));
    for (const d of this.session.store.all("devices")) if (d.micOn && (d.location ?? "room") === location && now - d.lastSeen < LAG_TTL_MS) listening.add(d.id);
    if (listening.size <= 1) return SOLO_SETTLE_MS;
    const worst = live.length ? Math.max(...live.map(([, l]) => l.ms)) : 0;
    return Math.min(MAX_SETTLE_MS, BASE_SETTLE_MS + worst * 1.25);
  }

  /** Utterances still waiting out their settle window or being transcribed. */
  get pending() {
    return this.open.length + this.finalized.filter((g) => g.busy).length;
  }

  /** Same, for lines this device heard (a record-to-prompt window waits on these). */
  pendingFor(deviceId: string) {
    return this.open.filter((g) => g.segments.some((s) => s.deviceId === deviceId)).length + this.finalized.filter((g) => g.busy && g.segments.some((s) => s.deviceId === deviceId)).length;
  }

  deviceLag(deviceId: string) {
    return this.lag.get(deviceId)?.ms ?? 0;
  }

  async ingest(input: { deviceId: string; t0: number; t1: number; wav: Uint8Array }): Promise<Segment> {
    const raw = decodeWav(input.wav);
    const pcm = resample(raw, 16000);
    const measured = speechLevelDb(pcm);
    // What the decoded audio measures, never what the sender says: levels pick the copy and label the speaker.
    const { levelDb, noiseDb } = measured;
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
      heardAt: Number.isFinite(input.t0) ? Math.min(now, input.t0) : now,
    };
    const location = this.session.store.get("devices", seg.deviceId)?.location ?? "room";
    const lag = Math.max(0, now - seg.t1);
    const prev = this.lag.get(seg.deviceId);
    // A buffered segment flushed after a reconnect would pin the average high for minutes.
    if (lag <= LAG_OUTLIER_MS) this.lag.set(seg.deviceId, { ms: prev == null ? lag : prev.ms * 0.7 + lag * 0.3, at: now, location });
    else if (prev) this.lag.set(seg.deviceId, { ...prev, at: now, location });
    this.session.touchDevice(seg.deviceId, { level: levelDb });

    const near = (g: Group) => g.location === location && (location === "room" || g.segments.some((x) => x.deviceId === seg.deviceId));
    // A late copy of an utterance that is already out.
    const done = this.finalized.find((g) => near(g) && overlaps(g, seg));
    if (done) {
      done.segments.push(seg);
      done.lastArrival = now;
      if (done.busy) await done.busy;
      await this.revisit(done, seg);
      return seg;
    }
    // A copy so late its group is gone (an offline buffer flushed) is transcribed like any other: lining
    // up in time with a line already shown isn't enough to drop it (someone else may have spoken then).
    // mergeTwin drops it only when its words are that line's, from other laptops.
    let g = this.open.find((x) => near(x) && overlaps(x, seg));
    if (!g) {
      g = { id: newId("grp"), segments: [], t0: seg.t0, t1: seg.t1, lastArrival: now, timer: null, utteranceId: null, finalizedWith: null, busy: null, location };
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
    const wait = Math.max(0, g.t1 + this.settleMs(g.location) - Date.now());
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

  /**
   * What whisper is primed with: only the brain's name, so it's spelled right when said. Whisper
   * repeats its hint on near-silence, so people's names stay out of it ("Chey, Pat." from nobody).
   */
  private hint() {
    const named = brainNames(this.session.settings()).filter((n) => n !== "JamSesh");
    return named.length ? `${named.join(", ")}, JamSesh.` : "JamSesh.";
  }

  /** Everyone's names, so a line made of nothing but names is recognized as whisper's invention. */
  private names() {
    return [...this.session.people().map((p) => p.name), ...this.session.agents().map((a) => a.name.split("'")[0])];
  }

  private async emit(g: Group) {
    const best = pickBest(g.segments);
    const dur = (best.t1 - best.t0) / 1000;
    // Nothing to transcribe in near-silence, steady noise (no pauses against a floor) or
    // a few knocks and clicks.
    // A noise floor near digital silence (a muted or paused mic) makes any room tone look like a
    // clear voice; then only a plainly loud segment counts.
    // pickBest prefers copies that pass this gate, so a rejected best means every copy fails it.
    if (!speechLike(best)) {
      g.finalizedWith = best.id;
      return;
    }
    const { text, engine } = await this.transcriber.transcribe(best.wav, dur, this.hint(), trustedSnr(best), this.names());
    const guess = this.identify(g.segments, best);
    g.finalizedWith = best.id;
    if (!text) return;
    // Someone reading the join sentence: every laptop hears it, and none of it belongs in the transcript.
    if (this.isCalibration(text, g)) return;
    if (await this.mergeTwin(g, text, best)) return;
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
      location: g.location,
      eventId: null,
      engine,
    };
    // Hybrid sessions: the room's speakers play remote voices (and remote laptops hear the
    // room through the call). The same words heard in the other location are an echo.
    const echo = this.echoOf(u, best.snr);
    if (echo === "drop") return;
    g.utteranceId = u.id;
    this.stats.lines++;
    if (guess.method.startsWith("voice")) this.stats.voice++;
    if (!guess.personId) this.stats.someone++;
    this.autoEnroll(guess, best, g.segments);
    this.keepSound(u.id, best);
    this.session.store.put("utterances", u);
    this.onLine?.(u, true);
    bus.send({ type: "utterance", utterance: u });
  }

  /** A person starts reading the join sentence. */
  beginEnrolment(personId: string) {
    const now = Date.now();
    this.enrolling.set(personId, { since: now - 1000, until: now + ENROL_WINDOW_MS });
  }

  /** The read never happened (the microphone didn't start): nothing is held out. */
  cancelEnrolment(personId: string) {
    this.enrolling.delete(personId);
  }

  /** The read is over; copies still on their way from slow laptops are held out for a little longer. */
  endEnrolment(personId: string) {
    const w = this.enrolling.get(personId);
    if (w) w.until = Date.now() + ENROL_GRACE_MS;
  }

  /**
   * A copy of the read: it arrived while that person reads, follows the script's wording, and the
   * reader's own laptop heard it loudest. Anyone else talking then, on any laptop, is still heard.
   */
  private isCalibration(text: string, g: Group) {
    const now = Date.now();
    const loudest = [...g.segments].sort((a, b) => speechDb(b) - speechDb(a))[0];
    const owner = loudest && this.session.store.get("devices", loudest.deviceId)?.personId;
    for (const [id, w] of this.enrolling) {
      if (now > w.until + 60_000) this.enrolling.delete(id);
      // The line's own clock can be seconds off, so the window is judged by when it arrived.
      else if (owner === id && g.lastArrival >= w.since && g.lastArrival <= w.until && scriptShare(text) >= 0.6) return true;
    }
    return false;
  }


  /**
   * The same words heard a moment apart in the same place by other laptops are one line, whatever the
   * copies' clocks said (a laptop a second off, a copy that arrived late). The new copies join the line
   * already shown, which is then labelled from every copy. The evidence has to be positive:
   * - only other devices' copies (a microphone that already gave the line, hearing the same words
   *   again, is someone saying them again), within a few seconds;
   * - the sound is the same sound: the two recordings' loudness contours line up (sameSound). Words
   *   and voice say who and what; only this says it was one moment of speech and not the same person
   *   saying it again, or saying a little more. A line whose contour isn't kept is never merged;
   * - the voices agree (both copies embedded, alike); when either can't be embedded (voice matching
   *   off, a line under 0.8 seconds such as "Looks good"), the words must be exactly the same.
   */
  private async mergeTwin(g: Group, text: string, best: Segment): Promise<boolean> {
    const mine = new Set(g.segments.map((s) => s.deviceId));
    const same = (a: string) => plainText(a) === plainText(text) && plainText(text) !== "";
    const twin = this.session.store
      .all("utterances")
      .filter(
        (x) =>
          x.location === g.location &&
          x.id !== g.utteranceId &&
          Math.abs(x.t0 - g.t0) < TWIN_MS &&
          Math.abs(x.t1 - g.t1) < TWIN_MS + 1500 &&
          !x.devices.some((d) => mine.has(d.deviceId)) &&
          (same(x.text) || sameWords(x.text, text, this.spokenMs(x), best.pcm.samples.length / 16)),
      )
      .sort((a, b) => Math.abs(a.t0 - g.t0) - Math.abs(b.t0 - g.t0))[0];
    if (!twin) return false;
    const heard = this.sounds.get(twin.id);
    if (!heard || !sameSound(narrow(best.pcm), heard.pcm)) return false;
    const theirs = this.voiceOf(twin).embedding;
    if (best.embedding && theirs) {
      if (cosine(best.embedding, theirs) < SAME_VOICE) return false;
    } else if (!same(twin.text)) return false;
    const home = this.finalized.find((x) => x.utteranceId === twin.id);
    // Its group is gone (a copy flushed late): the sound and the words said it's that line, so it isn't shown twice.
    if (!home) return true;
    this.finalized = this.finalized.filter((x) => x !== g);
    home.segments.push(...g.segments);
    home.t0 = Math.min(home.t0, g.t0);
    home.t1 = Math.max(home.t1, g.t1);
    home.lastArrival = Date.now();
    if (home.busy) await home.busy;
    await this.revisit(home, g.segments[0]);
    return true;
  }

  /** How long the line was spoken: its best copy's audio when that is still held (the line's own span includes laptop clock skew). */
  private spokenMs(u: Utterance) {
    const home = this.finalized.find((x) => x.utteranceId === u.id);
    return home?.segments.length ? pickBest(home.segments).pcm.samples.length / 16 : u.t1 - u.t0;
  }

  /** "drop" when this line is an echo of a clearer copy heard in the other location. */
  private echoOf(u: Utterance, snr: number): "drop" | "keep" {
    const recent = this.session.store
      .all("utterances")
      .filter((x) => x.location && x.location !== u.location && Math.abs(x.t0 - u.t0) < 3000 && Math.abs(x.t1 - u.t1) < 3500);
    for (const other of recent) {
      if (textSimilarity(other.text, u.text) < 0.55) continue;
      const otherSnr = Math.max(...other.devices.map((d) => d.snr));
      if (otherSnr >= snr - 6) return "drop";
      // This copy is much clearer: the earlier one was the echo.
      if (other.eventId) this.session.store.updateEvent(other.eventId, { relevance: "chatter", data: { echo: true } });
    }
    return "keep";
  }

  private keepSound(utteranceId: string, best: Segment) {
    const now = Date.now();
    for (const [id, x] of this.sounds) if (now - x.at > KEEP_SOUND_MS || this.sounds.size >= KEEP_SOUNDS) this.sounds.delete(id);
    this.sounds.set(utteranceId, { pcm: narrow(best.pcm), at: now });
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
      const r = await this.transcriber.transcribe(late.wav, (late.t1 - late.t0) / 1000, this.hint(), trustedSnr(late), this.names());
      if (r.text) ((text = r.text), (engine = r.engine));
      g.finalizedWith = late.id;
    }
    // Read the line again after the wait: someone may have corrected the speaker meanwhile, and a
    // correction always wins over a late copy.
    const fresh = this.session.store.get("utterances", u.id) ?? u;
    const manual = fresh.method === "manual";
    const person = manual ? this.session.person(fresh.personId) : this.session.person(guess.personId);
    const next: Utterance = {
      ...fresh,
      text,
      engine,
      personId: manual ? fresh.personId : guess.personId,
      speakerName: person?.name ?? "Someone",
      confidence: manual ? 1 : guess.confidence,
      method: manual ? "manual" : guess.method + "+late",
      deviceId: best.deviceId,
      devices: g.segments.map((s) => ({ deviceId: s.deviceId, level: round(s.levelDb), snr: round(s.snr) })),
    };
    if (next.text !== fresh.text || next.personId !== fresh.personId || next.devices.length !== fresh.devices.length) {
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
    const voiceTop = [...voice.values()].sort((a, b) => b - a);
    const scores = [...candidates].map((personId) => {
      const v = voice.get(personId);
      const d = deviceScores.get(personId) ?? 0;
      // A voice that clearly stands out from every other enrolled voice counts for more even
      // when it has few samples: it is how someone who walked to another laptop is still found.
      const standout = v !== undefined && v === voiceTop[0] && voiceTop.length > 1 ? clamp((v - voiceTop[1]) / 0.5) * 0.12 : 0;
      const wVoice = v === undefined ? 0 : Math.min(0.75, 0.45 + 0.05 * this.voiceprints.count(personId) + standout);
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
    const autos = this.voiceprints.learnedFrom(pid).auto;
    const top = guess.scores[0];
    const owner = this.session.store.get("devices", best.deviceId)?.personId;
    const byLevel = [...segments].sort((a, b) => speechDb(b) - speechDb(a));
    const margin = byLevel.length > 1 ? speechDb(byLevel[0]) - speechDb(byLevel[1]) : 99;
    const atOwnDevice = owner === pid && byLevel[0].deviceId === best.deviceId;
    // Someone with a voiceprint, recognised beyond doubt at a shared laptop (nobody's) or their own, teaches it
    // that channel too; at someone else's laptop it could be a visitor, so it waits for the owner's own lines.
    const runnerVoice = guess.scores.filter((x) => x.personId !== pid).reduce((m, x) => Math.max(m, x.voice), 0);
    const decisive = enrolled > 0 && !owner && top.personId === pid && top.voice >= DECISIVE_VOICE && runnerVoice <= 0.2 && margin >= 3;
    if (!(atOwnDevice || decisive) || best.snr <= CLEAN_SNR || best.clipped > MAX_CLIPPED || autos >= MAX_PRINT_SAMPLES) return;
    const voices: Heard[] = [{ e: best.embedding, at: best.heardAt }];
    for (const s of segments) {
      if (s === best || s.snr < 10 || s.clipped > MAX_CLIPPED) continue;
      if (s.embedding === undefined) s.embedding = embed(s.pcm);
      // Skip copies that carry someone else's voice (cross-talk bleed).
      if (s.embedding && cosine(s.embedding, best.embedding) >= 0.35) voices.push({ e: s.embedding, at: s.heardAt });
    }
    if (enrolled > 0) {
      // Either the device is clearly the loudest, or it is a bit closer than the rest and
      // the voice says the same: two weak signals that agree are enough to learn from.
      const sure = decisive || (guess.confidence >= 0.72 && margin >= 6 && (top.voice < 0 || top.voice >= 0.5));
      const agreed = guess.confidence >= 0.55 && margin >= 3 && top.voice >= 0.6;
      if (sure || agreed) for (const v of voices) this.voiceprints.add(pid, v.e, "auto", v.at);
      return;
    }
    if (guess.confidence < 0.5 || margin < 3) return;
    const held = this.candidates.get(pid) ?? [];
    const twin = held.find((c) => cosine(c[0].e, best.embedding!) >= 0.4);
    if (twin) {
      for (const v of [...twin, ...voices]) this.voiceprints.add(pid, v.e, "auto", v.at);
      this.candidates.delete(pid);
    } else {
      this.candidates.set(pid, [...held, voices].slice(-4));
    }
  }

  /** Someone says who said a line. The line's voice joins that person's voiceprint, counted as a correction. */
  assign(utteranceId: string, personId: string): { utterance: Utterance; learning: Learning } {
    const u = this.session.store.get("utterances", utteranceId);
    const person = this.session.person(personId);
    if (!u || !person) throw new Error("Unknown line or person");
    const prior = u.personId && u.personId !== personId ? u.personId : null;
    const heard = this.voiceOf(u);
    let learning: Learning;
    if (!voiceprintStatus().available) learning = { learned: false, reason: "voice matching is off on this host" };
    else if (heard.embedding && !this.voiceprints.add(personId, heard.embedding, "correction", heard.heardAt)) learning = { learned: false, reason: `that line was heard before ${person.name}'s voice was reset` };
    else if (heard.embedding) {
      let cleaned = 0;
      if (prior) {
        // What the wrong label taught the wrong person: this line's sample, and others that sound like it.
        this.voiceprints.remove(prior, heard.embedding);
        cleaned = this.voiceprints.forgetLike(prior, heard.embedding);
      }
      learning = { learned: true, cleaned, relabelled: this.relabelSimilar(heard.embedding, personId, u.id) };
    } else learning = { learned: false, reason: heard.reason };
    const next: Utterance = { ...u, personId, speakerName: person.name, confidence: 1, method: "manual" };
    this.session.store.put("utterances", next);
    this.onLine?.(next, false);
    bus.send({ type: "utterance", utterance: next });
    return { utterance: next, learning };
  }

  /** The voice sample of a line, from its copies while they are kept and from its event after that. */
  /** A person's voice was reset: the lines of theirs still held here no longer teach anyone. */
  forgetVoice(personId: string) {
    this.candidates.delete(personId);
    for (const g of this.finalized) if (g.utteranceId && this.session.store.get("utterances", g.utteranceId)?.personId === personId) g.forgotten = true;
  }

  /** A line's voice and when it was heard. A line kept from before heard-times were (no heardAt) counts as heard long ago. */
  private voiceOf(u: Utterance): { embedding: Float32Array | null; heardAt: number; reason: string } {
    const g = this.finalized.find((x) => x.utteranceId === u.id);
    if (g?.forgotten) return { embedding: null, heardAt: 0, reason: "that voice was reset after the line" };
    if (g) {
      const usable = g.segments.filter((s) => s.clipped <= MAX_CLIPPED);
      if (!usable.length) return { embedding: null, heardAt: 0, reason: "every copy of it was clipped" };
      const best = pickBest(usable);
      if (best.embedding === undefined) best.embedding = embed(best.pcm);
      return best.embedding ? { embedding: best.embedding, heardAt: best.heardAt, reason: "" } : { embedding: null, heardAt: 0, reason: `the line is under ${MIN_VOICE_SECONDS} seconds` };
    }
    const data = u.eventId ? this.session.store.event(u.eventId)?.data : undefined;
    const stored = data?.embedding as number[] | undefined;
    return stored?.length ? { embedding: new Float32Array(stored), heardAt: Number(data?.heardAt) || 0, reason: "" } : { embedding: null, heardAt: 0, reason: "no voice sample was kept for that line" };
  }

  /** Lines nobody could name that sound like the voice just corrected: they were that person too. */
  private relabelSimilar(e: Float32Array, personId: string, exceptId: string) {
    const person = this.session.person(personId);
    if (!person) return 0;
    const unlabeled = this.session.store.all("utterances").filter((x) => !x.personId && x.id !== exceptId).sort((a, b) => b.t0 - a.t0).slice(0, RELABEL_LOOKBACK);
    let n = 0;
    for (const x of unlabeled) {
      const other = this.voiceOf(x).embedding;
      if (!other || cosine(normalize(other), e) < RELABEL_SIM) continue;
      const next: Utterance = { ...x, personId, speakerName: person.name, confidence: 0.6, method: "voice" };
      this.session.store.put("utterances", next);
      this.onLine?.(next, false);
      bus.send({ type: "utterance", utterance: next });
      n++;
    }
    return n;
  }

  /**
   * A person read the join sentences. The read replaces any earlier one, and it is kept as three-second
   * chunks so the voiceprint starts with variety.
   */
  enrol(personId: string, pcm: Pcm): { ok: true; samples: number } | { ok: false; reason: string } {
    // Taken or refused, the read is over: copies on their way get the grace, then the room is heard again.
    this.endEnrolment(personId);
    const { levelDb, noiseDb } = speechLevelDb(pcm);
    if (levelDb - noiseDb < 8 || levelDb < -50) return { ok: false, reason: "That was too quiet. Hold the laptop closer and try again." };
    const chunk = 16000 * 3;
    const fresh: Float32Array[] = [];
    for (let i = 0; i + chunk / 2 <= pcm.samples.length; i += chunk) {
      const e = embed({ sampleRate: 16000, samples: pcm.samples.subarray(i, Math.min(pcm.samples.length, i + chunk)) });
      if (e) fresh.push(e);
    }
    if (!fresh.length) return { ok: false, reason: "Couldn't hear enough speech. Try reading the whole thing." };
    this.voiceprints.replaceEnrol(personId, fresh, Date.now());
    return { ok: true, samples: this.voiceprints.learnedFrom(personId).enrol };
  }

  /** The embedding of an utterance's best copy and when it was heard, kept with its event so labels work after restarts. */
  voiceFor(utteranceId: string): { embedding: number[] | null; heardAt?: number } {
    const g = [...this.finalized, ...this.open].find((x) => x.utteranceId === utteranceId);
    if (!g) return { embedding: null };
    const best = pickBest(g.segments);
    if (best.embedding === undefined) best.embedding = embed(best.pcm);
    return best.embedding ? { embedding: [...best.embedding], heardAt: best.heardAt } : { embedding: null };
  }
}

/**
 * Same sentence heard twice. As many words, nearly all alike (a word misheard); or a copy that lost a
 * word or two at the end (a far laptop), when it was said over as long a stretch of audio. A word the
 * other copy has, over speech that is longer, is speech and not noise: that is another line.
 */
function sameWords(a: string, b: string, aMs: number, bMs: number) {
  const x = plainText(a).split(" ");
  const y = plainText(b).split(" ");
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length < 4 || long.length - short.length > 2) return false;
  if (long.length === short.length) return x.filter((w, i) => w !== y[i]).length <= Math.floor(x.length / 4);
  if (Math.abs(aMs - bMs) > Math.max(400, 0.15 * Math.max(aMs, bMs))) return false;
  let at = 0;
  for (const w of long) if (w === short[at]) at++;
  return at === short.length;
}
/** 16 kHz to 8 kHz (pairs averaged): enough for the shape and the phase of speech, at half the memory. */
export function narrow(pcm: Pcm): Float32Array {
  const step = Math.max(1, Math.round(pcm.sampleRate / 8000));
  const out = new Float32Array(Math.floor(pcm.samples.length / step));
  for (let i = 0; i < out.length; i++) {
    let x = 0;
    for (let j = 0; j < step; j++) x += pcm.samples[i * step + j];
    out[i] = x / step;
  }
  return out;
}

/** Loudness per 20 ms frame (8 kHz audio), in dB: the shape of what a microphone heard. */
export function contour(x: Float32Array): Float32Array {
  const frame = 160;
  const out = new Float32Array(Math.floor(x.length / frame));
  for (let i = 0; i < out.length; i++) {
    let e = 0;
    for (let j = i * frame; j < (i + 1) * frame; j++) e += x[j] * x[j];
    out[i] = 10 * Math.log10(e / frame + 1e-10);
  }
  return out;
}

/** Best correlation of two loudness contours at an offset up to a second, over most of the shorter one. */
export function contourMatch(a: Float32Array, b: Float32Array): number {
  const need = Math.max(20, Math.floor(0.6 * Math.min(a.length, b.length)));
  let best = -1;
  for (let lag = -50; lag <= 50; lag++) {
    const from = Math.max(0, -lag);
    const to = Math.min(a.length, b.length - lag);
    const n = to - from;
    if (n < need) continue;
    let sa = 0;
    let sb = 0;
    for (let i = from; i < to; i++) (sa += a[i]), (sb += b[i + lag]);
    const ma = sa / n;
    const mb = sb / n;
    let xy = 0;
    let xx = 0;
    let yy = 0;
    for (let i = from; i < to; i++) {
      const x = a[i] - ma;
      const y = b[i + lag] - mb;
      (xy += x * y), (xx += x * x), (yy += y * y);
    }
    if (xx > 0 && yy > 0) best = Math.max(best, xy / Math.sqrt(xx * yy));
  }
  return best;
}

/**
 * How sharply two recordings' waveforms line up at one offset (up to a second): the phase-only cross-correlation
 * (GCC-PHAT) peak, in standard deviations of the rest. One sound on two microphones is one waveform, delayed and
 * coloured by the room, so it peaks sharply; two sounds, however alike, have no offset where they agree.
 */
export function coherence(a: Float32Array, b: Float32Array): number {
  const cap = 8000 * 4;
  const x = a.subarray(0, cap);
  const y = b.subarray(0, cap);
  let n = 1;
  while (n < x.length + y.length) n *= 2;
  const ar = new Float64Array(n);
  const ai = new Float64Array(n);
  const br = new Float64Array(n);
  const bi = new Float64Array(n);
  ar.set(x);
  br.set(y);
  fft(ar, ai, false);
  fft(br, bi, false);
  for (let k = 0; k < n; k++) {
    // A times the conjugate of B, keeping only the phase.
    const re = ar[k] * br[k] + ai[k] * bi[k];
    const im = ai[k] * br[k] - ar[k] * bi[k];
    const m = Math.hypot(re, im) || 1;
    ar[k] = re / m;
    ai[k] = im / m;
  }
  fft(ar, ai, true);
  const maxLag = Math.min(8000, n / 2 - 1);
  let peak = 0;
  let sq = 0;
  let count = 0;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    const v = ar[(lag + n) % n];
    peak = Math.max(peak, v);
    sq += v * v;
    count++;
  }
  const sd = Math.sqrt(sq / count);
  return sd > 0 && Number.isFinite(peak / sd) ? peak / sd : 0;
}

/** In-place radix-2 FFT (n a power of two); `inverse` scales by 1/n. */
function fft(re: Float64Array, im: Float64Array, inverse: boolean) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const ur = re[i + j];
        const ui = im[i + j];
        const vr = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci;
        const vi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
        re[i + j] = ur + vr;
        im[i + j] = ui + vi;
        re[i + j + len / 2] = ur - vr;
        im[i + j + len / 2] = ui - vi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) (re[i] /= n), (im[i] /= n);
}

/**
 * Whether two recordings (8 kHz) are one sound: their loudness rises and falls together, and their waveforms
 * line up at one offset. Two microphones in a room hear one moment of speech with different gain, noise and
 * echo; the same words said again, even by the same voice, are another waveform in another rhythm.
 */
export function sameSound(a: Float32Array, b: Float32Array): boolean {
  return contourMatch(contour(a), contour(b)) >= SAME_SOUND && coherence(a, b) >= COHERENT;
}

const wordCount = (t: string) => t.split(/\s+/).filter(Boolean).length;
/** Lowercase words only: "Looks good." and "looks good" are the same words. */
const plainText = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}\s']+/gu, " ").replace(/\s+/g, " ").trim();

function textSimilarity(a: string, b: string) {
  const words = (t: string) => new Set(t.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2));
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return 0;
  return [...x].filter((w) => y.has(w)).length / Math.min(x.size, y.size);
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

/** Whether a copy holds a voice rather than silence, steady noise or a few knocks. */
function speechLike(s: Segment) {
  const brokenFloor = s.levelDb - s.snr < BROKEN_FLOOR_DB && s.levelDb < LOUD_DB;
  return !(brokenFloor || s.levelDb < MIN_SPEECH_DB || s.snr < MIN_SPEECH_SNR || s.active < MIN_ACTIVE || (s.active > STEADY_ACTIVE && s.snr < STEADY_SNR));
}

/**
 * The clearest copy: signal-to-noise first, then loudness. Copies the quality gate would reject
 * (a mic reading a broken floor as huge SNR) never beat one it accepts.
 */
export function pickBest(segments: Segment[]): Segment {
  const ok = segments.filter(speechLike);
  return [...(ok.length ? ok : segments)].sort((a, b) => b.snr * 0.7 + b.levelDb * 0.3 - (a.snr * 0.7 + a.levelDb * 0.3))[0];
}

const round = (n: number) => Math.round(n * 10) / 10;
const clamp = (n: number) => Math.min(1, Math.max(0, n));

/** A segment's signal-to-noise ratio, or 0 when its noise floor can't be real (digital silence). */
function trustedSnr(seg: { levelDb: number; snr: number }) {
  return seg.levelDb - seg.snr < BROKEN_FLOOR_DB ? 0 : seg.snr;
}
