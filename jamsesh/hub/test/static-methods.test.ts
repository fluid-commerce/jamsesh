// Files are answered to GET (HEAD where allowed) only: any other method on a file route gets 405, so a file body never goes through the front door's reader.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../src/hub";
import { startHttp } from "../src/http";

const dir = mkdtempSync(join(tmpdir(), "jam-static-"));
const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, "d") });
const server = startHttp(hub, 0);
afterAll(() => {
  server.stop(true);
  hub.devproxy.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("file routes answer GET, and any write method is a 405 (never a file)", async () => {
  const base = `http://127.0.0.1:${server.port}`;
  for (const path of ["/connect", "/renders/x.png", "/renders/full/x.png", "/canvas/index.html", "/download/mac", "/some/page", "/index.html"]) {
    for (const method of ["POST", "PATCH", "DELETE"]) {
      const r = await fetch(`${base}${path}`, { method, headers: { origin: base } });
      expect([path, method, r.status === 405 || r.status === 403 || r.status === 401]).toEqual([path, method, true]);
      expect(r.headers.get("content-disposition")).toBeNull();
    }
  }
  expect((await fetch(`${base}/connect`)).status).toBe(200);
});
