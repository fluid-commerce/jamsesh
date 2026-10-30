// 16-bit PCM WAV encode and decode, mono, any sample rate.

export interface Pcm {
  sampleRate: number;
  samples: Float32Array;
}

/** The rates JamSesh records at (browsers and the Mac's microphones); anything else isn't ours. */
export const MIN_RATE = 8000;
export const MAX_RATE = 48000;
/** Longer than any segment (14 s) or join read (20 s) a device sends. */
export const MAX_SECONDS = 120;

/** Audio that isn't a WAV JamSesh would send: the sender's mistake (400), not the host's. */
export class BadWav extends Error {}

/**
 * Decodes a WAV. Its whole structure is checked before any sample is read: RIFF/WAVE with the RIFF size the file
 * really has; every chunk with a printable id, inside the file, the chunks ending exactly at the end of the file;
 * one complete `fmt ` chunk, before the one `data` chunk; whole sample frames. Then its header: a rate outside what
 * JamSesh records, a format it doesn't make, or more than `maxSeconds` of audio is refused before anything is
 * allocated, so a small upload can't claim a rate (1 Hz) that resampling turns into millions of samples. Every
 * refusal is a BadWav.
 */
export function decodeWav(bytes: Uint8Array, maxSeconds = MAX_SECONDS): Pcm {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new BadWav("not a WAV file");
  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null;
  let data: { body: number; size: number } | null = null;
  let off = 12;
  /** The last chunk is odd-sized and its pad byte isn't in the file. */
  let padMissing = false;
  while (off < bytes.length) {
    if (off + 8 > bytes.length) throw new BadWav("WAV ends partway through a chunk header");
    const id = tag(off);
    if (![...bytes.subarray(off, off + 4)].every((c) => c >= 0x20 && c <= 0x7e)) throw new BadWav("WAV has a chunk with an unreadable id");
    const size = view.getUint32(off + 4, true);
    const body = off + 8;
    if (body + size > bytes.length) throw new BadWav(`WAV ${id.trim() || "chunk"} chunk runs past the end of the file`);
    if (id === "fmt ") {
      if (fmt) throw new BadWav("WAV has two fmt chunks");
      if (data) throw new BadWav("WAV data comes before its fmt chunk");
      if (size < 16) throw new BadWav("WAV fmt chunk is incomplete");
      fmt = { format: view.getUint16(body, true), channels: view.getUint16(body + 2, true), sampleRate: view.getUint32(body + 4, true), bits: view.getUint16(body + 14, true) };
    } else if (id === "data") {
      if (!fmt) throw new BadWav("WAV data comes before its fmt chunk");
      if (data) throw new BadWav("WAV has two data chunks");
      data = { body, size };
    }
    // An odd-sized chunk is followed by a pad byte, which only the last chunk may leave out.
    padMissing = size % 2 === 1 && body + size === bytes.length;
    off = Math.min(bytes.length, body + size + (size % 2));
  }
  // The RIFF size is the file's length after its first 8 bytes, counting a final pad byte only when one is missing.
  const riff = view.getUint32(4, true);
  if (riff !== bytes.length - 8 && !(padMissing && riff === bytes.length - 7)) throw new BadWav(`WAV says it is ${riff + 8} bytes but is ${bytes.length}`);
  if (!fmt) throw new BadWav("WAV file has no fmt chunk");
  if (!data) throw new BadWav("WAV file has no data");
  const { format, channels, sampleRate, bits } = fmt;
  const { body, size } = data;
  if (!Number.isInteger(sampleRate) || sampleRate < MIN_RATE || sampleRate > MAX_RATE) throw new BadWav(`WAV sample rate ${sampleRate} Hz is outside ${MIN_RATE} to ${MAX_RATE} Hz`);
  if (channels < 1 || channels > 2 || ![8, 16, 32].includes(bits) || !(format === 1 || (format === 3 && bits === 32))) throw new BadWav("unsupported WAV format");
  const frame = (bits / 8) * channels;
  if (size % frame) throw new BadWav("WAV data ends partway through a sample");
  const frames = size / frame;
  if (frames > sampleRate * maxSeconds) throw new BadWav(`WAV is longer than ${maxSeconds} seconds`);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) {
      const p = body + (i * channels + c) * (bits / 8);
      acc += format === 3 && bits === 32 ? view.getFloat32(p, true) : bits === 16 ? view.getInt16(p, true) / 32768 : bits === 32 ? view.getInt32(p, true) / 2147483648 : (bytes[p] - 128) / 128;
    }
    out[i] = acc / channels;
  }
  return { sampleRate, samples: out };
}

export function encodeWav({ sampleRate, samples }: Pcm): Uint8Array {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 32768 : s * 32767, true);
  }
  return new Uint8Array(buf);
}

export function resample(pcm: Pcm, rate: number): Pcm {
  if (pcm.sampleRate === rate) return pcm;
  // Never more than the output rate allows from the input's own length (a decoded WAV is already bounded).
  if (!(pcm.sampleRate >= MIN_RATE && pcm.sampleRate <= MAX_RATE && rate >= MIN_RATE && rate <= MAX_RATE)) throw new BadWav("sample rate out of range");
  const ratio = pcm.sampleRate / rate;
  const n = Math.floor(pcm.samples.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * ratio;
    const i0 = Math.floor(x);
    const t = x - i0;
    out[i] = (pcm.samples[i0] ?? 0) * (1 - t) + (pcm.samples[i0 + 1] ?? 0) * t;
  }
  return { sampleRate: rate, samples: out };
}

/** Share of samples pinned at full scale: a preamp set too hot, which wrecks a voiceprint. */
export function clippedShare(pcm: Pcm): number {
  let n = 0;
  for (const x of pcm.samples) if (x >= 0.98 || x <= -0.98) n++;
  return pcm.samples.length ? n / pcm.samples.length : 0;
}

/**
 * RMS level in dBFS over the loudest 50% of 30 ms frames, which tracks speech, not pauses.
 * `active` is the share of frames within 15 dB of the 95th-percentile frame: speech keeps
 * about half its frames there (0.48 at the lowest in 60 clean clips), steady noise all of
 * them, and a few clicks or knocks almost none.
 */
export function speechLevelDb(pcm: Pcm): { levelDb: number; noiseDb: number; active: number } {
  const frame = Math.round(pcm.sampleRate * 0.03);
  const levels: number[] = [];
  for (let i = 0; i + frame <= pcm.samples.length; i += frame) {
    let acc = 0;
    for (let j = i; j < i + frame; j++) acc += pcm.samples[j] ** 2;
    levels.push(10 * Math.log10(acc / frame + 1e-12));
  }
  if (!levels.length) return { levelDb: -100, noiseDb: -100, active: 0 };
  levels.sort((a, b) => a - b);
  const p95 = levels[Math.floor(levels.length * 0.95)];
  const active = levels.filter((l) => l > p95 - 15).length / levels.length;
  const upper = levels.slice(Math.floor(levels.length / 2));
  const levelDb = upper.reduce((a, b) => a + b, 0) / upper.length;
  const noiseDb = levels[Math.floor(levels.length * 0.1)];
  return { levelDb, noiseDb, active };
}
