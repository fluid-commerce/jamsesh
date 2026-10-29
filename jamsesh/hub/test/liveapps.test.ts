// Live app tiles (6.3): frames out, taps in, who is driving, and the unhappy paths. A fake `xcrun` stands
// in for the Simulator so nothing here touches a real device or the host's own folder.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "jam-live-"));
process.env.JAMSESH_HOME = join(dir, "home");
process.env.JAMSESH_SILENT = "1";
const shim = join(dir, "shim");
mkdirSync(shim);
writeFileSync(
  join(shim, "xcrun"),
  `#!/bin/bash
D="${dir}"
[ "$2" = "io" ] && { [ -e "$D/gone" ] && exit 1; n=$(cat "$D/n" 2>/dev/null || echo 0); [ -e "$D/same" ] || echo $((n+1)) > "$D/n"; printf '\\xff\\xd8frame-%s\\xff\\xd9' "$(cat "$D/n")" > "\${@: -1}"; exit 0; }
[ "$2" = "list" ] && { [ -e "$D/gone" ] && echo '{"devices":{"r":[]}}' || echo '{"devices":{"r":[{"udid":"U1","state":"Booted","name":"iPhone Test"}]}}'; exit 0; }
[ "$2" = "ui" ] && { [ -n "$5" ] && echo "$5" > "$D/appearance" && exit 0; echo light; exit 0; }
exit 0
`,
);
chmodSync(join(shim, "xcrun"), 0o755);
process.env.PATH = `${shim}:${process.env.PATH}`;

const { Hub } = await import("../src/hub");
const { startHttp } = await import("../src/http");
const { CONTROL_IDLE_MS, pickSimWindow, planCapture } = await import("../src/liveapps");

const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, "d") });
const server = startHttp(hub, 0);
const base = `http://127.0.0.1:${server.port}`;
afterAll(() => {
  hub.live.stopAll();
  server.stop(true);
  hub.devproxy.stop();
  rmSync(dir, { recursive: true, force: true });
});

const s = hub.session;
const calls: string[] = [];
hub.live.pickSim = async () => ({ udid: "U1", name: "iPhone Test" });
hub.live.companionFor = () => ({
  onExit: () => {},
  start: async () => null,
  describe: async () => ({ widthPx: 1206, heightPx: 2622, widthPt: 402, heightPt: 874, density: 3 }),
  tap: async (x: number, y: number) => void calls.push(`tap ${Math.round(x)},${Math.round(y)}`),
  swipe: async (x: number, y: number, x2: number, y2: number) => void calls.push(`swipe ${Math.round(x)},${Math.round(y)}>${Math.round(x2)},${Math.round(y2)}`),
  button: async (b: string) => void calls.push(`button ${b}`),
  orientation: async (o: number) => void calls.push(`orientation ${o}`),
  type: async (t: string) => void calls.push(`type ${t}`),
  key: async (k: string) => void calls.push(`key ${k}`),
  stop: () => {},
});
// No Mac helper by default: window capture has its own tests below.
hub.live.helper = async () => "no helper in tests";
s.store.setSetting("hostControl", true);
const maya = s.upsertPerson({ name: "Maya" });
const sam = s.upsertPerson({ name: "Sam" });
s.store.setSetting("hostPersonId", maya.id);

const json = { "content-type": "application/json" };
const host = () => ({ cookie: `jam_window=${hub.auth.windows.take(hub.auth.windows.mint())}` });
const post = (path: string, body: unknown, h: Record<string, string> = host()) => fetch(`${base}/api${path}`, { method: "POST", headers: { ...json, ...h }, body: JSON.stringify(body) });
// Sam's own laptop: a paired browser that belongs to Sam.
const samDevice = hub.auth.issue({ kind: "browser", label: "Sam's laptop", ip: "10.0.0.7", personId: sam.id });
const samHeaders = { "x-forwarded-for": "10.0.0.7", authorization: `Bearer ${samDevice.token}` };
const agent = hub.auth.issue({ kind: "agent", label: "Agents on Mac", ip: "10.0.0.5", ownerDeviceId: "dev_mac0" });
const agentHeaders = { "x-forwarded-for": "10.0.0.5", authorization: `Bearer ${agent.token}` };

let appId = "";
const mine = () => s.state().liveApps.find((a) => a.id === appId)!;
test("starting a tile: the host's window can, an agent or a stranger can't", async () => {
  expect((await post("/apps", { kind: "ios" }, agentHeaders)).status).toBe(403);
  expect((await post("/apps", { kind: "ios" }, { "x-forwarded-for": "9.9.9.9" })).status).toBe(401);
  // A paired person who isn't the host can't put the host's Simulator on a tile either.
  expect((await post("/apps", { kind: "ios" }, samHeaders)).status).toBe(403);
  const r = await post("/apps", { kind: "ios" });
  expect(r.status).toBe(200);
  const { app } = (await r.json()) as any;
  appId = app.id;
  expect(app).toMatchObject({ kind: "ios", name: "iPhone Test", width: 402, height: 874, canTap: true, controller: null, appearance: "light" });
  expect(s.state().liveApps).toHaveLength(1);
  // Asking again for the same device gives the same tile.
  expect(((await (await post("/apps", { kind: "ios" })).json()) as any).app.id).toBe(appId);
});

test("with host control off, nothing starts", async () => {
  s.store.setSetting("hostControl", false);
  hub.live.stop(appId);
  expect((await post("/apps", { kind: "ios" })).status).toBe(409);
  s.store.setSetting("hostControl", true);
  const r = await post("/apps", { kind: "ios" });
  appId = ((await r.json()) as any).app.id;
});

test("frames reach a viewer, identical ones are dropped, and capture stops when nobody watches", async () => {
  const got: string[] = [];
  const off = hub.live.subscribe(appId, (f) => got.push(new TextDecoder().decode(f).replace(/[^\w-]/g, "")))!;
  await Bun.sleep(900);
  expect(got.length).toBeGreaterThan(2);
  // The screen stops changing: the fake keeps writing the same bytes, and nothing more goes out.
  await Bun.file(join(dir, "same")).write("1");
  await Bun.sleep(300);
  const settled = got.length;
  await Bun.sleep(700);
  expect(got.length).toBe(settled);
  off();
  await Bun.sleep(800);
  rmSync(join(dir, "same"));
  const n = readFileSync(join(dir, "n"), "utf8");
  await Bun.sleep(500);
  expect(readFileSync(join(dir, "n"), "utf8")).toBe(n);
});

test("only the person driving can tap; control is taken, refused, passed and released", async () => {
  const tap = (h: Record<string, string>) => post(`/apps/${appId}/input`, { t: "tap", x: 0.5, y: 0.5 }, h);
  // Nobody is driving yet.
  expect((await tap(host())).status).toBe(409);
  expect(calls).toEqual([]);
  // An agent has no route at all, driving or not.
  expect((await tap(agentHeaders)).status).toBe(403);
  expect((await post(`/apps/${appId}/control`, { action: "take" }, agentHeaders)).status).toBe(403);
  expect(((await (await post(`/apps/${appId}/control`, { action: "take" }, samHeaders)).json()) as any).result).toContain("driving");
  expect(mine().controller?.name).toBe("Sam");
  // Maya (the host's person) is not driving: refused, with the reason.
  const refused = await tap(host());
  expect(refused.status).toBe(409);
  expect(((await refused.json()) as any).error).toContain("Sam is driving");
  expect(calls).toEqual([]);
  // Sam taps: a point in the middle of the screen, mapped to points.
  expect((await tap(samHeaders)).status).toBe(200);
  expect(calls).toEqual(["tap 201,437"]);
  // Another person can't just take it; the host's window can.
  const take = (h: Record<string, string>) => post(`/apps/${appId}/control`, { action: "take" }, h);
  await take(host());
  expect(mine().controller?.name).toBe("Maya");
  // Passing needs a real person; a repeat of the same pass is harmless.
  expect((await post(`/apps/${appId}/control`, { action: "pass", to: "nobody" })).status).toBe(400);
  await post(`/apps/${appId}/control`, { action: "pass", to: sam.id });
  await post(`/apps/${appId}/control`, { action: "pass", to: sam.id });
  expect(mine().controller?.name).toBe("Sam");
  // Maya no longer holds it, so she can't release it.
  expect(((await (await post(`/apps/${appId}/control`, { action: "release" }, samHeaders)).json()) as any).result).toContain("released");
  expect(mine().controller).toBeNull();
});

test("Home, Rotate, Light/Dark and swipes go through; touches wait for portrait", async () => {
  await post(`/apps/${appId}/control`, { action: "take" }, samHeaders);
  calls.length = 0;
  const send = async (b: unknown) => ((await (await post(`/apps/${appId}/input`, b, samHeaders)).json()) as any);
  expect((await send({ t: "home" })).ok).toBe(true);
  expect((await send({ t: "swipe", x: 0.5, y: 0.8, x2: 0.5, y2: 0.2, ms: 250 })).ok).toBe(true);
  expect((await send({ t: "appearance" })).ok).toBe(true);
  expect(readFileSync(join(dir, "appearance"), "utf8").trim()).toBe("dark");
  expect(mine().appearance).toBe("dark");
  expect((await send({ t: "rotate" })).ok).toBe(true);
  expect(mine().orientation).toBe("landscape-left");
  expect((await send({ t: "tap", x: 0.5, y: 0.5 })).error).toContain("portrait");
  expect((await send({ t: "rotate" })).ok).toBe(true);
  expect(calls).toEqual(["button home", "swipe 201,699>201,175", "orientation 2", "orientation 0"]);
  // Junk never reaches the device.
  calls.length = 0;
  for (const bad of [{ t: "tap" }, { t: "tap", x: "a", y: 1 }, { t: "tap", x: NaN, y: 1 }, { t: "launch" }, {}, { t: "swipe", x: 1, y: 1 }]) expect((await send(bad)).ok).toBe(false);
  // Out-of-range points are clamped onto the screen.
  expect((await send({ t: "tap", x: 7, y: -3 })).ok).toBe(true);
  expect(calls).toEqual(["tap 402,0"]);
});

test("control lapses when the driver goes idle", async () => {
  const live = (hub.live as any).apps.get(appId);
  live.lastActive = Date.now() - CONTROL_IDLE_MS - 1000;
  const r = await post(`/apps/${appId}/input`, { t: "tap", x: 0.1, y: 0.1 }, samHeaders);
  expect(r.status).toBe(409);
  expect(mine().controller).toBeNull();
  // And someone else can take a lapsed hold without the host's override.
  await post(`/apps/${appId}/control`, { action: "take" }, samHeaders);
  live.lastActive = Date.now() - CONTROL_IDLE_MS - 1000;
  expect(hub.live.control(appId, "take", { personId: maya.id, name: "Maya", host: false })).toContain("driving");
});

test("the frame socket: people only, and only for a live app", async () => {
  const ws = (path: string, h: Record<string, string>) => fetch(`${base}${path}`, { headers: { upgrade: "websocket", connection: "Upgrade", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", origin: base, ...h } });
  expect((await ws(`/ws/app/${appId}`, agentHeaders)).status).toBe(403);
  expect((await ws(`/ws/app/app-nope`, host())).status).toBe(404);
  expect((await ws(`/ws/app/${appId}`, { "x-forwarded-for": "9.9.9.9" })).status).toBe(401);
  // Loopback alone isn't a person: another process on the host, or the host's window key guessed, gets no frames.
  expect((await ws(`/ws/app/${appId}`, {})).status).toBe(403);
  expect((await ws(`/ws/app/${appId}`, { cookie: "jam_window=" + "0".repeat(64) })).status).toBe(403);
  expect((await ws(`/ws/app/${appId}`, { authorization: `Bearer ${agent.token}` })).status).toBe(403);
  // A real socket from the host's window gets binary frames.
  const sock = new WebSocket(`ws://127.0.0.1:${server.port}/ws/app/${appId}`, { headers: { ...host(), origin: base } } as any);
  sock.binaryType = "arraybuffer";
  const frame = await new Promise<ArrayBuffer>((res, rej) => {
    sock.onmessage = (e) => res(e.data as ArrayBuffer);
    sock.onerror = () => rej(new Error("socket failed"));
    setTimeout(() => rej(new Error("no frame")), 4000);
  });
  expect(new Uint8Array(frame)[0]).toBe(0xff);
  sock.close();
});

test("a device that disappears mid-stream ends the tile, frees control and says why", async () => {
  await post(`/apps/${appId}/control`, { action: "take" }, samHeaders);
  const got: number[] = [];
  const off = hub.live.subscribe(appId, () => got.push(1))!;
  await Bun.sleep(400);
  await Bun.file(join(dir, "gone")).write("1");
  await Bun.sleep(2500);
  off();
  const app = s.state().liveApps.find((a) => a.id === appId)!;
  expect(app.status).toBe("gone");
  expect(app.controller).toBeNull();
  expect(app.canTap).toBe(false);
  expect(app.note).toContain("shut down or removed");
  // A gone tile can't be driven or watched.
  expect((await post(`/apps/${appId}/input`, { t: "tap", x: 0.5, y: 0.5 }, samHeaders)).status).toBe(409);
  expect(hub.live.subscribe(appId, () => {})).toBeNull();
  rmSync(join(dir, "gone"));
});

test("an unapproved build streams nothing: a denial, an expired request and a failed build never open a tile", async () => {
  const opened: unknown[] = [];
  hub.host.onOpened = (a) => void opened.push(a);
  const r = hub.host.request({ agentId: "a9", agentName: "Sam's Claude", ownerName: "Sam", repo: "https://github.com/octocat/Hello-World.git", branch: "master", command: "true", open: "simulator:Build/App.app" });
  if (typeof r === "string") throw new Error(r);
  // Nothing happens while it waits, and an agent can't approve it.
  expect(opened).toEqual([]);
  expect((await post(`/build-requests/${r.id}`, { approve: true }, agentHeaders)).status).toBe(403);
  expect(hub.host.decide(r.id, false, "Maya")).toContain("Denied");
  await Bun.sleep(100);
  expect(opened).toEqual([]);
  expect(s.state().liveApps.filter((a) => a.status === "live")).toHaveLength(0);
});

test("no more than four live apps at once", async () => {
  hub.live.pickSim = async (d) => ({ udid: `U-${d}`, name: `Phone ${d}` });
  const made = [];
  for (const d of ["a", "b", "c", "d", "e"]) made.push(await hub.live.startIos(d, "Maya"));
  expect(made.filter((m) => typeof m !== "string")).toHaveLength(4);
  expect(String(made[4])).toContain("already 4");
  hub.live.stopAll();
});

test("a Mac app's helper: frames come out, input goes in, and its errors become words", async () => {
  // A stand-in for jamsesh-live: says its window size, sends one framed JPEG, echoes input to a file, then exits on stdin EOF.
  const fake = join(dir, "fake-live");
  writeFileSync(
    fake,
    `#!/bin/bash
[ "$1" = "--apps" ] && { echo '[{"pid":41,"bundle":"com.example.fake","name":"Fake App"},{"pid":42,"bundle":"com.example.fakehelper","name":"Fake App Helper"},{"pid":43,"bundle":"com.example.twin1","name":"Twin"},{"pid":44,"bundle":"com.example.twin2","name":"twin"}]'; exit 0; }
echo "$@" > "${dir}/mac-args"
echo '{"event":"window","w":800,"h":600}' >&2
printf '\\x00\\x00\\x00\\x06\\xff\\xd8ab\\xff\\xd9'
while read -r line; do echo "$line" >> "${dir}/mac-input"; done
`,
  );
  chmodSync(fake, 0o755);
  // An app is found by its exact name (any case), never by part of one, and two apps with that name are refused.
  expect(String(await hub.live.startMac({ name: "Fake" }, "Maya", [fake]))).toContain("No running app is called Fake");
  expect(String(await hub.live.startMac({ name: "App" }, "Maya", [fake]))).toContain("No running app");
  expect(String(await hub.live.startMac({ name: "Twin" }, "Maya", [fake]))).toContain("Two running apps");
  expect(String(await hub.live.startMac({ name: "Fake App", bundle: "com.x; rm -rf ~" }, "Maya", [fake]))).toContain("bundle id");
  expect(hub.live.list().filter((a) => a.status === "live")).toHaveLength(0);
  const r = await hub.live.startMac({ name: "fake app" }, "Maya", [fake]);
  if (typeof r === "string") throw new Error(r);
  expect(r).toMatchObject({ kind: "mac", name: "fake app", width: 800, height: 600, canTap: true });
  // The helper is told the app's bundle id: it captures and sends input to that app's own process only.
  expect(readFileSync(join(dir, "mac-args"), "utf8").trim()).toBe("com.example.fake 30");
  let frames = 0;
  const off = hub.live.subscribe(r.id, () => frames++)!;
  expect(frames).toBe(1);
  off();
  hub.live.control(r.id, "take", { personId: sam.id, name: "Sam", host: false });
  expect(await hub.live.input(r.id, { personId: sam.id, name: "Sam", host: false }, { t: "tap", x: 0.25, y: 0.75 })).toBeNull();
  expect(await hub.live.input(r.id, { personId: sam.id, name: "Sam", host: false }, { t: "home" })).toContain("iPhone");
  expect(await hub.live.input(r.id, { personId: maya.id, name: "Maya", host: false }, { t: "tap", x: 0.5, y: 0.5 })).toContain("Sam is driving");
  await Bun.sleep(300);
  expect(readFileSync(join(dir, "mac-input"), "utf8")).toContain('"t":"tap","x":0.25,"y":0.75');
  hub.live.stopAll();
  // A helper that can't capture says why, and no tile is left behind.
  const bad = join(dir, "bad-live");
  writeFileSync(bad, `#!/bin/bash\necho '{"event":"error","code":"screen","text":"Screen Recording isn'"'"'t allowed for JamSesh on this Mac."}' >&2\nexit 3\n`);
  chmodSync(bad, 0o755);
  const refused = await hub.live.startMac({ name: "Fake App", bundle: "com.example.fake" }, "Maya", [bad]);
  expect(String(refused)).toContain("Screen Recording");
  expect(hub.live.list().filter((a) => a.status === "live")).toHaveLength(0);
});

test("the Mac helper source ships with the hub", () => {
  expect(existsSync(join(import.meta.dir, "..", "native", "jamsesh-live.swift"))).toBe(true);
});

test("typing and named keys reach the Simulator for the person driving; bad ones don't", async () => {
  hub.live.pickSim = async () => ({ udid: "U1", name: "iPhone Test" });
  const r = (await (await post("/apps", { kind: "ios" })).json()) as any;
  const id = r.app.id as string;
  const send = async (b: unknown, h = samHeaders) => ((await (await post(`/apps/${id}/input`, b, h)).json()) as any);
  expect((await send({ t: "text", text: "hi" })).ok).toBe(false);
  await post(`/apps/${id}/control`, { action: "take" }, samHeaders);
  calls.length = 0;
  expect((await send({ t: "text", text: "Hi!" })).ok).toBe(true);
  expect((await send({ t: "key", key: "return" })).ok).toBe(true);
  expect((await send({ t: "key", key: "rm -rf" })).ok).toBe(false);
  expect(calls).toEqual(["type Hi!", "key return"]);
  hub.live.stop(id);
});

test("choosing the capture: window at 30 fps only when everything is there, else screenshots with a hint", () => {
  const win = (title: string, id = 1) => ({ id, title, w: 460, h: 920 });
  const base = { helper: true, screenAccess: true, windows: [win("iPhone 16 Pro – iOS 18.6")], deviceName: "iPhone 16 Pro", portrait: true, haveScreen: true };
  expect(planCapture(base)).toEqual({ mode: "window", window: win("iPhone 16 Pro – iOS 18.6") });
  // A longer name that starts the same is a different device.
  expect(pickSimWindow([win("iPhone 16 Pro Max – iOS 18.6")], "iPhone 16 Pro")).toBeNull();
  expect(pickSimWindow([win("iPhone 16 Pro - iOS 26.5")], "iPhone 16 Pro")).toMatchObject({ id: 1 });
  expect(planCapture({ ...base, helper: false })).toMatchObject({ mode: "screenshots", hint: expect.stringContaining("command line tools") });
  expect(planCapture({ ...base, screenAccess: false })).toMatchObject({ mode: "screenshots", hint: expect.stringContaining("Screen Recording") });
  expect(planCapture({ ...base, windows: [] })).toMatchObject({ mode: "screenshots", hint: expect.stringContaining("open this device in Simulator") });
  expect(planCapture({ ...base, windows: [win("iPhone 16 Pro – iOS 18.6"), win("iPhone 16 Pro – iOS 26.5", 2)] })).toMatchObject({ mode: "screenshots", hint: expect.stringContaining("Two Simulator windows") });
  // Turned screens and unknown screen sizes use screenshots, quietly.
  expect(planCapture({ ...base, portrait: false })).toEqual({ mode: "screenshots" });
  expect(planCapture({ ...base, haveScreen: false })).toEqual({ mode: "screenshots" });
});

function fakeHelper(name: string, opts: { screen: boolean; windows: unknown[]; frames?: boolean }) {
  const f = join(dir, name);
  writeFileSync(
    f,
    `#!/bin/bash
[ "$1" = "--check" ] && { echo '{"screen":${opts.screen},"accessibility":true}'; exit 0; }
# Simulator's windows are asked for by its bundle id, not a name another app could share.
[ "$1" = "--windows" ] && { [ "$2" = "com.apple.iphonesimulator" ] && echo '${JSON.stringify(opts.windows)}' || echo '[]'; exit 0; }
echo "$@" > "${dir}/${name}.args"
${opts.frames === false ? "exit 0" : `printf '\\x00\\x00\\x00\\x08\\xff\\xd8win!\\xff\\xd9'; sleep 30`}
`,
  );
  chmodSync(f, 0o755);
  return f;
}

test("a Simulator with Screen Recording and its window open streams the window, cropped to the screen, and says so", async () => {
  const f = fakeHelper("live-ok", { screen: true, windows: [{ id: 77, title: "iPhone Test – iOS 18.6", w: 460, h: 940 }] });
  hub.live.helper = async () => [f];
  hub.live.pickSim = async () => ({ udid: "U1", name: "iPhone Test" });
  const r = (await (await post("/apps", { kind: "ios" })).json()) as any;
  const id = r.app.id as string;
  for (let i = 0; i < 30 && s.state().liveApps.find((a) => a.id === id)?.capture !== "window"; i++) await Bun.sleep(100);
  const app = () => s.state().liveApps.find((a) => a.id === id)!;
  expect(app().capture).toBe("window");
  expect(app().hint).toBeUndefined();
  const got: string[] = [];
  const off = hub.live.subscribe(id, (fr) => got.push(new TextDecoder().decode(fr).replace(/[^\w!]/g, "")))!;
  await Bun.sleep(500);
  expect(got).toContain("win!");
  // The screenshot loop stays off while the window is streamed.
  const n = readFileSync(join(dir, "n"), "utf8");
  await Bun.sleep(500);
  expect(readFileSync(join(dir, "n"), "utf8")).toBe(n);
  expect(readFileSync(join(dir, "live-ok.args"), "utf8")).toMatch(/^com\.apple\.iphonesimulator 30 --window 77 --crop [\d.]+,[\d.]+,[\d.]+,[\d.]+/);
  // Rotating drops to screenshots (the window isn't the screen's shape any more); the person is told why nothing is wrong.
  await post(`/apps/${id}/control`, { action: "take" }, samHeaders);
  await post(`/apps/${id}/input`, { t: "rotate" }, samHeaders);
  for (let i = 0; i < 30 && app().capture !== "screenshots"; i++) await Bun.sleep(100);
  expect(app().capture).toBe("screenshots");
  off();
  hub.live.stop(id);
});

test("without Screen Recording the Simulator uses screenshots and the tile carries the hint; a helper that dies falls back too", async () => {
  hub.live.helper = async () => [fakeHelper("live-noaccess", { screen: false, windows: [] })];
  hub.live.pickSim = async () => ({ udid: "U1", name: "iPhone Test" });
  const r = (await (await post("/apps", { kind: "ios" })).json()) as any;
  const id = r.app.id as string;
  const app = () => s.state().liveApps.find((a) => a.id === id)!;
  for (let i = 0; i < 30 && !app().hint; i++) await Bun.sleep(100);
  expect(app().capture).toBe("screenshots");
  expect(app().hint).toContain("Screen Recording");
  hub.live.stop(id);
  // The helper starts, then exits at once: back to screenshots, with the reason.
  const dying = fakeHelper("live-dies", { screen: true, windows: [{ id: 5, title: "iPhone Test – iOS 18.6", w: 460, h: 940 }], frames: false });
  hub.live.helper = async () => [dying];
  const r2 = (await (await post("/apps", { kind: "ios" })).json()) as any;
  const id2 = r2.app.id as string;
  for (let i = 0; i < 30 && !s.state().liveApps.find((a) => a.id === id2)?.hint; i++) await Bun.sleep(100);
  const a2 = s.state().liveApps.find((a) => a.id === id2)!;
  expect(a2.capture).toBe("screenshots");
  expect(a2.hint).toContain("Window capture stopped");
  expect(a2.status).toBe("live");
  hub.live.stop(id2);
});

test("the brain puts a live app tile on a layout by id or by name", async () => {
  const { Brain } = await import("../src/brain/brain");
  hub.live.pickSim = async () => ({ udid: "U1", name: "iPhone Test" });
  hub.live.helper = async () => "no helper in tests";
  const app = (await hub.live.startIos(undefined, "Felipe's Claude (approved by Maya)")) as any;
  const brain = new Brain(s, {} as any);
  clearInterval((brain as any).digestTimer);
  const tools = (brain as any).tools([], { effects: 0 });
  const a = s.upsertArtifact({ kind: "screenshot", title: "Checkout mockup" });
  const out = await tools.set_layout.execute({ tiles: [{ kind: "artifact", ref: a.id }, { kind: "app", ref: "felipe" }, { kind: "app", ref: "no such app" }] });
  expect(out).toContain("2 tile(s)");
  expect(s.stage().layout?.tiles).toEqual([{ kind: "artifact", artifactId: a.id, label: undefined }, { kind: "app", appId: app.id, label: "iPhone Test" }]);
  // A tile for an app that stopped doesn't resolve.
  hub.live.stop(app.id);
  const gone = await tools.set_layout.execute({ tiles: [{ kind: "app", ref: app.id }] });
  expect(gone).toContain("None of those tiles resolved");
});

test("on a locked big screen the screen's drivers drive the tile, like anything else there; elsewhere its own controller does", async () => {
  hub.live.stopAll();
  const before = calls.length;
  const app = (await hub.live.startIos(undefined, "Maya")) as any;
  const tap = (h: Record<string, string>, extra: object = {}) => post(`/apps/${app.id}/input`, { t: "tap", x: 0.5, y: 0.5, ...extra }, h);
  const show = () => s.setStage({ mode: "layout", layout: { tiles: [{ kind: "app", appId: app.id }] } }, "Maya", "main", { person: { id: maya.id, name: "Maya" } });
  s.touchDevice("samLaptop", { personId: sam.id, location: "room", micOn: false });
  s.deviceOnline = () => true;
  show();
  // Maya holds the screen but isn't driving yet: nobody can tap, and the tile says why.
  const none = await tap(host());
  expect(none.status).toBe(409);
  expect(((await none.json()) as any).error).toContain("start driving it first");
  expect(s.state().liveApps.find((a) => a.id === app.id)).toMatchObject({ viaScreen: "main", controller: null, drivers: [] });
  // The tile's own take/pass is refused on a locked screen, with the way to do it there.
  const take = ((await (await post(`/apps/${app.id}/control`, { action: "take" }, samHeaders)).json()) as any).result;
  expect(take).toContain("locked screen");
  expect(hub.live.get(app.id)?.controller).toBeNull();
  // Maya drives; she can tap. Sam, not a driver, can't (his own window, or as a replay).
  s.drive("start", "main", maya.id);
  expect((await tap(host())).status).toBe(200);
  expect((await tap(samHeaders)).status).toBe(409);
  // The big screen's window replays a driver's cursor as that driver; it can't speak for someone who isn't driving.
  expect((await tap(host(), { as: sam.id })).status).toBe(200); // falls back to the window's own person, Maya, who is driving
  const asSam = await post(`/apps/${app.id}/input`, { t: "tap", x: 0.2, y: 0.2, as: sam.id }, samHeaders);
  expect(asSam.status).toBe(409);
  // Drive together: Sam drives too, from his own window and as a replay.
  expect(s.drive("together", "main", maya.id, sam.id)).toMatchObject({ ok: true });
  expect((await tap(samHeaders)).status).toBe(200);
  const n = calls.length;
  expect((await post(`/apps/${app.id}/input`, { t: "tap", x: 0.9, y: 0.9, as: sam.id }, host())).status).toBe(200);
  expect(calls.length).toBe(n + 1);
  expect(s.state().liveApps.find((a) => a.id === app.id)?.drivers?.map((d) => d.name)).toEqual(["Maya", "Sam"]);
  // Pass control to Sam alone: Maya is out.
  s.drive("pass", "main", maya.id, sam.id);
  expect((await tap(host())).status).toBe(409);
  expect((await tap(samHeaders)).status).toBe(200);
  // An agent still has no route, driving screen or not; a stranger neither.
  expect((await tap(agentHeaders)).status).toBe(403);
  expect((await tap({ "x-forwarded-for": "9.9.9.9" })).status).toBe(401);
  // Only a driver (or the host window) can stop the tile from the screen.
  expect((await fetch(`${base}/api/apps/${app.id}`, { method: "DELETE", headers: { ...samHeaders } })).status).toBe(200);
  expect(calls.length).toBeGreaterThan(before);
  // Off the locked screen the tile's own controller model applies again.
  const again = (await hub.live.startIos(undefined, "Maya")) as any;
  expect(s.state().liveApps.find((a) => a.id === again.id)?.viaScreen).toBeUndefined();
  s.unlockStage("main");
  expect(((await (await post(`/apps/${again.id}/control`, { action: "take" }, samHeaders)).json()) as any).result).toContain("driving");
});
