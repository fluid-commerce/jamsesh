// Which methods a request may use, decided once for every route: only GET reads and only POST, PATCH and DELETE act.
// HEAD reads files and nothing else; OPTIONS (a preflight) is answered without reaching a route; anything else is refused.
// Routes can therefore treat "not GET" as "acts" without a method of their own sneaking past a guard.

const FILE_READ = /^\/(api\/attachments\/[\w-]+|renders\/(?!full\/).+|assets\/.+|icons\/.+|fonts\/.+)$/;

/** A response when the method isn't allowed for this path; null to carry on. */
export async function methodAllowed(req: Request): Promise<Response | null> {
  const path = new URL(req.url).pathname;
  switch (req.method) {
    case "GET":
    case "POST":
    case "PATCH":
    case "DELETE":
      return null;
    case "HEAD":
      return FILE_READ.test(path) ? null : new Response(null, { status: 405, headers: { allow: "GET" } });
    case "OPTIONS":
      // No cross-site permission is ever given; the answer is only that nothing happens here.
      return new Response(null, { status: 204, headers: { allow: "GET, POST, PATCH, DELETE" } });
    default:
      return new Response(JSON.stringify({ error: "That method isn't used here." }), { status: 405, headers: { "content-type": "application/json", allow: "GET, POST, PATCH, DELETE" } });
  }
}
