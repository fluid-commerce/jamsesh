// Phase 2 review, security and delivery: a chat's MCP session and hooks belong to the machine that
// joined it, room state never shows transport ids, delivery is at least once (a lost hook answer is
// offered again, an acknowledged one never), and a chat the room removed stays out until a person
// lets it back in. Real HTTP and the real hook script against throwaway hubs.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../src/hub";
import { startHttp } from "../src/http";
import { hookScript } from "../src/install-scripts";
import type { Agent } from "../src/types";
import { hooksOf } from "./hooks";

const dir = mkdtempSync(join(tmpdir(), "jam-isolation-"));
const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, "d") });
const server = startHttp(hub, 0);
const base = `http://127.0.0.1:${server.port}`;
const retry = Hub.DELIVERY_RETRY_MS;
afterAll(() => {
  Hub.DELIVERY_RETRY_MS = retry;
  server.stop(true);
  hub.devproxy.stop();
  rmSync(dir, { recursive: true, force: true });
});

const s = hub.session;
// Requests from another computer (through a proxy, so not loopback).
const remote = { "x-forwarded-for": "9.9.9.9", "content-type": "application/json" };
const chey = s.upsertPerson({ name: "Chey" });
const felipe = s.upsertPerson({ name: "Felipe" });
// Two Macs' agents credentials, each issued from that Mac's window.
const macA = hub.auth.issue({ kind: "agent", label: "Chey's agents", ip: "10.0.0.8", personId: chey.id, ownerDeviceId: "dev_macA" });
const macB = hub.auth.issue({ kind: "agent", label: "Felipe's agents", ip: "10.0.0.9", personId: felipe.id, ownerDeviceId: "dev_macB" });
const felipeWindow = hub.auth.issue({ kind: "browser", label: "Felipe's laptop", ip: "10.0.0.9", personId: felipe.id });
const bearer = (t: string) => ({ ...remote, authorization: `Bearer ${t}` });
const directive = (text: string, targets: string[]) => s.createDirective({ text, mode: "implement", targets, requestedBy: "Chey" });
const joinChat = (chatId: string, machine = "dev_macA", cwd = "/work/app") =>
  s.registerAgent({ ownerName: "Chey", harness: "claude-code", repo: "app", cwd, machine, platform: "web", chatId }).agent;
const hook = (kind: string, token: string, body: object, ack = "") =>
  fetch(`${base}/api/hooks/${kind}`, { method: "POST", headers: { ...bearer(token), ...(ack ? { "x-jam-ack": ack } : {}) }, body: JSON.stringify(body) });

// ---- 1. MCP sessions ----

const mcpPost = (token: string, body: object, sid?: string) =>
  fetch(`${base}/mcp`, { method: "POST", headers: { ...bearer(token), accept: "application/json, text/event-stream", ...(sid ? { "mcp-session-id": sid } : {}) }, body: JSON.stringify(body) });
const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } };
const callTool = (name: string, args: object) => ({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });

test("room state never shows a chat's transport id, and an MCP session answers only its own machine", async () => {
  const init = await mcpPost(macA.token, initialize);
  expect(init.status).toBe(200);
  const sid = init.headers.get("mcp-session-id")!;
  await init.body?.cancel();
  await (await mcpPost(macA.token, { jsonrpc: "2.0", method: "notifications/initialized" }, sid)).body?.cancel();
  const joined = await mcpPost(macA.token, callTool("jam_join", { harness: "codex", repo: "api", cwd: "/work/api" }), sid);
  expect(await joined.text()).toContain("api");
  const victim = s.agents().find((a) => a.harness === "codex" && a.cwd === "/work/api")!;
  expect(victim).toBeDefined();
  // Not in the room's state, over HTTP or in the live patches.
  const state = await (await fetch(`${base}/api/state`, { headers: bearer(felipeWindow.token) })).json();
  expect(JSON.stringify(state)).not.toContain(sid);
  expect(JSON.stringify(state)).not.toContain(victim.chatId!);
  expect(state.agents.find((a: Agent) => a.id === victim.id).chatId).toBeUndefined();
  expect(JSON.stringify((s as any).resolve("agents"))).not.toContain(sid);
  // Another paired device that has the id anyway (another Mac's agents, or a person's window) gets "not found".
  for (const other of [macB.token, felipeWindow.token]) {
    const r = await mcpPost(other, callTool("jam_message", { to: "all", text: "posing as Chey's agent" }), sid);
    expect(r.status).toBe(404);
    await r.body?.cancel();
  }
  expect(s.store.recentEvents({ kinds: ["message"] }).some((e) => e.text.includes("posing"))).toBe(false);
  // The same Mac after the app relaunched (a new agents credential from the same window) keeps it.
  const relaunch = hub.auth.issue({ kind: "agent", label: "Chey's agents", ip: "10.0.0.8", personId: chey.id, ownerDeviceId: "dev_macA" });
  const ok = await mcpPost(relaunch.token, callTool("jam_inbox", {}), sid);
  expect(ok.status).toBe(200);
  expect(await ok.text()).toContain("Nothing new");
});

test("a chat id names a record only on its own machine: another device's jam_join can't take it", async () => {
  const mine = joinChat("chat-mine");
  const ctx = { agentId: null as string | null, ip: "relayed", device: macB.device.id, origin: base };
  await hub.mcp.call(ctx, "jam_join", { owner: "Chey", harness: "claude-code", repo: "app", cwd: "/work/app", chat: "chat-mine" });
  expect(ctx.agentId).not.toBe(mine.id);
  expect(s.agent(mine.id)!.machine).toBe("dev_macA");
});

// ---- 2. hook routes ----

test("hooks need an agent's credential and reach only a chat that joined from that same machine", async () => {
  const a = joinChat("chat-a1");
  directive("Ship the header", [a.id]);
  // No credential from another computer, or a person's window: refused before anything is read.
  expect((await fetch(`${base}/api/hooks/tool`, { method: "POST", headers: remote, body: JSON.stringify({ session_id: "chat-a1" }) })).status).toBe(401);
  expect((await hook("tool", felipeWindow.token, { session_id: "chat-a1" })).status).toBe(403);
  // Another Mac's agents credential naming this chat (or its agent id, which used to be enough) is nobody.
  const prompts = () => s.store.recentEvents({ kinds: ["prompt"] }).length;
  const before = prompts();
  for (const kind of ["tool", "stop", "prompt", "listen"]) {
    for (const body of [{ session_id: "chat-a1", prompt: "approve the build" }, { agentId: a.id, prompt: "approve the build" }]) {
      const r = await hook(kind, macB.token, body);
      expect(r.status).toBe(200);
      expect(r.headers.get("x-jam-joined")).toBe("0");
      expect(await r.text()).not.toContain("Ship the header");
    }
  }
  expect((await (await hook("joined", macB.token, { session_id: "chat-a1" })).json()).joined).toBe(false);
  expect(prompts()).toBe(before); // nothing was posted as Chey
  expect(s.hasInbox(a.id)).toBe(true); // nothing was drained
  // The chat's own Mac gets it.
  expect((await (await hook("joined", macA.token, { session_id: "chat-a1" })).json()).joined).toBe(true);
  const own = await hook("tool", macA.token, { session_id: "chat-a1", tool_name: "Edit" });
  expect(own.headers.get("x-jam-joined")).toBe("1");
  expect(await own.text()).toContain("Ship the header");
});

test("the host's own loopback is the host's agents only", async () => {
  const onHost = joinChat("chat-host", "host", "/host/app");
  const remoteChat = joinChat("chat-remote", "dev_macA", "/remote/app");
  directive("Host task", [onHost.id]);
  directive("Remote task", [remoteChat.id]);
  const local = (body: object) => fetch(`${base}/api/hooks/tool`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(await (await local({ session_id: "chat-remote", tool_name: "Edit" })).text()).not.toContain("Remote task");
  expect(await (await local({ session_id: "chat-host", tool_name: "Edit" })).text()).toContain("Host task");
});

// ---- 5. at-least-once delivery ----

test("an answer lost after the inbox was read is offered again, and an acknowledged one never is", async () => {
  Hub.DELIVERY_RETRY_MS = 150;
  try {
    const a = joinChat("chat-lost");
    const d = directive("Fix the footer", [a.id]);
    const first = await hook("tool", macA.token, { session_id: "chat-lost", tool_name: "Edit" });
    const id1 = first.headers.get("x-jam-delivery")!;
    expect(id1).toBeTruthy();
    expect(await first.text()).toContain("Fix the footer");
    // The answer never reached Claude Code, so the next call carries no acknowledgement: still waiting, not delivered.
    expect(s.store.get("directives", d.id)!.progress[a.id]).toBe("pending");
    expect((await (await hook("tool", macA.token, { session_id: "chat-lost", tool_name: "Edit" })).text())).not.toContain("Fix the footer");
    await Bun.sleep(200);
    const again = await hook("tool", macA.token, { session_id: "chat-lost", tool_name: "Edit" });
    const id2 = again.headers.get("x-jam-delivery")!;
    expect(id2).not.toBe(id1);
    expect(await again.text()).toContain("Fix the footer");
    // Acknowledged: delivered now, and never handed over again (not even after the retry time).
    await (await hook("tool", macA.token, { session_id: "chat-lost", tool_name: "Edit" }, id2)).body?.cancel();
    expect(s.store.get("directives", d.id)!.progress[a.id]).toBe("delivered");
    await Bun.sleep(200);
    for (const kind of ["tool", "prompt", "stop"]) expect(await (await hook(kind, macA.token, { session_id: "chat-lost", tool_name: "Edit", prompt: "hi" })).text()).not.toContain("Fix the footer");
    // A late acknowledgement of the first answer changes nothing, and nothing goes backwards.
    s.setDirectiveFor(d.id, a.id, "acked");
    await (await hook("tool", macA.token, { session_id: "chat-lost" }, id1)).body?.cancel();
    expect(s.store.get("directives", d.id)!.progress[a.id]).toBe("acked");
  } finally {
    Hub.DELIVERY_RETRY_MS = retry;
  }
});

test("a listener whose answer was lost hands the same items to the next listener at once; messages too", async () => {
  const a = joinChat("chat-listen");
  const b = joinChat("chat-other-agent", "dev_macB", "/work/b");
  const h = hooksOf(hub);
  const first = h.listen(a, {}, 2000);
  await Bun.sleep(30);
  s.sendMessage(b.id, a.id, "Is the header sticky?");
  expect(await first).toContain("Is the header sticky?");
  // Lost on the way: the script calls again without acknowledging it.
  h.lose(a);
  expect(await h.listen(a, {}, 500)).toContain("Is the header sticky?");
  // Passed on this time: the agent's next hook acknowledges it, and it's gone for good.
  h.tool(a, { tool_name: "Edit" });
  expect(s.hasInbox(a.id)).toBe(false);
  expect(hub.mcp.inboxText(a, true)).toBe("Nothing new.");
});

test("jam_inbox still hands over what a lost hook answer held", () => {
  const a = joinChat("chat-inbox");
  directive("Rename the modal", [a.id]);
  const h = hooksOf(hub);
  expect(JSON.stringify(h.tool(a, { tool_name: "Edit" }))).toContain("Rename the modal");
  h.lose(a);
  expect(hub.mcp.inboxText(a, true)).toContain("Rename the modal");
  expect(hub.mcp.inboxText(a, true)).not.toContain("DIRECTIVE");
});

// ---- 6. a removed chat stays out ----

test("a removed chat can't join again until a person allows it, or its person says connect in that chat", async () => {
  const a = joinChat("chat-gone");
  s.removeAgent(a.id);
  const ctx = (device: string) => ({ agentId: null as string | null, ip: "relayed", device, origin: base });
  const join = (c: ReturnType<typeof ctx>) => hub.mcp.call(c, "jam_join", { harness: "claude-code", repo: "app", cwd: "/work/app", chat: "chat-gone" });
  await expect(join(ctx(macA.device.id))).rejects.toThrow("removed this chat");
  // Another machine saying "connect" for this chat doesn't let it back.
  expect((await (await hook("joined", macB.token, { session_id: "chat-gone", connect: true })).json()).joined).toBe(false);
  await expect(join(ctx(macA.device.id))).rejects.toThrow("removed this chat");
  // Its own person typing "connect to jamsesh" in it (the hook says so) does.
  await (await hook("joined", macA.token, { session_id: "chat-gone", connect: true })).body?.cancel();
  expect((await join(ctx(macA.device.id))).isError).toBeFalsy();

  // A Codex chat (its MCP connection is the chat): out until someone allows it again, people only.
  const codex = ctx(macA.device.id);
  await hub.mcp.call(codex, "jam_join", { harness: "codex", repo: "api", cwd: "/work/api2" });
  s.removeAgent(codex.agentId!);
  await expect(hub.mcp.call(codex, "jam_join", { harness: "codex", repo: "api", cwd: "/work/api2" })).rejects.toThrow("removed this chat");
  const list = await (await fetch(`${base}/api/removed-chats`, { headers: bearer(felipeWindow.token) })).json();
  const rec = list.find((r: any) => r.name.includes("Codex"));
  expect(rec).toBeDefined();
  expect(JSON.stringify(list)).not.toContain("mcp:");
  expect((await fetch(`${base}/api/removed-chats`, { headers: bearer(macA.token) })).status).toBe(403);
  expect((await fetch(`${base}/api/removed-chats/${rec.id}/allow`, { method: "POST", headers: bearer(macA.token), body: "{}" })).status).toBe(403);
  expect((await fetch(`${base}/api/removed-chats/${rec.id}/allow`, { method: "POST", headers: bearer(felipeWindow.token), body: "{}" })).status).toBe(200);
  expect((await hub.mcp.call(codex, "jam_join", { harness: "codex", repo: "api", cwd: "/work/api2" })).isError).toBeFalsy();
});

test("a removal outlives a hub restart", async () => {
  const data = join(dir, "restart");
  const one = new Hub({ canvas: false, whisper: false, dataDir: data });
  const a = one.session.registerAgent({ ownerName: "Chey", harness: "claude-code", repo: "app", cwd: "/w", machine: "host", chatId: "chat-r" }).agent;
  one.session.removeAgent(a.id);
  one.stop();
  const two = new Hub({ canvas: false, whisper: false, dataDir: data });
  await expect(two.mcp.call({ agentId: null, ip: "127.0.0.1", device: "host" }, "jam_join", { owner: "Chey", harness: "claude-code", cwd: "/w", chat: "chat-r" })).rejects.toThrow("removed this chat");
  two.stop();
});

// ---- the real hook script ----

// The JamSesh app's relay on another Mac: it marks what it forwards, so the host never takes it for loopback.
const relay = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const u = new URL(req.url);
    const headers = new Headers(req.headers);
    headers.set("x-forwarded-host", `127.0.0.1:${u.port}`);
    const r = await fetch(`${base}${u.pathname}${u.search}`, { method: req.method, headers, body: req.method === "GET" ? undefined : await req.arrayBuffer() });
    return new Response(await r.arrayBuffer(), { status: r.status, headers: r.headers });
  },
});
const viaRelay = `http://127.0.0.1:${relay.port}`;
afterAll(() => relay.stop(true));

function box(hubUrl: string, token: string) {
  const home = mkdtempSync(join(dir, "client-"));
  writeFileSync(join(home, "hook.sh"), hookScript(hub), { mode: 0o755 });
  writeFileSync(join(home, "client.env"), `JAMSESH_HUB='${hubUrl}'\nJAMSESH_TOKEN='${token}'\nJAMSESH_NAME='Chey'\nJAMSESH_ACTIVE=1\n`);
  if (token) writeFileSync(join(home, "auth.header"), `authorization: Bearer ${token}\n`, { mode: 0o600 });
  const run = async (kind: string, body: object, extraEnv: Record<string, string> = {}) => {
    const proc = Bun.spawn(["bash", join(home, "hook.sh"), kind], {
      stdin: new Blob([JSON.stringify(body)]),
      stdout: "pipe",
      stderr: "pipe",
      env: { HOME: home, PATH: "/usr/bin:/bin", JAMSESH_CLIENT_ENV: join(home, "client.env"), JAMSESH_DIR: home, JAMSESH_SILENT: "1", ...extraEnv },
    });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { out, err, code };
  };
  return { home, run };
}

test("hook.sh records what it passed on and acknowledges it with its next call; a lost answer comes back", async () => {
  Hub.DELIVERY_RETRY_MS = 150;
  try {
    const a = joinChat("chat-script");
    const d = directive("Tighten the nav", [a.id]);
    const { home, run } = box(viaRelay, macA.token);
    const first = await run("tool", { session_id: "chat-script", tool_name: "Edit" });
    expect(first.out).toContain("Tighten the nav");
    const acks = join(home, "acks/chat-script");
    expect(readdirSync(acks)).toHaveLength(1);
    expect(s.store.get("directives", d.id)!.progress[a.id]).toBe("pending");
    // The next hook call carries the id: delivered, the note is cleared, nothing is repeated.
    const second = await run("tool", { session_id: "chat-script", tool_name: "Edit" });
    expect(second.out).not.toContain("Tighten the nav");
    expect(s.store.get("directives", d.id)!.progress[a.id]).toBe("delivered");
    expect(readdirSync(acks)).toHaveLength(0);
    // An answer that never got passed on (the note is missing) is offered again after the retry time.
    const d2 = directive("Fix the tab order", [a.id]);
    expect((await run("tool", { session_id: "chat-script", tool_name: "Edit" })).out).toContain("Fix the tab order");
    rmSync(acks, { recursive: true, force: true });
    await Bun.sleep(200);
    expect((await run("prompt", { session_id: "chat-script", prompt: "carry on" })).out).toContain("Fix the tab order");
    await run("stop", { session_id: "chat-script" });
    expect(s.store.get("directives", d2.id)!.progress[a.id]).toBe("delivered");
  } finally {
    Hub.DELIVERY_RETRY_MS = retry;
  }
});

test("hook.sh sends nothing more for a chat once the room removed it, or after a host switch", async () => {
  // A fake host that records every hook body it receives.
  let joined = true;
  const bodies: { path: string; body: string }[] = [];
  const fake = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      const body = await req.text();
      bodies.push({ path, body });
      if (path.endsWith("/hooks/joined")) return Response.json({ joined });
      return Response.json({}, { headers: { "x-jam-joined": joined ? "1" : "0" } });
    },
  });
  try {
    const { home, run } = box(`http://127.0.0.1:${fake.port}`, "tok");
    await run("prompt", { session_id: "chat-m", prompt: "first, while joined" });
    expect(bodies.some((b) => b.path.endsWith("/hooks/prompt") && b.body.includes("first, while joined"))).toBe(true);
    expect(existsSync(join(home, "chats/chat-m"))).toBe(true);
    // Removed (or this Mac now reaches another host): the chat's marker is no reason to send.
    joined = false;
    bodies.length = 0;
    await run("prompt", { session_id: "chat-m", prompt: "secret plans" });
    await run("tool", { session_id: "chat-m", tool_name: "Read", tool_response: "secret file contents" });
    expect(bodies.map((b) => b.path)).toEqual(["/api/hooks/joined", "/api/hooks/joined"]);
    expect(JSON.stringify(bodies)).not.toContain("secret");
    expect(existsSync(join(home, "chats/chat-m"))).toBe(false);
    // The joined question carries only the session id.
    expect(JSON.parse(bodies[0]!.body)).toEqual({ session_id: "chat-m", connect: false });
    // "connect to jamsesh" in that chat asks to be let back in, and still sends no prompt.
    bodies.length = 0;
    const c = await run("prompt", { session_id: "chat-m", prompt: "connect to jamsesh" });
    expect(JSON.parse(bodies[0]!.body)).toEqual({ session_id: "chat-m", connect: true });
    expect(c.out).toContain("JamSesh chat id for jam_join (pass it as chat): chat-m");
    expect(bodies).toHaveLength(1);
  } finally {
    fake.stop(true);
  }
});

test("hook.sh listen against a real hub wakes the agent, and the wake is acknowledged by the next hook", async () => {
  const a = joinChat("chat-wake");
  const { home, run } = box(viaRelay, macA.token);
  mkdirSync(join(home, "acks"), { recursive: true });
  const waking = run("listen", { session_id: "chat-wake" }, { JAMSESH_LISTEN_SECONDS: "20" });
  await Bun.sleep(400);
  const d = directive("Wake up and fix the footer", [a.id]);
  const r = await waking;
  expect(r.code).toBe(2);
  expect(r.err).toContain("Wake up and fix the footer");
  expect(s.store.get("directives", d.id)!.progress[a.id]).toBe("pending");
  await run("tool", { session_id: "chat-wake", tool_name: "Edit" });
  expect(s.store.get("directives", d.id)!.progress[a.id]).toBe("delivered");
});

// ---- re-review: removal, the outbox, the connect phrase ----

test("removing an agent ends its waiting listener and jam_wait, drops its handovers, and releases its tasks", async () => {
  const a = joinChat("chat-rm-wait");
  const other = joinChat("chat-rm-other", "dev_macB", "/work/other");
  const shared = directive("Build the settings page", [a.id, other.id]);
  const solo = directive("Fix the footer", [a.id]);
  // Taken already: open work, nothing new in its inbox, so both wait.
  for (const d of [shared, solo]) s.setDirectiveFor(d.id, a.id, "acked");
  const listening = hooksOf(hub).listen(a, {}, 5000);
  const ctx = { agentId: a.id, ip: "relayed", device: macA.device.id, origin: base };
  const waiting = hub.mcp.call(ctx, "jam_wait", { seconds: 30 });
  await Bun.sleep(30);
  const t0 = Date.now();
  s.removeAgent(a.id);
  // Both end at once with nothing: the removed chat isn't woken or handed anything.
  expect(await listening).toBe("");
  await expect(waiting).rejects.toThrow("removed you");
  expect(Date.now() - t0).toBeLessThan(1500);
  expect(s.store.setting(`deliveries:${a.id}`, [1])).toEqual([]);
  // Its share of each task is cancelled, so nothing waits on a tile that's gone; the other target carries on.
  expect(s.store.get("directives", solo.id)!.status).toBe("cancelled");
  expect(s.store.get("directives", shared.id)!.progress[a.id]).toBe("cancelled");
  expect(s.store.get("directives", shared.id)!.progress[other.id]).toBe("pending");
  expect(s.store.get("directives", shared.id)!.status).not.toBe("cancelled");
  expect(s.store.recentEvents({ kinds: ["system"] }).some((e) => e.text.includes("Fix the footer") && e.text.includes("now cancelled"))).toBe(true);
}, 10_000);

test("a prompt that arrives twice under one id is recorded once", async () => {
  joinChat("chat-dup");
  const post = () => fetch(`${base}/api/hooks/prompt`, { method: "POST", headers: { ...bearer(macA.token), "x-jam-prompt-id": "p123-dup" }, body: JSON.stringify({ session_id: "chat-dup", prompt: "make the header sticky" }) });
  await (await post()).body?.cancel();
  await (await post()).body?.cancel();
  expect(s.store.recentEvents({ kinds: ["prompt"] }).filter((e) => e.text === "make the header sticky")).toHaveLength(1);
});

test("hook.sh outbox: a lost answer is replayed under the same id, a failed replay stays queued, concurrent writes all land", async () => {
  // A fake host: the first prompt is accepted but answered too late (the hook gives up after 4 seconds);
  // then its replay fails once; after that everything goes through.
  let mode: "slow" | "fail" | "ok" = "slow";
  let failId = "";
  const prompts: { id: string | null; body: string }[] = [];
  const fake = Bun.serve({
    port: 0,
    idleTimeout: 30,
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      const body = await req.text();
      if (path.endsWith("/hooks/joined")) return Response.json({ joined: true });
      if (!path.endsWith("/hooks/prompt")) return Response.json({});
      prompts.push({ id: req.headers.get("x-jam-prompt-id"), body });
      if (mode === "slow") {
        await Bun.sleep(5000);
        return Response.json({});
      }
      if (mode === "fail" && req.headers.get("x-jam-prompt-id") === failId) return new Response("busy", { status: 503 });
      return Response.json({});
    },
  });
  try {
    const { home, run } = box(`http://127.0.0.1:${fake.port}`, "tok");
    mkdirSync(join(home, "chats"), { recursive: true });
    writeFileSync(join(home, "chats/chat-q"), "");
    await run("prompt", { session_id: "chat-q", prompt: "first prompt" });
    const outbox = join(home, "outbox.jsonl");
    const lines = () => (existsSync(outbox) ? readFileSync(outbox, "utf8").split("\n").filter(Boolean) : []);
    expect(lines()).toHaveLength(1);
    const id = prompts[0]!.id!;
    expect(id).toMatch(/^p\d+-/);
    expect(lines()[0]!.split("\t")[1]).toBe(id);
    // The host looks down for 45 seconds after that: let it be reachable again.
    rmSync(join(home, "hub-down"), { force: true });
    mode = "fail";
    failId = id;
    // Replays run in the background after the hook returns: wait for each to finish.
    const until = async (ok: () => boolean) => {
      for (let i = 0; i < 200 && !ok(); i++) await Bun.sleep(50);
      expect(ok()).toBe(true);
    };
    const idle = () => !existsSync(`${outbox}.lock`);
    await run("tool", { session_id: "chat-q", tool_name: "Edit" });
    // The tool call went through but the replay didn't: the prompt is still queued.
    await until(() => prompts.filter((p) => p.id === id).length === 2 && idle());
    expect(lines().map((l) => l.split("\t")[1])).toEqual([id]);
    mode = "ok";
    prompts.length = 0;
    await run("tool", { session_id: "chat-q", tool_name: "Edit" });
    // Replayed under the same id it was first sent with, so the host can tell it's the same prompt.
    await until(() => prompts.some((p) => p.id === id && p.body.includes("first prompt")) && idle() && lines().length === 0);
    // Many hooks queueing at once (the host is down): every prompt lands, each with its own id.
    writeFileSync(join(home, "hub-down"), String(Math.floor(Date.now() / 1000)));
    await Promise.all(Array.from({ length: 12 }, (_, i) => run("prompt", { session_id: "chat-q", prompt: `burst ${i}` })));
    const burst = lines();
    expect(burst).toHaveLength(12);
    expect(new Set(burst.map((l) => l.split("\t")[1])).size).toBe(12);
    expect(existsSync(`${outbox}.lock`)).toBe(false);
  } finally {
    fake.stop(true);
  }
}, 30_000);

test("only a prompt that asks to connect counts as asking: \"don't connect to jamsesh\" doesn't", async () => {
  const asks: boolean[] = [];
  const fake = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const body = await req.json().catch(() => ({}));
      if (new URL(req.url).pathname.endsWith("/hooks/joined")) asks.push(body.connect === true);
      return Response.json({ joined: false });
    },
  });
  try {
    const { run } = box(`http://127.0.0.1:${fake.port}`, "tok");
    for (const prompt of ["connect to jamsesh", "Please connect to jamsesh", "  /jamsesh mobile nav", "don't connect to jamsesh", "why did you join the session?", "we should not join jamsesh yet"])
      await run("prompt", { session_id: "chat-c", prompt });
    expect(asks).toEqual([true, true, true, false, false, false]);
  } finally {
    fake.stop(true);
  }
});
