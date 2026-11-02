// The canvas host is a helper answering JSON-RPC over stdio, behind the parent-watch wrapper. In
// Bun 1.2 a Bun.file stream read to its end also ends a helper's stdout stream that is being read
// at the same time: the hub stopped seeing the host's replies the moment the host page loaded a
// file, and every canvas call then timed out after 60 s. These keep a stand-in host answering
// through the real wrapper while the hub serves files and hashes them.
import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256File } from "../src/audio/models";
import { FigcraftMcp } from "../src/canvas/figcraft-mcp";
import { Hub } from "../src/hub";
import { startHttp } from "../src/http";

process.env.JAMSESH_SILENT = "1";
const dir = mkdtempSync(join(tmpdir(), "jam-stdio-"));
const ECHO = join(import.meta.dir, "fixtures", "mcp-echo.ts");
let hub: Hub | null = null;
let server: ReturnType<typeof startHttp> | null = null;

afterAll(async () => {
  server?.stop(true);
  if (hub) {
    hub.devproxy.stop();
    hub.stop();
  }
  rmSync(dir, { recursive: true, force: true });
});

/** Runs `fn` with a stand-in host of its own (the only stdout being read, so a stream ended by mistake is this one), then stops it. */
async function withHost(fn: (host: FigcraftMcp) => Promise<void>) {
  const host = new FigcraftMcp(process.execPath, ["run", ECHO]);
  try {
    await host.init();
    await fn(host);
  } finally {
    expect(await host.close()).toBe(true);
  }
}

/** Calls the host `n` times (a few at once, as the poll, the watchdog and agents do) and returns how many didn't answer. */
async function unanswered(host: FigcraftMcp, n: number) {
  const results = await Promise.all(Array.from({ length: n }, () => host.call("inspect_document", {}, 3_000).then(() => true, () => false)));
  return results.filter((ok) => !ok).length;
}

test("a host behind the parent-watch wrapper answers every call", async () => {
  await withHost(async (host) => {
    for (let round = 0; round < 20; round++) expect(await unanswered(host, 10)).toBe(0);
  });
});

test("serving files to the host page doesn't stop the host's replies", async () => {
  hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, "d") });
  server = startHttp(hub, 0);
  const render = join(hub.canvas.rendersDir, "frame.png");
  writeFileSync(render, new Uint8Array(4096).fill(7));
  const port = server.port;
  await withHost(async (host) => {
    expect(await unanswered(host, 3)).toBe(0);
    for (let i = 0; i < 4; i++) {
      const r = await fetch(`http://127.0.0.1:${port}/renders/frame.png`);
      expect(r.status).toBe(200);
      expect((await r.arrayBuffer()).byteLength).toBe(4096);
      expect(await unanswered(host, 3)).toBe(0);
    }
  });
}, 30_000);

test("hashing a model file doesn't stop the host's replies", async () => {
  const files = [1024, 3 * 1024 * 1024].map((size) => {
    const file = join(dir, `model-${size}.bin`);
    const bytes = new Uint8Array(size).map((_, i) => i % 251);
    writeFileSync(file, bytes);
    return { file, sha: createHash("sha256").update(bytes).digest("hex") };
  });
  await withHost(async (host) => {
    for (let i = 0; i < 6; i++) {
      const { file, sha } = files[i % 2];
      expect(await sha256File(file)).toBe(sha);
      expect(await unanswered(host, 3)).toBe(0);
    }
  });
}, 30_000);
