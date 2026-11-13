// 5.2: Parakeet's process loads only the pinned transcribe.cpp library, and a child that never says
// it's listening is stopped cleanly.
import "./hear.env";
import { afterAll, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Parakeet, PARAKEET } from "../src/audio/parakeet";
import { libraryFolder, MAIN_LIBRARY, TRANSCRIBE_PINS, verifiedLibrary } from "../src/audio/transcribe-lib";

const dir = join(tmpdir(), `jam-pklib-${Date.now()}`);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A folder holding the pinned file names, each `bytes` (by default not the pinned contents). */
function fakeSet(at: string, bytes = "not the pinned build") {
  mkdirSync(at, { recursive: true });
  for (const name of Object.keys(TRANSCRIBE_PINS.libs)) writeFileSync(join(at, name), bytes);
  return join(at, MAIN_LIBRARY);
}

test("the pins name the fork's commit, the binding's header hash and every library's SHA-256", () => {
  expect(TRANSCRIBE_PINS.repo).toBe("https://github.com/anomalyco/transcribe.cpp");
  expect(TRANSCRIBE_PINS.commit).toMatch(/^[0-9a-f]{40}$/);
  expect(TRANSCRIBE_PINS.abihash).toBe("f99ad4169374b8f3");
  expect(Object.keys(TRANSCRIBE_PINS.libs).sort()).toEqual(["libggml-base.0.dylib", "libggml-cpu.0.dylib", "libggml-metal.0.dylib", "libggml.0.dylib", MAIN_LIBRARY].sort());
  for (const sha of Object.values(TRANSCRIBE_PINS.libs)) expect(sha).toMatch(/^[0-9a-f]{64}$/);
});

test("inside the app only its own lib/transcribe counts: both variables pointing elsewhere are ignored", () => {
  const res = join(dir, "app-res");
  const elsewhere = fakeSet(join(dir, "elsewhere"));
  const env = { JAMSESH_RESOURCES: res, JAMSESH_TRANSCRIBE_LIBRARY: elsewhere, TRANSCRIBE_LIBRARY: elsewhere };
  expect(libraryFolder(env, join(dir, "home"))).toEqual({ dir: join(res, "lib", "transcribe"), inside: res });
  // In a checkout the variable picks the folder, and ~/.jamsesh/lib/transcribe is the default.
  expect(libraryFolder({ JAMSESH_TRANSCRIBE_LIBRARY: elsewhere }, join(dir, "home")).dir).toBe(dirname(elsewhere));
  expect(libraryFolder({}, join(dir, "home")).dir).toBe(join(dir, "home", "lib", "transcribe"));
});

test("files that aren't the pinned build are refused, wherever they are named from", async () => {
  const home = join(dir, "home-fake");
  // Missing.
  await expect(verifiedLibrary({}, home)).rejects.toThrow("isn't on this Mac");
  await expect(verifiedLibrary({ JAMSESH_RESOURCES: join(dir, "empty-res") }, home)).rejects.toThrow("the app is missing lib/transcribe");
  // The right names with other bytes: through the variable, in ~/.jamsesh/lib, and in the app.
  const fake = fakeSet(join(dir, "fake"));
  await expect(verifiedLibrary({ JAMSESH_TRANSCRIBE_LIBRARY: fake }, home)).rejects.toThrow("isn't the pinned build");
  fakeSet(join(home, "lib", "transcribe"));
  await expect(verifiedLibrary({}, home)).rejects.toThrow("isn't the pinned build");
  const res = join(dir, "res-fake");
  fakeSet(join(res, "lib", "transcribe"));
  await expect(verifiedLibrary({ JAMSESH_RESOURCES: res, JAMSESH_TRANSCRIBE_LIBRARY: fake, TRANSCRIBE_LIBRARY: fake }, home)).rejects.toThrow("isn't the pinned build");
  // A link out of the app's resources isn't the app's own copy.
  const linked = join(dir, "res-link");
  mkdirSync(join(linked, "lib"), { recursive: true });
  symlinkSync(join(dir, "fake"), join(linked, "lib", "transcribe"));
  await expect(verifiedLibrary({ JAMSESH_RESOURCES: linked }, home)).rejects.toThrow("isn't inside the app");
});

test("Parakeet with a library that isn't the pinned build doesn't start, says why, and leaves the room to whisper", async () => {
  const model = join(dir, "model");
  mkdirSync(model, { recursive: true });
  for (const f of PARAKEET.files) writeFileSync(join(model, f), "not a model");
  const fake = fakeSet(join(dir, "fake-for-child"));
  const saved = { ...process.env };
  Object.assign(process.env, { JAMSESH_PARAKEET_DIR: model, JAMSESH_TRANSCRIBE_LIBRARY: fake, TRANSCRIBE_LIBRARY: fake });
  try {
    const p = new Parakeet();
    expect(await p.start(false)).toBeNull();
    expect(p.status().state).toBe("failed");
    expect(p.status().detail).toContain("isn't the pinned build");
  } finally {
    for (const k of ["JAMSESH_PARAKEET_DIR", "JAMSESH_TRANSCRIBE_LIBRARY", "TRANSCRIBE_LIBRARY"]) if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}, 30_000);

// The pinned build itself, when this machine has one (app/build-transcribe.sh).
const FORK = process.env.JAMSESH_TEST_TRANSCRIBE_LIBRARY;
test.skipIf(!FORK)("the pinned build is accepted only as the app's own copy inside the app, and not once a byte changes", async () => {
  const res = join(dir, "res-real");
  const lib = join(res, "lib", "transcribe");
  mkdirSync(lib, { recursive: true });
  for (const name of Object.keys(TRANSCRIBE_PINS.libs)) copyFileSync(join(dirname(FORK!), name), join(lib, name));
  const outside = fakeSet(join(dir, "outside"));
  expect(await verifiedLibrary({ JAMSESH_RESOURCES: res, JAMSESH_TRANSCRIBE_LIBRARY: outside, TRANSCRIBE_LIBRARY: outside }, dir)).toEndWith(join("res-real", "lib", "transcribe", MAIN_LIBRARY));
  expect(await verifiedLibrary({ JAMSESH_TRANSCRIBE_LIBRARY: join(lib, MAIN_LIBRARY) }, dir)).toEndWith(MAIN_LIBRARY);
  writeFileSync(join(lib, "libggml-cpu.0.dylib"), "changed", { flag: "a" });
  await expect(verifiedLibrary({ JAMSESH_RESOURCES: res }, dir)).rejects.toThrow("isn't the pinned build (libggml-cpu.0.dylib)");
});

test("a child that never says it's listening is stopped after the start limit, with no read left hanging", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  const model = join(dir, "silent-model");
  mkdirSync(model, { recursive: true });
  for (const f of PARAKEET.files) writeFileSync(join(model, f), "x");
  process.env.JAMSESH_PARAKEET_DIR = model;
  try {
    const p = new Parakeet();
    p.startTimeoutMs = 300;
    const pidFile = join(dir, "silent.pid");
    p.argv = () => [process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`];
    const started = Date.now();
    expect(await p.start(false)).toBeNull();
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(p.status()).toMatchObject({ state: "failed" });
    expect(p.status().detail).toStartWith("The speech model didn't start");
    expect((p as any).proc).toBeNull();
    // The child was stopped, not left running.
    const pid = Number(await Bun.file(pidFile).text());
    expect(pid).toBeGreaterThan(1);
    expect(() => process.kill(pid, 0)).toThrow();
    await Bun.sleep(200);
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    delete process.env.JAMSESH_PARAKEET_DIR;
  }
}, 30_000);
