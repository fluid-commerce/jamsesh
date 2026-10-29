// 6.1: driving the big screen. The lock's owner (and whoever they hand control to) has a cursor of their own; nobody else does.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bus } from "../src/bus";
import { Hub } from "../src/hub";
import { cleanDrive, driveFrom, startHttp } from "../src/http";
import { allowDriveScript, withDriveScript } from "../src/devdrive";
import type { BusMessage } from "../src/types";

process.env.JAMSESH_SILENT = "1";
const dir = mkdtempSync(join(tmpdir(), "jam-drive-"));
const hubs: Hub[] = [];
afterAll(() => {
  for (const h of hubs) h.stop();
  bus.resolver = null;
  rmSync(dir, { recursive: true, force: true });
});

function room() {
  const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, String(Math.random())) });
  hubs.push(hub);
  const s = hub.session;
  const chey = s.upsertPerson({ name: "Chey" });
  const felipe = s.upsertPerson({ name: "Felipe" });
  const maya = s.upsertPerson({ name: "Maya" });
  s.touchDevice("chey-mac", { label: "Chey's Mac", personId: chey.id, kind: "client" });
  s.touchDevice("felipe-laptop", { label: "Felipe's laptop", personId: felipe.id, kind: "client" });
  s.touchDevice("maya-phone", { label: "Maya's phone", personId: maya.id, kind: "client" });
  const online = new Set(["chey-mac", "felipe-laptop"]); // Maya is away
  s.deviceOnline = (id) => online.has(id);
  const art = s.upsertArtifact({ kind: "screenshot", stage: "built", title: "Checkout", agentId: null, image: "/renders/x.png" });
  const cast = (p: { id: string; name: string }, screen = "main") => s.setStage({ mode: "spotlight", items: [art.id], title: "Checkout" }, p.name, screen, { person: { id: p.id, name: p.name } });
  const win = (personId: string | null, kind: "browser" | "agent" = "browser") => {
    const { device } = hub.auth.issue({ kind, label: "w", ip: "10.0.0.9", personId });
    const sent: any[] = [];
    return { ws: { data: { deviceId: "d", pairedId: device.id }, send: (m: string) => sent.push(JSON.parse(m)) } as any, sent };
  };
  const heard: BusMessage[] = [];
  const off = bus.on((m) => m.type === "drive" && heard.push(m));
  return { hub, s, chey, felipe, maya, cast, win, heard, off, online };
}

const move = (x = 0.5, y = 0.5) => ({ type: "drive", screen: "main", ev: { k: "move", x, y } });

test("only the lock's owner starts driving; strangers, an unlocked screen and no-one-in-particular are refused with a reason", () => {
  const { s, chey, felipe, cast } = room();
  expect(s.drive("start", "main", chey.id)).toMatchObject({ ok: false, status: 409 });
  cast(chey);
  expect(s.drive("start", "main", felipe.id)).toMatchObject({ ok: false, status: 403 });
  expect(s.drive("start", "main", null)).toMatchObject({ ok: false, status: 403 });
  expect(s.drive("pass", "main", felipe.id, chey.id)).toMatchObject({ ok: false, status: 403 });
  expect(s.drive("start", "main", chey.id)).toEqual({ ok: true, drivers: [chey.id] });
  expect(s.drive("start", "main", chey.id)).toEqual({ ok: true, drivers: [chey.id] }); // asking twice is fine
  expect(s.stage().lock?.drivers).toEqual([chey.id]);
});

test("pass control hands driving over; drive together adds a second; the owner can take it back or stop someone", () => {
  const { s, chey, felipe, maya, cast } = room();
  cast(chey);
  s.drive("start", "main", chey.id);
  expect(s.drive("pass", "main", chey.id, felipe.id)).toEqual({ ok: true, drivers: [felipe.id] });
  // Felipe can't pass it on, can't start for himself again after leaving, and can stop himself.
  expect(s.drive("pass", "main", felipe.id, chey.id)).toMatchObject({ ok: false, status: 403 });
  expect(s.drive("start", "main", chey.id).ok).toBe(true);
  expect(s.driversOf()).toEqual([felipe.id, chey.id]);
  expect(s.drive("stop", "main", chey.id, felipe.id)).toEqual({ ok: true, drivers: [chey.id] }); // the owner stops Felipe
  expect(s.drive("together", "main", chey.id, felipe.id)).toEqual({ ok: true, drivers: [chey.id, felipe.id] });
  expect(s.drive("stop", "main", felipe.id)).toEqual({ ok: true, drivers: [chey.id] });
  expect(s.drive("stop", "main", felipe.id, chey.id)).toMatchObject({ ok: true }); // not allowed to stop Chey: only stops himself, who isn't driving
  expect(s.driversOf()).toEqual([chey.id]);
  // Someone who isn't here, someone who doesn't exist, and yourself.
  expect(s.drive("pass", "main", chey.id, maya.id)).toMatchObject({ ok: false, status: 409 });
  expect(s.drive("pass", "main", chey.id, "nobody")).toMatchObject({ ok: false, status: 404 });
  expect(s.drive("together", "main", chey.id, chey.id)).toMatchObject({ ok: false, status: 400 });
  expect(s.driversOf()).toEqual([chey.id]);
  expect(s.drive("stop", "main", felipe.id, chey.id)).toMatchObject({ ok: true });
});

test("the drivers go with the lock: a new cast, an unlock or a lapse ends them", () => {
  const { s, chey, felipe, cast, online } = room();
  cast(chey);
  s.drive("together", "main", chey.id, felipe.id);
  expect(s.driversOf()).toEqual([chey.id, felipe.id]);
  cast(felipe); // another person's deliberate cast takes the lock over
  expect(s.driversOf()).toEqual([]);
  expect(s.drive("start", "main", chey.id)).toMatchObject({ ok: false, status: 403 });
  s.drive("start", "main", felipe.id);
  s.unlockStage();
  expect(s.driversOf()).toEqual([]);
  cast(chey);
  s.drive("start", "main", chey.id);
  online.delete("chey-mac");
  const lock = s.stage().lock!;
  (lock as any).lastActive = 0;
  s.store.all("devices").find((d) => d.id === "chey-mac")!.lastSeen = 0;
  s.store.patch("devices", "chey-mac", { lastSeen: 0 });
  // The owner has been gone past the lapse time: the lock lets go, and so does driving.
  s.sweepLocks();
  expect(s.driversOf()).toEqual([]);
});

test("driving a second screen is its own thing", () => {
  const { s, chey, felipe, cast } = room();
  const info = { width: 1920, height: 1080, dpr: 1, screenX: 0, screenY: 0, at: Date.now() };
  s.reportScreen("main", info);
  s.reportScreen("screen-2", { ...info, screenX: 1920 });
  cast(chey);
  cast(felipe, "screen-2");
  expect(s.drive("start", "screen-2", chey.id)).toMatchObject({ ok: false, status: 403 });
  expect(s.drive("start", "screen-2", felipe.id).ok).toBe(true);
  expect(s.driversOf("main")).toEqual([]);
  expect(s.driversOf("screen-2")).toEqual([felipe.id]);
  expect(s.stage("screen-2").lock?.drivers).toEqual([felipe.id]);
});

test("a driver's input reaches every window as that person; strangers, agents, stale drivers and junk are dropped", () => {
  const { s, hub, chey, felipe, cast, win, heard, off } = room();
  const c = win(chey.id);
  const f = win(felipe.id);
  const bot = win(null, "agent");
  const nobody = win(null);
  cast(chey);
  // Before anyone started driving, even the owner is refused.
  driveFrom(c.ws, hub, move());
  expect(heard).toHaveLength(0);
  expect(c.sent[0]).toMatchObject({ type: "drive-denied", screen: "main" });
  s.drive("start", "main", chey.id);
  driveFrom(c.ws, hub, { ...move(0.25, 0.75), personId: felipe.id }); // claiming to be someone else changes nothing
  expect(heard).toHaveLength(1);
  expect(heard[0]).toMatchObject({ type: "drive", personId: chey.id, name: "Chey", color: chey.color, screen: "main", ev: { k: "move", x: 0.25, y: 0.75 } });
  for (const w of [f, bot, nobody]) driveFrom(w.ws, hub, move());
  expect(heard).toHaveLength(1);
  expect(f.sent[0].type).toBe("drive-denied");
  expect(bot.sent[0].type).toBe("drive-denied");
  // Junk is not sent on.
  for (const ev of [null, "x", { k: "move", x: NaN, y: 0 }, { k: "move", x: "a", y: 0 }, { k: "teleport", x: 0, y: 0 }, { k: "key", key: "x".repeat(100), down: true }, { k: "key", key: "" }]) driveFrom(c.ws, hub, { type: "drive", screen: "main", ev });
  expect(heard).toHaveLength(1);
  // Out-of-range numbers are pulled in.
  driveFrom(c.ws, hub, { type: "drive", screen: "main", ev: { k: "wheel", x: 9, y: -3, dx: 1e9, dy: -1e9, ctrl: 1 } });
  expect(heard[1]).toMatchObject({ ev: { k: "wheel", x: 1, y: 0, dx: 5000, dy: -5000, ctrl: true } });
  // Control moves: Felipe now, and Chey's window is dropped at once.
  s.drive("pass", "main", chey.id, felipe.id);
  driveFrom(c.ws, hub, move());
  driveFrom(f.ws, hub, move(0.1, 0.2));
  expect(heard).toHaveLength(3);
  expect(heard[2]).toMatchObject({ personId: felipe.id });
  // The lock moves: Felipe's input stops too.
  cast(chey);
  driveFrom(f.ws, hub, move());
  expect(heard).toHaveLength(3);
  off();
});

test("a window can send only so many events a second", () => {
  const { s, hub, chey, cast, win, heard, off } = room();
  const c = win(chey.id);
  cast(chey);
  s.drive("start", "main", chey.id);
  for (let i = 0; i < 400; i++) driveFrom(c.ws, hub, move(i / 400, 0.5));
  expect(heard.length).toBe(120);
  off();
});

test("cleanDrive keeps keys, buttons and wheel in shape", () => {
  expect(cleanDrive({ k: "key", key: "a", code: "KeyA", down: false, mods: { shift: 1 } })).toEqual({ k: "key", key: "a", code: "KeyA", down: false, mods: { shift: true, ctrl: false, alt: false, meta: false } });
  expect(cleanDrive({ k: "down", x: 0.5, y: 0.5, b: 9, n: 99 })).toEqual({ k: "down", x: 0.5, y: 0.5, b: 4, n: 3 });
  expect(cleanDrive({ k: "leave" })).toEqual({ k: "leave" });
});

test("the http routes: the window's person is who acts; an agent's credential is refused", async () => {
  const { hub, s, chey, felipe, cast } = room();
  s.store.setSetting("hostPersonId", chey.id);
  const server = startHttp(hub, 0);
  s.deviceOnline = (id) => id === "chey-mac" || id === "felipe-laptop";
  try {
    const cookie = () => `jam_window=${hub.auth.windows.take(hub.auth.windows.mint())}`;
    const post = (path: string, body: any, headers: Record<string, string> = { cookie: cookie() }) =>
      fetch(`http://127.0.0.1:${server.port}/api${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    // No lock, no driving.
    expect((await post("/drive/start", {})).status).toBe(409);
    cast(chey);
    // A process on the host without the window key isn't a person; neither is an agent's credential.
    expect((await post("/drive/start", {}, {})).status).toBe(403);
    const agent = hub.auth.issue({ kind: "agent", label: "Agents", ip: "127.0.0.1" });
    expect((await post("/drive/start", {}, { authorization: `Bearer ${agent.token}` })).status).toBe(403);
    expect(s.driversOf()).toEqual([]);
    const ok = await post("/drive/start", {});
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).drivers).toEqual([chey.id]);
    // Passing to someone who is away is refused with their name in the reason.
    const away = await post("/drive/pass", { to: s.upsertPerson({ name: "Maya" }).id });
    expect(away.status).toBe(409);
    expect(((await away.json()) as any).error).toContain("Maya");
    expect((await post("/drive/pass", { to: felipe.id })).status).toBe(200);
    expect(s.driversOf()).toEqual([felipe.id]);
    expect((await post("/drive/together", { to: felipe.id })).status).toBe(200);
    expect(s.driversOf()).toEqual([felipe.id, chey.id]);
    // Felipe, speaking for himself, is not the owner.
    expect((await post("/drive/together", { to: chey.id, personId: felipe.id })).status).toBe(403);
    expect((await post("/drive/stop", {})).status).toBe(200);
    expect(s.driversOf()).toEqual([felipe.id]);
  } finally {
    server.stop(true);
  }
});

test("the dev proxy's script goes first in a page, and a strict Content-Security-Policy gets its hash", () => {
  expect(withDriveScript("<!doctype html><html><head><title>x</title></head><body></body></html>")).toMatch(/<head><script>\(function\(\)\{[\s\S]*<\/script><title>/);
  expect(withDriveScript("<div>bare</div>").startsWith("<script>")).toBe(true);
  expect(withDriveScript("<!DOCTYPE html><p>x</p>")).toMatch(/^<!DOCTYPE html><script>/);
  expect(allowDriveScript("default-src 'self'; img-src *")).toMatch(/^default-src 'self' 'sha256-[A-Za-z0-9+/=]+'; img-src \*$/);
  expect(allowDriveScript("script-src 'self'; default-src 'none'")).toMatch(/^script-src 'self' 'sha256-/);
  expect(allowDriveScript("img-src *")).toBe("img-src *");
  expect(allowDriveScript("script-src 'unsafe-inline'")).toBe("script-src 'unsafe-inline'");
});
