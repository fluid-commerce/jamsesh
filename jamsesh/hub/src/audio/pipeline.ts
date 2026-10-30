// Room audio. Every device with its mic on sends speech segments stamped in host
// time. Copies of the same utterance from different devices are grouped by capture
// time, the clearest copy is transcribed, and the speaker is identified from which
// device heard it loudest plus a voiceprint match. A copy that could be someone else
// talking at the same moment is transcribed too, and is its own line when its words
// are not the clearest copy's.
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
  /** When it was heard, on this host's clock: its synced start, its arrival, or its reset epoch's end, whichever is earliest. */
  heardAt: number;
  embedding?: Float32Array | null;
  /** Its transcription, once asked for: a copy is never sent to whisper twice. */
  heard?: Promise<{ text: string; engine: string }>;
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
  /**
   * Everything that decides what its copies become runs here, one job after another (see run): its first
   * transcription, then each copy that arrives after that. Nothing else reads or changes its copies meanwhile.
   */
  queue: Promise<void>;
  /** Jobs queued or running. */
  jobs: number;
  /** Its line turned out to be another line's (mergeTwin): copies that reach it go on to that line's group. */
  mergedInto?: Group;
  /** Copies from the room and from remote laptops never group: they are different rooms. */
  location: "room" | "remote";
  /** Its speaker's voice was reset since: nothing is learned from it. */
  forgotten?: boolean;
  /** Copies that said other words than the rest of their group: named by voice only, and never taught from. */
  split?: boolean;
  /**
   * Copies that arrived after their line's own group was let go: this group stands for that line from then on
   * (utteranceId is the line's), so later copies join it too. The line's earlier copies are gone, so its speaker
   * and wording stay as they are; copies only add their devices.
   */
  adopted?: boolean;
}

/** Who corrected a line: the host's own window, or a person's window (null: neither, e.g. the brain). */
export type Corrector = { host: boolean; personId: string | null };

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
/**
 * A copy within this of the best copy's voice level could be someone else talking at the same moment, so it is
 * transcribed too. Further down it is the same voice across the room (4 laptops at a table spread over about 20 dB).
 */
const DIFFERENT_SPEECH_DB = 10;
/** A quieter copy that was the loudest of all of them for this long had someone at its own laptop speaking then. */
const LOUDEST_PART_MS = 400;
const LOUDEST_FRAME_MS = 200;
/** Copies of one line, as clocks and microphones see it, start within this of each other. */
const TWIN_MS = 3000;
/** Copies of one voice on two microphones compare at 0.7 to 0.9; two voices saying the same words, about 0.4 to 0.55. */
const SAME_VOICE = 0.6;
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
  /** Unconfirmed first voice samples per person (see autoEnroll). */
  private candidates = new Map<string, Heard[][]>();
  voiceprints: Voiceprints;
  /** People reading the join sentence right now: what the room's laptops hear of it is not conversation. */
  private enrolling = new Map<string, { since: number; until: number; read: string; open: boolean }>();
  /**
   * The highest read-start order each window has used for each person ("person|window"). Kept after its read
   * closes, is cancelled or runs out, so a delayed older start is never taken later.
   */
  private readFence = new Map<string, number>();
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
    return this.open.length + this.finalized.filter((g) => g.jobs > 0).length;
  }

  /** Same, for lines this device heard (a record-to-prompt window waits on these). */
  pendingFor(deviceId: string) {
    return this.open.filter((g) => g.segments.some((s) => s.deviceId === deviceId)).length + this.finalized.filter((g) => g.jobs > 0 && g.segments.some((s) => s.deviceId === deviceId)).length;
  }

  deviceLag(deviceId: string) {
    return this.lag.get(deviceId)?.ms ?? 0;
  }

  /** `epoch`: the reset epoch the device had when it captured the segment (Store.voiceEpoch); none for audio the host captured now. */
  async ingest(input: { deviceId: string; t0: number; t1: number; wav: Uint8Array; epoch?: number }): Promise<Segment> {
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
      heardAt: Math.min(Number.isFinite(input.t0) ? Math.min(now, input.t0) : now, input.epoch === undefined ? now : this.session.store.heardBy(input.epoch)),
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
      done.lastArrival = now;
      await this.run(done, () => this.admit(done, [seg]));
      return seg;
    }
    // A copy so late its group is gone (an offline buffer flushed) is transcribed like any other: lining
    // up in time with a line already shown isn't enough to drop it (someone else may have spoken then).
    // mergeTwin drops it only when its words are that line's, from other laptops.
    let g = this.open.find((x) => near(x) && overlaps(x, seg));
    if (!g) {
      g = { id: newId("grp"), segments: [], t0: seg.t0, t1: seg.t1, lastArrival: now, timer: null, utteranceId: null, finalizedWith: null, queue: Promise.resolve(), jobs: 0, location };
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

  /** Waits for every open group and every queued job to finish (tests). */
  async flush() {
    const groups = [...this.open];
    // Stop every timer first: one that fires while an earlier group is transcribing
    // would finalize its group a second time.
    for (const g of groups) {
      if (g.timer) clearTimeout(g.timer);
      g.timer = null;
    }
    for (const g of groups) if (this.open.includes(g)) this.finalize(g);
    while (this.work.size) await Promise.all([...this.work]);
  }

  /** Every job on any group, so flush can wait for all of them. */
  private work = new Set<Promise<void>>();

  /**
   * THE ONE RULE FOR COPIES: every copy of speech becomes exactly one line, or joins exactly one line, and is
   * never lost or counted twice, however late it comes. Enforced here: a group's copies are only decided inside
   * its own queue, one job at a time, and a group gets its first job (its transcription) before any late copy can
   * find it. A late copy is then decided by admit, the only way into a group that has been transcribed.
   */
  private run(g: Group, job: () => Promise<void>, after: Promise<void> = Promise.resolve()): Promise<void> {
    g.jobs++;
    const done: Promise<void> = Promise.all([g.queue, after])
      .then(job)
      .catch((e) => console.error("audio:", e))
      .finally(() => {
        g.jobs--;
        this.work.delete(done);
      });
    g.queue = done;
    this.work.add(done);
    return done;
  }

  private finalize(g: Group): Promise<void> {
    this.open = this.open.filter((x) => x !== g);
    g.timer = null;
    // Each part's transcription is queued before the part is visible to late copies, so a late copy always
    // waits for it. Parts are heard in order: each one's first job waits for the previous part's.
    let previous: Promise<void> = Promise.resolve();
    for (const part of this.splitCrosstalk(g)) {
      previous = this.run(part, () => this.emit(part), previous);
      this.keep(part);
    }
    return previous;
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
    return { ...g, id: newId("grp"), queue: Promise.resolve(), jobs: 0, mergedInto: undefined, timer: null, utteranceId: null, finalizedWith: null, segments, t0: Math.min(...segments.map((s) => s.t0)), t1: Math.max(...segments.map((s) => s.t1)) };
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
    // pickBest prefers copies that pass this gate, so a rejected best means every copy fails it. Copies split
    // out of a group already passed couldDiffer, whose loudest-for-a-moment rule covers replies too short for it.
    if (!g.split && !speechLike(best)) {
      g.finalizedWith = best.id;
      return;
    }
    const { text, engine } = await this.words(best, dur);
    g.finalizedWith = best.id;
    // Copies that could be someone else talking at the same moment, with other words, leave the group first: the
    // line is labelled from the copies that heard it, and each other set of words is its own line after it.
    const apart = await this.differing(g, best, text);
    this.without(g, apart.flat());
    this.show(g, best, text, engine);
    for (const set of apart) this.emitApart(g, set);
  }

  /** What a copy says. */
  private words(s: Segment, dur = (s.t1 - s.t0) / 1000) {
    return (s.heard ??= this.transcriber.transcribe(s.wav, dur, this.hint(), trustedSnr(s), this.names()));
  }

  /**
   * The group's other copies that could be different speech (see couldDiffer) are transcribed; those whose words
   * don't agree one by one with the best copy's come back in sets that say the same words.
   */
  private async differing(g: Group, best: Segment, text: string): Promise<Segment[][]> {
    const words = plainText(text);
    const sets = new Map<string, Segment[]>();
    for (const s of g.segments) {
      if (s === best || !couldDiffer(s, best, g.segments)) continue;
      const theirs = plainText((await this.words(s)).text);
      if (theirs && theirs !== words) sets.set(theirs, [...(sets.get(theirs) ?? []), s]);
    }
    return [...sets.values()];
  }

  private without(g: Group, gone: Segment[]) {
    if (!gone.length) return;
    g.segments = g.segments.filter((s) => !gone.includes(s));
    g.t0 = Math.min(...g.segments.map((s) => s.t0));
    g.t1 = Math.max(...g.segments.map((s) => s.t1));
  }

  /**
   * Copies that said something else: their own line, from a group of their own. Called from inside g's job after
   * the copies left g, so each copy is in exactly one group. The new group's transcription is queued before it is
   * visible; it isn't awaited here (a job never waits for another group's queue, so no two queues wait on each other).
   */
  private emitApart(g: Group, set: Segment[]) {
    const part: Group = { ...this.regroup(g, set), split: true };
    this.run(part, () => this.emit(part));
    this.keep(part);
  }

  private show(g: Group, best: Segment, text: string, engine: string) {
    const guess = this.identify(g.segments, best, !g.split);
    if (!text) return;
    // Someone reading the join sentence: every laptop hears it, and none of it belongs in the transcript.
    if (this.isCalibration(text, g)) return;
    // From here to the line being stored nothing awaits: two groups finishing together can't both miss each other.
    if (this.mergeTwin(g, text, best)) return;
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
    if (!g.split) this.autoEnroll(guess, best, g.segments);
    this.session.store.put("utterances", u);
    this.onLine?.(u, true);
    bus.send({ type: "utterance", utterance: u });
  }

  /** Adds copies' devices to a line, keeping the ones it already lists. */
  private addDevices(u: Utterance, segs: Segment[]) {
    const known = new Set(u.devices.map((d) => d.deviceId));
    const added = segs.filter((x) => !known.has(x.deviceId)).map((x) => ({ deviceId: x.deviceId, level: round(x.levelDb), snr: round(x.snr) }));
    if (!added.length) return;
    const next: Utterance = { ...u, devices: [...u.devices, ...added] };
    this.session.store.put("utterances", next);
    this.onLine?.(next, false);
    bus.send({ type: "utterance", utterance: next });
  }

  /**
   * A person starts reading the join sentence. Returns the read's id: its end and its recording name it, and
   * only the person's latest read is open, so an earlier read's late end or upload can't touch a newer one.
   */
  beginEnrolment(personId: string, order?: { window: string; seq: number }): string | null {
    const now = Date.now();
    // `order`: which window began the read and its place in that window's order. A start that isn't later than
    // every start that window already made for this person (requests overtaking each other, a replay) is refused,
    // whether or not that newer read is still open. In-process callers pass none.
    if (order) {
      const key = `${personId}|${order.window}`;
      if (!Number.isFinite(order.seq) || order.seq <= (this.readFence.get(key) ?? -Infinity)) return null;
      this.readFence.set(key, order.seq);
    }
    const read = newId("read");
    this.enrolling.set(personId, { since: now - 1000, until: now + ENROL_WINDOW_MS, read, open: true });
    return read;
  }

  /** The read never happened (the microphone didn't start): nothing is held out. Only for that read. */
  cancelEnrolment(personId: string, read: string) {
    if (this.enrolling.get(personId)?.read === read) this.enrolling.delete(personId);
  }

  /**
   * The read is over: copies still on their way from slow laptops are held out for a little longer, and its
   * recording is no longer taken (a profile closed mid-read). Only for that read.
   */
  endEnrolment(personId: string, read: string) {
    const w = this.enrolling.get(personId);
    if (!w || w.read !== read) return;
    w.until = Date.now() + ENROL_GRACE_MS;
    w.open = false;
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
   * already shown, which is then labelled from every copy. When unsure, both lines are kept:
   * - only other devices' copies (a microphone that already gave the line, hearing the same words
   *   again, is someone saying them again), starting within a few seconds of it;
   * - the words agree one by one (same words, same order, nothing added or missing);
   * - and when both copies have a voice, the voices agree.
   */
  private mergeTwin(g: Group, text: string, best: Segment): boolean {
    const mine = new Set(g.segments.map((s) => s.deviceId));
    const words = plainText(text);
    if (!words) return false;
    // The nearest in time of every line that qualifies, voices included: a nearer one in another voice doesn't hide it.
    const twin = this.session.store
      .all("utterances")
      .filter((x) => x.location === g.location && x.id !== g.utteranceId && Math.abs(x.t0 - g.t0) < TWIN_MS && Math.abs(x.t1 - g.t1) < TWIN_MS + 1500 && !x.devices.some((d) => mine.has(d.deviceId)) && plainText(x.text) === words)
      .filter((x) => {
        const theirs = this.voiceOf(x).embedding;
        return !best.embedding || !theirs || cosine(best.embedding, theirs) >= SAME_VOICE;
      })
      .sort((a, b) => Math.abs(a.t0 - g.t0) - Math.abs(b.t0 - g.t0))[0];
    if (!twin) return false;
    const home = this.finalized.find((x) => x.utteranceId === twin.id);
    // Its group is gone (a copy flushed late): the same words from another laptop then, so it isn't shown twice. It
    // still joins that line: its devices are added (the line's other copies are gone, so its speaker stands).
    // g then stands for that line (adopted), so a still later copy finds it and joins too.
    if (!home) {
      g.utteranceId = twin.id;
      g.adopted = true;
      this.addDevices(twin, g.segments);
      return true;
    }
    // The copies become late copies of that line, decided by its own queue; anything still sent to g follows them.
    this.finalized = this.finalized.filter((x) => x !== g);
    g.mergedInto = home;
    const moved = g.segments;
    g.segments = [];
    home.lastArrival = Date.now();
    this.run(home, () => this.admit(home, moved));
    return true;
  }

  /**
   * "drop" when this line is an echo of a clearer copy heard in the other location: the very same words, one by one.
   * A line with a word added or changed ("Yes" and "Yes please") is someone answering, and stays.
   */
  private echoOf(u: Utterance, snr: number): "drop" | "keep" {
    const words = plainText(u.text);
    const recent = this.session.store
      .all("utterances")
      .filter((x) => x.location && x.location !== u.location && Math.abs(x.t0 - u.t0) < 3000 && Math.abs(x.t1 - u.t1) < 3500);
    for (const other of recent) {
      if (plainText(other.text) !== words) continue;
      const otherSnr = Math.max(...other.devices.map((d) => d.snr));
      if (otherSnr >= snr - 6) return "drop";
      // This copy is much clearer: the earlier one was the echo.
      if (other.eventId) this.session.store.updateEvent(other.eventId, { relevance: "chatter", data: { echo: true } });
    }
    return "keep";
  }

  private keep(g: Group) {
    this.finalized.push(g);
    const cutoff = Date.now() - KEEP_FINAL_MS;
    // A group with work still queued is never let go: a copy arriving then would start a second line for it.
    this.finalized = this.finalized.filter((x) => x.lastArrival > cutoff || x.jobs > 0 || x === g);
  }

  /** Copies that reach a group after its first transcription. Runs only as one of that group's jobs (see run). */
  private async admit(g: Group, segs: Segment[]): Promise<void> {
    if (g.mergedInto) {
      const home = g.mergedInto;
      this.run(home, () => this.admit(home, segs));
      return;
    }
    for (const seg of segs) {
      g.segments.push(seg);
      g.t0 = Math.min(g.t0, seg.t0);
      g.t1 = Math.max(g.t1, seg.t1);
      g.lastArrival = Date.now();
      await this.settle(g, seg);
      if (g.mergedInto) return this.admit(g, segs.slice(segs.indexOf(seg) + 1));
    }
  }

  /**
   * What one late copy becomes. The same decision as for copies that came in time, made before anything about
   * the line changes: a copy that could be someone else talking then (couldDiffer), or that is now the clearest
   * copy, is transcribed first, and is its own line exactly when its words aren't the line's. Only a copy with the
   * line's words can change the line (its speaker, and its wording when it's much cleaner).
   */
  private async settle(g: Group, late: Segment) {
    const u = g.utteranceId ? this.session.store.get("utterances", g.utteranceId) : undefined;
    const current = g.segments.find((s) => s.id === g.finalizedWith);
    const best = pickBest(g.segments);
    if (!u) {
      // No line came from the copies before (no words, an echo, the join read). A clearer copy is tried as the
      // group's best; otherwise a copy that could be someone else is heard on its own.
      if (!current || best !== current) return this.emit(g);
      if (!couldDiffer(late, current, g.segments)) return;
      const before = current.heard ? plainText((await current.heard).text) : "";
      const theirs = plainText((await this.words(late)).text);
      if (theirs && theirs !== before) {
        this.without(g, [late]);
        this.emitApart(g, [late]);
      }
      return;
    }
    let text = u.text;
    let engine = u.engine;
    if (late === best || (current && couldDiffer(late, current, g.segments))) {
      const r = await this.words(late);
      const theirs = plainText(r.text);
      if (theirs && theirs !== plainText(u.text)) {
        this.without(g, [late]);
        this.emitApart(g, [late]);
        return;
      }
      // The same words, much more clearly: its wording (case, punctuation) is the line's.
      if (theirs && late === best && current && late.snr > current.snr + 6) {
        ((text = r.text), (engine = r.engine));
        g.finalizedWith = late.id;
      }
    }
    const guess = this.identify(g.segments, best, !g.split);
    // Read the line again after the wait: someone may have corrected the speaker meanwhile, and a
    // correction always wins over a late copy.
    const fresh = this.session.store.get("utterances", u.id) ?? u;
    if (g.adopted) return this.addDevices(fresh, g.segments);
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
   * laptop is still recognized. `byDevice` false: only a voice names the speaker.
   */
  identify(segments: Segment[], best = pickBest(segments), byDevice = true): SpeakerGuess {
    const s = this.session;
    const byLevel = [...segments].sort((a, b) => speechDb(b) - speechDb(a));
    const loud = byLevel[0];
    const margin = byLevel.length > 1 ? speechDb(loud) - speechDb(byLevel[1]) : 6;
    const deviceScores = new Map<string, number>();
    for (const seg of byDevice ? byLevel : []) {
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

  /**
   * Someone says who said a line. The line is relabelled whoever says so. Its voice joins that person's
   * voiceprint (counted as a correction) only when the one correcting is that person or the host; what the
   * wrong label taught the wrong person is taken back only when they or the host correct it. Anyone else's
   * correction relabels the line and teaches nothing, so nobody can write or erase another person's voice.
   */
  assign(utteranceId: string, personId: string, by: Corrector): { utterance: Utterance; learning: Learning } {
    const u = this.session.store.get("utterances", utteranceId);
    const person = this.session.person(personId);
    if (!u || !person) throw new Error("Unknown line or person");
    const prior = u.personId && u.personId !== personId ? u.personId : null;
    const mayTeach = by.host || by.personId === personId;
    const mayUnteach = !!prior && (by.host || by.personId === prior);
    const heard = this.voiceOf(u);
    let learning: Learning;
    if (!voiceprintStatus().available) learning = { learned: false, reason: "voice matching is off on this host" };
    else if (!heard.embedding) learning = { learned: false, reason: heard.reason };
    else {
      const cleaned = mayUnteach ? (this.voiceprints.remove(prior!, heard.embedding), this.voiceprints.forgetLike(prior!, heard.embedding)) : 0;
      if (!mayTeach) learning = { learned: false, reason: `only ${person.name} or the host can teach ${person.name}'s voice` };
      else if (!this.voiceprints.add(personId, heard.embedding, "correction", heard.heardAt)) learning = { learned: false, reason: `that line was heard before ${person.name}'s voice was reset` };
      else learning = { learned: true, cleaned, relabelled: this.relabelSimilar(heard.embedding, personId, u.id) };
    }
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
    // An adopted group's copies came later and never named the speaker: the line's own sample is its event's.
    const g = this.finalized.find((x) => x.utteranceId === u.id && !x.adopted);
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
   * chunks so the voiceprint starts with variety. `epoch` is the reset epoch the hub gave when the read
   * started: a read begun before this person's voice was reset teaches nothing.
   */
  enrol(personId: string, pcm: Pcm, epoch: number, read: string | null): { ok: true; samples: number } | { ok: false; reason: string } {
    // A recording is taken only for the person's open read (`null`: an in-process caller with no read window).
    const w = this.enrolling.get(personId);
    if (read !== null && !(w && w.read === read && w.open)) return { ok: false, reason: "That read was closed before it arrived, so it wasn't kept. Read again." };
    // Taken or refused, the read is over: copies on their way get the grace, then the room is heard again.
    if (read !== null) this.endEnrolment(personId, read);
    const heardAt = Math.min(Date.now(), this.session.store.heardBy(epoch));
    if (heardAt <= this.session.store.voiceResetAt(personId)) return { ok: false, reason: "Your voice was reset while you read, so that read wasn't kept. Read again." };
    const { levelDb, noiseDb } = speechLevelDb(pcm);
    if (levelDb - noiseDb < 8 || levelDb < -50) return { ok: false, reason: "That was too quiet. Hold the laptop closer and try again." };
    const chunk = 16000 * 3;
    const fresh: Float32Array[] = [];
    for (let i = 0; i + chunk / 2 <= pcm.samples.length; i += chunk) {
      const e = embed({ sampleRate: 16000, samples: pcm.samples.subarray(i, Math.min(pcm.samples.length, i + chunk)) });
      if (e) fresh.push(e);
    }
    if (!fresh.length) return { ok: false, reason: "Couldn't hear enough speech. Try reading the whole thing." };
    this.voiceprints.replaceEnrol(personId, fresh, heardAt);
    return { ok: true, samples: this.voiceprints.learnedFrom(personId).enrol };
  }

  /** The embedding of an utterance's best copy and when it was heard, kept with its event so labels work after restarts. */
  voiceFor(utteranceId: string): { embedding: number[] | null; heardAt?: number } {
    const g = [...this.finalized, ...this.open].find((x) => x.utteranceId === utteranceId && !x.adopted);
    if (!g) return { embedding: null };
    const best = pickBest(g.segments);
    if (best.embedding === undefined) best.embedding = embed(best.pcm);
    return best.embedding ? { embedding: [...best.embedding], heardAt: best.heardAt } : { embedding: null };
  }
}

/** Lowercase words only: "Looks good." and "looks good" are the same words. */
const plainText = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}\s']+/gu, " ").replace(/\s+/g, " ").trim();

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

/**
 * Whether a copy that isn't the best could be different speech, so it is worth transcribing: it holds a voice nearly
 * as loud as the best copy's, or its own laptop heard it the loudest of all for part of the span (a short reply over
 * a long sentence, too brief to pass the speech gate on its own).
 */
function couldDiffer(s: Segment, best: Segment, all: Segment[]) {
  return (speechLike(s) && speechDb(s) >= speechDb(best) - DIFFERENT_SPEECH_DB) || loudestMs(s, all) >= LOUDEST_PART_MS;
}

/** How long a copy was louder than every other copy while it held a voice, in frames on the host's clock. */
function loudestMs(s: Segment, all: Segment[]) {
  let won = 0;
  for (let t = s.t0; t + LOUDEST_FRAME_MS <= s.t1; t += LOUDEST_FRAME_MS) {
    const mine = frameDb(s, t);
    if (mine >= s.noiseDb + MIN_SPEECH_SNR && all.every((o) => o === s || frameDb(o, t) < mine)) won += LOUDEST_FRAME_MS;
  }
  return won;
}

function frameDb(s: Segment, t: number) {
  const rate = s.pcm.sampleRate;
  const i0 = Math.round(((t - s.t0) / 1000) * rate);
  const i1 = Math.min(s.pcm.samples.length, i0 + Math.round((LOUDEST_FRAME_MS / 1000) * rate));
  if (i0 < 0 || i1 <= i0) return -Infinity;
  let acc = 0;
  for (let i = i0; i < i1; i++) acc += s.pcm.samples[i] ** 2;
  return 10 * Math.log10(acc / (i1 - i0) + 1e-12);
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
