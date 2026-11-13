// The Parakeet child process (5.2): a whisper.cpp-shaped POST /inference on 127.0.0.1, so the hub's
// engine pool treats it like any other local engine. The form carries `file` (a WAV) and, optionally,
// `hotwords` ("Chey/JamSesh/left-hand nav"). Prints "listening <port>" once the model is loaded.
// It runs the GGUF model through transcribe.cpp (the `transcribe-cpp` package), on the Mac's GPU
// (Metal) on Apple silicon, with Hex's fork of the library when it's there (app/build-transcribe.sh),
// which rescores the words Parakeet heard against the room's list.

import { config } from "../config";
import { verifiedLibrary } from "./transcribe-lib";
import { decodeWav, resample } from "./wav";

/** The longest clip it decodes; the pipeline's clips are 15 s at most. */
const MAX_SECONDS = 60;
/** The model's input rate. */
const RATE = 16_000;
/** The most terms Parakeet's rescoring takes (Hex's fork caps it at 64 too); the first ones win. */
export const MAX_TERMS = 64;

/**
 * The `transcribe-cpp` module, bound to the pinned library (transcribe-lib.ts): whatever library an
 * environment variable names is dropped first, and the binding is pointed at the verified one, so
 * it loads nothing else. Inside the Mac app the hub is one compiled program, so the binding is found
 * in the bundled node_modules at run time, never bundled.
 */
export async function loadTranscribeCpp(): Promise<typeof import("transcribe-cpp")> {
  delete process.env.TRANSCRIBE_LIBRARY;
  process.env.TRANSCRIBE_LIBRARY = await verifiedLibrary(process.env, config.home);
  const where: string = config.nodeModules ? Bun.resolveSync("transcribe-cpp", config.nodeModules) : Bun.resolveSync("transcribe-cpp", import.meta.dir);
  await keepKoffiArrays(Bun.resolveSync("koffi", where));
  return await import(where);
}

/**
 * The binding makes a new koffi array type for every run's word list. Under Bun a koffi type that is
 * garbage-collected aborts the process (its finalizer isn't GC-safe), so each array type is made once
 * and kept: at most one per list length.
 */
async function keepKoffiArrays(koffiPath: string) {
  // The module the binding imports (koffi's ESM entry), not a second copy through require.
  const koffi = (await import(koffiPath)).default as { array: (...a: unknown[]) => unknown; __jamKept?: boolean };
  if (koffi.__jamKept) return;
  const make = koffi.array.bind(koffi);
  const kept = new Map<string, unknown>();
  koffi.array = (type: unknown, length: unknown, ...rest: unknown[]) => {
    // Bounded: word lists are at most MAX_TERMS long; anything else is made as usual.
    if (typeof type !== "string" || typeof length !== "number" || length > 256 || rest.length) return make(type, length, ...rest);
    const key = `${type}\u0000${length}`;
    if (!kept.has(key)) kept.set(key, make(type, length));
    return kept.get(key);
  };
  koffi.__jamKept = true;
}

/**
 * The hub's `hotwords` field ("Chey/chey/JamSesh/jamsesh/left-hand nav", people and agents first) as
 * the model's vocabulary: single words only, in order, one per spelling, at most MAX_TERMS. A term of
 * several words ("left-hand nav", "Felipe's Codex") isn't rescored: the fork's rescoring was seen to
 * write "left-hand nav nav". Those stay with the correction pass, which gets the whole list.
 */
export function vocabularyFrom(hotwords: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of hotwords.slice(0, 4000).split("/")) {
    const term = raw.replace(/[^\p{L}\p{N}' .&-]+/gu, " ").replace(/\s+/g, " ").trim();
    const key = term.toLowerCase();
    if (!term || /[\s-]/.test(term) || seen.has(key)) continue;
    seen.add(key);
    out.push(term);
    if (out.length >= MAX_TERMS) break;
  }
  return out;
}

/** What the server needs of a loaded model (transcribe-cpp's TranscribeModel). */
export interface SttModel {
  supports(feature: "vocabulary"): boolean;
  transcribe(pcm: Float32Array, opts: { vocabulary?: readonly string[] }): Promise<{ text: string }>;
}

/** The server's request handler: POST /inference with `file` (a WAV) and optional `hotwords`, answering `{text}` or `{error}`. */
export function sttHandler(asr: SttModel) {
  // Hex's fork rescores Parakeet's words against the list (2.5 nats per piece, its default); upstream transcribe.cpp takes none.
  const biased = asr.supports("vocabulary");
  return async (req: Request): Promise<Response> => {
    if (new URL(req.url).pathname !== "/inference") return new Response("parakeet");
    if (req.method !== "POST") return Response.json({ error: "POST a WAV file" }, { status: 405 });
    try {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof Blob)) return Response.json({ error: "no file" }, { status: 400 });
      const pcm = decodeWav(new Uint8Array(await file.arrayBuffer()));
      if (pcm.samples.length > pcm.sampleRate * MAX_SECONDS) return Response.json({ error: "clip too long" }, { status: 413 });
      if (!pcm.samples.length) return Response.json({ text: "" });
      const vocabulary = biased ? vocabularyFrom(String(form.get("hotwords") ?? "")) : [];
      const r = await asr.transcribe(resample(pcm, RATE).samples, vocabulary.length ? { vocabulary } : {});
      return Response.json({ text: String(r.text ?? "") });
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
    }
  };
}

export async function runSttServer(model: string) {
  let asr: Awaited<ReturnType<Awaited<ReturnType<typeof loadTranscribeCpp>>["TranscribeModel"]["load"]>>;
  try {
    const { TranscribeModel } = await loadTranscribeCpp();
    asr = await TranscribeModel.load(model);
  } catch (e) {
    // The hub shows the last line of this as the reason, and whisper carries the room.
    console.error((e instanceof Error ? e.message : String(e)).replace(/\s+/g, " "));
    process.exit(1);
  }
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: 8 * 1024 * 1024, fetch: sttHandler(asr) });
  console.log(`listening ${server.port}`);
  if (process.env.JAMSESH_STT_PARENT_PIPE === "1") {
    // The hub holds the other end: when it's gone, for any reason, so is this process.
    for await (const _ of Bun.stdin.stream());
    process.exit(0);
  }
  await new Promise(() => {});
}

if (import.meta.main) await runSttServer(process.argv[2] ?? "");
