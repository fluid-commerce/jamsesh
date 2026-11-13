// The Parakeet child process (5.2): a whisper.cpp-shaped POST /inference on 127.0.0.1, so the hub's
// engine pool treats it like any other local engine. The form carries `file` (a WAV) and, optionally,
// `hotwords` ("Chey/JamSesh/left-hand nav"). Prints "listening <port>" once the model is loaded.
// It runs the GGUF model through transcribe.cpp (the `transcribe-cpp` package), on the Mac's GPU
// (Metal) on Apple silicon.

import { config } from "../config";
import { decodeWav, resample } from "./wav";

/** The longest clip it decodes; the pipeline's clips are 15 s at most. */
const MAX_SECONDS = 60;
/** The model's input rate. */
const RATE = 16_000;
/** No more terms than the hub sends (vocabulary.ts `hotwords`). */
const MAX_TERMS = 120;

/** The `transcribe-cpp` module. Inside the Mac app the hub is one compiled program, so it's found in the bundled node_modules at run time, never bundled. */
export async function loadTranscribeCpp(): Promise<typeof import("transcribe-cpp")> {
  const where: string = config.nodeModules ? Bun.resolveSync("transcribe-cpp", config.nodeModules) : "transcribe-cpp";
  return await import(where);
}

/** The hub's `hotwords` field ("Chey/JamSesh/left-hand nav") as a list of terms, in order, without junk. */
export function vocabularyFrom(hotwords: string): string[] {
  const seen = new Set<string>();
  for (const raw of hotwords.slice(0, 4000).split("/")) {
    const term = raw.replace(/[^\p{L}\p{N}' .&-]+/gu, " ").replace(/\s+/g, " ").trim();
    if (term && !seen.has(term)) seen.add(term);
    if (seen.size >= MAX_TERMS) break;
  }
  return [...seen];
}

/** What the server needs of a loaded model (transcribe-cpp's TranscribeModel). */
export interface SttModel {
  supports(feature: "vocabulary"): boolean;
  transcribe(pcm: Float32Array, opts: { vocabulary?: readonly string[] }): Promise<{ text: string }>;
}

/** The server's request handler: POST /inference with `file` (a WAV) and optional `hotwords`, answering `{text}` or `{error}`. */
export function sttHandler(asr: SttModel) {
  // Parakeet in transcribe.cpp takes no word list today; when a build does, the room's words go to it.
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
  const { TranscribeModel } = await loadTranscribeCpp();
  const asr = await TranscribeModel.load(model);
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
