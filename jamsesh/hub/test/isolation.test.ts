// A test build beside the real app shares nothing with it (SPEC "Run a test build beside the real app"). One test
// per refusal: inherited location variables, real storage (through links), remote access, real ports, the speech
// helper, the canvas and live-build ports.
import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The hub's config creates its folders when first imported: point them at a throwaway place first.
const dir = mkdtempSync(join(tmpdir(), "jam-iso-"));
process.env.JAMSESH_HOME = join(dir, "jamsesh-home");
process.env.JAMSESH_DATA = join(dir, "data");
const { findWhisperModel, LocalWhisper, whisperPort } = await import("../src/audio/whisper");
const { config, ownPort } = await import("../src/config");
const { freePort, isolateEnv, isolatedPort, LOCATION_VARS, listenerPid, ownsListener, REAL_PORTS, realRoots } = await import("../src/isolate");
const { Network } = await import("../src/net");
const { Canvas } = await import("../src/canvas/canvas");

const wasHome = process.env.HOME;
const wasIsolated = config.isolated;
afterEach(() => {
  config.isolated = wasIsolated;
  if (wasHome === undefined) delete process.env.HOME;
  else process.env.HOME = wasHome;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const fakeHome = join(dir, "fake-home");
mkdirSync(join(fakeHome, ".jamsesh"), { recursive: true });
const roots = realRoots(fakeHome);

test("refusal: the environment comes from JAMSESH_APP_DATA alone, so every inherited location variable is dropped", () => {
  const env: Record<string, string | undefined> = { JAMSESH_APP_DATA: join(dir, "app") };
  for (const k of LOCATION_VARS) env[k] = "/somewhere/real";
  env.JAMSESH_PORT = "5747";
  const r = isolateEnv(env, roots);
  expect(r.home).toBe(join(dir, "app", "home"));
  expect(env.JAMSESH_HOME).toBe(r.home);
  for (const k of LOCATION_VARS.filter((k) => k !== "JAMSESH_HOME")) expect(env[k], k).toBeUndefined();
  for (const k of ["JAMSESH_DATA", "JAMSESH_TEAM", "JAMSESH_WHISPER_PORT", "JAMSESH_FIGCRAFT_PORT", "JAMSESH_DEV_PORT_START", "JAMSESH_WHISPER_MODEL", "JAMSESH_PUBLIC_URL"]) expect(LOCATION_VARS).toContain(k);
  expect(env.JAMSESH_PORT).toBe("5747");
  expect(() => isolateEnv({}, roots)).toThrow("JAMSESH_APP_DATA");
  expect(() => isolateEnv({ JAMSESH_APP_DATA: "relative" }, roots)).toThrow("absolute");
});

test("refusal: a data folder inside the real storage, by real path (links, folders not made yet)", () => {
  const real = join(fakeHome, ".jamsesh");
  symlinkSync(real, join(dir, "link"));
  for (const p of [real, join(real, "x", "not-made-yet"), join(dir, "link"), join(dir, "link", "new")]) expect(() => isolateEnv({ JAMSESH_APP_DATA: p }, roots), p).toThrow("real JamSesh");
  expect(() => isolateEnv({ JAMSESH_APP_DATA: join(fakeHome, "Library", "Application Support", "com.fluidcommerce.jamsesh") }, roots)).toThrow("real JamSesh");
  expect(() => isolateEnv({ JAMSESH_APP_DATA: join(dir, "fine") }, roots)).not.toThrow();
});

test("refusal: no real port, however it is given", () => {
  for (const real of REAL_PORTS) {
    expect(() => isolatedPort("JAMSESH_PORT", String(real))).toThrow("real app");
    expect(() => ownPort("JAMSESH_PORT", 1, { JAMSESH_PORT: String(real) }, true)).toThrow("real app");
  }
  for (const bad of [undefined, "", "abc", "80", "70000"]) expect(() => ownPort("JAMSESH_PORT", 1, { JAMSESH_PORT: bad }, true)).toThrow();
  expect(ownPort("JAMSESH_PORT", 1, { JAMSESH_PORT: "5999" }, true)).toBe(5999);
  // Not isolated: as always.
  expect(ownPort("JAMSESH_PORT", 1234, {}, false)).toBe(1234);
  expect(ownPort("JAMSESH_PORT", 1234, { JAMSESH_PORT: "4790" }, false)).toBe(4790);
  for (const p of [7979, 8178, 5100, 5104, 4790, 4747, 4848, 4949]) expect(REAL_PORTS).toContain(p);
});

test("the canvas and live builds take OS-assigned ports in an isolated hub, never the real ones", () => {
  const p = freePort();
  expect(p).toBeGreaterThan(1023);
  expect(REAL_PORTS).not.toContain(p);
});

test("refusal: an isolated hub never reads a saved net.json, so remote access can't come back", async () => {
  const netDir = join(dir, "net");
  mkdirSync(netDir, { recursive: true });
  writeFileSync(join(netDir, "net.json"), JSON.stringify({ domain: "jam.duckdns.org", token: "a".repeat(30), enabled: true, externalPort: 443, internalPort: 4443 }));
  let fetched = 0;
  const f = (async () => (fetched++, new Response("OK\n1.2.3.4\n\nUPDATED"))) as unknown as typeof fetch;
  config.isolated = false;
  expect(new Network(netDir, f).config()?.enabled).toBe(true);
  config.isolated = true;
  const n = new Network(netDir, f);
  expect(n.config()).toBeNull();
  expect(n.tlsOptions()).toBeNull();
  await n.start();
  expect(fetched).toBe(0);
  const r = await n.routes(new Request("http://x/api/net/config", { method: "POST", body: JSON.stringify({ domain: "jam", token: "a".repeat(30) }) }), new URL("http://x/api/net/config"));
  expect(r?.status).toBe(409);
  n.stop?.();
});

test("refusal: the speech helper takes a port the OS hands out, ignoring the environment and 8178", () => {
  expect(whisperPort({ JAMSESH_WHISPER_PORT: "5878" }, false)).toBe(5878);
  expect(whisperPort({}, false)).toBe(8178);
  const p = whisperPort({ JAMSESH_WHISPER_PORT: "8178" }, true);
  expect(REAL_PORTS).not.toContain(p);
  expect(p).not.toBe(5878);
});

test("refusal: an isolated hub never adopts a server already answering (it doesn't even probe it)", async () => {
  let hits = 0;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => (hits++, Response.json({ text: "" })) });
  try {
    config.isolated = true;
    const w = new LocalWhisper();
    const got = await w.start(Number(server.port), false);
    expect(got).not.toBe(`http://127.0.0.1:${server.port}`);
    expect(hits).toBe(0);
    config.isolated = false;
    expect(await new LocalWhisper().start(Number(server.port), false)).toBe(`http://127.0.0.1:${server.port}`);
  } finally {
    server.stop(true);
  }
});

test("refusal: a helper counts as ours only when the process we started (or its child) is the one listening", async () => {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
  try {
    expect(await listenerPid(Number(server.port))).toBe(process.pid);
    expect(await ownsListener(Number(server.port), process.pid)).toBe(true);
    // Someone else's pid, and a port nobody listens on: both no.
    expect(await ownsListener(Number(server.port), process.pid + 100000)).toBe(false);
    expect(await ownsListener(freePort(), process.pid)).toBe(false);
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

test("refusal: the canvas never takes or adopts a real port, even a saved one or one just below it", async () => {
  const saved = 47900;
  const asked: number[] = [];
  const canvas = new Canvas({ store: { setting: () => saved } } as any);
  const was = config.figcraftPort;
  config.isolated = true;
  // Scanning up from just under the real canvas port would reach 47900 on the second candidate.
  config.figcraftPort = 47899;
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((u: any, ...a: any[]) => (asked.push(Number(String(u).match(/:(\d+)/)?.[1])), realFetch(u, ...a))) as typeof fetch;
  try {
    const p = await (canvas as any).choosePort();
    expect(REAL_PORTS).not.toContain(p);
    expect(asked).not.toContain(47900);
  } finally {
    globalThis.fetch = realFetch;
    config.figcraftPort = was;
  }
});
