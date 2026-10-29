// Speech to text. Order: Parakeet on the host when the room turned on the faster engine (5.2),
// local whisper.cpp (the default), whisper servers that client machines offer, then the gateway. A pool spreads work across whoever is free. Every engine is
// biased toward the room's vocabulary, and its text goes through the same correction pass.
import { transcribe as aiTranscribe } from "ai";
import { bus } from "../bus";
import { config } from "../config";
import type { Session } from "../session";
import { describeError, gateway } from "../brain/llm";
import { brainNames } from "../names";
import { Parakeet } from "./parakeet";
import { LocalWhisper, ping, whisperPort } from "./whisper";
import { buildVocabulary, correctTranscript, hotwords, promptWith, type VocabEntry } from "./vocabulary";

interface Engine {
  id: string;
  label: string;
  /** parakeet takes hotwords and English only; whisper engines take a prompt. */
  kind: "parakeet" | "local" | "worker";
  url: string;
  inflight: number;
  failures: number;
  lastOk: number;
}

const HALLUCINATIONS = [
  /^\s*(thank you|thanks)( (so much|for watching|for listening))?[.!]?\s*$/i,
  /^\s*(you|bye|okay\.?)\s*$/i,
  /^\s*[\[(].*[\])]\s*$/, // [BLANK_AUDIO], (music)
  /^\s*\*[^*]+\*\s*$/, // *sad music*, *applause*
  /subtitles by|amara\.org|transcribed by/i,
];

const OUTRO = "next video|like and subscribe|see you (in the )?next (one|time)|thanks for watching|don'?t forget to subscribe|welcome to the show";
/** Video-outro phrase anywhere in a line: believed only on weak audio, since "let's look at the next video" is real. */
const OUTRO_ANYWHERE = new RegExp(OUTRO, "i");
/** A line that is only the outro: the phrase, maybe after filler and a stock lead-in ("I'm going to go to the next video."). */
const OUTRO_ONLY = new RegExp(
  `^\\s*(?:(?:ok(?:ay)?|so|and|well|um|uh|alright|all right|right|now)[,.]?\\s+)*(?:(?:i'?m |we'?re |i |we )?(?:going to |gonna |will |'ll )?(?:go to|move on to|move onto|head to|jump to|see you in|on to|onto)(?: the)? |see you |until )?(?:${OUTRO})(?:[\\s,.!]+(?:everyone|guys|folks|bye|thanks|thank you))*[.!\\s]*$`,
  "i",
);
const SOUND_DESCRIPTION = /^\s*\*[^*]+\*\s*$/;

/**
 * Whisper invents "Thank you." or a lone full stop for silence and steady noise, at any
 * length. Such stock phrases are believed only when the audio was a short blip (too
 * brief to carry a sentence anyway) or a clean voice (snr in dB, when known).
 */
export function cleanTranscript(text: string, durationSec: number, snr = Infinity, names: string[] = []): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (!/[\p{L}\p{N}]/u.test(t)) return "";
  // Only the room's own words ("Chey, Pat."): whisper repeating the names it was given, but only when the
  // audio says so (weak or noisy) or it repeats one word. On a clean voice, "Chey, Passport." is someone talking.
  const words = t.toLowerCase().split(/[^\p{L}\p{N}']+/u).filter(Boolean);
  const known = new Set(names.flatMap((n) => n.toLowerCase().split(/[^\p{L}\p{N}']+/u)).filter(Boolean));
  const onlyRoomWords = known.size > 0 && words.length > 0 && words.every((w) => known.has(w));
  if (onlyRoomWords && (snr < CLEAN_VOICE_SNR || (words.length > 1 && new Set(words).size === 1))) return "";
  if (SOUND_DESCRIPTION.test(t) || OUTRO_ONLY.test(t)) return "";
  if (OUTRO_ANYWHERE.test(t) && (durationSec < 3 || snr < CLEAN_VOICE_SNR)) return "";
  if (HALLUCINATIONS.some((r) => r.test(t)) && (durationSec < 3 || snr < CLEAN_VOICE_SNR)) return "";
  return t;
}
const CLEAN_VOICE_SNR = 15;
const RANK = { parakeet: 0, local: 1, worker: 2 };

export class Transcriber {
  private engines = new Map<string, Engine>();
  readonly whisper = new LocalWhisper();
  readonly parakeet = new Parakeet();
  /** Project terms beyond the session's own names (the brief's glossary); the hub sets this. */
  glossary: () => string[] = () => [];

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
    const local = this.pool().length > 0;
    if (mode !== "gateway" && local) return null;
    if (mode !== "local" && gateway(this.session)) return null;
    const model = [this.whisper.status(), this.parakeet.status()].find((m) => m.state === "downloading" || m.state === "starting");
    if (model) return `Speech can't be turned into text yet: ${model.detail.split(". ")[0].replace(/\.$/, "")}${model.progress !== null ? ` (${model.progress}%)` : ""}.`;
    return mode === "local"
      ? `Speech can't be turned into text: no speech model is running on this host (${this.whisper.status().detail.replace(/\.$/, "")}). Let the gateway transcribe in Settings.`
      : `Speech can't be turned into text: no speech model is running on this host and no gateway key is set. Add a gateway key in Settings.`;
  }

  /** The words every engine is biased toward: people, agents, the brain's names, the room's list, glossary, workstreams. */
  vocabulary(): VocabEntry[] {
    const s = this.session;
    return buildVocabulary({
      people: s.people().map((p) => p.name),
      agents: s.agents().map((a) => a.name),
      brain: brainNames(s.settings()),
      custom: s.settings().vocabulary,
      terms: this.glossary(),
      workstreams: s.store.all("workstreams").filter((w) => w.status === "active").map((w) => w.title),
    });
  }

  /** Healthy engines that can take this session's language, least busy first, then by preference. */
  private pool() {
    const english = this.language() === "en";
    return [...this.engines.values()].filter((e) => e.failures < 3 && (e.kind !== "parakeet" || english)).sort((a, b) => a.inflight - b.inflight || RANK[a.kind] - RANK[b.kind]);
  }

  private fastWanted() {
    const s = this.session.settings();
    return s.fastEngine && s.transcription !== "gateway";
  }

  private starting: Promise<boolean> | null = null;
  /**
   * Starts or stops Parakeet to match the "Faster engine" setting (off by default). Turning it on
   * downloads the model the first time (minutes, never offline) while whisper or the gateway carry
   * the room; once it's ready it goes first. Resolves with whether it's running.
   */
  syncFastEngine(): Promise<boolean> {
    if (!this.fastWanted()) {
      this.parakeet.stop();
      this.engines.delete("parakeet");
      return Promise.resolve(false);
    }
    if (this.engines.has("parakeet")) return Promise.resolve(true);
    this.starting ??= (async () => {
      this.parakeet.onExit = () => this.engines.delete("parakeet");
      const url = await this.parakeet.start(!config.offline);
      if (!url) return false;
      if (!this.fastWanted()) return this.parakeet.stop(), false;
      this.engines.set("parakeet", { id: "parakeet", label: "host Parakeet", kind: "parakeet", url, inflight: 0, failures: 0, lastOk: Date.now() });
      this.trouble = null;
      return true;
    })().finally(() => (this.starting = null));
    return this.starting;
  }

  /** Says so once in a while, in the feed and on screen, instead of the room going silently deaf. */
  warn(reason: string) {
    this.trouble = reason;
    if (Date.now() - this.warnedAt < 5 * 60_000) return;
    this.warnedAt = Date.now();
    bus.send({ type: "toast", tone: "warn", text: "JamSesh can't hear the room", detail: reason });
    this.session.store.addEvent({ kind: "system", authorType: "system", authorName: "JamSesh", text: reason, relevance: "work", data: { transcriptionProblem: true } });
  }

  /**
   * Starts the host's whisper.cpp, the default engine. With the model on this Mac it resolves once
   * it's running; on the first host session it downloads the model in the background (never
   * offline) and resolves false at once, while the gateway covers the room.
   */
  async startLocal(port = whisperPort()) {
    const now = this.whisper.canStartNow() || (await ping(`http://127.0.0.1:${port}`));
    const run = this.whisper.start(port, !config.offline).then((url) => {
      console.log(`whisper: ${url ? "ready" : this.whisper.status().detail}`);
      if (!url) return false;
      this.engines.set("local", { id: "local", label: "host whisper.cpp", kind: "local", url, inflight: 0, failures: 0, lastOk: Date.now() });
      this.trouble = null;
      return true;
    });
    return now ? run : false;
  }

  stop() {
    this.whisper.stop();
    this.parakeet.stop();
  }

  /** A client machine offers its own whisper server for the room. */
  addWorker(id: string, label: string, url: string) {
    this.engines.set(id, { id, label, kind: "worker", url, inflight: 0, failures: 0, lastOk: Date.now() });
  }

  removeWorker(id: string) {
    this.engines.delete(id);
  }

  engineList() {
    return [...this.engines.values()].sort((a, b) => RANK[a.kind] - RANK[b.kind]).map((e) => ({ id: e.id, label: e.label, kind: e.kind, inflight: e.inflight, healthy: e.failures < 3 }));
  }

  async transcribe(wav: Uint8Array, durationSec: number, hint = "", snr = Infinity, names: string[] = []): Promise<{ text: string; engine: string }> {
    const mode = this.session.settings().transcription;
    const vocab = this.vocabulary();
    // Engines primed with the room's words repeat them on near-silence, like whisper repeats names:
    // a line made of nothing but those words is dropped like one made of names.
    const known = [...names, ...vocab.map((v) => v.term)];
    const finish = (text: string, engine: string) => ({ text: correctTranscript(cleanTranscript(text, durationSec, snr, known), vocab).text, engine });
    const prompt = promptWith(hint, vocab);
    if (mode !== "gateway") {
      for (const e of this.pool()) {
        e.inflight++;
        try {
          const text = await inference(e.url, wav, this.language(), e.kind === "parakeet" ? { hotwords: hotwords(vocab) } : { prompt });
          e.failures = 0;
          this.trouble = null;
          e.lastOk = Date.now();
          return finish(text, e.label);
        } catch (err) {
          e.failures++;
          console.error(`transcription ${e.label}:`, describeError(err));
        } finally {
          e.inflight--;
        }
      }
      // Engines that failed get another chance after a minute.
      for (const e of this.engines.values()) if (e.failures >= 3 && Date.now() - e.lastOk > 60_000) e.failures = 2;
    }
    if (mode === "local" || !gateway(this.session)) {
      this.warn(this.problem() ?? "Speech can't be turned into text right now.");
      return { text: "", engine: "none" };
    }
    try {
      const text = await this.cloud(wav, prompt);
      this.trouble = null;
      return finish(text, "gateway");
    } catch (err) {
      this.warn(`Transcription failed: ${describeError(err)}`);
      return { text: "", engine: "none" };
    }
  }

  /** The gateway's transcription (OpenAI's), primed with the same words as whisper. */
  async cloud(wav: Uint8Array, prompt: string): Promise<string> {
    const gw = gateway(this.session);
    if (!gw) throw new Error("no gateway key");
    const lang = this.language();
    // Bounded, so a slow gateway can't hold a recorded prompt past its window.
    const r = await aiTranscribe({ abortSignal: AbortSignal.timeout(20_000), model: gw.transcription(this.session.settings().models.transcribe), audio: wav, providerOptions: { openai: { ...(lang === "auto" ? {} : { language: lang }), ...(prompt ? { prompt } : {}) } } });
    return r.text;
  }
}

/** POST /inference to a whisper.cpp server or the Parakeet child (same shape; each reads its own field). */
async function inference(url: string, wav: Uint8Array, language: string, vocab: { prompt?: string; hotwords?: string }): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([wav as Uint8Array<ArrayBuffer>], { type: "audio/wav" }), "clip.wav");
  form.append("response_format", "json");
  form.append("temperature", "0");
  form.append("language", language);
  if (vocab.prompt) form.append("prompt", vocab.prompt);
  if (vocab.hotwords) form.append("hotwords", vocab.hotwords);
  const r = await fetch(`${url}/inference`, { method: "POST", body: form, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = (await r.json()) as { text?: string; error?: string };
  if (j.error) throw new Error(j.error);
  return j.text ?? "";
}
