// A test build beside the real app shares nothing with it (SPEC "Run a test build beside the real app"):
// its hub has no default ports, runs no speech helper of its own choosing, adopts nobody's, reads no
// shared model cache, and can't open the router for remote access.
import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The hub's config creates its folders when first imported: point them at a throwaway place first.
const dir = mkdtempSync(join(tmpdir(), "jam-iso-"));
process.env.JAMSESH_HOME = join(dir, "jamsesh-home");
process.env.JAMSESH_DATA = join(dir, "data");
const { findWhisperModel, LocalWhisper, whisperPort } = await import("../src/audio/whisper");
const { config, ownPort, REAL_PORTS } = await import("../src/config");
const { Network } = await import("../src/net");
const wasHome = process.env.HOME;
const wasIsolated = config.isolated;
afterEach(() => {
  config.isolated = wasIsolated;
  if (wasHome === undefined) delete process.env.HOME;
  else process.env.HOME = wasHome;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("an isolated hub has no default port: a missing or real one is an error", () => {
  for (const name of ["JAMSESH_PORT", "JAMSESH_FIGCRAFT_PORT", "JAMSESH_DEV_PORT_START"]) {
    expect(() => ownPort(name, 1234, {}, true)).toThrow(name);
    expect(() => ownPort(name, 1234, { [name]: "" }, true)).toThrow(name);
    for (const real of REAL_PORTS) expect(() => ownPort(name, 1234, { [name]: String(real) }, true)).toThrow("real app");
    expect(ownPort(name, 1234, { [name]: "5999" }, true)).toBe(5999);
    // Not isolated: as always.
    expect(ownPort(name, 1234, {}, false)).toBe(1234);
    expect(ownPort(name, 1234, { [name]: String(REAL_PORTS[0]) }, false)).toBe(REAL_PORTS[0]);
  }
});

test("the speech helper's port: 8178 as always, but an isolated hub only ever gets its own", () => {
  expect(whisperPort({}, false)).toBe(8178);
  expect(whisperPort({ JAMSESH_WHISPER_PORT: "5878" }, false)).toBe(5878);
  expect(whisperPort({}, true)).toBeNull();
  expect(whisperPort({ JAMSESH_WHISPER_PORT: "8178" }, true)).toBeNull();
  expect(whisperPort({ JAMSESH_WHISPER_PORT: "5878" }, true)).toBe(5878);
});

test("with no port the isolated hub starts no speech helper and says why", async () => {
  config.isolated = true;
  const w = new LocalWhisper();
  expect(await w.start(null, false)).toBeNull();
  expect(w.status().state).toBe("off");
});

test("an isolated hub never adopts a server already answering on its port (the real app's helper); a normal hub does", async () => {
  // A stand-in for the real app's whisper-server: it answers a transcription like one.
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ text: "" }) });
  try {
    config.isolated = true;
    const iso = new LocalWhisper();
    expect(await iso.start(Number(server.port), false)).toBeNull();
    expect(iso.status().state).toBe("failed");
    expect(iso.status().detail).toContain("already using port");
    config.isolated = false;
    const normal = new LocalWhisper();
    expect(await normal.start(Number(server.port), false)).toBe(`http://127.0.0.1:${server.port}`);
  } finally {
    server.stop(true);
  }
});

test("an isolated hub doesn't read the shared model cache; a normal one does", () => {
  const home = join(dir, "home");
  const cache = join(home, ".cache", "whisper-cpp");
  mkdirSync(cache, { recursive: true });
  const model = join(cache, "ggml-base.en.bin");
  writeFileSync(model, "");
  truncateSync(model, 30_000_000);
  process.env.HOME = home;
  config.isolated = false;
  expect(findWhisperModel()).toBe(model);
  config.isolated = true;
  expect(findWhisperModel()).toBeNull();
});

test("remote access (a router port and a DuckDNS name) can't be turned on from an isolated hub", async () => {
  config.isolated = true;
  const n = new Network(join(dir, "net"));
  const r = await n.routes(new Request("http://x/api/net/config", { method: "POST", body: JSON.stringify({ domain: "jam", token: "a".repeat(30) }) }), new URL("http://x/api/net/config"));
  expect(r?.status).toBe(409);
});
