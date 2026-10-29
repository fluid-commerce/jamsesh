// 6.1: driving the big screen. The lock's owner (and whoever they hand control to) has a cursor of their own; nobody else does.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bus } from "../src/bus";
import { Hub } from "../src/hub";
import { cleanDrive, driveFrom, startHttp } from "../src/http";
import { allowDriveScript, driveScript, scriptHash, withDriveScript } from "../src/devdrive";
import { createHash } from "node:crypto";
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

test("an owner who re-casts while driving keeps driving; handed-over drivers are cut off; a non-driving owner stays not driving", () => {
  const { s, chey, felipe, cast } = room();
  cast(chey);
  s.drive("together", "main", chey.id, felipe.id);
  cast(chey);
  expect(s.driversOf()).toEqual([chey.id]);
  s.drive("stop", "main", chey.id);
  cast(chey);
  expect(s.driversOf()).toEqual([]);
  s.drive("start", "main", chey.id);
  cast(felipe); // someone else's cast still ends it
  expect(s.driversOf()).toEqual([]);
});

test("who is online, for the Pass control menu", () => {
  const { s, chey, felipe, maya } = room();
  expect(s.onlinePeople().sort()).toEqual([chey.id, felipe.id].sort());
  expect(s.onlinePeople()).not.toContain(maya.id);
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

test("a person can send only so many events a second, however many windows they open", () => {
  const { s, hub, chey, felipe, cast, win, heard, off } = room();
  const [a, b, c] = [win(chey.id), win(chey.id), win(chey.id)];
  cast(chey);
  s.drive("start", "main", chey.id);
  s.drive("together", "main", chey.id, felipe.id);
  for (let i = 0; i < 400; i++) driveFrom([a, b, c][i % 3].ws, hub, move(i / 400, 0.5));
  expect(heard.length).toBe(120);
  // Someone else driving together has a budget of their own.
  const f = win(felipe.id);
  for (let i = 0; i < 10; i++) driveFrom(f.ws, hub, move());
  expect(heard.length).toBe(130);
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
    // Who is online to pass to: people's windows only, not an agent or another process on the host.
    const online = (headers: Record<string, string>) => fetch(`http://127.0.0.1:${server.port}/api/drive/online`, { headers });
    expect((await online({ authorization: `Bearer ${agent.token}` })).status).toBe(403);
    expect((await online({})).status).toBe(403);
    const remoteAgent = hub.auth.issue({ kind: "agent", label: "Agents", ip: "10.0.0.5" });
    expect((await online({ authorization: `Bearer ${remoteAgent.token}`, "x-forwarded-for": "10.0.0.5" })).status).toBe(403);
    const lap = hub.auth.issue({ kind: "browser", label: "Felipe's laptop", ip: "10.0.0.6", personId: felipe.id });
    const seen = await online({ authorization: `Bearer ${lap.token}`, "x-forwarded-for": "10.0.0.6" });
    expect(seen.status).toBe(200);
    expect((await online({ cookie: cookie() })).status).toBe(200);
  } finally {
    server.stop(true);
  }
});

const KEY = "k".repeat(48);
const KEY_HASH = createHash("sha256").update(KEY).digest("hex");
const HOST = "http://127.0.0.1:4790";
const SCRIPT = driveScript(HOST, KEY_HASH);
const HASH = scriptHash(SCRIPT);

test("the dev proxy's script goes first in a page, before any meta Content-Security-Policy", () => {
  const tag = `<script>${SCRIPT}</script>`;
  expect(withDriveScript("<!doctype html><html><head><title>x</title></head><body></body></html>", SCRIPT)).toBe(`<!doctype html><html><head>${tag}<title>x</title></head><body></body></html>`);
  expect(withDriveScript("<div>bare</div>", SCRIPT).startsWith("<script>")).toBe(true);
  expect(withDriveScript("<!DOCTYPE html><p>x</p>", SCRIPT)).toBe(`<!DOCTYPE html>${tag}<p>x</p>`);
  // A meta policy inside the head comes after the script, as does one before the head (or with no head at all).
  const inHead = `<head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="script-src 'self'"></head>`;
  expect(withDriveScript(inHead, SCRIPT).indexOf(tag)).toBeLessThan(withDriveScript(inHead, SCRIPT).indexOf("http-equiv"));
  const before = `<!doctype html><meta http-equiv=content-security-policy content="script-src 'none'"><head><title>x</title></head>`;
  expect(withDriveScript(before, SCRIPT)).toBe(`<!doctype html>${tag}<meta http-equiv=content-security-policy content="script-src 'none'"><head><title>x</title></head>`);
  const noHead = `<META HTTP-EQUIV="Content-Security-Policy" CONTENT="default-src 'none'"><p>x</p>`;
  expect(withDriveScript(noHead, SCRIPT).startsWith(tag)).toBe(true);
});

test("a header Content-Security-Policy gets the script's hash wherever inline scripts are decided", () => {
  expect(allowDriveScript("default-src 'self'; img-src *", HASH)).toBe(`default-src 'self' ${HASH}; img-src *`);
  expect(allowDriveScript("script-src 'self'; default-src 'none'", HASH)).toBe(`script-src 'self' ${HASH}; default-src 'none'`);
  // script-src-elem decides inline <script> elements when it is there: it gets the hash, and so does script-src.
  expect(allowDriveScript("script-src-elem 'self'", HASH)).toBe(`script-src-elem 'self' ${HASH}`);
  expect(allowDriveScript("script-src 'self'; script-src-elem 'self' https://cdn.example", HASH)).toBe(`script-src 'self' ${HASH}; script-src-elem 'self' https://cdn.example ${HASH}`);
  // Nothing about scripts: nothing to widen. Inline already allowed: left as it is (a hash would switch that off).
  expect(allowDriveScript("img-src *", HASH)).toBe("img-src *");
  expect(allowDriveScript("script-src 'unsafe-inline'", HASH)).toBe("script-src 'unsafe-inline'");
  expect(allowDriveScript("script-src 'unsafe-inline' 'nonce-abc'", HASH)).toBe(`script-src 'unsafe-inline' 'nonce-abc' ${HASH}`);
  // Two policies in one header (two headers joined): each one is widened.
  expect(allowDriveScript("script-src 'self', default-src 'none'", HASH)).toBe(`script-src 'self' ${HASH}, default-src 'none' ${HASH}`);
});

/** Runs the page script in a stand-in frame and returns how to post to it, and the keys it replayed. */
function frame() {
  const listeners: ((m: any) => void)[] = [];
  const replayed: string[] = [];
  const parent = { postMessage: () => {} };
  const win: any = {
    parent,
    addEventListener: (type: string, fn: (m: any) => void) => type === "message" && listeners.push(fn),
    crypto: globalThis.crypto,
    TextEncoder,
    Promise,
    innerWidth: 800,
    innerHeight: 600,
  };
  win.window = win;
  win.document = { activeElement: null, body: { dispatchEvent: (e: any) => (replayed.push(e.key), false) } };
  win.KeyboardEvent = class {
    constructor(
      readonly type: string,
      o: object,
    ) {
      Object.assign(this, o);
    }
  };
  new Function(...Object.keys(win), SCRIPT)(...Object.values(win));
  const post = async (data: unknown, origin = HOST, source: unknown = parent) => {
    for (const l of listeners) l({ data, origin, source });
    await new Promise((r) => setTimeout(r, 20));
  };
  return { post, replayed };
}

const keyEv = (key: string) => ({ k: "key", key, down: true });

test("a build's frame replays input only from the host's big screen, with the session's key", async () => {
  const f = frame();
  // Another page on the same machine (any other port, or localhost for 127.0.0.1) is ignored, key or not.
  await f.post({ jamDrive: keyEv("a"), key: KEY }, "http://127.0.0.1:5173");
  await f.post({ jamDrive: keyEv("b"), key: KEY }, "http://localhost:4790");
  await f.post({ jamDrive: keyEv("c"), key: KEY }, "https://127.0.0.1:4790");
  // The big screen's origin without the key, with a wrong one, or from a window that isn't the parent.
  await f.post({ jamDrive: keyEv("d") });
  await f.post({ jamDrive: keyEv("e"), key: "x".repeat(48) });
  await f.post({ jamDrive: keyEv("f"), key: KEY }, HOST, {});
  expect(f.replayed).toEqual([]);
  // The real thing, in order, including events sent while the key is still being checked.
  void f.post({ jamDrive: keyEv("g"), key: KEY });
  await f.post({ jamDrive: keyEv("h"), key: KEY });
  await f.post({ jamDrive: keyEv("i"), key: "nope" });
  expect(f.replayed).toEqual(["g", "h"]);
  // The page itself holds only the key's hash.
  expect(SCRIPT).toContain(KEY_HASH);
  expect(SCRIPT).not.toContain(KEY);
});

test("the big screen's frame key: the host's own windows only", async () => {
  const { hub } = room();
  const server = startHttp(hub, 0);
  try {
    const get = (headers: Record<string, string>) => fetch(`http://127.0.0.1:${server.port}/api/drive/frame-key`, { headers });
    const ok = await get({ cookie: `jam_window=${hub.auth.windows.take(hub.auth.windows.mint())}` });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).key).toBe(hub.devproxy.frameKey);
    expect((await get({})).status).toBe(403);
    const lap = hub.auth.issue({ kind: "browser", label: "A laptop", ip: "10.0.0.6", personId: hub.session.people()[0].id });
    expect((await get({ authorization: `Bearer ${lap.token}`, "x-forwarded-for": "10.0.0.6" })).status).toBe(403);
    const agent = hub.auth.issue({ kind: "agent", label: "Agents", ip: "10.0.0.5" });
    expect((await get({ authorization: `Bearer ${agent.token}`, "x-forwarded-for": "10.0.0.5" })).status).toBe(403);
  } finally {
    server.stop(true);
  }
});

/** A stand-in frame that records every mouse and keyboard event the page script fires, and lets the test run the page's own timers. */
function pressFrame() {
  const listeners: ((m: any) => void)[] = [];
  const fired: string[] = [];
  const timers: (() => void)[] = [];
  const parent = { postMessage: () => {} };
  const body: any = {
    tagName: "BODY",
    isContentEditable: false,
    dispatchEvent: (e: any) => (fired.push(e.type === "keyup" || e.type === "keydown" ? `${e.type} ${e.key}` : `${e.type} b${e.button} buttons${e.buttons}`), false),
    contains: () => true,
    closest: () => null,
  };
  const win: any = {
    parent,
    addEventListener: (type: string, fn: (m: any) => void) => type === "message" && listeners.push(fn),
    crypto: globalThis.crypto,
    TextEncoder,
    Promise,
    innerWidth: 800,
    innerHeight: 600,
    setTimeout: (fn: () => void) => timers.push(fn),
    clearTimeout: () => {},
    getComputedStyle: () => ({ overflowX: "visible", overflowY: "visible" }),
  };
  win.window = win;
  win.document = { activeElement: null, body, documentElement: body, elementFromPoint: () => body };
  class Ev {
    type: string;
    constructor(type: string, o: object) {
      this.type = type;
      Object.assign(this, o);
    }
  }
  win.KeyboardEvent = Ev;
  win.MouseEvent = Ev;
  new Function(...Object.keys(win), SCRIPT)(...Object.values(win));
  const post = async (jamDrive: unknown, who = "p1") => {
    for (const l of listeners) l({ data: { jamDrive, key: KEY, who }, origin: HOST, source: parent });
    await new Promise((r) => setTimeout(r, 15));
  };
  return { post, fired, timers };
}

test("a build's frame lets go of a held button and held keys when the driver leaves, per driver, and by itself when input goes quiet", async () => {
  const f = pressFrame();
  await f.post({ k: "down", x: 0.5, y: 0.5, b: 0 });
  await f.post({ k: "key", key: "Shift", code: "ShiftLeft", down: true, mods: { shift: true } });
  f.fired.length = 0;
  // Leaving mid-press (blur, pointer-lock loss, the driver removed) ends the press and the key: up events, no click.
  await f.post({ k: "leave" });
  expect(f.fired).toContain("pointerup b0 buttons0");
  expect(f.fired).toContain("mouseup b0 buttons0");
  expect(f.fired).toContain("keyup Shift");
  expect(f.fired.some((e) => e.startsWith("click"))).toBe(false);
  // A second leave has nothing left to release.
  f.fired.length = 0;
  await f.post({ k: "leave" });
  expect(f.fired.filter((e) => e.startsWith("mouseup") || e.startsWith("keyup"))).toEqual([]);

  // One driver leaving doesn't let go of another's press.
  await f.post({ k: "down", x: 0.2, y: 0.2, b: 0 }, "alice");
  await f.post({ k: "down", x: 0.7, y: 0.7, b: 0 }, "bob");
  f.fired.length = 0;
  await f.post({ k: "leave" }, "alice");
  expect(f.fired.filter((e) => e.startsWith("mouseup")).length).toBe(1);
  f.fired.length = 0;
  await f.post({ k: "up", x: 0.7, y: 0.7, b: 0 }, "bob");
  expect(f.fired.some((e) => e.startsWith("mouseup"))).toBe(true);

  // Input that goes quiet with a press held: the page's own timer lets go.
  await f.post({ k: "down", x: 0.4, y: 0.4, b: 2 });
  await f.post({ k: "key", key: "a", code: "KeyA", down: true });
  f.fired.length = 0;
  f.timers.at(-1)!();
  expect(f.fired).toContain("mouseup b2 buttons0");
  expect(f.fired).toContain("keyup a");
  // A key that came up on its own is not released again.
  await f.post({ k: "key", key: "b", code: "KeyB", down: true });
  await f.post({ k: "key", key: "b", code: "KeyB", down: false });
  f.fired.length = 0;
  await f.post({ k: "leave" });
  expect(f.fired.filter((e) => e.startsWith("keyup"))).toEqual([]);
});
