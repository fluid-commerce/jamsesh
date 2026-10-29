// One bounded way into every request body: the whole body is read up to a cap, within a time limit and a shared memory
// budget, before any route sees it. Past the cap nothing more is kept (the rest is read and dropped, so the sender gets its
// answer on a clean connection).

/** The most a request body may be: JSON is small; only the routes that take files carry media. */
export const BODY_LIMITS = { json: 2 * 1024 * 1024, other: 1024 * 1024, media: 32 * 1024 * 1024, photo: 8 * 1024 * 1024 };
/** Routes that take a file or a recording. */
const MEDIA_ROUTES = /^\/api\/(audio|attachments|upload|people\/[\w-]+\/(voice|photo))$/;
export const READ_MS = { small: 15_000, media: 90_000 };
/** What all bodies being read at once may hold in all: each read reserves its cap until it is done. */
const BUDGET = 256 * 1024 * 1024;
let reserved = 0;

export function limitFor(req: Request): number {
  const path = new URL(req.url).pathname;
  if (/^\/api\/people\/[\w-]+\/photo$/.test(path)) return BODY_LIMITS.photo;
  if (MEDIA_ROUTES.test(path)) return BODY_LIMITS.media;
  return (req.headers.get("content-type") ?? "").includes("application/json") ? BODY_LIMITS.json : BODY_LIMITS.other;
}

/** The body's bytes; null when it passes `max` or isn't finished within `ms` (the read is then dropped). */
export async function readBytes(req: Request, max: number, ms = READ_MS.media): Promise<Uint8Array | null | "timeout"> {
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let late = false;
  const timer = setTimeout(() => {
    late = true;
    reader.cancel().catch(() => {});
  }, ms);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size <= max) chunks.push(value);
      else chunks.length = 0;
    }
  } catch {
    return late ? "timeout" : null;
  } finally {
    clearTimeout(timer);
  }
  if (late) return "timeout";
  return size > max ? null : new Uint8Array(await new Blob(chunks as BlobPart[]).arrayBuffer());
}

/**
 * The request with its body already read (so a later `req.json()` or `arrayBuffer()` is bounded too), plus a `release` to call when the
 * request has been answered, or the refusal to send. The memory a body may take stays charged to the shared budget until then, four
 * times over (the bytes, and the copies a route makes while parsing). Every route is reached through this, which is what keeps the body cap, the time limit
 * and a "closing" check from being per-route.
 */
export async function buffered(req: Request): Promise<{ req: Request; release: () => void } | { status: number; message: string }> {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return { req, release: () => {} };
  const max = limitFor(req);
  // The bytes, the copy a route parses, and (for a file) the copies it makes of the part: four times the cap at the peak.
  const charge = max * 4;
  if (reserved + charge > BUDGET) return { status: 503, message: "The hub is busy receiving other requests. Try again in a moment." };
  reserved += charge;
  let released = false;
  const release = () => {
    if (!released) (released = true), (reserved -= charge);
  };
  const bytes = await readBytes(req, max, max > BODY_LIMITS.json ? READ_MS.media : READ_MS.small);
  if (bytes === "timeout" || !bytes) {
    release();
    return bytes === "timeout" ? { status: 408, message: "That request took too long to arrive." } : { status: 413, message: "That request is too large." };
  }
  // The length is now known exactly, whatever the sender declared (or didn't).
  const headers = new Headers(req.headers);
  headers.set("content-length", String(bytes.length));
  return { req: new Request(req.url, { method: req.method, headers, body: new Blob([bytes as BlobPart]) }), release };
}
