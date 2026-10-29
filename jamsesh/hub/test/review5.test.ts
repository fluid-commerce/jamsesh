// Phase 2, fifth review: a Codex chat keeps its identity across MCP sessions (a reconnect resumes it,
// a removal sticks), jam_ask ends on removal or disconnection, a slow outbox replay never holds the
// hook, old open tasks stay in the state, a blocked report survives its own hook and Stop, and
// "asked for" is judged by time.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../src/hub";
import { startHttp } from "../src/http";
import { hookScript } from "../src/install-scripts";
import { hooksOf } from "./hooks";

const dir = mkdtempSync(join(tmpdir(), "jam-review5-"));
const data = join(dir, "d");
let hub = new Hub({ canvas: false, whisper: false, dataDir: data });
let server = startHttp(hub, 0);
let base = `http://127.0.0.1:${server.port}`;
afterAll(() => {
  server.stop(true);
  hub.stop();
  rmSync(dir, { recursive: true, force: true });
});
const remote = { "x-forwarded-for": "9.9.9.9", "content-type": "application/json", accept: "application/json, text/event-stream" };
const window = hub.auth.issue({ kind: "browser", label: "Rae's Mac", ip: "10.0.0.20" });
const cred = hub.auth.issue({ kind: "agent", label: "Rae's agents", ip: "10.0.0.20", ownerDeviceId: window.device.id });

/** A fresh MCP connection (what Codex opens after a reconnect or a hub restart), then a tool call on it. */
async function session(token = cred.token) {
  const post = (body: object, sid?: string) => fetch(`${base}/mcp`, { method: "POST", headers: { ...remote, authorization: `Bearer ${token}`, ...(sid ? { "mcp-session-id": sid } : {}) }, body: JSON.stringify(body) });
  const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "codex", version: "1" } } });
  const sid = init.headers.get("mcp-session-id")!;
  await init.body?.cancel();
  await (await post({ jsonrpc: "2.0", method: "notifications/initialized" }, sid)).body?.cancel();
  return async (name: string, args: object) => {
    const t = await (await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }, sid)).text();
    const json = JSON.parse(t.includes("data:") ? t.split("data:").pop()!.trim() : t);
    return { text: json.result.content.map((c: any) => c.text).join("\n") as string, error: !!json.result.isError };
  };
}
const codexJoin = { owner: "Rae", harness: "codex", repo: "site", cwd: "/work/site" };

test("a Codex chat that reconnects (a new MCP session, or a hub restart) is the same agent; a removed one stays out", async () => {
  const first = await session();
  await first("jam_join", codexJoin);
  const agent = hub.session.agents().find((a) => a.harness === "codex" && a.cwd === "/work/site")!;
  hub.session.claim(agent.id, "Site header");
  const again = await session();
  expect((await again("jam_join", codexJoin)).text).toContain(agent.id);
  expect(hub.session.agents().filter((a) => a.harness === "codex" && a.cwd === "/work/site")).toHaveLength(1);
  // After a hub restart too.
  server.stop(true);
  hub.stop();
  hub = new Hub({ canvas: false, whisper: false, dataDir: data });
  server = startHttp(hub, 0);
  base = `http://127.0.0.1:${server.port}`;
  const afterRestart = await session();
  expect((await afterRestart("jam_join", codexJoin)).text).toContain(agent.id);
  expect(hub.session.store.all("workstreams").find((w) => w.title === "Site header")?.ownerAgentId).toBe(agent.id);
  // Removed: a new MCP session, and a restart, still can't bring it back by itself.
  hub.session.removeAgent(agent.id);
  const refused = await (await session())("jam_join", codexJoin);
  expect(refused.error).toBe(true);
  expect(refused.text).toContain("removed this chat");
  // Another Mac's Codex in a folder with the same path is a different chat.
  const otherWindow = hub.auth.issue({ kind: "browser", label: "Mo's Mac", ip: "10.0.0.21" });
  const other = hub.auth.issue({ kind: "agent", label: "Mo's agents", ip: "10.0.0.21", ownerDeviceId: otherWindow.device.id });
  expect((await (await session(other.token))("jam_join", { ...codexJoin, owner: "Mo" })).error).toBe(false);
});

test("jam_ask ends with nothing when its agent is removed or its device disconnected while it waits", async () => {
  const s = hub.session;
  const w = hub.auth.issue({ kind: "browser", label: "Jo's Mac", ip: "10.0.0.30" });
  const c = hub.auth.issue({ kind: "agent", label: "Jo's agents", ip: "10.0.0.30", ownerDeviceId: w.device.id });
  const reg = (cwd: string) => s.registerAgent({ ownerName: "Jo", harness: "claude-code", repo: "x", cwd, machine: w.device.id, chatId: `chat-${cwd}` }).agent;
  const asker = reg("/ask/a");
  const target = reg("/ask/b");
  const ask = (agentId: string) => hub.mcp.call({ agentId, ip: "relayed", device: c.device.id }, "jam_ask", { to: target.id, question: "Sticky header?", waitSeconds: 30 }).then((o) => (o.content[0] as { text: string }).text, (e: Error) => `error: ${e.message}`);
  const t0 = Date.now();
  const removed = ask(asker.id);
  await Bun.sleep(30);
  s.removeAgent(asker.id);
  expect(await removed).toContain("removed you");
  const asker2 = reg("/ask/c");
  const revoked = ask(asker2.id);
  await Bun.sleep(30);
  hub.auth.revoke(w.device.id);
  expect(await revoked).toContain("disconnected");
  expect(Date.now() - t0).toBeLessThan(3000);
});

test("a slow host never holds the hook: queued prompts replay in the background", async () => {
  const replays: string[] = [];
  const fake = Bun.serve({
    port: 0,
    idleTimeout: 30,
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      if (path.endsWith("/hooks/joined")) return Response.json({ joined: true, room: "room-1" });
      if (path.endsWith("/hooks/prompt")) {
        const body = await req.text();
        await Bun.sleep(3500); // each replay is slow, but answers inside the hook's 4-second limit
        replays.push(body);
      }
      return Response.json({});
    },
  });
  try {
    const home = mkdtempSync(join(dir, "client-"));
    writeFileSync(join(home, "client.env"), `JAMSESH_HUB='http://127.0.0.1:${fake.port}'\nJAMSESH_ACTIVE=1\n`);
    mkdirSync(join(home, "chats"), { recursive: true });
    writeFileSync(join(home, "chats/chat-slow"), "room-1");
    const now = Math.floor(Date.now() / 1000);
    mkdirSync(join(home, "outbox"), { recursive: true });
    for (const i of [1, 2]) writeFileSync(join(home, "outbox", `${now}_q${i}_room-1`), JSON.stringify({ session_id: "chat-slow", prompt: `queued ${i}` }));
    const t0 = Date.now();
    const proc = Bun.spawn(["bash", "-c", hookScript(hub), "hook", "tool"], {
      stdin: new Blob([JSON.stringify({ session_id: "chat-slow", tool_name: "Edit" })]),
      stdout: "pipe",
      env: { HOME: home, PATH: "/usr/bin:/bin", JAMSESH_CLIENT_ENV: join(home, "client.env"), JAMSESH_DIR: home },
    });
    await new Response(proc.stdout).text();
    await proc.exited;
    // The hook ended right after its own call (two slow replays in the foreground would take over 7 seconds).
    expect(Date.now() - t0).toBeLessThan(3000);
    for (let i = 0; i < 200 && (replays.length < 2 || existsSync(join(home, "outbox/.replaying"))); i++) await Bun.sleep(50);
    expect(replays.map((b) => JSON.parse(b).prompt).sort()).toEqual(["queued 1", "queued 2"]);
    expect(readdirSync(join(home, "outbox"))).toEqual([]);
  } finally {
    fake.stop(true);
  }
}, 20_000);

test("the state carries every open task, however many newer ones there are", () => {
  const s = hub.session;
  const a = s.registerAgent({ ownerName: "Chey", harness: "claude-code", repo: "x", cwd: "/state/a", machine: "m1", chatId: "chat-state" }).agent;
  const old = s.createDirective({ text: "The old settings page", mode: "implement", targets: [a.id], requestedBy: "Chey" });
  s.store.patch("directives", old.id, { reassignOfferedAt: { [a.id]: Date.now() } });
  for (let i = 0; i < 70; i++) s.endDirective(s.createDirective({ text: `Newer ${i}`, mode: "note", targets: [a.id], requestedBy: "Chey" }).id, "done");
  expect(s.state().directives.map((d) => d.id)).toContain(old.id);
  expect((s as any).resolve("directives").value.map((d: any) => d.id)).toContain(old.id);
  expect(s.state().directives.length).toBeLessThanOrEqual(61);
});

test("a blocked report or a question survives its own tool hook and Stop; the next real tool means working again", async () => {
  const s = hub.session;
  for (const kind of ["blocked", "question"] as const) {
    const a = s.registerAgent({ ownerName: "Chey", harness: "claude-code", repo: "x", cwd: `/blocked/${kind}`, machine: "m1", chatId: `chat-${kind}` }).agent;
    await hub.mcp.call({ agentId: a.id, ip: "127.0.0.1", device: null }, "jam_update", { kind, text: "Need the API key" });
    const h = hooksOf(hub);
    h.tool(a, { tool_name: "mcp__jamsesh__jam_update" });
    expect(s.agent(a.id)).toMatchObject({ status: "blocked", activity: "Need the API key" });
    h.stop(a, { last_assistant_message: "I'm waiting on the API key." });
    expect(s.agent(a.id)).toMatchObject({ status: "blocked", activity: "Need the API key" });
    h.tool(a, { tool_name: "Edit" });
    expect(s.agent(a.id)?.status).toBe("working");
  }
});

test("work the person asked for an hour's half ago isn't called unprompted, however busy the room", () => {
  const s = hub.session;
  const a = s.registerAgent({ ownerName: "Chey", harness: "claude-code", repo: "x", cwd: "/asked/a", machine: "m1", chatId: "chat-asked" }).agent;
  s.store.put("agents", { ...s.agent(a.id)!, joinedAt: Date.now() - 60 * 60_000 });
  s.store.addEvent({ kind: "prompt", authorType: "person", authorName: "Chey", text: "do the footer", data: { agentId: a.id } });
  for (let i = 0; i < 150; i++) s.store.addEvent({ kind: "prompt", authorType: "person", authorName: "Mo", text: `other ${i}`, data: { agentId: "a_other" } });
  s.claim(a.id, "Footer");
  const line = s.store.recentEvents({ kinds: ["system"], limit: 50 }).find((e) => e.authorId === a.id && e.text.includes("Footer"))!;
  expect(line.text).toContain('took "Footer"');
});
