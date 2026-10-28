import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Canvas } from "../src/canvas/canvas";
import { Hub } from "../src/hub";
import { startHttp } from "../src/http";

const dir = mkdtempSync(join(tmpdir(), "jam-httpfix-"));
const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, "d") });
const server = startHttp(hub, 0);
const base = `http://127.0.0.1:${server.port}`;
afterAll(() => {
  server.stop(true);
  hub.devproxy.stop();
  rmSync(dir, { recursive: true, force: true });
});

// A request that counts as coming from another machine (the relay marks it).
const remote = { "x-forwarded-for": "9.9.9.9" };
const agent = hub.auth.issue({ kind: "agent", label: "Agents on Mac", ip: "10.0.0.5", ownerDeviceId: "host" });
const browser = hub.auth.issue({ kind: "browser", label: "Laptop", ip: "10.0.0.6" });

test("an agent credential is refused on human routes whether it comes as a header or ?token=", async () => {
  const body = JSON.stringify({ text: "hi", personId: "p1" });
  const h = { ...remote, "content-type": "application/json" };
  const viaHeader = await fetch(`${base}/api/say`, { method: "POST", headers: { ...h, authorization: `Bearer ${agent.token}` }, body });
  expect(viaHeader.status).toBe(403);
  const viaQuery = await fetch(`${base}/api/say?token=${agent.token}`, { method: "POST", headers: h, body });
  expect(viaQuery.status).toBe(403);
  const stage = await fetch(`${base}/api/stage?token=${agent.token}`, { method: "POST", headers: h, body: JSON.stringify({ stage: { mode: "board" } }) });
  expect(stage.status).toBe(403);
});

test("agents can't change people, settings, directives or transcription workers", async () => {
  const h = { ...remote, "content-type": "application/json", authorization: `Bearer ${agent.token}` };
  for (const [method, path] of [["POST", "/api/people"], ["PATCH", "/api/people/p1"], ["DELETE", "/api/people/p1"], ["POST", "/api/settings"], ["POST", "/api/directives"], ["POST", "/api/workers"]] as const) {
    const r = await fetch(`${base}${path}`, { method, headers: h, body: method === "DELETE" ? undefined : "{}" });
    expect([path, r.status]).toEqual([path, 403]);
  }
});

test("a worker has to be the caller's own machine, and can't replace the local engine", async () => {
  const h = { "content-type": "application/json", authorization: `Bearer ${browser.token}` };
  const post = (b: object) => fetch(`${base}/api/workers`, { method: "POST", headers: h, body: JSON.stringify(b) });
  expect((await post({ id: "local", url: "http://127.0.0.1:9/" })).status).toBe(400);
  // Through the relay the hub can't tell the caller's address.
  expect((await fetch(`${base}/api/workers`, { method: "POST", headers: { ...h, ...remote }, body: JSON.stringify({ id: "w", url: "http://203.0.113.9:9/" }) })).status).toBe(403);
});

test("a failed audio upload isn't remembered as received", async () => {
  const url = `${base}/api/audio?deviceId=dX&t0=1000&t1=3000`;
  const send = () => fetch(url, { method: "POST", headers: { "content-type": "audio/wav" }, body: new Uint8Array([1, 2, 3]) }).then((r) => r.json() as Promise<any>);
  const first = await send();
  const retry = await send();
  expect(first.duplicate).toBeUndefined();
  expect(retry.duplicate).toBeUndefined();
});

test("a page on another site can't post as the host's own window", async () => {
  const r = await fetch(`${base}/api/pair/agents`, { method: "POST", headers: { origin: "http://evil.example", "content-type": "text/plain" } });
  expect(r.status).toBe(403);
  const ok = await fetch(`${base}/api/pair/agents`, { method: "POST", headers: { "content-type": "text/plain" } });
  expect(ok.status).toBe(200);
});

test("an agents credential is one machine across relaunches, and a new one retires the old", async () => {
  const a = await fetch(`${base}/api/pair/agents`, { method: "POST" }).then((r) => r.json() as Promise<any>);
  const b = await fetch(`${base}/api/pair/agents`, { method: "POST" }).then((r) => r.json() as Promise<any>);
  expect(hub.auth.machineOf(a.deviceId)).toBe("host");
  expect(hub.auth.machineOf(b.deviceId)).toBe("host");
  expect(hub.auth.check(a.token)).toBeNull();
  expect(hub.auth.check(b.token)).not.toBeNull();
});

test("a dev server on the host Mac registers through the relay; a tunnelled caller gets a clear error", async () => {
  const app = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
  try {
    const ctx = { agentId: null as string | null, ip: "relayed", device: agent.device.id, origin: "http://127.0.0.1:4790" };
    const join = await hub.mcp.call(ctx, "jam_join", { owner: "Rae", harness: "claude", cwd: "/tmp/x" });
    expect(JSON.stringify(join)).toContain("http://127.0.0.1:4790/api/upload");
    const r = await hub.mcp.call(ctx, "jam_devserver", { url: `http://localhost:${app.port}` });
    expect((r.content[0] as any).text).toContain("Live for the room");
    // The hub's own port is never a dev server.
    const self = await hub.mcp.call(ctx, "jam_devserver", { url: `http://localhost:${server.port}` }).catch((e) => e);
    expect(String(self?.message ?? self)).toContain("belongs to JamSesh");
    const tunnelled = { ...ctx, agentId: ctx.agentId, device: browser.device.id };
    await expect(hub.mcp.call(tunnelled, "jam_devserver", { url: `http://localhost:${app.port}` })).rejects.toThrow(/tunnel or proxy/);
  } finally {
    app.stop(true);
  }
});

test("a dev app's own Authorization header doesn't hide the paired cookie", () => {
  const req = (h: Record<string, string>) => new Request("http://x/", { headers: h });
  expect(hub.devproxy.allowed(req({ authorization: "Bearer my-app-jwt", cookie: `jam_token=${browser.token}` }), "192.168.1.5")).toBe(true);
  expect(hub.devproxy.allowed(req({ authorization: "Bearer my-app-jwt" }), "192.168.1.5")).toBe(false);
});

test("a canvas join that fails closes its headless participant", async () => {
  let closed = 0;
  const c = Object.create(Canvas.prototype) as any;
  c.agents = new Map();
  c.filesDir = dir;
  c.session = { canvas: { editLink: "ws://x/?token=t", status: "live" }, touchAgent: () => {} };
  c.spawnParticipant = () => ({ alive: true, init: () => Promise.reject(new Error("boom")), close: () => void closed++ });
  await expect(c.forAgent({ id: "a1", name: "A" })).rejects.toThrow("boom");
  await Bun.sleep(5);
  expect(closed).toBe(1);
  expect(c.agents.size).toBe(0);
});
