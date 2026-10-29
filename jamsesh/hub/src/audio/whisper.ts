// whisper.cpp on the host (5.2), the default engine. The Mac app ships `whisper-server` (built by
// app/build-whisper.sh, MIT); the model (574 MB) is downloaded on a Mac's first host session into
// ~/.jamsesh/models, checked against a pinned SHA-256, while the gateway covers the room. A model
// already in ~/.cache/whisper-cpp, or Homebrew's whisper-server, is used when found.

import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "../config";
import { downloadVerified, type ModelState, type ModelStatus } from "./models";

export const WHISPER_MODEL = {
  name: "ggml-large-v3-turbo-q5_0.bin",
  label: "Whisper large-v3-turbo",
  url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin",
  sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
  bytes: 574_041_195,
  licence: "Whisper weights MIT (OpenAI); whisper.cpp MIT",
};

const first = (paths: (string | undefined | false)[]) => paths.find((p): p is string => !!p && existsSync(p)) ?? null;

/** whisper-server: a chosen path, the app bundle, ~/.jamsesh/bin, then Homebrew's. */
export function findWhisperServer(): string | null {
  const res = process.env.JAMSESH_RESOURCES;
  return first([process.env.JAMSESH_WHISPER_SERVER, res && join(res, "bin", "whisper-server"), join(config.home, "bin", "whisper-server"), "/opt/homebrew/bin/whisper-server", "/usr/local/bin/whisper-server"]);
}

/** The model: a chosen file, ~/.jamsesh/models, then what install.sh or a person put in ~/.cache/whisper-cpp. */
export function findWhisperModel(): string | null {
  const cache = join(process.env.HOME || homedir(), ".cache", "whisper-cpp");
  return first([
    process.env.JAMSESH_WHISPER_MODEL,
    join(config.home, "models", WHISPER_MODEL.name),
    join(cache, "ggml-large-v3-turbo-q5_0.bin"),
    join(cache, "ggml-large-v3-turbo.bin"),
    join(cache, "ggml-medium.en.bin"),
    join(cache, "ggml-base.en.bin"),
  ]);
}

/** The port the host's whisper-server listens on. */
export const whisperPort = () => Number(process.env.JAMSESH_WHISPER_PORT) || 8178;

export async function ping(url: string) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(800) });
    return r.status < 500;
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

  status(): ModelStatus {
    return { engine: WHISPER_MODEL.label, state: this.state, detail: this.detail, progress: this.progress, sizeMb: Math.round(WHISPER_MODEL.bytes / 1e6), installed: !!findWhisperModel(), source: WHISPER_MODEL.url, licence: WHISPER_MODEL.licence };
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

  /**
   * Starts whisper-server on `port` (or uses one already answering there), downloading the model
   * first when there's none and `download` allows it. Resolves with its URL, or null with the reason in status().
   */
  async start(port: number, download: boolean): Promise<string | null> {
    this.stopped = false;
    const url = `http://127.0.0.1:${port}`;
    if (await ping(url)) return this.set("ready", "Running on this host."), url;
    const bin = findWhisperServer();
    if (!bin) return this.set("missing", "whisper-server isn't on this host."), null;
    let model = findWhisperModel();
    if (!model && !download) return this.set("missing", `The speech model isn't on this host (${Math.round(WHISPER_MODEL.bytes / 1e6)} MB download).`), null;
    try {
      model ??= await this.download();
      if (this.stopped) return null;
      this.set("starting", "Loading the speech model.");
      this.proc = Bun.spawn([bin, "-m", model, "--host", "127.0.0.1", "--port", String(port), "-t", "6", "--no-timestamps", "-l", "auto"], { stdout: "ignore", stderr: "ignore" });
      for (let i = 0; i < 60 && !(await ping(url)); i++) await Bun.sleep(250);
      if (!(await ping(url))) throw new Error("whisper-server didn't start.");
      this.set("ready", "Running on this host.");
      return url;
    } catch (e) {
      this.set("failed", (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 240));
      return null;
    }
  }

  private async download(): Promise<string> {
    const dir = join(config.home, "models");
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, WHISPER_MODEL.name);
    const part = `${dest}.part`;
    this.set("downloading", `Downloading the speech model (${Math.round(WHISPER_MODEL.bytes / 1e6)} MB, once). The gateway covers the room meanwhile.`, 0);
    try {
      await downloadVerified(WHISPER_MODEL, part, (pct) => (this.progress = pct), () => this.stopped);
      renameSync(part, dest);
      return dest;
    } finally {
      rmSync(part, { force: true });
    }
  }

  /** Stops the whisper-server this hub started (never one it found already running) and any download. */
  stop() {
    this.stopped = true;
    this.proc?.kill();
    this.proc = null;
  }
}
