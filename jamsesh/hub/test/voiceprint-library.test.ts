// The Mac app's hub is one compiled Bun program, which can't resolve the voice library by package name
// or by its folder, only by a file: voiceprint.ts loads it through the entry file its package.json names.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { libraryEntry } from "../src/audio/voiceprint";

function pkg(json: string | null) {
  const dir = mkdtempSync(join(tmpdir(), "jamsesh-lib-"));
  mkdirSync(dir, { recursive: true });
  if (json !== null) writeFileSync(join(dir, "package.json"), json);
  return dir;
}

test("the library loads through the file its package.json names", () => {
  const dir = pkg(JSON.stringify({ name: "sherpa-onnx-node", main: "sherpa-onnx.js" }));
  expect(libraryEntry(dir)).toBe(join(dir, "sherpa-onnx.js"));
});

test("no main, an empty one, a broken or missing package.json: index.js", () => {
  for (const json of [JSON.stringify({ name: "x" }), JSON.stringify({ main: "" }), JSON.stringify({ main: 3 }), "{not json", null]) {
    const dir = pkg(json);
    expect(libraryEntry(dir)).toBe(join(dir, "index.js"));
  }
});

test("the real voice library resolves to a file that loads", () => {
  const dir = join(import.meta.dir, "..", "..", "node_modules", "sherpa-onnx-node");
  const lib = require(libraryEntry(dir));
  expect(typeof lib.SpeakerEmbeddingExtractor).toBe("function");
});
