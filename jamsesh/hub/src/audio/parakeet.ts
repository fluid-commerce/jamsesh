// Parakeet (5.2): NVIDIA's Parakeet TDT 0.6B v2 speech model, the host's opt-in faster engine
// (Settings > Transcription; whisper.cpp is the default until real-room clips decide). It runs through
// sherpa-onnx, the library the app already ships for voiceprints, so there's no new runtime. The
// model (482 MB) is downloaded the first time a host needs it, into ~/.jamsesh/models, and checked
// against a pinned hash. It runs in a child process (stt-server.ts): a decode never blocks the hub,
// and its memory (about 2 GB) goes back when the hub stops.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { stopHelper } from "../children";
import { config } from "../config";

export const PARAKEET = {
  name: "parakeet-tdt-0.6b-v2-int8",
  label: "Parakeet TDT 0.6B v2",
  url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2",
  sha256: "157c157bc51155e03e37d2466522a3a737dd9c72bb25f36eb18912964161e1ad",
  bytes: 482_468_385,
  files: ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"],
  licence: "Model CC-BY-4.0 (NVIDIA), converted by sherpa-onnx (Apache-2.0)",
};

export type ModelState = "ready" | "starting" | "downloading" | "missing" | "failed" | "off";

export interface ModelStatus {
  engine: string;
  state: ModelState;
  /** A sentence for Settings and /engines: what it's doing, or why it isn't running. */
  detail: string;
  /** Download progress, 0 to 100, while downloading. */
  progress: number | null;
  sizeMb: number;
  /** The model is on this machine. */
  installed: boolean;
  source: string;
  licence: string;
}

const has = (dir: string) => PARAKEET.files.every((f) => existsSync(join(dir, f)));

/** Where the model is on this machine: a chosen folder, the app bundle, or ~/.jamsesh/models. */
export function findModel(): string | null {
  const own = join(config.home, "models", PARAKEET.name);
  const places = [process.env.JAMSESH_PARAKEET_DIR, process.env.JAMSESH_RESOURCES && join(process.env.JAMSESH_RESOURCES, "models", PARAKEET.name), own];
  return places.find((p): p is string => !!p && has(p)) ?? null;
}

/** How to start the child: this binary with a flag when compiled, otherwise bun on the script. */
function serverArgv(dir: string): string[] {
  return import.meta.dir.includes("$bunfs") ? [process.execPath, "--stt-server", dir] : [process.execPath, join(import.meta.dir, "stt-server.ts"), dir];
}

export class Parakeet {
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
      const r = await fetch(PARAKEET.url, { redirect: "follow" });
      if (!r.ok || !r.body) throw new Error(`Couldn't download the speech model: HTTP ${r.status}.`);
      const archive = join(work, "model.tar.bz2");
      const out = Bun.file(archive).writer();
      const hash = createHash("sha256");
      let got = 0;
      for await (const chunk of r.body) {
        if (this.stopped) throw new Error("Stopped while downloading.");
        hash.update(chunk);
        out.write(chunk);
        got += chunk.byteLength;
        if (got > PARAKEET.bytes) throw new Error("The speech model download is larger than expected.");
        this.progress = Math.floor((100 * got) / PARAKEET.bytes);
      }
      await out.end();
      if (hash.digest("hex") !== PARAKEET.sha256) throw new Error("The speech model download didn't match its checksum.");
      const tar = Bun.spawnSync(["tar", "-xjf", archive, "-C", work], { stdout: "ignore", stderr: "pipe" });
      if (tar.exitCode !== 0) throw new Error(`Couldn't unpack the speech model: ${tar.stderr.toString().trim().slice(0, 120)}`);
      const unpacked = join(work, `sherpa-onnx-nemo-${PARAKEET.name}`);
      if (!has(unpacked)) throw new Error("The speech model archive is missing files.");
      const dest = join(models, PARAKEET.name);
      rmSync(dest, { recursive: true, force: true });
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
