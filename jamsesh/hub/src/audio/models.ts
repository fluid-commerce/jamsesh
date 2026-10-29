// Speech models a host downloads once (5.2): fetched over HTTPS, checked against a pinned size and
// SHA-256 before anything uses them, and kept in ~/.jamsesh/models. Shared by whisper.cpp's model
// and Parakeet's.

import { createHash } from "node:crypto";

export interface Pinned {
  url: string;
  sha256: string;
  bytes: number;
}

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

/**
 * Downloads `pin.url` to `file` (which must not be in use: callers pass a temporary name and move it
 * into place). Throws with a sentence for the room on HTTP errors, a size or checksum mismatch, or
 * when `cancelled()` turns true. `progress` gets 0 to 100.
 */
export async function downloadVerified(pin: Pinned, file: string, progress: (pct: number) => void, cancelled: () => boolean = () => false) {
  const r = await fetch(pin.url, { redirect: "follow" });
  if (!r.ok || !r.body) throw new Error(`Couldn't download the speech model: HTTP ${r.status}.`);
  const out = Bun.file(file).writer();
  const hash = createHash("sha256");
  let got = 0;
  try {
    for await (const chunk of r.body) {
      if (cancelled()) throw new Error("Stopped while downloading.");
      hash.update(chunk);
      out.write(chunk);
      got += chunk.byteLength;
      if (got > pin.bytes) throw new Error("The speech model download is larger than expected.");
      progress(Math.floor((100 * got) / pin.bytes));
    }
  } finally {
    await out.end();
  }
  if (got !== pin.bytes || hash.digest("hex") !== pin.sha256) throw new Error("The speech model download didn't match its checksum.");
}
