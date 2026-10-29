// whisper.cpp on the host (5.2), the default engine. The Mac app ships `whisper-server` (built by
// app/build-whisper.sh, MIT); the model (574 MB) is downloaded on a Mac's first host session into
// ~/.jamsesh/models, checked against a pinned SHA-256, while the gateway covers the room. A model
// already in ~/.cache/whisper-cpp, or Homebrew's whisper-server, is used when found. The pinned model
// is used only once its size and SHA-256 match, wherever it was found; a server already on the port is
// used only when it answers a transcription like whisper-server.

import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { stopHelper, withStdinWatch } from "../children";
import { config } from "../config";
import { downloadVerified, fileMatches, type ModelState, type ModelStatus } from "./models";
import { encodeWav } from "./wav";

export const WHISPER_MODEL = {
  name: "ggml-large-v3-turbo-q5_0.bin",
  label: "Whisper large-v3-turbo",
  url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin",
  sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
  bytes: 574_041_195,
  licence: "Whisper weights MIT (OpenAI); whisper.cpp MIT",
};

const first = (paths: (string | undefined | false)[]) => paths.find((p): p is string => !!p && existsSync(p)) ?? null;

/** The smallest whisper.cpp model (tiny, quantized) is about 31 MB: anything smaller is a broken file. */
const MIN_MODEL_BYTES = 25_000_000;

/** A model file that could be whole: the pinned one at exactly its size, any other at a model's size. */
function plausible(path: string) {
  try {
    const size = statSync(path).size;
    return basename(path) === WHISPER_MODEL.name ? size === WHISPER_MODEL.bytes : size >= MIN_MODEL_BYTES;
  } catch {
    return false;
  }
}

/** whisper-server: a chosen path, the app bundle, ~/.jamsesh/bin, then Homebrew's. */
export function findWhisperServer(): string | null {
  const res = process.env.JAMSESH_RESOURCES;
  return first([process.env.JAMSESH_WHISPER_SERVER, res && join(res, "bin", "whisper-server"), join(config.home, "bin", "whisper-server"), "/opt/homebrew/bin/whisper-server", "/usr/local/bin/whisper-server"]);
}

/**
 * The model: a chosen file, ~/.jamsesh/models, then what install.sh or a person put in ~/.cache/whisper-cpp.
 * A file cut short (an interrupted download), chosen or not, is passed over; `skip` holds files that failed their checksum.
 */
export function findWhisperModel(skip: ReadonlySet<string> = new Set()): string | null {
  const cache = join(process.env.HOME || homedir(), ".cache", "whisper-cpp");
  const chosen = process.env.JAMSESH_WHISPER_MODEL;
  return first(
    [chosen, join(config.home, "models", WHISPER_MODEL.name), join(cache, WHISPER_MODEL.name), join(cache, "ggml-large-v3-turbo.bin"), join(cache, "ggml-medium.en.bin"), join(cache, "ggml-base.en.bin")].filter(
      (p) => !!p && !skip.has(p) && plausible(p),
    ),
  );
}

/** Checksums already checked this run, by path, size and modification time (574 MB is a second or two to hash). */
const checked = new Map<string, string>();

/** Whether the pinned model at `path` is the exact file (other models have no pin to check against). */
async function verified(path: string): Promise<boolean> {
  if (basename(path) !== WHISPER_MODEL.name) return true;
  const st = statSync(path);
  const stamp = `${st.size}:${st.mtimeMs}:${WHISPER_MODEL.sha256}`;
  if (checked.get(path) === stamp) return true;
  const ok = await fileMatches(WHISPER_MODEL, path);
  if (ok) checked.set(path, stamp);
  return ok;
}

/** The port the host's whisper-server listens on. */
export const whisperPort = () => Number(process.env.JAMSESH_WHISPER_PORT) || 8178;

/** Something answers HTTP at `url` (it may be anything: see `isWhisperServer`). */
export async function ping(url: string) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(800) });
    return r.status < 500;
  } catch {
    return false;
  }
}

/** Whether `url` is a whisper-server: it transcribes half a second of silence and answers with a `text`. */
export async function isWhisperServer(url: string, timeoutMs = 15_000): Promise<boolean> {
  try {
    const form = new FormData();
    const wav = encodeWav({ sampleRate: 16000, samples: new Float32Array(8000) });
    form.append("file", new Blob([wav as Uint8Array<ArrayBuffer>], { type: "audio/wav" }), "probe.wav");
    form.append("response_format", "json");
    const r = await fetch(`${url}/inference`, { method: "POST", body: form, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return false;
    const j = (await r.json()) as { text?: unknown };
    return typeof j?.text === "string";
  } catch {
    return false;
  }
}

export class LocalWhisper {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private state: ModelState = "missing";
  private detail = "Not started.";
  private progress: number | null = null;
  private stopped = false;
  /** Pinned model files that failed their checksum this run. */
  private bad = new Set<string>();
  /** Called when the whisper-server this hub started ends on its own. */
  onExit: (() => void) | null = null;
  /** How long whisper-server may take to load its model and answer. */
  startupMs = 30_000;

  status(): ModelStatus {
    return { engine: WHISPER_MODEL.label, state: this.state, detail: this.detail, progress: this.progress, sizeMb: Math.round(WHISPER_MODEL.bytes / 1e6), installed: !!findWhisperModel(this.bad), source: WHISPER_MODEL.url, licence: WHISPER_MODEL.licence };
  }

  private set(state: ModelState, detail: string, progress: number | null = null) {
    this.state = state;
    this.detail = detail;
    this.progress = progress;
  }

  /** Whether start() can finish without a download. */
  canStartNow() {
    return !!findWhisperServer() && !!findWhisperModel();
  }

  /** A model that passed its checksum, passing over any that don't (and deleting one only if JamSesh downloaded it). */
  private async goodModel(): Promise<string | null> {
    for (let model = findWhisperModel(this.bad); model; model = findWhisperModel(this.bad)) {
      this.set("starting", "Checking the speech model.");
      if (await verified(model)) return model;
      this.bad.add(model);
      if (mayReplace(model)) (rmSync(model, { force: true }), recordDownload(false));
    }
    return null;
  }

  /**
   * Starts whisper-server on `port` (or uses a whisper-server already answering there, never anything
   * else), downloading the model first when there's none and `download` allows it. Resolves with its URL,
   * or null with the reason in status().
   */
  async start(port: number, download: boolean): Promise<string | null> {
    this.stopped = false;
    const url = `http://127.0.0.1:${port}`;
    if (await ping(url)) {
      if (await isWhisperServer(url)) return this.set("ready", "Running on this host."), url;
      return this.set("failed", `Something other than whisper-server is using port ${port}. Free it or set JAMSESH_WHISPER_PORT.`), null;
    }
    const bin = findWhisperServer();
    if (!bin) return this.set("missing", "whisper-server isn't on this host."), null;
    try {
      let model = await this.goodModel();
      if (!model && !download) return this.set("missing", `The speech model isn't on this host (${Math.round(WHISPER_MODEL.bytes / 1e6)} MB download).`), null;
      model ??= await this.download();
      if (this.stopped) return null;
      this.set("starting", "Loading the speech model.");
      return await this.spawn(bin, model, port);
    } catch (e) {
      this.set("failed", (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 240));
      return null;
    }
  }

  /** Runs whisper-server and waits for it to transcribe. A server that dies or doesn't answer in time is stopped. */
  private async spawn(bin: string, model: string, port: number): Promise<string> {
    const url = `http://127.0.0.1:${port}`;
    // Its stdin is a pipe from the hub, so it ends when the hub does, even after kill -9 or a crash.
    const proc = Bun.spawn(withStdinWatch([bin, "-m", model, "--host", "127.0.0.1", "--port", String(port), "-t", "6", "--no-timestamps", "-l", "auto"]), { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
    this.proc = proc;
    let died: number | null = null;
    void proc.exited.then((code) => {
      died = code;
      if (this.stopped || this.proc !== proc) return;
      this.proc = null;
      this.set("failed", `whisper-server stopped (exit ${code}).`);
      this.onExit?.();
    });
    const until = Date.now() + this.startupMs;
    while (died === null && !this.stopped && Date.now() < until && !(await ping(url))) await Bun.sleep(250);
    if (died === null && !this.stopped && (await isWhisperServer(url))) {
      this.set("ready", "Running on this host.");
      return url;
    }
    const why = this.stopped ? "Stopped." : died !== null ? `whisper-server exited (${died}) while starting.` : "whisper-server didn't start in time.";
    if (this.proc === proc) this.proc = null;
    await stopHelper(proc);
    throw new Error(why);
  }

  private async download(): Promise<string> {
    const dir = join(config.home, "models");
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, WHISPER_MODEL.name);
    const part = `${dest}.part`;
    // Before 574 MB of download: it could only land over someone else's file.
    if (!mayReplace(dest)) throw new Error(KEPT_THEIRS(dest));
    this.set("downloading", `Downloading the speech model (${Math.round(WHISPER_MODEL.bytes / 1e6)} MB, once). The gateway covers the room meanwhile.`, 0);
    try {
      await downloadVerified(WHISPER_MODEL, part, (pct) => (this.progress = pct), () => this.stopped);
      // Asked again at the last moment: someone may have put a file there while it downloaded.
      if (!mayReplace(dest)) throw new Error(KEPT_THEIRS(dest));
      renameSync(part, dest);
      recordDownload(true);
      const st = statSync(dest);
      checked.set(dest, `${st.size}:${st.mtimeMs}:${WHISPER_MODEL.sha256}`);
      return dest;
    } finally {
      rmSync(part, { force: true });
    }
  }

  /** Stops the whisper-server this hub started (never one it found already running) and any download. */
  stop() {
    this.stopped = true;
    if (this.proc) void stopHelper(this.proc);
    this.proc = null;
  }
}

const KEPT_THEIRS = (path: string) => `A speech model JamSesh didn't download is at ${path}. It was left alone; move it away to let JamSesh download its own.`;

/**
 * The model file JamSesh downloaded itself, by the identity of that very file (device, inode, size, birth and
 * modification times) at ~/.jamsesh/models: the only file it ever deletes or replaces. A file put there later, even
 * with the same name, is someone else's. Earlier builds recorded only a file name, which proves nothing: ignored.
 */
const manifest = () => join(config.home, "models", "downloaded.json");
type Identity = { dev: number; ino: number; size: number; birth: number; mtime: number };

const identity = (path: string): Identity | null => {
  try {
    const st = lstatSync(path);
    return st.isFile() ? { dev: st.dev, ino: st.ino, size: st.size, birth: st.birthtimeMs, mtime: st.mtimeMs } : null;
  } catch {
    return null;
  }
};

function recorded(): Identity | null {
  try {
    const m: unknown = JSON.parse(readFileSync(manifest(), "utf8"));
    const r = m && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, unknown>)[WHISPER_MODEL.name] : null;
    const ok = r && typeof r === "object" && (["dev", "ino", "size", "birth", "mtime"] as const).every((k) => Number.isFinite((r as Record<string, unknown>)[k]));
    return ok ? (r as Identity) : null;
  } catch {
    return null;
  }
}

/** Records the file now at the managed path as JamSesh's own download, or (false) forgets it. */
export function recordDownload(on: boolean) {
  const own = on ? identity(join(config.home, "models", WHISPER_MODEL.name)) : null;
  const tmp = `${manifest()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(own ? { [WHISPER_MODEL.name]: own } : {}));
  renameSync(tmp, manifest());
}

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/**
 * Whether `path` is the exact file JamSesh downloaded: a plain file at its managed path (compared by real path)
 * whose identity is the one recorded when the download landed, and not a file chosen with JAMSESH_WHISPER_MODEL.
 */
export function ownDownload(path: string) {
  const own = join(config.home, "models", WHISPER_MODEL.name);
  const chosen = process.env.JAMSESH_WHISPER_MODEL;
  if (chosen && real(chosen) === real(path)) return false;
  if (real(path) !== real(own)) return false;
  const now = identity(own);
  const was = recorded();
  return !!now && !!was && now.dev === was.dev && now.ino === was.ino && now.size === was.size && now.birth === was.birth && now.mtime === was.mtime;
}

/**
 * THE ONE RULE FOR MODEL FILES: JamSesh deletes or writes over a model path only when nothing is there or what is
 * there is its own download (ownDownload). Every removal and the download's rename go through here.
 */
export function mayReplace(path: string) {
  const chosen = process.env.JAMSESH_WHISPER_MODEL;
  if (chosen && real(chosen) === real(path)) return false;
  try {
    lstatSync(path);
  } catch {
    return true;
  }
  return ownDownload(path);
}
