// Which native transcribe.cpp library Parakeet's process may load (5.2): only Hex's fork as pinned in
// app/transcribe-pins.json (the commit app/build-transcribe.sh builds and each library's SHA-256),
// compiled into the hub. One rule, checked at every start of the process before the binding loads
// anything: inside the Mac app, the copy in its own resources and nothing else (TRANSCRIBE_LIBRARY
// and JAMSESH_TRANSCRIBE_LIBRARY are ignored); in a checkout, JAMSESH_TRANSCRIBE_LIBRARY or
// ~/.jamsesh/lib/transcribe (install.sh). Every library file must be a regular file in that folder,
// with its pinned hash. Anything else and Parakeet doesn't start; whisper carries the room.

import { lstatSync, realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import pins from "../../../app/transcribe-pins.json";
import { sha256File } from "./models";

export const TRANSCRIBE_PINS: { repo: string; commit: string; abihash: string; libs: Record<string, string> } = pins;

/** The library the binding is pointed at, inside a folder holding exactly the pinned files. */
export const MAIN_LIBRARY = "libtranscribe.dylib";

/** Where the pinned library may come from, by where the hub runs. */
export function libraryFolder(env: NodeJS.ProcessEnv, home: string): { dir: string; inside: string | null } {
  // Packaged: the app's resources only. Nothing a parent passes down can point elsewhere.
  if (env.JAMSESH_RESOURCES) return { dir: join(env.JAMSESH_RESOURCES, "lib", "transcribe"), inside: env.JAMSESH_RESOURCES };
  return { dir: env.JAMSESH_TRANSCRIBE_LIBRARY ? dirname(env.JAMSESH_TRANSCRIBE_LIBRARY) : join(home, "lib", "transcribe"), inside: null };
}

/**
 * The real path of the pinned libtranscribe.dylib, after checking every pinned file: in the allowed
 * folder (inside the app's resources when packaged), not a link, with its pinned SHA-256. Throws a
 * sentence for Settings otherwise.
 */
export async function verifiedLibrary(env: NodeJS.ProcessEnv, home: string): Promise<string> {
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
  for (const [name, want] of Object.entries(TRANSCRIBE_PINS.libs)) {
    const file = join(real, name);
    let ok = false;
    try {
      ok = lstatSync(file).isFile() && dirname(realpathSync(file)) === real && (await sha256File(file)) === want;
    } catch {
      ok = false;
    }
    if (!ok) throw new Error(`Parakeet's speech library isn't the pinned build (${name}); whisper is transcribing instead.`);
  }
  return join(real, MAIN_LIBRARY);
}
