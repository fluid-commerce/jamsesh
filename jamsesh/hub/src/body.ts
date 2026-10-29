// One bounded way into every request body: the whole body is read up to a cap before any route sees it.
// Past the cap nothing more is kept (the rest is read and dropped, so the sender gets its answer on a clean connection).

/** The most a request body may be: JSON is small; audio, pictures and forms carry media. */
export const BODY_LIMITS = { json: 2 * 1024 * 1024, media: 32 * 1024 * 1024 };

/** The body's bytes; null when it passes `max`. */
export async function readBytes(req: Request, max: number): Promise<Uint8Array | null> {
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size <= max) chunks.push(value);
    else chunks.length = 0;
  }
  return size > max ? null : new Uint8Array(await new Blob(chunks as BlobPart[]).arrayBuffer());
}

/**
 * The request with its body already read (so a later `req.json()` or `arrayBuffer()` is bounded too), or null when the body is
 * too large. Every route is reached through this, which is what keeps a body cap and a "closing" check from being per-route.
 */
export async function buffered(req: Request): Promise<Request | null> {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return req;
  const json = (req.headers.get("content-type") ?? "").includes("application/json");
  const bytes = await readBytes(req, json ? BODY_LIMITS.json : BODY_LIMITS.media);
  if (!bytes) return null;
  return new Request(req.url, { method: req.method, headers: req.headers, body: new Blob([bytes as BlobPart]) });
}
