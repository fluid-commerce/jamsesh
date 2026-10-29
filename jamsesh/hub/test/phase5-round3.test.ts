// The third review of Phase 5: who may claim a person (and so their voiceprint), what a reset forgets,
// levels measured from the audio and never taken from the sender, and a download that can be cancelled.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../src/hub";
import { startHttp } from "../src/http";
import { downloadVerified } from "../src/audio/models";
import { installedIntact, PARAKEET, writeManifest } from "../src/audio/parakeet";
import { encodeWav } from "../src/audio/wav";

const dir = mkdtempSync(join(tmpdir(), "jam-p5r3-"));
const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, "d") });
const server = startHttp(hub, 0);
const base = `http://127.0.0.1:${server.port}`;
const servers: { stop: (f?: boolean) => void }[] = [];
afterAll(() => {
  server.stop(true);
  for (const s of servers) s.stop(true);
  hub.devproxy.stop();
  rmSync(dir, { recursive: true, force: true });
});

const remote = { "x-forwarded-for": "9.9.9.9" };
const json = { "content-type": "application/json" };
const as = (token: string) => ({ ...remote, authorization: `Bearer ${token}` });
const call = (token: string, method: string, path: string, body?: unknown) => fetch(`${base}/api${path}`, { method, headers: { ...json, ...as(token) }, body: body === undefined ? undefined : JSON.stringify(body) });
const victim = hub.session.upsertPerson({ name: "Victim" });
const loose = hub.session.upsertPerson({ name: "Loose" });
const owner = hub.auth.issue({ kind: "browser", label: "Victim's laptop", ip: "10.0.0.5", personId: victim.id });
const stranger = hub.auth.issue({ kind: "browser", label: "New laptop", ip: "10.0.0.6" });

test("a newly paired browser can't claim a person who is already on another laptop, so their voice stays theirs", async () => {
  const claim = await call(stranger.token, "POST", "/devices", { deviceId: "d-stranger", personId: victim.id });
  expect(claim.status).toBe(403);
  expect(hub.auth.get(stranger.device.id)?.personId).toBeNull();
  expect((await call(stranger.token, "DELETE", `/people/${victim.id}/voiceprint`)).status).toBe(403);
  expect((await call(stranger.token, "POST", `/people/${victim.id}/voice/start`, { seq: Bun.nanoseconds() })).status).toBe(403);
  // The owner still can.
  expect((await call(owner.token, "POST", `/people/${victim.id}/voice/start`, { seq: Bun.nanoseconds() })).status).toBe(200);
});

test("nor the person using the host's own window; a person nobody holds can be claimed once", async () => {
  hub.session.store.setSetting("hostPersonId", loose.id);
  const other = hub.auth.issue({ kind: "browser", label: "Another", ip: "10.0.0.8" });
  expect((await call(other.token, "POST", "/devices", { deviceId: "d-other", personId: loose.id })).status).toBe(403);
  hub.session.store.setSetting("hostPersonId", "");
  expect((await call(other.token, "POST", "/devices", { deviceId: "d-other", personId: loose.id })).status).toBe(200);
  expect(hub.auth.get(other.device.id)?.personId).toBe(loose.id);
  // A second laptop for the same person isn't allowed to take it either; the host removes the old pairing first.
  const late = hub.auth.issue({ kind: "browser", label: "Late", ip: "10.0.0.9" });
  expect((await call(late.token, "POST", "/devices", { deviceId: "d-late", personId: loose.id })).status).toBe(403);
  // Once someone has been them, disconnecting that laptop doesn't free them for anyone: the host lets one in (phase5-round4).
  hub.auth.revoke(other.device.id);
  expect((await call(late.token, "POST", "/devices", { deviceId: "d-late", personId: loose.id })).status).toBe(403);
});

test("a reset forgets voices not yet confirmed", async () => {
  const held = new Float32Array(256).fill(0.1);
  (hub.audio as any).candidates.set(victim.id, [[{ e: held, at: Date.now() }]]);
  hub.resetVoice(victim.id);
  expect((hub.audio as any).candidates.has(victim.id)).toBe(false);
});

test("the level a laptop reports in the URL is ignored: the audio is measured", async () => {
  const mine = await call(owner.token, "POST", "/devices", { deviceId: "d-owner", label: "Mic" });
  expect(mine.status).toBe(200);
  const n = 16000 * 2;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = 0.05 * Math.sin(i / 20) * (0.5 + 0.5 * Math.sin(i / 3000));
  const wav = encodeWav({ sampleRate: 16000, samples: x });
  const levels: number[] = [];
  for (const [i, q] of ["", "&level=999&noise=-999", "&level=Infinity&noise=NaN", "&level=-Infinity&noise=-Infinity"].entries()) {
    const t0 = Date.now() - 20_000 + i * 5000;
    const r = await fetch(`${base}/api/audio?deviceId=d-owner&t0=${t0}&t1=${t0 + 2000}${q}`, { method: "POST", headers: { ...as(owner.token), "content-type": "audio/wav" }, body: wav as unknown as BodyInit });
    expect(r.status).toBe(200);
    levels.push(hub.session.store.get("devices", "d-owner")!.level as number);
  }
  expect(Number.isFinite(levels[0])).toBe(true);
  for (const l of levels) expect(l).toBe(levels[0]);
  // Someone else's device, with the same forged values, is still refused.
  const t0 = Date.now();
  expect((await fetch(`${base}/api/audio?deviceId=d-owner&t0=${t0}&t1=${t0 + 2000}&level=999`, { method: "POST", headers: { ...as(stranger.token), "content-type": "audio/wav" }, body: wav as unknown as BodyInit })).status).toBe(403);
});

const pin = (url: string) => ({ url, sha256: "0".repeat(64), bytes: 1000 });
/** A server that sends its headers and a few bytes, then says nothing for as long as it's open. */
function stalled() {
  const s = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(new ReadableStream({ start: (c) => c.enqueue(new Uint8Array(10)) }), { headers: { "content-length": "1000" } }),
  });
  servers.push(s);
  return `http://127.0.0.1:${s.port}/model`;
}

test("a download that stalls ends when it's cancelled, without waiting for another chunk", async () => {
  let stop = false;
  const started = Date.now();
  setTimeout(() => (stop = true), 300);
  await expect(downloadVerified(pin(stalled()), join(dir, "a.part"), () => {}, () => stop)).rejects.toThrow("Stopped while downloading.");
  expect(Date.now() - started).toBeLessThan(3000);
});

test("a download that stalls ends on its own after the idle limit; one that never answers does too", async () => {
  const started = Date.now();
  await expect(downloadVerified(pin(stalled()), join(dir, "b.part"), () => {}, () => false, 400)).rejects.toThrow("stalled");
  expect(Date.now() - started).toBeLessThan(3000);
  const silent = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Promise<Response>(() => {}) });
  servers.push(silent);
  await expect(downloadVerified(pin(`http://127.0.0.1:${silent.port}/m`), join(dir, "c.part"), () => {}, () => false, 400)).rejects.toThrow("stalled");
});

test("installed Parakeet files are checked against what was verified at install; a changed one isn't loaded", async () => {
  const where = join(dir, "pk");
  mkdirSync(where, { recursive: true });
  for (const f of PARAKEET.files) writeFileSync(join(where, f), `contents of ${f}`);
  // No manifest, or one that can't be read: the files can't be verified, so they're not blessed (and nothing is written).
  expect(await installedIntact(where)).toBe(false);
  expect(existsSync(join(where, ".files.sha256.json"))).toBe(false);
  for (const bad of ["{not json", "null", "[]", "{}"]) {
    writeFileSync(join(where, ".files.sha256.json"), bad);
    expect(await installedIntact(where)).toBe(false);
  }
  await writeManifest(where);
  expect(Object.keys(JSON.parse(readFileSync(join(where, ".files.sha256.json"), "utf8")))).toEqual(PARAKEET.files);
  expect(await installedIntact(where)).toBe(true);
  writeFileSync(join(where, PARAKEET.files[1]), "swapped");
  expect(await installedIntact(where)).toBe(false);
  // A folder the person chose (or the app bundle) isn't second-guessed; a fresh install is recorded from the verified archive.
  expect(await installedIntact(where, false)).toBe(true);
  await writeManifest(where);
  expect(await installedIntact(where)).toBe(true);
});
