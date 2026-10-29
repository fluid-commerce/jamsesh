// How a chat that has no id of its own (Codex and other harnesses without hooks) is told apart:
// by its harness, its machine and its folder, as one key.
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";

/** A folder as one spelling: absolute, normalized, without a trailing slash, and (on this computer's own file system) its real path. */
export function canonicalCwd(cwd: string, real: boolean) {
  const c = cwd.trim();
  if (!c || !isAbsolute(c)) return "";
  let out = normalize(c).replace(/(.)\/+$/, "$1");
  if (real) {
    try {
      out = realpathSync(out);
    } catch {}
  }
  return out;
}

/** The key of a hook-less chat: a hash of the whole path, so long folders that share a beginning stay apart. */
export const chatKey = (harness: string, machine: string, cwd: string) => `${harness}:${createHash("sha256").update(`${harness}:${machine}:${cwd}`).digest("hex")}`;

/** Whether an id is a chatKey (the older spelling was the readable `harness:machine:folder`, cut at 300 characters). */
export const isChatKey = (id: string | null | undefined, harness: string) => !!id && new RegExp(`^${harness}:[0-9a-f]{64}$`).test(id);
