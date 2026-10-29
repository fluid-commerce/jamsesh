// Phase 5, office review: a person identity is granted only by the host's explicit confirmation of that exact
// person (or, by becomePerson's rule, someone the browser made itself or nobody has been). Every path into
// bindBrowser, the one place a browser credential is given a person. Nothing makes sound.
import "./voices.env";
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../src/hub";
import { startHttp } from "../src/http";

const dir = mkdtempSync(join(tmpdir(), "jam-p5r7-"));
const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, "d") });
const server = startHttp(hub, 0);
const base = `http://127.0.0.1:${server.port}`;
afterAll(() => {
  server.stop(true);
  hub.devproxy.stop();
  rmSync(dir, { recursive: true, force: true });
});

const remote = { "x-forwarded-for": "9.9.9.9", "content-type": "application/json" };
const call = (token: string, method: string, path: string, body?: unknown) =>
  fetch(`${base}/api${path}`, { method, headers: { ...remote, authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
const asHostWindow = (method: string, path: string, body?: unknown) =>
  fetch(`${base}/api${path}`, { method, headers: { "content-type": "application/json", cookie: `jam_window=${hub.auth.windows.take(hub.auth.windows.mint())}` }, body: body === undefined ? undefined : JSON.stringify(body) });
const browser = (label: string) => hub.auth.issue({ kind: "browser", label, ip: "10.0.0.20" });
/** A person someone else already holds, and a laptop asking to be them. */
async function asking(name: string) {
  const p = hub.session.upsertPerson({ name });
  const own = browser(`${name}'s laptop`);
  expect((await call(own.token, "POST", "/devices", { deviceId: `d-${name}`, personId: p.id })).status).toBe(200);
  const other = browser(`Someone wanting ${name}`);
  expect((await call(other.token, "POST", "/devices", { deviceId: `d-want-${name}`, personId: p.id })).status).toBe(403);
  return { p, own, other };
}

test("the host's approval names the person it was shown; a request changed since then isn't granted", async () => {
  const lee = await asking("Lee");
  const ray = await asking("Ray");
  // The host is shown "wants Lee"; meanwhile the laptop asks to be Ray instead.
  expect((await call(lee.other.token, "POST", "/devices", { deviceId: `d-want-Lee`, personId: ray.p.id })).status).toBe(403);
  expect(hub.auth.get(lee.other.device.id)?.wants).toBe(ray.p.id);
  const r = await asHostWindow("POST", `/paired/${lee.other.device.id}/allow`, { personId: lee.p.id });
  expect(r.status).toBe(409);
  expect((await r.json()).error).toContain("now asking to be Ray");
  expect(hub.auth.get(lee.other.device.id)?.personId).toBeNull();
  // Ray's own laptop is untouched.
  expect(hub.auth.get(ray.own.device.id)?.personId).toBe(ray.p.id);
});

test("an approval without a person, or with a junk one, grants nothing", async () => {
  const kai = await asking("Kai");
  for (const body of [{}, { personId: null }, { personId: 5 }, { personId: [kai.p.id] }, { personId: "p_nobody" }, undefined]) {
    expect((await asHostWindow("POST", `/paired/${kai.other.device.id}/allow`, body)).status).toBe(409);
    expect(hub.auth.get(kai.other.device.id)?.personId).toBeNull();
  }
  expect(hub.auth.get(kai.own.device.id)?.personId).toBe(kai.p.id);
});

test("a late replay of an approval for a laptop that was disconnected meanwhile grants nothing", async () => {
  const ivy = await asking("Ivy");
  hub.auth.revoke(ivy.other.device.id);
  expect((await asHostWindow("POST", `/paired/${ivy.other.device.id}/allow`, { personId: ivy.p.id })).status).toBe(404);
  expect(hub.auth.get(ivy.own.device.id)?.personId).toBe(ivy.p.id);
});

test("the exact approval grants that person, once; replaying it after changes nothing", async () => {
  const max = await asking("Max");
  expect((await asHostWindow("POST", `/paired/${max.other.device.id}/allow`, { personId: max.p.id })).status).toBe(200);
  expect(hub.auth.get(max.other.device.id)).toMatchObject({ personId: max.p.id, wants: null });
  expect(hub.auth.get(max.own.device.id)).toBeNull();
  // Replayed later: the laptop isn't asking anymore.
  expect((await asHostWindow("POST", `/paired/${max.other.device.id}/allow`, { personId: max.p.id })).status).toBe(404);
});
