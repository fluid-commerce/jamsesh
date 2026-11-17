// The Mac app's hub is one compiled Bun program: it can't resolve a package by name from the bundle's node_modules
// folder, so Parakeet's binding is loaded through the entry file its package.json names (stt-server.ts), as the
// voice library is. The release check (`jamsesh-hub --stt-check`) covers the real bundle.
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { libraryEntry } from "../src/audio/voiceprint";

test("the Parakeet binding's entry file is a real file in the layout the bundle copies", () => {
  const entry = libraryEntry(join(import.meta.dir, "..", "..", "node_modules", "transcribe-cpp"));
  expect(entry.endsWith(join("transcribe-cpp", "dist", "index.js"))).toBe(true);
  expect(existsSync(entry)).toBe(true);
});

test("a relative bundle folder still gives an absolute entry (a relative one is read as a package name)", () => {
  const rel = join("jamsesh", "app", "x", "node_modules", "transcribe-cpp");
  const entry = libraryEntry(rel);
  expect(entry.startsWith("/")).toBe(true);
  expect(entry.endsWith(join(rel, "index.js"))).toBe(true);
});
