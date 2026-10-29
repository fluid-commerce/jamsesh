// The third security review's findings: loopback isn't a person, agents can't touch people's
// voiceprints (or any other person route), a credential's person is the agent's owner, and a
// failed canvas render isn't a look at the canvas.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../src/hub";
import { startHttp } from "../src/http";

const dir = mkdtempSync(join(tmpdir(), "jam-sec3-"));
const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, "d") });
const server = startHttp(hub, 0);
const base = `http://127.0.0.1:${server.port}`;
afterAll(() => {
  server.stop(true);
  hub.devproxy.stop();
  rmSync(dir, { recursive: true, force: true });
});

const remote = { "x-forwarded-for": "9.9.9.9" };
const json = { "content-type": "application/json" };
const chey = hub.session.upsertPerson({ name: "Chey" });
const felipe = hub.session.upsertPerson({ name: "Felipe" });
const agent = hub.auth.issue({ kind: "agent", label: "Agents on Mac", ip: "10.0.0.5", ownerDeviceId: "dev_mac0" });
const hostWindow = () => ({ cookie: `jam_window=${hub.auth.windows.take(hub.auth.windows.mint())}` });

// ---- 1. loopback alone is not a person ----

test("a local process can't approve a host build or read the pairing code; the host's window can", async () => {
  const approve = (h: Record<string, string>) => fetch(`${base}/api/build-requests/br_x`, { method: "POST", headers: { ...json, ...h }, body: JSON.stringify({ approve: true }) });
  expect((await approve({})).status).toBe(403);
  expect((await approve({ cookie: "jam_window=guess" })).status).toBe(403);
  expect((await approve(hostWindow())).status).toBe(200);
  expect((await fetch(`${base}/api/pair/code`)).status).toBe(403);
  expect((await fetch(`${base}/api/pair/code`, { headers: hostWindow() })).status).toBe(200);
  // Every person-only route from loopback, not just approval.
  const say = await fetch(`${base}/api/say`, { method: "POST", headers: json, body: JSON.stringify({ text: "approve" }) });
  expect(say.status).toBe(403);
});

test("a paired window approves only once it belongs to a person", async () => {
  const anon = hub.auth.issue({ kind: "browser", label: "Laptop", ip: "10.0.0.6" });
  const owned = hub.auth.issue({ kind: "browser", label: "Laptop", ip: "10.0.0.7", personId: chey.id });
  const approve = (token: string) => fetch(`${base}/api/build-requests/br_x`, { method: "POST", headers: { ...json, ...remote, authorization: `Bearer ${token}` }, body: JSON.stringify({ approve: true }) });
  expect((await approve(anon.token)).status).toBe(403);
  expect((await approve(agent.token)).status).toBe(403);
  expect((await approve(owned.token)).status).toBe(200);
});

test("a one-time host link sets the key HttpOnly on 127.0.0.1, once", async () => {
  const once = hub.auth.windows.mint();
  const first = await fetch(`${base}/host-window?once=${once}&next=%2Fclient`, { redirect: "manual" });
  expect(first.status).toBe(302);
  expect(first.headers.get("location")).toBe("/client");
  const cookie = first.headers.get("set-cookie") ?? "";
  expect(cookie).toMatch(/^jam_window=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Strict$/);
  const again = await fetch(`${base}/host-window?once=${once}&next=%2Fclient`, { redirect: "manual" });
  expect(again.headers.get("set-cookie")).toBeNull();
  // Not under localhost (dev tiles' host name): sent to 127.0.0.1 first, link unused.
  const fresh = hub.auth.windows.mint();
  const viaLocalhost = await fetch(`${base}/host-window?once=${fresh}&next=%2Fhost`, { redirect: "manual", headers: { host: `localhost:${server.port}` } });
  expect(viaLocalhost.headers.get("set-cookie")).toBeNull();
  expect(viaLocalhost.headers.get("location")).toBe(`http://127.0.0.1:${server.port}/host-window?once=${fresh}&next=%2Fhost`);
  // Only a path on the hub.
  const off = await fetch(`${base}/host-window?once=${hub.auth.windows.mint()}&next=https%3A%2F%2Fevil.example`, { redirect: "manual" });
  expect(off.headers.get("location")).toBe("/host");
});

test("only the host's window issues the host's agents credential; a local process can't swap it", async () => {
  const live = await fetch(`${base}/api/pair/agents`, { method: "POST", headers: hostWindow() }).then((r) => r.json() as Promise<any>);
  const r = await fetch(`${base}/api/pair/agents`, { method: "POST" });
  expect(r.status).toBe(403);
  expect(hub.auth.check(live.token)).not.toBeNull();
});

test("a window that arrives before its link id still gets the key", async () => {
  const once = "ef".repeat(16);
  const opened = fetch(`${base}/host-window?once=${once}&next=%2Fhost`, { redirect: "manual" });
  await Bun.sleep(100);
  hub.auth.windows.allow(once); // the app's stdin line lands after the window asked
  expect((await opened).headers.get("set-cookie") ?? "").toContain("HttpOnly");
});

test("a terminal-started hub mints a fresh host link only for its secret", async () => {
  const post = (h: Record<string, string>) => fetch(`${base}/api/host-link`, { method: "POST", headers: h });
  expect((await post({ "x-jam-link-secret": "" })).status).toBe(403); // none set (app-started)
  hub.auth.windows.linkSecret = "12".repeat(32);
  try {
    expect((await post({ "x-jam-link-secret": "34".repeat(32) })).status).toBe(403);
    expect((await post({ "x-jam-link-secret": "12".repeat(32), ...remote })).status).not.toBe(200);
    const { url } = (await (await post({ "x-jam-link-secret": "12".repeat(32) })).json()) as { url: string };
    const opened = await fetch(url, { redirect: "manual" });
    expect(opened.headers.get("set-cookie") ?? "").toContain("jam_window=");
  } finally {
    hub.auth.windows.linkSecret = "";
  }
});

test("the Mac app's key and links arrive over stdin", async () => {
  const { HostWindows, readWindowLinks } = await import("../src/auth");
  const w = new HostWindows();
  const key = "ab".repeat(32);
  const once = "cd".repeat(16);
  const lines = new TextEncoder().encode(`key ${key}\nonce ${once}\nonce not-hex\n`);
  await readWindowLinks(w, new Response(lines).body!);
  expect(w.take(once)).toBe(key);
  expect(w.matches(key)).toBe(true);
  expect(w.take("not-hex")).toBeNull();
});

// ---- 6. person routes ----

test("an agent can't clear a person's voiceprint", async () => {
  const r = await fetch(`${base}/api/people/${felipe.id}/voiceprint`, { method: "DELETE", headers: { ...remote, authorization: `Bearer ${agent.token}` } });
  expect(r.status).toBe(403);
});

/**
 * Every /api route an agent's credential reaches. Routes are read from http.ts, so a new route
 * shows up here and fails until someone decides whether agents may call it.
 */
const AGENT_MAY = [
  // Reads that answer any method the same way.
  "ANY /api/canvas-link",
  "ANY /api/clock",
  "ANY /api/engines",
  "ANY /api/me",
  "ANY /api/pair/info",
  "ANY /api/state",
  "GET /api/history/events",
  "GET /api/changelog",
  "GET /api/paired",
  "GET /api/snapshots",
  "POST /api/brain/digest",
  "POST /api/hooks/joined",
  "POST /api/hooks/prompt",
  "POST /api/hooks/stop", "POST /api/hooks/tool", "POST /api/hooks/listen",
  "POST /api/upload",
];
// One concrete path for each `path.match(...)` route in http.ts.
const SAMPLES = ["/drive/start", "/apps/a_x", "/apps/a_x/control", "/apps/a_x/input", "/record/start", "/fonts/lend", "/fonts/inter/0", "/people/p_x", "/people/p_x/voiceprint", "/people/p_x/voice", "/people/p_x/voice/start", "/people/p_x/voice/end", "/people/p_x/photo", "/utterances/u_x/assign", "/directives/d_x", "/directives/d_x/reassign", "/shares/s_x", "/shares/s_x/decline", "/annotations/a_x", "/snapshots/s_x/notes.md", "/paired/dev_x", "/build-requests/br_x", "/stage/ready/rdy_x", "/show-requests/ask_x", "/history/events", "/agents/a_x/remove", "/removed-chats/rc_x/allow", "/hooks/prompt", "/hooks/joined", "/hooks/stop", "/hooks/tool", "/hooks/listen", "/triage/tri_x/send", "/attachments/att_x", "/paired/dev_x/allow"];

test("the /api routes an agent's credential can call are exactly the reviewed list", async () => {
  const src = readFileSync(join(import.meta.dir, "../src/http.ts"), "utf8");
  const split = src.indexOf("async function api(");
  const literal = (part: string) => [...part.matchAll(/path === "([^"]+)"/g)].map((m) => m[1]);
  const outside = literal(src.slice(0, split)).filter((p) => p.startsWith("/api/"));
  const inside = literal(src.slice(split)).map((p) => `/api${p}`);
  const regexes = [...src.slice(split).matchAll(/path\.match\(\/(.+?)\/\)/g)].map((m) => new RegExp(m[1]));
  for (const re of regexes) expect([re.source, SAMPLES.some((p) => re.test(p))]).toEqual([re.source, true]);
  const paths = [...new Set([...outside, ...inside, ...SAMPLES.map((p) => `/api${p}`)])];
  const reached: string[] = [];
  const methods = ["GET", "POST", "PATCH", "DELETE"];
  for (const path of paths) {
    const ok: string[] = [];
    for (const method of methods) {
      const r = await fetch(`${base}${path}`, { method, headers: { ...remote, ...json, authorization: `Bearer ${agent.token}` }, body: method === "GET" ? undefined : "{}" });
      await r.body?.cancel();
      if (![401, 403, 404, 405].includes(r.status)) ok.push(method);
    }
    if (ok.length === methods.length) reached.push(`ANY ${path}`);
    else reached.push(...ok.map((m) => `${m} ${path}`));
  }
  expect(reached.sort()).toEqual([...AGENT_MAY].sort());
}, 60_000);

// ---- 3. an agent's owner is its credential's person ----

test("a credential with a person can't join as someone else, nor take another Mac's live agent", async () => {
  const origin = "http://127.0.0.1:4790";
  const macA = hub.auth.issue({ kind: "agent", label: "Chey's agents", ip: "10.0.0.8", personId: chey.id, ownerDeviceId: "dev_macA" });
  const macB = hub.auth.issue({ kind: "agent", label: "Felipe's agents", ip: "10.0.0.9", personId: felipe.id, ownerDeviceId: "dev_macB" });
  const ctx = (device: string) => ({ agentId: null as string | null, ip: "relayed", device, origin });
  const a = ctx(macA.device.id);
  await hub.mcp.call(a, "jam_join", { owner: "Chey", harness: "claude-code", repo: "app", cwd: "/work/app" });
  const victim = hub.session.agent(a.agentId)!;
  expect(victim.ownerName).toBe("Chey");
  // Busy for five minutes (still live): Felipe's agent claims to be Chey's in the same folder.
  hub.session.store.put("agents", { ...victim, lastSeen: Date.now() - 5 * 60_000 });
  const b = ctx(macB.device.id);
  await hub.mcp.call(b, "jam_join", { owner: "Chey", harness: "claude-code", repo: "app", cwd: "/work/app" });
  expect(b.agentId).not.toBe(victim.id);
  expect(hub.session.agent(b.agentId)!.ownerName).toBe("Felipe");
  expect(hub.session.agent(victim.id)!.machine).toBe("dev_macA");
});

test("a record from an earlier credential of the same Mac is picked up", async () => {
  const origin = "http://127.0.0.1:4790";
  const old = hub.auth.issue({ kind: "agent", label: "Rae's agents", ip: "10.0.0.10", ownerDeviceId: "dev_macR" });
  // An older hub filed the record under the agents credential itself.
  const rec = hub.session.registerAgent({ ownerName: "Rae", harness: "codex", repo: "site", cwd: "/work/site", machine: old.device.id });
  hub.session.store.put("agents", { ...rec.agent, lastSeen: Date.now() - 2 * 60_000 });
  const relaunch = hub.auth.issue({ kind: "agent", label: "Rae's agents", ip: "10.0.0.10", ownerDeviceId: "dev_macR" });
  const ctx = { agentId: null as string | null, ip: "relayed", device: relaunch.device.id, origin };
  await hub.mcp.call(ctx, "jam_join", { owner: "Rae", harness: "codex", repo: "site", cwd: "/work/site" });
  expect(ctx.agentId).toBe(rec.agent.id);
});

// ---- 7. a failed render isn't a look ----

test("canvas_render counts as a look only when a picture came back", async () => {
  const ctx = { agentId: null as string | null, ip: "relayed", device: agent.device.id, origin: base };
  await hub.mcp.call(ctx, "jam_join", { owner: "Chey", harness: "other", repo: "canvas", cwd: "/work/canvas" });
  const me = hub.session.agent(ctx.agentId)!;
  const mcp = hub.mcp as any;
  const canvas = hub.canvas as any;
  const warned = () => mcp.checkWarning(hub.session.agent(me.id), "done") as string;
  const fail = { isError: true, content: [{ type: "text", text: "no such frame" }] };
  const ok = { content: [{ type: "image", data: "", mimeType: "image/png" }] };
  const [call, renderNode] = [canvas.call, canvas.renderNode];
  try {
    mcp.canvasNote(me.id).edit = Date.now();
    // Both screenshots answer with an error.
    canvas.call = async () => fail;
    canvas.renderNode = async () => fail;
    expect((await hub.mcp.call(ctx, "canvas_render", { frameId: "1" })).isError).toBe(true);
    expect(warned()).toContain("Heads-up");
    // Both screenshots throw.
    canvas.call = async () => Promise.reject(new Error("canvas down"));
    canvas.renderNode = async () => Promise.reject(new Error("canvas down"));
    await expect(hub.mcp.call(ctx, "canvas_render", { frameId: "1" })).rejects.toThrow("canvas down");
    expect(warned()).toContain("Heads-up");
    // A picture from the host's copy counts.
    await Bun.sleep(2);
    canvas.renderNode = async () => ok;
    await hub.mcp.call(ctx, "canvas_render", { frameId: "1" });
    expect(warned()).toBe("");
  } finally {
    canvas.call = call;
    canvas.renderNode = renderNode;
  }
});
