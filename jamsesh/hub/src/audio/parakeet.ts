// Parakeet (5.2): NVIDIA's Parakeet TDT 0.6B v2 speech model, the host's opt-in faster engine
// (Settings > Transcription; whisper.cpp is the default until real-room clips decide). It runs through
// sherpa-onnx, the library the app already ships for voiceprints, so there's no new runtime. The
// model (482 MB) is downloaded the first time a host needs it, into ~/.jamsesh/models, and checked
// against a pinned hash. It runs in a child process (stt-server.ts): a decode never blocks the hub,
// and its memory (about 2 GB) goes back when the hub stops.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type HelperRegistry, stopHelper } from "../children";
import { config } from "../config";
import { downloadVerified, type ModelState, type ModelStatus } from "./models";

export type { ModelState, ModelStatus };

export const PARAKEET = {
  name: "parakeet-tdt-0.6b-v2-int8",
  label: "Parakeet TDT 0.6B v2",
  url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2",
  sha256: "157c157bc51155e03e37d2466522a3a737dd9c72bb25f36eb18912964161e1ad",
  bytes: 482_468_385,
  files: ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"],
  licence: "Model CC-BY-4.0 (NVIDIA), converted by sherpa-onnx (Apache-2.0)",
};

const has = (dir: string) => PARAKEET.files.every((f) => existsSync(join(dir, f)));

/** Where the model is on this machine: a chosen folder, the app bundle, or ~/.jamsesh/models. */
export function findModel(): string | null {
  const own = join(config.home, "models", PARAKEET.name);
  const places = [process.env.JAMSESH_PARAKEET_DIR, process.env.JAMSESH_RESOURCES && join(process.env.JAMSESH_RESOURCES, "models", PARAKEET.name), own];
  return places.find((p): p is string => !!p && has(p)) ?? null;
}

const MANIFEST = ".files.sha256.json";

const hashFile = async (path: string) => {
  const h = createHash("sha256");
  for await (const chunk of Bun.file(path).stream()) h.update(chunk);
  return h.digest("hex");
};

/** The SHA-256 of every model file, recorded when the verified archive was unpacked. */
export const writeManifest = async (dir: string) => writeFileSync(join(dir, MANIFEST), JSON.stringify(Object.fromEntries(await Promise.all(PARAKEET.files.map(async (f) => [f, await hashFile(join(dir, f))])))));

/**
 * Whether the unpacked files are still the ones that were verified. A managed folder without a
 * readable manifest can't be verified, so it isn't intact (the caller reinstalls it from the pinned
 * archive); a chosen folder or the app bundle is the person's own and isn't second-guessed.
 */
export async function installedIntact(dir: string, managed = true): Promise<boolean> {
  if (!managed) return true;
  let want: Record<string, unknown>;
  try {
    want = JSON.parse(readFileSync(join(dir, MANIFEST), "utf8"));
    if (!want || typeof want !== "object") return false;
  } catch {
    return false;
  }
  for (const f of PARAKEET.files) if ((await hashFile(join(dir, f))) !== want[f]) return false;
  return true;
}

function samePath(a: string, b: string) {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return resolve(a) === resolve(b);
  }
}

/** How to start the child: this binary with a flag when compiled, otherwise bun on the script. */
function serverArgv(dir: string): string[] {
  return import.meta.dir.includes("$bunfs") ? [process.execPath, "--stt-server", dir] : [process.execPath, join(import.meta.dir, "stt-server.ts"), dir];
}

export class Parakeet {
  /** The hub's helper list, so stopping the hub finds the server this starts (none when used alone). */
  constructor(private helpers?: HelperRegistry) {}

  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private state: ModelState = "off";
  private detail = "Off. Turn on the faster engine in Settings.";
  private progress: number | null = null;
  private stopped = false;
  /** Called when a running engine's process ends on its own. */
  onExit: (() => void) | null = null;

  status(): ModelStatus {
    return { engine: PARAKEET.label, state: this.state, detail: this.detail, progress: this.progress, sizeMb: Math.round(PARAKEET.bytes / 1e6), installed: !!findModel(), source: PARAKEET.url, licence: PARAKEET.licence };
  }

  private set(state: ModelState, detail: string, progress: number | null = null) {
    this.state = state;
    this.detail = detail;
    this.progress = progress;
  }

  /**
   * Starts the engine, downloading the model first when this host doesn't have it and `download`
   * allows it. Resolves with the engine's URL, or null with the reason in status().
   */
  async start(download: boolean): Promise<string | null> {
    if (process.env.JAMSESH_PARAKEET === "0") return this.set("off", "Turned off on this host (JAMSESH_PARAKEET=0)."), null;
    this.stopped = false;
    let dir = findModel();
    const own = join(config.home, "models", PARAKEET.name);
    // Whatever spelling found it (models/./name, a symlink), the managed model is checked against its manifest.
    if (dir && samePath(dir, own) && !(await installedIntact(own).catch(() => false))) {
      // A file changed after it was verified: it isn't loaded, and a fresh copy replaces it where downloads are allowed.
      rmSync(own, { recursive: true, force: true });
      dir = findModel();
    }
    if (!dir && !download) return this.set("missing", `The speech model isn't on this host (${Math.round(PARAKEET.bytes / 1e6)} MB download).`), null;
    try {
      dir ??= await this.download();
      if (this.stopped) return null;
      this.set("starting", "Loading the speech model.");
      const url = await this.spawn(dir);
      if (this.stopped) return this.stop(), null;
      this.set("ready", `Running on this host (${PARAKEET.label}).`);
      return url;
    } catch (e) {
      if (this.stopped) return this.set("off", "Off. Turn on the faster engine in Settings."), null;
      this.set("failed", (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 240));
      return null;
    }
  }

  private async download(): Promise<string> {
    const models = join(config.home, "models");
    mkdirSync(models, { recursive: true });
    const work = mkdtempSync(join(models, ".parakeet-"));
    try {
      this.set("downloading", `Downloading the speech model (${Math.round(PARAKEET.bytes / 1e6)} MB, once).`, 0);
      const archive = join(work, "model.tar.bz2");
      await downloadVerified(PARAKEET, archive, (pct) => (this.progress = pct), () => this.stopped);
      const tar = Bun.spawnSync(["tar", "-xjf", archive, "-C", work], { stdout: "ignore", stderr: "pipe" });
      if (tar.exitCode !== 0) throw new Error(`Couldn't unpack the speech model: ${tar.stderr.toString().trim().slice(0, 120)}`);
      const unpacked = join(work, `sherpa-onnx-nemo-${PARAKEET.name}`);
      if (!has(unpacked)) throw new Error("The speech model archive is missing files.");
      const dest = join(models, PARAKEET.name);
      rmSync(dest, { recursive: true, force: true });
      await writeManifest(unpacked);
      renameSync(unpacked, dest);
      return dest;
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  private async spawn(dir: string): Promise<string> {
    // Its stdin is a pipe from the hub, so it ends when the hub does, even after kill -9 or a crash.
    const proc = Bun.spawn(serverArgv(dir), { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, JAMSESH_STT_PARENT_PIPE: "1" } });
    this.proc = proc;
    this.helpers?.track(proc);
    // Keep the end of its error output for the reason, and keep the pipe drained so it never blocks.
    let tail = "";
    void (async () => {
      for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) tail = (tail + new TextDecoder().decode(chunk)).slice(-600);
    })().catch(() => {});
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    let seen = "";
    const ready = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return null;
        seen += new TextDecoder().decode(value);
        const m = seen.match(/listening (\d+)/);
        if (m) return Number(m[1]);
      }
    })();
    const port = await Promise.race([ready, Bun.sleep(90_000).then(() => null)]);
    reader.releaseLock();
    if (!port) {
      void stopHelper(proc);
      this.proc = null;
      await Bun.sleep(300);
      const why = tail.trim().split("\n").pop()?.slice(0, 160);
      throw new Error(`The speech model didn't start${why ? `: ${why}` : "."}`);
    }
    void proc.exited.then((code) => {
      if (this.stopped || this.proc !== proc) return;
      this.proc = null;
      this.set("failed", `The speech model stopped (exit ${code})${tail.trim() ? `: ${tail.trim().split("\n").pop()?.slice(0, 160)}` : "."}`);
      this.onExit?.();
    });
    return `http://127.0.0.1:${port}`;
  }

  /** Stops the engine, or a download in progress; start() can run again afterwards. */
  stop() {
    this.stopped = true;
    if (this.proc) void stopHelper(this.proc);
    this.proc = null;
    if (this.state !== "off") this.set("off", "Off. Turn on the faster engine in Settings.");
  }
}
