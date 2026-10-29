// Microphone capture with voice activity detection. Speech segments are cut on the
// device, stamped in host time, and sent to the hub as 16 kHz WAV. The hub groups
// copies of the same utterance from every device and keeps the clearest one.
//
// Auto gain control stays off so loudness still says how close a speaker is to
// this device; the hub uses that to tell who is talking.
import { useSyncExternalStore } from "react";
import { hub, pref } from "./hub";
import { backoffMs, createStore, idbTable, markContact } from "./offline";

const RATE = 16000;
const FRAME = 320; // 20 ms
const PREROLL_FRAMES = 15;
const START_FRAMES = 3;
const END_SILENCE_FRAMES = 35;
const MAX_FRAMES = 14 * 50;
const MIN_SPEECH_FRAMES = 20;

const WORKLET = `
class Down extends AudioWorkletProcessor {
  constructor() { super(); this.ratio = sampleRate / ${RATE}; this.acc = 0; this.n = 0; this.pos = 0; this.out = new Float32Array(${FRAME}); this.i = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let k = 0; k < ch.length; k++) {
      this.acc += ch[k]; this.n++; this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        this.out[this.i++] = this.acc / this.n; this.acc = 0; this.n = 0;
        if (this.i === ${FRAME}) { this.port.postMessage(this.out.slice(0)); this.i = 0; }
      }
    }
    return true;
  }
}
registerProcessor("jam-down", Down);
`;

export interface MicStatus {
  on: boolean;
  level: number;
  noise: number;
  speaking: boolean;
  sent: number;
  error: string | null;
  deviceLabel: string;
  /** Seconds of finished speech waiting on this laptop for the hub to come back. */
  buffered: number;
}

type Listener = (s: MicStatus) => void;

// ---------------------------------------------------------------------------
// Audio buffer: finished speech segments wait here (IndexedDB) while the hub is
// unreachable, then upload oldest-first with their ORIGINAL host-clock timestamps.
// The hub's pipeline merges late copies by capture time.

export const AUDIO_MAX_SECONDS = 180;
export const AUDIO_MAX_SEGMENTS = 60;

export interface AudioSeg {
  seq?: number;
  deviceId: string;
  t0: number;
  t1: number;
  level: number;
  noise: number;
  wav: ArrayBuffer;
  /** Stamped before the first clock sample arrived; shifted by the clock offset at upload. */
  unsynced?: boolean;
  /** The host's reset epoch when it was captured: audio from before a Reset never teaches that voice. */
  epoch?: number;
}

export interface AudioBufferState {
  segments: number;
  seconds: number;
  uploading: boolean;
  /** Segments the hub accepted since this page loaded. */
  uploaded: number;
  dropped: number;
}

const wavSeconds = (s: { wav: ArrayBuffer }) => Math.max(0, (s.wav.byteLength - 44) / (RATE * 2));

type PostResult = "ok" | "retry" | "unauthorized" | "drop";

export class AudioBuffer {
  private rows: AudioSeg[] = [];
  private store = createStore<AudioBufferState>({ segments: 0, seconds: 0, uploading: false, uploaded: 0, dropped: 0 });
  private draining = false;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private uploaded = 0;
  private dropped = 0;
  private loaded: Promise<void> | null = null;
  subscribe = this.store.subscribe;
  get = this.store.get;
  onUploaded = new Set<() => void>();

  constructor(
    private table = idbTable<AudioSeg>("audio"),
    private post: (s: AudioSeg) => Promise<PostResult> = postSegment,
    private canSend: () => boolean = () => hub.get().status === "connected" && hub.get().clockSynced,
  ) {}

  private publish() {
    this.store.set({ segments: this.rows.length, seconds: Math.round(this.rows.reduce((a, r) => a + wavSeconds(r), 0) * 10) / 10, uploading: this.draining, uploaded: this.uploaded, dropped: this.dropped });
  }

  load() {
    this.loaded ??= this.table.all().then((rows) => {
      this.rows = [...rows, ...this.rows].sort((a, b) => a.t0 - b.t0);
      this.publish();
    });
    return this.loaded;
  }

  /** A finished speech segment: straight to the hub when it is reachable, else saved. */
  async submit(seg: AudioSeg) {
    await this.load();
    if (!this.rows.length && !this.draining && this.canSend()) {
      const r = await this.post(seg);
      if (r === "ok") return this.done();
      if (r === "drop") return void this.dropped++;
    }
    seg.seq = await this.table.add(seg);
    this.rows.push(seg);
    this.rows.sort((a, b) => a.t0 - b.t0);
    await this.trim();
    this.publish();
    void this.drain();
  }

  private done() {
    this.uploaded++;
    this.publish();
    for (const fn of this.onUploaded) fn();
  }

  /** Oldest speech goes first when over the cap. */
  private async trim() {
    const gone: AudioSeg[] = [];
    const secs = () => this.rows.reduce((a, r) => a + wavSeconds(r), 0);
    while (this.rows.length > 1 && (this.rows.length > AUDIO_MAX_SEGMENTS || secs() > AUDIO_MAX_SECONDS)) gone.push(this.rows.shift()!);
    this.dropped += gone.length;
    await Promise.all(gone.map((g) => (g.seq != null ? this.table.delete(g.seq) : undefined)));
  }

  /** Upload what is waiting, oldest capture first. */
  async drain(): Promise<void> {
    await this.load();
    if (this.draining || !this.rows.length || !this.canSend()) return;
    this.draining = true;
    this.publish();
    try {
      while (this.rows.length && this.canSend()) {
        const s = this.rows[0];
        const r = await this.post(s);
        if (r === "retry") {
          this.schedule();
          return;
        }
        if (r === "unauthorized") return;
        this.rows.shift();
        this.attempt = 0;
        if (s.seq != null) await this.table.delete(s.seq);
        if (r === "ok") this.done();
        else this.dropped++;
        this.publish();
      }
    } finally {
      this.draining = false;
      this.publish();
    }
  }

  private schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, backoffMs(this.attempt++, Math.random, 15_000));
  }

  kick() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.attempt = 0;
    return this.drain();
  }
}

async function postSegment(s: AudioSeg): Promise<PostResult> {
  // Segments stamped before the clock synced get the offset now (drain waits for the sync).
  const shift = s.unsynced ? hub.get().clockOffset : 0;
  const q = new URLSearchParams({ deviceId: s.deviceId, t0: String(Math.round(s.t0 + shift)), t1: String(Math.round(s.t1 + shift)), level: s.level.toFixed(1), noise: s.noise.toFixed(1), epoch: String(s.epoch ?? -1) });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20_000);
  try {
    const res = await fetch(`/api/audio?${q}`, { method: "POST", credentials: "same-origin", signal: ctl.signal, headers: { "content-type": "audio/wav" }, body: s.wav });
    markContact();
    if (res.ok) return "ok";
    if (res.status === 401) {
      hub.markUnauthorized();
      return "unauthorized";
    }
    // 404: this window's device isn't registered with the host yet (it is a moment after joining).
    return res.status >= 500 || res.status === 404 || res.status === 408 || res.status === 429 ? "retry" : "drop";
  } catch {
    return "retry";
  } finally {
    clearTimeout(timer);
  }
}

export const audioBuffer = new AudioBuffer();

if (typeof window !== "undefined") {
  void audioBuffer.load().then(() => audioBuffer.drain());
  hub.subscribe(() => audioBuffer.get().segments && void audioBuffer.drain());
  window.addEventListener("online", () => void audioBuffer.kick());
}

/** Seconds and count of speech waiting on this laptop. */
export function useBufferedAudio() {
  return useSyncExternalStore(audioBuffer.subscribe, audioBuffer.get);
}

/** How far above the room's noise someone must be to count as talking over the brain, not its echo. */
export const BARGE_MARGIN_DB = 22;
const BARGE_FRAMES = 8;

/** True when a finished segment is the brain's own voice coming back, not a person. */
export function isEchoSegment(level: number, noise: number, suppressing: boolean) {
  return suppressing && level < noise + BARGE_MARGIN_DB;
}

export class Mic {
  status: MicStatus = { on: false, level: -90, noise: -70, speaking: false, sent: 0, error: null, deviceLabel: "", buffered: audioBuffer.get().seconds };
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private listeners = new Set<Listener>();
  private ring: Float32Array[] = [];
  /** The reset epoch each ring frame was captured under (hub.voiceEpoch then). */
  private ringEpochs: number[] = [];
  /**
   * The reset epoch of the segment: the one its earliest frame was captured under. Epochs only go up, so this is
   * the oldest in the segment, and audio from before a reset never carries a newer epoch (the hub would date it
   * after the reset and teach it). Set with segStart, never at finish.
   */
  private segEpoch = -1;
  private seg: Float32Array[] | null = null;
  private segStart = 0;
  private segSpeechFrames = 0;
  private segLevels: number[] = [];
  private silence = 0;
  private run = 0;
  private noise = -60;
  private frameIndex = 0;
  private base = 0;
  private lastLevelSent = 0;
  /** This laptop is a remote one: the brain only plays here when the listener wants it. */
  remote = false;
  private suppressUntil = 0;
  private loud = 0;
  /** Called when someone talks over the brain: cut its voice off. */
  onBargeIn = new Set<() => void>();
  private wanted = false;
  private starting: Promise<void> | null = null;
  private lastFrameAt = 0;
  /** The track is muted by the system; frames resume on their own. */
  private paused = false;
  /** Watchdog checks in a row that found no frames. */
  private stalls = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private tries = 0;

  constructor(private deviceId: string) {
    audioBuffer.subscribe(() => this.status.buffered !== audioBuffer.get().seconds && this.emit({ buffered: audioBuffer.get().seconds }));
    audioBuffer.onUploaded.add(() => this.emit({ sent: this.status.sent + 1 }));
    hub.speakListeners.add((m) => {
      // Don't transcribe the room brain talking through the speaker, but only when something plays:
      // no audio (text-to-speech failed) or a remote laptop with "hear the brain" off is silent here.
      if (!m.audio || (this.remote && pref("hearBrain") === "off")) return;
      this.suppressUntil = Date.now() + Math.max(2500, m.text.length * 75) + 600;
    });
  }

  onChange(fn: Listener) {
    this.listeners.add(fn);
    fn(this.status);
    return () => this.listeners.delete(fn);
  }

  private emit(patch: Partial<MicStatus>) {
    this.status = { ...this.status, ...patch };
    for (const fn of this.listeners) fn(this.status);
  }

  /** Starts listening. The mic then stays wanted: if it dies (device change, sleep) it comes back by itself. */
  async start() {
    this.wanted = true;
    if (this.status.on) return;
    this.starting ??= this.open().finally(() => (this.starting = null));
    return this.starting;
  }

  /** Turns the mic on if it is off; false (with the reason on status.error) when it can't be. */
  async ensureOn() {
    try {
      await this.start();
      return this.status.on;
    } catch {
      return false;
    }
  }

  /** The brain finished talking (or was cut off): what the mic hears from now on is people. */
  playbackEnded() {
    this.suppressUntil = Math.min(this.suppressUntil, Date.now() + 300);
  }

  private async open() {
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("This page can't use the microphone over plain HTTP. Open the host's https address (set up Remote access on the host), or use the host itself.");
      }
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: false, autoGainControl: false },
      });
      this.ctx = new AudioContext();
      // A context made without a click starts suspended in some browsers; a suspended one hears nothing.
      await this.ctx.resume().catch(() => {});
      this.ctx.onstatechange = () => {
        if (this.ctx && this.ctx.state !== "running" && this.ctx.state !== "closed") void this.ctx.resume().catch(() => {});
      };
      const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
      await this.ctx.audioWorklet.addModule(url);
      const src = this.ctx.createMediaStreamSource(this.stream);
      const node = new AudioWorkletNode(this.ctx, "jam-down");
      node.port.onmessage = (e) => this.frame(e.data as Float32Array);
      src.connect(node);
      this.frameIndex = 0;
      this.base = 0;
      this.lastFrameAt = Date.now();
      const track = this.stream.getAudioTracks()[0];
      track?.addEventListener("ended", () => this.recover("The microphone was unplugged or taken by another app."));
      // Paused by the system (another app took the input, or the window was hidden): not a fault.
      track?.addEventListener("mute", () => (this.paused = true));
      track?.addEventListener("unmute", () => ((this.paused = false), (this.lastFrameAt = Date.now())));
      this.watchdog ??= setInterval(() => this.check(), 2000);
      this.tries = 0;
      this.emit({ on: true, error: null, deviceLabel: track?.label ?? "Microphone" });
    } catch (e) {
      this.teardown();
      const msg = e instanceof Error ? e.message : String(e);
      this.emit({ on: false, error: micProblem(e) });
      // Permission refusals won't fix themselves by retrying; anything else might.
      if (this.wanted && this.tries > 0 && !/NotAllowed|Permission|denied/i.test(`${(e as Error)?.name} ${msg}`)) this.scheduleRetry();
      throw e;
    }
  }

  /** The stream died or went quiet while it should be listening: say so, then try again. */
  private recover(reason: string) {
    if (!this.wanted) return;
    this.teardown();
    this.emit({ on: false, speaking: false, level: -90, error: `${reason} Reconnecting…` });
    this.tries = Math.max(this.tries, 1);
    this.scheduleRetry();
  }

  private scheduleRetry() {
    if (this.retry || !this.wanted) return;
    if (this.tries > 6) {
      this.emit({ error: "The microphone stopped and could not come back. Turn it on again." });
      return;
    }
    const wait = Math.min(15_000, 1000 * 2 ** (this.tries - 1));
    this.tries++;
    this.retry = setTimeout(() => {
      this.retry = null;
      if (this.wanted && !this.status.on) void this.start().catch(() => {});
    }, wait);
  }

  /** Every couple of seconds: frames still arriving? */
  private check() {
    if (!this.status.on || this.paused) return;
    if (Date.now() - this.lastFrameAt <= 3500) return void (this.stalls = 0);
    // Stalled: wake the audio first; only call it dead when that hasn't helped twice running.
    void this.ctx?.resume().catch(() => {});
    if (++this.stalls >= 2) {
      this.stalls = 0;
      this.recover("The microphone stopped delivering sound.");
    }
  }

  private teardown() {
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.stream = null;
    this.seg = null;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
  }

  stop() {
    this.wanted = false;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.teardown();
    this.emit({ on: false, speaking: false, level: -90, error: null });
  }

  /** Sends the sentence being spoken right now without waiting for the pause that normally ends it. Resolves once it is uploaded. */
  async flush() {
    if (!this.seg) return;
    this.silence = 0;
    await this.finish(this.base + this.frameIndex * 20);
  }

  private frame(f: Float32Array) {
    this.lastFrameAt = Date.now();
    const now = hub.now();
    // Time from the audio clock, re-anchored to host time when they drift apart.
    const t = this.base + this.frameIndex * 20;
    if (!this.base || Math.abs(t - (now - 20)) > 250) ((this.base = now - 20 - this.frameIndex * 20));
    const ts = this.base + this.frameIndex * 20;
    this.frameIndex++;

    let acc = 0;
    for (let i = 0; i < f.length; i++) acc += f[i] * f[i];
    const db = 10 * Math.log10(acc / f.length + 1e-12);
    // Digital silence (a paused or muted track) says nothing about the room: it would drag the floor
    // toward -120 dB and make faint room tone look like a clear voice.
    if (db > -100) {
      if (db < this.noise) this.noise = this.noise * 0.9 + db * 0.1;
      else this.noise += Math.min(0.02, (db - this.noise) * 0.002);
    }
    const isSpeech = db > this.noise + 10 && db > -58;

    this.ring.push(f);
    this.ringEpochs.push(hub.get().voiceEpoch);
    if (this.ring.length > PREROLL_FRAMES) (this.ring.shift(), this.ringEpochs.shift());

    // Someone talking over the brain: sustained and well above the room, which its echo is not.
    if (Date.now() < this.suppressUntil) {
      this.loud = db > this.noise + BARGE_MARGIN_DB && db > -45 ? this.loud + 1 : 0;
      if (this.loud >= BARGE_FRAMES) {
        this.loud = 0;
        this.suppressUntil = 0;
        for (const fn of this.onBargeIn) fn();
      }
    } else this.loud = 0;

    if (!this.seg) {
      this.run = isSpeech ? this.run + 1 : 0;
      if (this.run >= START_FRAMES) {
        this.seg = [...this.ring];
        this.segStart = ts - (this.ring.length - 1) * 20;
        this.segEpoch = this.ringEpochs[0] ?? -1;
        this.segSpeechFrames = this.run;
        this.segLevels = [db];
        this.silence = 0;
      }
    } else {
      this.seg.push(f);
      if (isSpeech) {
        this.silence = 0;
        this.segSpeechFrames++;
        this.segLevels.push(db);
      } else this.silence++;
      if (this.silence >= END_SILENCE_FRAMES || this.seg.length >= MAX_FRAMES) this.finish(ts);
    }

    if (Date.now() - this.lastLevelSent > 200) {
      this.lastLevelSent = Date.now();
      hub.send({ type: "level", level: Math.round(db) });
      this.emit({ level: db, noise: this.noise, speaking: !!this.seg });
    }
  }

  private finish(ts: number): Promise<void> | void {
    const frames = this.seg!;
    this.seg = null;
    this.run = 0;
    const trim = Math.max(0, this.silence - 10);
    const kept = frames.slice(0, frames.length - trim);
    const t0 = this.segStart;
    const t1 = ts - trim * 20;
    if (this.segSpeechFrames < MIN_SPEECH_FRAMES) return;
    const samples = new Float32Array(kept.length * FRAME);
    kept.forEach((k, i) => samples.set(k, i * FRAME));
    const levels = [...this.segLevels].sort((a, b) => a - b);
    const level = levels.slice(Math.floor(levels.length / 2)).reduce((a, b) => a + b, 0) / Math.max(1, levels.length - Math.floor(levels.length / 2));
    // The brain's own voice coming back through the speakers is not a person.
    if (isEchoSegment(level, this.noise, Date.now() < this.suppressUntil)) return;
    return audioBuffer.submit({ deviceId: this.deviceId, t0: Math.round(t0), t1: Math.round(t1), level: Number(level.toFixed(1)), noise: Number(this.noise.toFixed(1)), wav: encodeWav(samples), unsynced: !hub.get().clockSynced, epoch: this.segEpoch });
  }
}

export function encodeWav(samples: Float32Array): ArrayBuffer {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  w(8, "WAVE");
  w(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, RATE, true);
  v.setUint32(28, RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 32767, true);
  return buf;
}

/** What went wrong with the mic, as a sentence that says what to do (browsers give terse names). */
export function micProblem(e: unknown) {
  const name = (e as Error)?.name ?? "";
  const msg = e instanceof Error ? e.message : String(e);
  if (/NotAllowed|Permission|denied/i.test(`${name} ${msg}`)) return "The microphone is blocked for JamSesh. Allow it (System Settings > Privacy & Security > Microphone, or this site's settings in your browser), then try again.";
  if (/NotFound|Overconstrained|Requested device not found/i.test(`${name} ${msg}`)) return "No microphone found. Plug one in or choose an input in System Settings > Sound, then try again.";
  if (/NotReadable|in use|Could not start/i.test(`${name} ${msg}`)) return "Another app is using the microphone. Close it or choose another input, then try again.";
  if (/NotSupported|not supported|mediaDevices/i.test(`${name} ${msg}`)) return "This window can't use a microphone. Open JamSesh in the Mac app or on the host's secure address.";
  return `The microphone didn't start: ${msg}`;
}
