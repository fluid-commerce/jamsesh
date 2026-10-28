// Speech to text. Order: local whisper.cpp on the host, whisper servers that client
// machines offer, then the gateway. A pool spreads work across whoever is free.
import { transcribe as aiTranscribe } from "ai";
import { bus } from "../bus";
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

/** Video-outro lines whisper invents from noise; nobody says these in a working session. */
const NEVER_SAID = /next video|like and subscribe|see you (in the )?next (one|time)|thanks for watching|don'?t forget to subscribe/i;

/**
 * Whisper invents "Thank you." or a lone full stop for silence and steady noise, at any
 * length. Such stock phrases are believed only when the audio was a short blip (too
 * brief to carry a sentence anyway) or a clean voice (snr in dB, when known).
 */
export function cleanTranscript(text: string, durationSec: number, snr = Infinity, names: string[] = []): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (!/[\p{L}\p{N}]/u.test(t)) return "";
  // Only people's names ("Chey, Pat."): whisper repeating names it was given, not someone talking.
  const words = t.toLowerCase().split(/[^\p{L}\p{N}']+/u).filter(Boolean);
  const known = new Set(names.flatMap((n) => n.toLowerCase().split(/[^\p{L}\p{N}']+/u)).filter(Boolean));
  if (known.size && words.length && words.every((w) => known.has(w))) return "";
  if (NEVER_SAID.test(t)) return "";
  if (HALLUCINATIONS.some((r) => r.test(t)) && (durationSec < 3 || snr < CLEAN_VOICE_SNR)) return "";
  return t;
}
const CLEAN_VOICE_SNR = 15;

export class Transcriber {
  private engines = new Map<string, Engine>();
  private localProc: ReturnType<typeof Bun.spawn> | null = null;

  /** Why nothing is being heard, when that is the case (shown on the big screen and in Settings). */
  private trouble: string | null = null;
  private warnedAt = 0;

  constructor(private session: Session) {}

  /** The "language" setting: an ISO code, or "auto" to let whisper detect it. Default English. */
  private language() {
    const l = String(this.session.store.setting<string>("language", "en") || "en").toLowerCase();
    return /^[a-z]{2,3}$|^auto$/.test(l) ? l : "en";
  }

  /** null when speech can be turned into text; otherwise a sentence saying what to fix. */
  problem(): string | null {
    const mode = this.session.settings().transcription;
    if (this.trouble) return this.trouble;
    const local = [...this.engines.values()].some((e) => e.failures < 3);
    if (mode !== "gateway" && local) return null;
    if (mode !== "local" && gateway(this.session)) return null;
    return mode === "local"
      ? "Speech can't be turned into text: no local whisper is running. Install whisper-cpp and a model, or let the gateway transcribe in Settings."
      : "Speech can't be turned into text: no whisper model is installed and no gateway key is set. Add a gateway key in Settings or install whisper-cpp.";
  }

  /** Says so once in a while, in the feed and on screen, instead of the room going silently deaf. */
  warn(reason: string) {
    this.trouble = reason;
    if (Date.now() - this.warnedAt < 5 * 60_000) return;
    this.warnedAt = Date.now();
    bus.send({ type: "toast", tone: "warn", text: "JamSesh can't hear the room", detail: reason });
    this.session.store.addEvent({ kind: "system", authorType: "system", authorName: "JamSesh", text: reason, relevance: "work", data: { transcriptionProblem: true } });
  }

  async startLocal(port = 8178) {
    if (!config.whisperServerBin || !config.whisperModel) return false;
    const url = `http://127.0.0.1:${port}`;
    if (!(await ping(url))) {
      this.localProc = Bun.spawn(
        [config.whisperServerBin, "-m", config.whisperModel, "--host", "127.0.0.1", "--port", String(port), "-t", "6", "--no-timestamps", "-l", "auto"],
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

  async transcribe(wav: Uint8Array, durationSec: number, hint = "", snr = Infinity, names: string[] = []): Promise<{ text: string; engine: string }> {
    const mode = this.session.settings().transcription;
    if (mode !== "gateway") {
      const pool = [...this.engines.values()].filter((e) => e.failures < 3).sort((a, b) => a.inflight - b.inflight || (a.kind === "local" ? -1 : 1));
      for (const e of pool) {
        e.inflight++;
        try {
          const text = await whisperServer(e.url, wav, hint, this.language());
          e.failures = 0;
          this.trouble = null;
          e.lastOk = Date.now();
          return { text: cleanTranscript(text, durationSec, snr, names), engine: e.label };
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
    const gw = mode === "local" ? null : gateway(this.session);
    if (!gw) {
      this.warn(this.problem() ?? "Speech can't be turned into text right now.");
      return { text: "", engine: "none" };
    }
    try {
      const lang = this.language();
      // Bounded, so a slow gateway can't hold a recorded prompt past its window.
      const r = await aiTranscribe({ abortSignal: AbortSignal.timeout(20_000), model: gw.transcription(this.session.settings().models.transcribe), audio: wav, providerOptions: lang === "auto" ? undefined : { openai: { language: lang } } });
      this.trouble = null;
      return { text: cleanTranscript(r.text, durationSec, snr, names), engine: "gateway" };
    } catch (err) {
      this.warn(`Transcription failed: ${describeError(err)}`);
      return { text: "", engine: "none" };
    }
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

async function whisperServer(url: string, wav: Uint8Array, hint: string, language = "en"): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([wav as Uint8Array<ArrayBuffer>], { type: "audio/wav" }), "clip.wav");
  form.append("response_format", "json");
  form.append("temperature", "0");
  form.append("language", language);
  if (hint) form.append("prompt", hint);
  const r = await fetch(`${url}/inference`, { method: "POST", body: form, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = (await r.json()) as { text?: string; error?: string };
  if (j.error) throw new Error(j.error);
  return j.text ?? "";
}
