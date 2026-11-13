// Parakeet (5.2): NVIDIA's Parakeet TDT 0.6B v3 speech model (25 European languages), the host's
// default engine (Settings > Transcription > Faster engine, on unless the room turns it off). It runs
// through transcribe.cpp (the `transcribe-cpp` package) on the Mac's GPU (Metal). The model (740 MB,
// one GGUF file) is downloaded the first time a host needs it, into ~/.jamsesh/models, and checked
// against a pinned size and hash; whisper.cpp or the gateway carry the room until it's ready. It runs
// in a child process (stt-server.ts): a decode never blocks the hub, and its memory goes back when
// the hub stops.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type HelperRegistry, stopHelper } from "../children";
import { config } from "../config";
import { downloadVerified, sha256File, type ModelState, type ModelStatus } from "./models";

export type { ModelState, ModelStatus };

/** The GGUF file, from handy-computer's Hugging Face repository at a fixed revision (an immutable URL). */
const GGUF = "parakeet-tdt-0.6b-v3-Q8_0.gguf";

export const PARAKEET = {
  name: "parakeet-tdt-0.6b-v3-q8_0",
  label: "Parakeet TDT 0.6B v3",
  url: `https://huggingface.co/handy-computer/parakeet-tdt-0.6b-v3-gguf/resolve/d8d8c32cb2017c57e5307767343e97870f8a7f53/${GGUF}`,
  sha256: "5859f77944efcd8eafa23a6350731960b2b55b2203df51f319665c807d802cc7",
  bytes: 739_508_576,
  files: [GGUF],
  licence: "Model CC-BY-4.0 (NVIDIA), converted to GGUF by transcribe.cpp (MIT)",
};

/** The languages Parakeet TDT 0.6B v3 transcribes (its model card); any other, and "auto", go to whisper. */
export const PARAKEET_LANGUAGES: ReadonlySet<string> = new Set(["bg", "hr", "cs", "da", "nl", "en", "et", "fi", "fr", "de", "el", "hu", "it", "lv", "lt", "mt", "pl", "pt", "ro", "ru", "sk", "sl", "es", "sv", "uk"]);

const has = (dir: string) => PARAKEET.files.every((f) => existsSync(join(dir, f)));

/** Where the model is on this machine: a chosen folder, the app bundle, or ~/.jamsesh/models. */
export function findModel(): string | null {
  const own = join(config.home, "models", PARAKEET.name);
  const places = [process.env.JAMSESH_PARAKEET_DIR, process.env.JAMSESH_RESOURCES && join(process.env.JAMSESH_RESOURCES, "models", PARAKEET.name), own];
  return places.find((p): p is string => !!p && has(p)) ?? null;
}

const MANIFEST = ".files.sha256.json";

/** The SHA-256 of every model file, recorded when the verified download was installed. */
export const writeManifest = async (dir: string) => writeFileSync(join(dir, MANIFEST), JSON.stringify(Object.fromEntries(await Promise.all(PARAKEET.files.map(async (f) => [f, await sha256File(join(dir, f))])))));

/**
 * Whether the unpacked files are still the ones that were verified. A managed folder without a
 * readable manifest can't be verified, so it isn't intact (the caller reinstalls it from the pinned
 * download); a chosen folder or the app bundle is the person's own and isn't second-guessed.
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
  for (const f of PARAKEET.files) if ((await sha256File(join(dir, f))) !== want[f]) return false;
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
  const model = join(dir, GGUF);
  return import.meta.dir.includes("$bunfs") ? [process.execPath, "--stt-server", model] : [process.execPath, join(import.meta.dir, "stt-server.ts"), model];
}

/** Moves a model folder JamSesh can't vouch for out of the way, keeping it (the name says why), so nothing a person put there is lost. */
function setAside(path: string) {
  renameSync(path, `${path}.unverified-${Date.now()}`);
}

export class Parakeet {
  /** The hub's helper list, so stopping the hub finds the server this starts (none when used alone). */
  constructor(private helpers?: HelperRegistry) {}

  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private state: ModelState = "off";
  private detail = "Off. Turn on the faster engine in Settings.";
  private progress: number | null = null;
  private stopped = false;
  /** Moves on every start and every stop: a start that finds it changed after a wait was stopped (or replaced) and changes no files. */
  private gen = 0;
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
    const my = ++this.gen;
    const gone = () => this.gen !== my;
    // Never rejects: every failure, finding and checking the model included, is a failed status (callers fire and forget).
    try {
      let dir = findModel();
      const own = join(config.home, "models", PARAKEET.name);
      // Whatever spelling found it (models/./name, a symlink), the managed model is checked against its manifest.
      if (dir && samePath(dir, own) && !(await installedIntact(own).catch(() => false))) {
        if (gone()) throw new Error("stopped"); // turned off while it was being checked: nothing is moved
        // A file changed after it was verified, or the folder was never JamSesh's: it isn't loaded, and it is moved aside (never deleted: it may be someone's own model); a fresh copy replaces it where downloads are allowed.
        try {
          setAside(own);
        } catch (e) {
          throw new Error(`The speech model at ${own} changed and couldn't be removed (${e instanceof Error ? e.message : String(e)}).`);
        }
        dir = findModel();
      }
      if (!dir && !download) return this.set("missing", `The speech model isn't on this host (${Math.round(PARAKEET.bytes / 1e6)} MB download).`), null;
      dir ??= await this.download(gone);
      if (gone()) return null;
      this.set("starting", "Loading the speech model.");
      const url = await this.spawn(dir);
      if (gone()) return this.stop(), null;
      this.set("ready", `Running on this host (${PARAKEET.label}).`);
      return url;
    } catch (e) {
      if (gone()) return this.stopped ? (this.set("off", "Off. Turn on the faster engine in Settings."), null) : null;
      this.set("failed", (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 240));
      return null;
    }
  }

  private async download(gone: () => boolean = () => this.stopped): Promise<string> {
    const models = join(config.home, "models");
    mkdirSync(models, { recursive: true });
    const work = mkdtempSync(join(models, ".parakeet-"));
    try {
      this.set("downloading", `Downloading the speech model (${Math.round(PARAKEET.bytes / 1e6)} MB, once).`, 0);
      const unpacked = join(work, PARAKEET.name);
      mkdirSync(unpacked);
      await downloadVerified(PARAKEET, join(unpacked, GGUF), (pct) => (this.progress = pct), gone);
      const dest = join(models, PARAKEET.name);
      if (gone()) throw new Error("stopped"); // turned off during the download: nothing is installed
      if (existsSync(dest)) setAside(dest);
      await writeManifest(unpacked);
      if (gone()) throw new Error("stopped");
      renameSync(unpacked, dest);
      return dest;
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  private async spawn(dir: string): Promise<string> {
    this.helpers?.assertOpen(); // the hub is stopping: no new helper (checked right before the spawn)
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
    this.gen++;
    if (this.proc) void stopHelper(this.proc);
    this.proc = null;
    if (this.state !== "off") this.set("off", "Off. Turn on the faster engine in Settings.");
  }
}
