// 5.2: Parakeet's process loads only the transcribe.cpp build whose hashes app/build-transcribe.sh
// recorded (transcribe-pins.generated.ts), and a child that never says it's listening is stopped cleanly.
import "./hear.env";
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Parakeet, PARAKEET } from "../src/audio/parakeet";
import { checkedRecord, LIBRARY_FILES, libraryFolder, MAIN_LIBRARY, recordedHashes, TRANSCRIBE_PINS, verifiedLibrary } from "../src/audio/transcribe-lib";

const dir = join(tmpdir(), `jam-pklib-${Date.now()}`);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const sha = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");
/** A folder holding the library file names, each with its own bytes (`tag` makes another build). */
function libSet(at: string, tag = "a build") {
  mkdirSync(at, { recursive: true });
  for (const name of LIBRARY_FILES) writeFileSync(join(at, name), `${tag}: ${name}`);
  return join(at, MAIN_LIBRARY);
}
/** What build-transcribe.sh would record for a set made by libSet(…, tag). */
const recordOf = (tag = "a build") => checkedRecord(TRANSCRIBE_PINS.commit, Object.fromEntries(LIBRARY_FILES.map((n) => [n, sha(`${tag}: ${n}`)])));

test("the source is pinned (the fork's commit and the binding's header hash); a record counts only for that commit and every file", () => {
  expect(TRANSCRIBE_PINS.repo).toBe("https://github.com/anomalyco/transcribe.cpp");
  expect(TRANSCRIBE_PINS.commit).toMatch(/^[0-9a-f]{40}$/);
  expect(TRANSCRIBE_PINS.abihash).toBe("f99ad4169374b8f3");
  expect("libs" in TRANSCRIBE_PINS).toBe(false);
  const hashes = Object.fromEntries(LIBRARY_FILES.map((n) => [n, sha(n)]));
  expect(checkedRecord(TRANSCRIBE_PINS.commit, hashes)).toEqual(hashes);
  expect(checkedRecord("0".repeat(40), hashes)).toBeNull();
  expect(checkedRecord(TRANSCRIBE_PINS.commit, { ...hashes, [MAIN_LIBRARY]: "short" })).toBeNull();
  const { [MAIN_LIBRARY]: _, ...missing } = hashes;
  expect(checkedRecord(TRANSCRIBE_PINS.commit, missing)).toBeNull();
});

test("inside the app only its own lib/transcribe counts: both variables pointing elsewhere are ignored", () => {
  const res = join(dir, "app-res");
  const elsewhere = libSet(join(dir, "elsewhere"));
  const env = { JAMSESH_RESOURCES: res, JAMSESH_TRANSCRIBE_LIBRARY: elsewhere, TRANSCRIBE_LIBRARY: elsewhere };
  expect(libraryFolder(env, join(dir, "home"))).toEqual({ dir: join(res, "lib", "transcribe"), inside: res });
  // In a checkout the variable picks the folder, and ~/.jamsesh/lib/transcribe is the default.
  expect(libraryFolder({ JAMSESH_TRANSCRIBE_LIBRARY: elsewhere }, join(dir, "home")).dir).toBe(dirname(elsewhere));
  expect(libraryFolder({}, join(dir, "home")).dir).toBe(join(dir, "home", "lib", "transcribe"));
});

test("the recorded build is accepted only as the app's own copy inside the app, and not once a byte changes", async () => {
  const res = join(dir, "res-real");
  const lib = join(res, "lib", "transcribe");
  libSet(lib);
  const record = recordOf();
  const outside = libSet(join(dir, "outside"));
  // Both variables naming another copy of the very same files change nothing: the app's copy is used.
  expect(await verifiedLibrary({ JAMSESH_RESOURCES: res, JAMSESH_TRANSCRIBE_LIBRARY: outside, TRANSCRIBE_LIBRARY: outside }, dir, record)).toEndWith(join("res-real", "lib", "transcribe", MAIN_LIBRARY));
  // In a checkout, the variable's folder, checked the same way.
  expect(await verifiedLibrary({ JAMSESH_TRANSCRIBE_LIBRARY: outside }, dir, record)).toEndWith(join("outside", MAIN_LIBRARY));
  writeFileSync(join(lib, "libggml-cpu.0.dylib"), "changed", { flag: "a" });
  await expect(verifiedLibrary({ JAMSESH_RESOURCES: res }, dir, record)).rejects.toThrow("isn't the build this hub recorded (libggml-cpu.0.dylib)");
});

test("no record, another build, or a link out of the app: refused, wherever the files are named from", async () => {
  const home = join(dir, "home-fake");
  const fake = libSet(join(dir, "fake"), "another build");
  const record = recordOf();
  // No record of a build (the generated module is missing): nothing loads.
  await expect(verifiedLibrary({ JAMSESH_TRANSCRIBE_LIBRARY: fake }, home, null)).rejects.toThrow("wasn't built with this hub");
  // Missing files.
  await expect(verifiedLibrary({}, home, record)).rejects.toThrow("isn't on this Mac");
  await expect(verifiedLibrary({ JAMSESH_RESOURCES: join(dir, "empty-res") }, home, record)).rejects.toThrow("the app is missing lib/transcribe");
  // The right names with another build's bytes: through the variable, in ~/.jamsesh/lib, and in the app.
  await expect(verifiedLibrary({ JAMSESH_TRANSCRIBE_LIBRARY: fake }, home, record)).rejects.toThrow("isn't the build this hub recorded");
  libSet(join(home, "lib", "transcribe"), "another build");
  await expect(verifiedLibrary({}, home, record)).rejects.toThrow("isn't the build this hub recorded");
  const res = join(dir, "res-fake");
  libSet(join(res, "lib", "transcribe"), "another build");
  await expect(verifiedLibrary({ JAMSESH_RESOURCES: res, JAMSESH_TRANSCRIBE_LIBRARY: libSet(join(dir, "good"), "a build"), TRANSCRIBE_LIBRARY: fake }, home, record)).rejects.toThrow("isn't the build this hub recorded");
  // A link out of the app's resources isn't the app's own copy, even to the recorded files.
  const linked = join(dir, "res-link");
  mkdirSync(join(linked, "lib"), { recursive: true });
  symlinkSync(join(dir, "good"), join(linked, "lib", "transcribe"));
  await expect(verifiedLibrary({ JAMSESH_RESOURCES: linked }, home, record)).rejects.toThrow("isn't inside the app");
});

test("the hub's record is the generated module's when there is one, and none otherwise", async () => {
  const r = await recordedHashes();
  if (r) expect(Object.keys(r).sort()).toEqual([...LIBRARY_FILES].sort());
  else expect(r).toBeNull();
});

test("Parakeet with a library that isn't the recorded build doesn't start, says why, and leaves the room to whisper", async () => {
  const model = join(dir, "model");
  mkdirSync(model, { recursive: true });
  for (const f of PARAKEET.files) writeFileSync(join(model, f), "not a model");
  const fake = libSet(join(dir, "fake-for-child"), "another build");
  const saved = { ...process.env };
  Object.assign(process.env, { JAMSESH_PARAKEET_DIR: model, JAMSESH_TRANSCRIBE_LIBRARY: fake, TRANSCRIBE_LIBRARY: fake });
  try {
    const p = new Parakeet();
    expect(await p.start(false)).toBeNull();
    expect(p.status().state).toBe("failed");
    expect(p.status().detail).toContain("whisper is transcribing instead");
  } finally {
    for (const k of ["JAMSESH_PARAKEET_DIR", "JAMSESH_TRANSCRIBE_LIBRARY", "TRANSCRIBE_LIBRARY"]) if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}, 30_000);

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
