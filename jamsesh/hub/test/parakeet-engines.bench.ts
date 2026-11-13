// A benchmark, not a test (never run in CI): times the old Parakeet engine (TDT 0.6B v2 int8 ONNX
// through sherpa-onnx, on the CPU) against the new one (TDT 0.6B v3 Q8_0 GGUF through transcribe.cpp,
// on the GPU) on the same clips. Each engine runs in its own process so their memory is measured
// apart. Clips are spoken with `say -o` (writes a file, plays nothing).
//
//   bun test/parakeet-engines.bench.ts --v2 <sherpa-onnx v2 int8 folder> --v3 <the .gguf> [--runs 7]
//
// Prints, per engine: model load, the median time per clip for a ~2.5 s and a ~9 s clip, the
// transcript, and the process's peak memory.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeWav } from "../src/audio/wav";

process.env.JAMSESH_SILENT = "1";

const CLIPS = {
  short: "Shay, put JamSesh on the big screen.",
  long: "Felipe, can you move the left-hand nav into FigCraft, then send the passport menu to Britt so she can check the payments workstream before lunch?",
};
const HOTWORDS = ["Chey", "JamSesh", "FigCraft", "Felipe", "Britt", "Passport", "left-hand nav", "workstream", "payments"];

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? NaN;

/** One engine, in this process: load, then each clip `runs` times. */
async function worker(engine: "v2" | "v3", model: string, files: string[], runs: number) {
  const pcms = files.map((f) => decodeWav(new Uint8Array(require("node:fs").readFileSync(f))));
  const t0 = performance.now();
  let run: (samples: Float32Array) => Promise<string>;
  if (engine === "v2") {
    // The engine stt-server.ts ran before transcribe.cpp: same settings (beam search with hotwords, 4 threads).
    const sherpa = require("sherpa-onnx-node");
    const bpeVocab = join(mkdtempSync(join(tmpdir(), "pk-bench-")), "bpe.vocab");
    const pieces = require("node:fs").readFileSync(join(model, "tokens.txt"), "utf8").split("\n").filter(Boolean);
    require("node:fs").writeFileSync(bpeVocab, pieces.map((l: string, i: number) => `${l.split(" ")[0]} ${-i}`).join("\n") + "\n");
    const rec = new sherpa.OfflineRecognizer({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: { transducer: { encoder: join(model, "encoder.int8.onnx"), decoder: join(model, "decoder.int8.onnx"), joiner: join(model, "joiner.int8.onnx") }, tokens: join(model, "tokens.txt"), numThreads: 4, modelType: "nemo_transducer", modelingUnit: "bpe", bpeVocab, debug: 0 },
      decodingMethod: "modified_beam_search",
      maxActivePaths: 4,
      hotwordsScore: 2.0,
    });
    run = async (samples) => {
      const stream = rec.createStream(HOTWORDS.join("/"));
      stream.acceptWaveform({ sampleRate: 16000, samples });
      rec.decode(stream);
      return String(rec.getResult(stream).text ?? "");
    };
  } else {
    const { TranscribeModel } = await import("transcribe-cpp");
    const asr = await TranscribeModel.load(model);
    const vocabulary = asr.supports("vocabulary") ? HOTWORDS : undefined;
    console.error(`v3 backend: ${asr.backend} (${asr.device.description}); vocabulary supported: ${!!vocabulary}`);
    run = async (samples) => (await asr.transcribe(samples, vocabulary ? { vocabulary } : {})).text;
  }
  const loadMs = performance.now() - t0;
  const out = pcms.map((pcm, i) => {
    return { file: files[i], seconds: pcm.samples.length / pcm.sampleRate, times: [] as number[], text: "" };
  });
  for (const [i, pcm] of pcms.entries()) {
    await run(pcm.samples); // warm-up, not counted
    for (let r = 0; r < runs; r++) {
      const t = performance.now();
      out[i].text = await run(pcm.samples);
      out[i].times.push(performance.now() - t);
    }
  }
  console.log(JSON.stringify({ engine, loadMs, clips: out.map((c) => ({ seconds: c.seconds, medianMs: median(c.times), text: c.text })) }));
}

async function main() {
  const arg = (k: string) => process.argv[process.argv.indexOf(k) + 1];
  if (process.argv[2] === "--worker") return worker(arg("--worker") as "v2" | "v3", arg("--model"), arg("--files").split(","), Number(arg("--runs")));
  const v2 = arg("--v2");
  const v3 = arg("--v3");
  const runs = Number(process.argv.includes("--runs") ? arg("--runs") : 7);
  if (!process.argv.includes("--v2") || !process.argv.includes("--v3")) throw new Error("usage: bun test/parakeet-engines.bench.ts --v2 <folder> --v3 <file.gguf> [--runs 7]");
  const dir = mkdtempSync(join(tmpdir(), "pk-bench-clips-"));
  try {
    const files = Object.entries(CLIPS).map(([name, text]) => {
      const f = join(dir, `${name}.wav`);
      const said = Bun.spawnSync(["/usr/bin/say", "-o", f, "--data-format=LEI16@16000", text]);
      if (said.exitCode !== 0) throw new Error(`say failed: ${said.stderr.toString()}`);
      return f;
    });
    for (const [engine, model] of [["v2", v2], ["v3", v3]] as const) {
      // /usr/bin/time -l reports the process's peak memory on stderr.
      const p = Bun.spawnSync(["/usr/bin/time", "-l", process.execPath, import.meta.path, "--worker", engine, "--model", model, "--files", files.join(","), "--runs", String(runs)], { env: { ...process.env, JAMSESH_SILENT: "1" } });
      const err = p.stderr.toString();
      const peak = Number(err.match(/(\d+)\s+maximum resident set size/)?.[1] ?? NaN);
      const line = p.stdout.toString().trim().split("\n").pop() ?? "";
      if (p.exitCode !== 0 || !line.startsWith("{")) {
        console.log(`${engine}: failed (exit ${p.exitCode}) ${err.slice(-400)}`);
        continue;
      }
      const r = JSON.parse(line);
      console.log(`\n${engine === "v2" ? "old: Parakeet v2 int8 ONNX, sherpa-onnx, CPU" : "new: Parakeet v3 Q8_0 GGUF, transcribe.cpp, GPU"}`);
      for (const l of err.split("\n").filter((l) => l.startsWith("v3 backend"))) console.log(`  ${l}`);
      console.log(`  model load ${(r.loadMs / 1000).toFixed(2)} s, peak memory ${(peak / 1e9).toFixed(2)} GB`);
      for (const c of r.clips) console.log(`  ${c.seconds.toFixed(1)} s clip: median ${(c.medianMs / 1000).toFixed(3)} s over ${runs} runs: ${JSON.stringify(c.text)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
