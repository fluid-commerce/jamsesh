// The Parakeet child process (5.2): a whisper.cpp-shaped POST /inference on 127.0.0.1, so the hub's
// engine pool treats it like any other local engine. The form carries `file` (a WAV) and, optionally,
// `hotwords` ("Chey/JamSesh/left-hand nav"). Prints "listening <port>" once the model is loaded.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { config } from "../config";
import { decodeWav } from "./wav";

/** The longest clip it decodes; the pipeline's clips are 15 s at most. */
const MAX_SECONDS = 60;

export async function runSttServer(dir: string) {
  const sherpa = config.nodeModules ? createRequire(join(config.nodeModules, "index.js"))("sherpa-onnx-node") : require("sherpa-onnx-node");
  // Hotwords are written as plain words when sherpa-onnx has the model's word pieces as a BPE vocabulary.
  const models = join(config.home, "models");
  mkdirSync(models, { recursive: true });
  const bpeVocab = join(models, "parakeet-bpe.vocab");
  const pieces = readFileSync(join(dir, "tokens.txt"), "utf8").split("\n").filter(Boolean);
  writeFileSync(bpeVocab, pieces.map((l, i) => `${l.split(" ")[0]} ${-i}`).join("\n") + "\n");
  const rec = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: join(dir, "encoder.int8.onnx"), decoder: join(dir, "decoder.int8.onnx"), joiner: join(dir, "joiner.int8.onnx") },
      tokens: join(dir, "tokens.txt"),
      numThreads: 4,
      modelType: "nemo_transducer",
      modelingUnit: "bpe",
      bpeVocab,
      debug: 0,
    },
    // Hotwords need beam search. Score 2 was best of 1, 1.5, 2 and 3 in the bake-off.
    decodingMethod: "modified_beam_search",
    maxActivePaths: 4,
    hotwordsScore: 2.0,
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodySize: 8 * 1024 * 1024,
    async fetch(req) {
      if (new URL(req.url).pathname !== "/inference") return new Response("parakeet");
      if (req.method !== "POST") return Response.json({ error: "POST a WAV file" }, { status: 405 });
      try {
        const form = await req.formData();
        const file = form.get("file");
        if (!(file instanceof Blob)) return Response.json({ error: "no file" }, { status: 400 });
        const pcm = decodeWav(new Uint8Array(await file.arrayBuffer()));
        if (pcm.samples.length > pcm.sampleRate * MAX_SECONDS) return Response.json({ error: "clip too long" }, { status: 413 });
        if (!pcm.samples.length) return Response.json({ text: "" });
        const hot = String(form.get("hotwords") ?? "").replace(/[^\p{L}\p{N}' ./&-]+/gu, " ").slice(0, 4000);
        const stream = hot.trim() ? rec.createStream(hot) : rec.createStream();
        stream.acceptWaveform({ sampleRate: pcm.sampleRate, samples: pcm.samples });
        rec.decode(stream);
        return Response.json({ text: String(rec.getResult(stream).text ?? "") });
      } catch (e) {
        return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
      }
    },
  });
  console.log(`listening ${server.port}`);
  if (process.env.JAMSESH_STT_PARENT_PIPE === "1") {
    // The hub holds the other end: when it's gone, for any reason, so is this process.
    for await (const _ of Bun.stdin.stream());
    process.exit(0);
  }
  await new Promise(() => {});
}

if (import.meta.main) await runSttServer(process.argv[2] ?? "");
