// Microphone capture with voice activity detection. Speech segments are cut on the
// device, stamped in host time, and sent to the hub as 16 kHz WAV. The hub groups
// copies of the same utterance from every device and keeps the clearest one.
//
// Auto gain control stays off so loudness still says how close a speaker is to
// this device; the hub uses that to tell who is talking.
import { hub } from "./hub";

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
}

type Listener = (s: MicStatus) => void;

export class Mic {
  status: MicStatus = { on: false, level: -90, noise: -70, speaking: false, sent: 0, error: null, deviceLabel: "" };
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private listeners = new Set<Listener>();
  private ring: Float32Array[] = [];
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
  private suppressUntil = 0;

  constructor(private deviceId: string) {
    hub.speakListeners.add((m) => {
      // Don't transcribe the room brain talking through the speaker.
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

  async start() {
    if (this.status.on) return;
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("This page can't use the microphone over plain HTTP. Open it from the JamSesh window that join.sh opens, or from the host itself.");
      }
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: false, autoGainControl: false },
      });
      this.ctx = new AudioContext();
      const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
      await this.ctx.audioWorklet.addModule(url);
      const src = this.ctx.createMediaStreamSource(this.stream);
      const node = new AudioWorkletNode(this.ctx, "jam-down");
      node.port.onmessage = (e) => this.frame(e.data as Float32Array);
      src.connect(node);
      this.frameIndex = 0;
      this.base = 0;
      const label = this.stream.getAudioTracks()[0]?.label ?? "Microphone";
      this.emit({ on: true, error: null, deviceLabel: label });
    } catch (e) {
      this.emit({ on: false, error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close();
    this.ctx = null;
    this.stream = null;
    this.seg = null;
    this.emit({ on: false, speaking: false, level: -90 });
  }

  private frame(f: Float32Array) {
    const now = hub.now();
    // Time from the audio clock, re-anchored to host time when they drift apart.
    const t = this.base + this.frameIndex * 20;
    if (!this.base || Math.abs(t - (now - 20)) > 250) ((this.base = now - 20 - this.frameIndex * 20));
    const ts = this.base + this.frameIndex * 20;
    this.frameIndex++;

    let acc = 0;
    for (let i = 0; i < f.length; i++) acc += f[i] * f[i];
    const db = 10 * Math.log10(acc / f.length + 1e-12);
    if (db < this.noise) this.noise = this.noise * 0.9 + db * 0.1;
    else this.noise += Math.min(0.02, (db - this.noise) * 0.002);
    const isSpeech = db > this.noise + 10 && db > -58;

    this.ring.push(f);
    if (this.ring.length > PREROLL_FRAMES) this.ring.shift();

    if (!this.seg) {
      this.run = isSpeech ? this.run + 1 : 0;
      if (this.run >= START_FRAMES) {
        this.seg = [...this.ring];
        this.segStart = ts - (this.ring.length - 1) * 20;
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

  private finish(ts: number) {
    const frames = this.seg!;
    this.seg = null;
    this.run = 0;
    const trim = Math.max(0, this.silence - 10);
    const kept = frames.slice(0, frames.length - trim);
    const t0 = this.segStart;
    const t1 = ts - trim * 20;
    if (this.segSpeechFrames < MIN_SPEECH_FRAMES) return;
    if (Date.now() < this.suppressUntil) return;
    const samples = new Float32Array(kept.length * FRAME);
    kept.forEach((k, i) => samples.set(k, i * FRAME));
    const levels = [...this.segLevels].sort((a, b) => a - b);
    const level = levels.slice(Math.floor(levels.length / 2)).reduce((a, b) => a + b, 0) / Math.max(1, levels.length - Math.floor(levels.length / 2));
    const q = new URLSearchParams({ deviceId: this.deviceId, t0: String(Math.round(t0)), t1: String(Math.round(t1)), level: level.toFixed(1), noise: this.noise.toFixed(1) });
    fetch(`/api/audio?${q}`, { method: "POST", headers: { "content-type": "audio/wav" }, body: encodeWav(samples) })
      .then(() => this.emit({ sent: this.status.sent + 1 }))
      .catch(() => {});
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
