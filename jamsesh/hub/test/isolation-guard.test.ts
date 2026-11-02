// The wall between the suite and the person's live JamSesh (test/preload.ts, src/config.ts), and the hub
// keeping its uploads in its own data folder: a test hub once wrote its screenshots into ~/.jamsesh/host.
import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { Hub } from "../src/hub";
import { config } from "../src/config";
import { assertNotLive } from "./preload";

const real = join(userInfo().homedir, ".jamsesh");

test("the suite runs on a throwaway home, never the real ~/.jamsesh", () => {
  expect(config.home.startsWith(real)).toBe(false);
  expect(config.dataDir.startsWith(real)).toBe(false);
});

test("config refuses to load when a test points at the real JamSesh folder", () => {
  const run = (env: Record<string, string>) =>
    Bun.spawnSync(["bun", "-e", 'await import("./src/config")'], { cwd: join(import.meta.dir, ".."), env: { ...process.env, NODE_ENV: "test", ...env } });
  const bad = run({ JAMSESH_HOME: real });
  expect(bad.exitCode).not.toBe(0);
  expect(bad.stderr.toString()).toContain("Test isolation");
  const badData = run({ JAMSESH_DATA: join(real, "host") });
  expect(badData.exitCode).not.toBe(0);
});

test("a test can't dial the live hub or the app's ports", async () => {
  await expect(fetch("http://127.0.0.1:4790/api/upload", { method: "POST" })).rejects.toThrow("Test isolation");
  await expect(fetch("http://localhost:47900/")).rejects.toThrow("Test isolation");
  expect(() => assertNotLive("127.0.0.1", 4790)).toThrow("Test isolation");
  expect(() => assertNotLive("example.com", 4790)).not.toThrow();
});

test("a hub given its own data folder keeps uploads, renders and canvas files there", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jam-iso-"));
  const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, "d") });
  try {
    expect(hub.canvas.rendersDir).toBe(join(dir, "d", "renders"));
    expect(hub.uploadsDir).toBe(join(dir, "d", "renders", "uploads"));
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
    await hub.saveUpload(null, new Uint8Array(png), { title: "iso", stage: "built" });
    expect(readdirSync(hub.uploadsDir).some((f) => f.startsWith("up_"))).toBe(true);
  } finally {
    hub.devproxy.stop();
    hub.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

import { mkdirSync as mk, mkdtempSync as mkt, symlinkSync as ln } from "node:fs";
import { tmpdir as td } from "node:os";
import { join as jn } from "node:path";
import { guardTestPaths } from "../src/config";
import { isLocalHost, isLivePort } from "./preload";

test("a path that leads into the real folder through a link is refused, a temp folder is not", () => {
  const root = mkt(jn(td(), "iso-"));
  const real = jn(root, "real-home");
  mk(jn(real, "host"), { recursive: true });
  ln(real, jn(root, "link"));
  expect(() => guardTestPaths([jn(root, "link", "host")], real)).toThrow(/real JamSesh folder/);
  expect(() => guardTestPaths([jn(root, "link", "not-yet", "made")], real)).toThrow(/real JamSesh folder/); // nearest existing ancestor is followed
  expect(() => guardTestPaths([jn(root, "elsewhere")], real)).not.toThrow();
});

test("the fetch guard covers every live port and fallback, and every spelling of this computer", () => {
  for (const port of [4747, 4750, 4790, 4848, 4949, 7979, 47900, 47931]) expect([port, isLivePort(port)]).toEqual([port, true]);
  for (const port of [5100, 8080, 51234]) expect([port, isLivePort(port)]).toEqual([port, false]);
  for (const host of ["localhost", "127.0.0.2", "127.1.2.3", "::1", "[::1]", "::ffff:127.0.0.1", "::ffff:7f00:1", "0.0.0.0", "[::]", "LOCALHOST", undefined]) expect([String(host), isLocalHost(host)]).toEqual([String(host), true]);
  for (const host of ["example.com", "192.168.1.5", "10.0.0.1"]) expect([host, isLocalHost(host)]).toEqual([host, false]);
  expect(() => assertNotLive("127.0.0.2", 4747)).toThrow(/Test isolation/);
  expect(() => assertNotLive("::ffff:127.0.0.1", 4848)).toThrow(/Test isolation/);
  expect(() => assertNotLive("example.com", 4747)).not.toThrow();
});
