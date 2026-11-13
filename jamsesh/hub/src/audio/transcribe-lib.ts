// Which native transcribe.cpp library Parakeet's process may load (5.2): only the build
// app/build-transcribe.sh made from the pinned source (app/transcribe-pins.json: the fork's commit and
// the binding's header hash). That script records the SHA-256 of each library it built in
// transcribe-pins.generated.ts, in the same run; bundle-hub.sh runs it before compiling the hub, so
// the app's hub carries the hashes of the app's own libraries. One rule, checked at every start of
// the process before the binding loads anything: inside the Mac app, the copy in its own resources
// and nothing else (TRANSCRIBE_LIBRARY and JAMSESH_TRANSCRIBE_LIBRARY are ignored); in a checkout,
// JAMSESH_TRANSCRIBE_LIBRARY or ~/.jamsesh/lib/transcribe (install.sh). Every library file must be a
// regular file in that folder, with its recorded hash. No record, or anything else, and Parakeet
// doesn't start; whisper carries the room.

import { lstatSync, realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import pins from "../../../app/transcribe-pins.json";
import { sha256File } from "./models";

export const TRANSCRIBE_PINS: { repo: string; commit: string; abihash: string } = pins;

/** The library the binding is pointed at, inside a folder holding exactly these files. */
export const MAIN_LIBRARY = "libtranscribe.dylib";
export const LIBRARY_FILES = [MAIN_LIBRARY, "libggml.0.dylib", "libggml-base.0.dylib", "libggml-cpu.0.dylib", "libggml-metal.0.dylib"] as const;

/**
 * The hashes build-transcribe.sh recorded for the pinned commit, compiled into the hub when the
 * module was there at compile time (a release build always has it). null when there's no record.
 */
export async function recordedHashes(): Promise<Record<string, string> | null> {
  try {
    // @ts-ignore: written by app/build-transcribe.sh, absent in a checkout that hasn't built it
    const m = await import("./transcribe-pins.generated");
    return checkedRecord(m.LIBRARY_COMMIT, m.LIBRARY_HASHES);
  } catch {
    return null;
  }
}

/** A record of `commit`'s build: a SHA-256 for every library file, for the pinned commit; else null. */
export function checkedRecord(commit: unknown, hashes: unknown): Record<string, string> | null {
  if (commit !== TRANSCRIBE_PINS.commit || !hashes || typeof hashes !== "object") return null;
  const h = hashes as Record<string, unknown>;
  return LIBRARY_FILES.every((f) => typeof h[f] === "string" && /^[0-9a-f]{64}$/.test(h[f] as string)) ? Object.fromEntries(LIBRARY_FILES.map((f) => [f, h[f] as string])) : null;
}

/** Where the pinned library may come from, by where the hub runs. */
export function libraryFolder(env: NodeJS.ProcessEnv, home: string): { dir: string; inside: string | null } {
  // Packaged: the app's resources only. Nothing a parent passes down can point elsewhere.
  if (env.JAMSESH_RESOURCES) return { dir: join(env.JAMSESH_RESOURCES, "lib", "transcribe"), inside: env.JAMSESH_RESOURCES };
  return { dir: env.JAMSESH_TRANSCRIBE_LIBRARY ? dirname(env.JAMSESH_TRANSCRIBE_LIBRARY) : join(home, "lib", "transcribe"), inside: null };
}

/**
 * The real path of libtranscribe.dylib, after checking every library file: in the allowed folder
 * (inside the app's resources when packaged), not a link, with the SHA-256 in `hashes` (the
 * recorded build). Throws a sentence for Settings otherwise.
 */
export async function verifiedLibrary(env: NodeJS.ProcessEnv, home: string, hashes: Record<string, string> | null = null): Promise<string> {
  if (!hashes) throw new Error("Parakeet's speech library wasn't built with this hub (no record of it; run jamsesh/app/build-transcribe.sh); whisper is transcribing instead.");
  const { dir, inside } = libraryFolder(env, home);
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    throw new Error(`Parakeet's speech library isn't on this Mac (${inside ? "the app is missing lib/transcribe" : "build it with jamsesh/app/build-transcribe.sh"}).`);
  }
  if (inside) {
    const root = realpathSync(inside);
    if (!real.startsWith(root + sep)) throw new Error("Parakeet's speech library isn't inside the app.");
  }
  for (const name of LIBRARY_FILES) {
    const want = hashes[name];
    const file = join(real, name);
    let ok = false;
    try {
      ok = lstatSync(file).isFile() && dirname(realpathSync(file)) === real && (await sha256File(file)) === want;
    } catch {
      ok = false;
    }
    if (!ok) throw new Error(`Parakeet's speech library isn't the build this hub recorded (${name}); whisper is transcribing instead.`);
  }
  return join(real, MAIN_LIBRARY);
}
