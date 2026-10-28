// Speech to text. Order: local whisper.cpp on the host, whisper servers that client
// machines offer, then the gateway. A pool spreads work across whoever is free.
import { transcribe as aiTranscribe } from "ai";
import { config } from "../config";
import type { Session } from "../session";
import { describeError, gateway } from "../brain/llm";

interface Engine {
  id: string;
  label: string;
  kind: "local" | "worker";
  url: string;
  inflight: number;
  failures: number;
  lastOk: number;
}

const HALLUCINATIONS = [
  /^\s*(thank you|thanks)( (so much|for watching|for listening))?[.!]?\s*$/i,
  /^\s*(you|bye|okay\.?)\s*$/i,
  /^\s*[\[(].*[\])]\s*$/, // [BLANK_AUDIO], (music)
  /subtitles by|amara\.org|transcribed by/i,
];

/**
 * Whisper invents "Thank you." or a lone full stop for silence and steady noise, at any
 * length. Such stock phrases are believed only when the audio was a short blip (too
 * brief to carry a sentence anyway) or a clean voice (snr in dB, when known).
 */
export function cleanTranscript(text: string, durationSec: number, snr = Infinity): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (!/[\p{L}\p{N}]/u.test(t)) return "";
  if (HALLUCINATIONS.some((r) => r.test(t)) && (durationSec < 3 || snr < CLEAN_VOICE_SNR)) return "";
  return t;
}
const CLEAN_VOICE_SNR = 15;

export class Transcriber {
  private engines = new Map<string, Engine>();
  private localProc: ReturnType<typeof Bun.spawn> | null = null;

  constructor(private session: Session) {}

  async startLocal(port = 8178) {
    if (!config.whisperServerBin || !config.whisperModel) return false;
    const url = `http://127.0.0.1:${port}`;
    if (!(await ping(url))) {
      this.localProc = Bun.spawn(
        [config.whisperServerBin, "-m", config.whisperModel, "--host", "127.0.0.1", "--port", String(port), "-t", "6", "--no-timestamps", "-l", "en"],
        { stdout: "ignore", stderr: "ignore" },
      );
      for (let i = 0; i < 60 && !(await ping(url)); i++) await Bun.sleep(250);
    }
    if (!(await ping(url))) return false;
    this.engines.set("local", { id: "local", label: "host whisper.cpp", kind: "local", url, inflight: 0, failures: 0, lastOk: Date.now() });
    return true;
  }

  stop() {
    this.localProc?.kill();
  }

  /** A client machine offers its own whisper server for the room. */
  addWorker(id: string, label: string, url: string) {
    this.engines.set(id, { id, label, kind: "worker", url, inflight: 0, failures: 0, lastOk: Date.now() });
  }

  removeWorker(id: string) {
    this.engines.delete(id);
  }

  engineList() {
    return [...this.engines.values()].map((e) => ({ id: e.id, label: e.label, kind: e.kind, inflight: e.inflight, healthy: e.failures < 3 }));
  }

  async transcribe(wav: Uint8Array, durationSec: number, hint = "", snr = Infinity): Promise<{ text: string; engine: string }> {
    const mode = this.session.settings().transcription;
    if (mode !== "gateway") {
      const pool = [...this.engines.values()].filter((e) => e.failures < 3).sort((a, b) => a.inflight - b.inflight || (a.kind === "local" ? -1 : 1));
      for (const e of pool) {
        e.inflight++;
        try {
          const text = await whisperServer(e.url, wav, hint);
          e.failures = 0;
          e.lastOk = Date.now();
          return { text: cleanTranscript(text, durationSec, snr), engine: e.label };
        } catch (err) {
          e.failures++;
          console.error(`whisper ${e.label}:`, describeError(err));
        } finally {
          e.inflight--;
        }
      }
      // Engines that failed get another chance after a minute.
      for (const e of this.engines.values()) if (e.failures >= 3 && Date.now() - e.lastOk > 60_000) e.failures = 2;
    }
    if (mode === "local") return { text: "", engine: "none" };
    const gw = gateway(this.session);
    if (!gw) return { text: "", engine: "none" };
    const r = await aiTranscribe({ model: gw.transcription(this.session.settings().models.transcribe), audio: wav });
    return { text: cleanTranscript(r.text, durationSec, snr), engine: "gateway" };
  }
}

async function ping(url: string) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(800) });
    return r.status < 500;
  } catch {
    return false;
  }
}

async function whisperServer(url: string, wav: Uint8Array, hint: string): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([wav as Uint8Array<ArrayBuffer>], { type: "audio/wav" }), "clip.wav");
  form.append("response_format", "json");
  form.append("temperature", "0");
  if (hint) form.append("prompt", hint);
  const r = await fetch(`${url}/inference`, { method: "POST", body: form, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = (await r.json()) as { text?: string; error?: string };
  if (j.error) throw new Error(j.error);
  return j.text ?? "";
}
