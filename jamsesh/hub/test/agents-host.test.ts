import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { forbiddenCommand } from "../src/canvas/canvas";
import { Canvas } from "../src/canvas/canvas";
import { DevProxy, normalizeTarget, ownTarget } from "../src/devproxy";
import { simScreenRect } from "../src/hostctl";
import { cleanRepo } from "../src/mcp";
import { Session } from "../src/session";
import { Store } from "../src/store";

test("credentials in a remote URL are dropped, the rest is kept", () => {
  expect(cleanRepo("https://user:ghp_abc123@github.com/acme/app.git")).toBe("https://github.com/acme/app.git");
  expect(cleanRepo("https://token@github.com/acme/app")).toBe("https://github.com/acme/app");
  expect(cleanRepo("git@github.com:acme/app.git")).toBe("git@github.com:acme/app.git");
  expect(cleanRepo("acme/app")).toBe("acme/app");
});

test("agents can't run file or collab commands on the shared canvas", () => {
  expect(forbiddenCommand("run_command", { command: "file.open", params: {} })).toBe("file.open");
  expect(forbiddenCommand("run_command", { command: "collab.join" })).toBe("collab.join");
  expect(forbiddenCommand("batch", { commands: [{ command: "node.create" }, { command: "file.save" }] })).toBe("file.save");
  expect(forbiddenCommand("run_command", { command: "node.create" })).toBeNull();
  expect(forbiddenCommand("create_node", { type: "frame" })).toBeNull();
});

test("frames made with run_command are placed clear of existing work too", () => {
  const c = Object.create(Canvas.prototype) as any;
  c.occupied = [{ x: 0, y: 0, w: 390, h: 844, at: Date.now(), page: "" }];
  c.placed = [];
  const args = c.place("run_command", { command: "node.create", params: { type: "frame", x: 0, y: 0, width: 390, height: 844 } });
  expect(args.params.x).toBeGreaterThan(390);
  const preset = c.place("run_command", { command: "frame.create", params: { preset: "iPhone 16", x: 0, y: 0 } });
  expect(preset.params.x).toBeGreaterThan(390);
});

test("a dev server has to be on the agent's own machine", () => {
  expect(ownTarget("http://localhost:5173", "192.168.1.40")).toBe("192.168.1.40:5173");
  expect(ownTarget("localhost:3000", "::ffff:192.168.1.40")).toBe("192.168.1.40:3000");
  expect(ownTarget("http://192.168.1.40:8080/app", "192.168.1.40")).toBe("192.168.1.40:8080");
  expect(ownTarget("http://0.0.0.0:5173", "127.0.0.1")).toBe("127.0.0.1:5173");
  expect(() => ownTarget("http://192.168.1.1:80", "192.168.1.40")).toThrow(/your own machine/);
  expect(() => ownTarget("http://10.0.0.5:5173", "127.0.0.1")).toThrow(/your own machine/);
  expect(() => ownTarget("http://localhost:99999", "127.0.0.1")).toThrow();
  expect(normalizeTarget("http://localhost:5173/")).toBe("127.0.0.1:5173");
});

test("the simulator's screen is found inside its window, bezel and title bar included", () => {
  // iPhone 17 Pro at 100%: 402×874 points in a 456×972 window.
  const r = simScreenRect({ x: 636, y: 67, width: 456, height: 972 }, 1206, 2622, 3)!;
  expect(r.width).toBeCloseTo(402, 0);
  expect(r.height).toBeCloseTo(874, 0);
  expect(r.x).toBeCloseTo(636 + 27, 0);
  expect(r.y).toBeCloseTo(67 + 44 + 27, 0);
  // Without a bezel, the screen fills the window below the title bar.
  const flat = simScreenRect({ x: 0, y: 0, width: 402, height: 874 + 44 }, 1206, 2622, 3)!;
  expect(flat.width).toBeCloseTo(402, 0);
  expect(flat.y).toBeCloseTo(44, 0);
});

// ---- the dev server forwarder ----

const dir = mkdtempSync(join(tmpdir(), "jam-dev-"));
const store = new Store(dir);
const session = new Session(store);
const token = "jst_testtoken123";
store.setSetting("pairedDevices", [{ id: "d1", kind: "browser", label: "x", tokenHash: createHash("sha256").update(token).digest("hex"), personId: null, createdAt: 0, lastSeen: 0, ip: "", revoked: false }]);
const proxy = new DevProxy(session);
const upstream = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/ws" && srv.upgrade(req)) return undefined;
    if (url.pathname === "/go") return new Response(null, { status: 302, headers: { location: `http://${req.headers.get("host")}/there` } });
    if (url.pathname === "/echo") return Response.json({ host: req.headers.get("host"), cookie: req.headers.get("cookie"), auth: req.headers.get("authorization") });
    return new Response("hello from the dev server");
  },
  websocket: { message: (ws, m) => void ws.send(`echo ${m}`) },
});
let dev: Awaited<ReturnType<DevProxy["register"]>>;
afterAll(() => {
  proxy.stop();
  upstream.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

// Requests to the forwarder arrive from this machine's loopback; a LAN address is another source, so use it for "someone on the network".
const lan = Object.values(require("node:os").networkInterfaces()).flat().find((a: any) => a?.family === "IPv4" && !a.internal) as any;

test("dev servers answer the host and paired devices, and refuse everyone else", async () => {
  const agent = session.registerAgent({ ownerName: "Maya", harness: "claude-code", repo: "acme/app", cwd: "/tmp/app", machine: "host", platform: "web" }).agent;
  dev = await proxy.register({ agentId: agent.id, name: "Web", target: `localhost:${upstream.port}` });
  expect(dev.up).toBe(true);
  // From the host itself.
  expect(await (await fetch(`http://127.0.0.1:${dev.hostPort}/`)).text()).toBe("hello from the dev server");
  if (!lan) return;
  const at = `http://${lan.address}:${dev.hostPort}`;
  const nobody = await fetch(`${at}/`, { headers: { accept: "text/html" } });
  expect(nobody.status).toBe(401);
  expect(await nobody.text()).toContain("JamSesh");
  expect((await fetch(`${at}/`, { headers: { cookie: "jam_token=wrong" } })).status).toBe(401);
  const viaCookie = await fetch(`${at}/echo`, { headers: { cookie: `a=1; jam_token=${token}; b=2` } });
  expect(viaCookie.status).toBe(200);
  const seen = (await viaCookie.json()) as any;
  expect(seen.cookie).toBe("a=1; b=2"); // the room's credentials don't reach the dev server
  expect(seen.host).toBe(`127.0.0.1:${upstream.port}`);
  const viaBearer = (await (await fetch(`${at}/echo`, { headers: { authorization: `Bearer ${token}` } })).json()) as any;
  expect(viaBearer.auth).toBeNull();
});

test("redirects stay on the shared address and hot-reload sockets work, protocol and all", async () => {
  const r = await fetch(`http://127.0.0.1:${dev.hostPort}/go`, { redirect: "manual" });
  expect(r.headers.get("location")).toBe("/there");
  const got = await new Promise<string>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${dev.hostPort}/ws`, ["vite-hmr"]);
    ws.onopen = () => ws.send("ping");
    ws.onmessage = (e) => (ws.close(), resolve(String(e.data)));
    ws.onerror = () => reject(new Error("socket failed"));
    setTimeout(() => reject(new Error("timeout")), 4000);
  });
  expect(got).toBe("echo ping");
});

test("a dev server that stays down is taken off, and agents can remove their own", async () => {
  proxy.remove(dev.id);
  expect(session.devservers().length).toBe(0);
  expect(session.artifacts().filter((a) => a.kind === "devserver").length).toBe(0);
  await expect(fetch(`http://127.0.0.1:${dev.hostPort}/`)).rejects.toThrow();
});
