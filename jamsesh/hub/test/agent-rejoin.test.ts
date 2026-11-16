// A chat whose local MCP server restarted joins again under a new transport id (`mcp:<session>`): it is the
// same agent, not a second one with a suffix. A live chat in the same folder, and a chat with its own id, are
// not taken over.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../src/hub";
import { startHttp } from "../src/http";
import { Session } from "../src/session";
import { Store } from "../src/store";

const fresh = () => new Session(new Store(mkdtempSync(join(tmpdir(), "jam-rejoin-"))));
const join_ = (s: Session, chatId: string | undefined, over: Record<string, unknown> = {}) =>
  s.registerAgent({ ownerName: "Chey", harness: "claude-code", repo: "jamsesh", branch: "main", cwd: "/work/jamsesh", machine: "host", platform: "web", chatId, ...over });
/** The agent has been quiet for `ms`. */
const quiet = (s: Session, id: string, ms: number) => s.store.put("agents", { ...s.agent(id)!, lastSeen: Date.now() - ms });

describe("rejoining after the MCP connection restarted", () => {
  test("a quiet agent under a new transport id is resumed: same id and name, no duplicate", () => {
    const s = fresh();
    const first = join_(s, "mcp:old").agent;
    quiet(s, first.id, 5 * 60_000);
    const again = join_(s, "mcp:new");
    expect(again.resumed).toBe(true);
    expect(again.agent.id).toBe(first.id);
    expect(again.agent.name).toBe(first.name);
    expect(again.agent.chatId).toBe("mcp:new");
    expect(s.agents()).toHaveLength(1);
  });

  test("a chat that is still live in another connection stays its own agent: two chats, one folder", () => {
    const s = fresh();
    const a = join_(s, "mcp:one").agent;
    const b = join_(s, "mcp:two");
    expect(b.resumed).toBe(false);
    expect(b.agent.id).not.toBe(a.id);
    expect(s.agents()).toHaveLength(2);
    expect(s.agent(a.id)!.chatId).toBe("mcp:one");
  });

  test("another folder, owner or harness is never taken over", () => {
    const s = fresh();
    const a = join_(s, "mcp:old").agent;
    quiet(s, a.id, 5 * 60_000);
    expect(join_(s, "mcp:x", { cwd: "/work/other" }).agent.id).not.toBe(a.id);
    expect(join_(s, "mcp:y", { ownerName: "Felipe" }).agent.id).not.toBe(a.id);
    expect(join_(s, "mcp:z", { harness: "codex" }).agent.id).not.toBe(a.id);
  });

  test("a chat with its own id behaves as before: it keeps its own record, and a named chat is never inherited", () => {
    const s = fresh();
    const named = join_(s, "chat-a").agent;
    quiet(s, named.id, 5 * 60_000);
    // A transport join does not take over a chat that names itself.
    expect(join_(s, "mcp:new").agent.id).not.toBe(named.id);
    // The named chat resumes by its own id, and a different named chat is a new agent.
    expect(join_(s, "chat-a").agent.id).toBe(named.id);
    expect(join_(s, "chat-b").agent.id).not.toBe(named.id);
    // A named chat never takes a transport chat's record either.
    const t = join_(s, "mcp:t", { cwd: "/work/t" }).agent;
    quiet(s, t.id, 5 * 60_000);
    expect(join_(s, "chat-c", { cwd: "/work/t" }).agent.id).not.toBe(t.id);
  });

  test("a removed chat stays removed: its folder is still blocked for a new transport id", () => {
    const s = fresh();
    const a = join_(s, "mcp:old").agent;
    s.removeAgent(a.id);
    expect(s.agent(a.id)).toBeUndefined();
    expect(s.rejoinBlocked("mcp:new", null, { machine: "host", cwd: "/work/jamsesh", harness: "claude-code" })).toBeDefined();
  });
});

// ---- through the real MCP endpoint: today's timeline ----

const dir = mkdtempSync(join(tmpdir(), "jam-rejoin-http-"));
const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, "d") });
const server = startHttp(hub, 0);
afterAll(() => {
  server.stop(true);
  hub.devproxy.stop();
  rmSync(dir, { recursive: true, force: true });
});
const chey = hub.session.upsertPerson({ name: "Chey" });
const cred = hub.auth.issue({ kind: "agent", label: "Chey's agents", ip: "10.0.0.8", personId: chey.id, ownerDeviceId: "dev_macA" });
const post = (body: object, sid?: string) =>
  fetch(`http://127.0.0.1:${server.port}/mcp`, {
    method: "POST",
    headers: { "x-forwarded-for": "9.9.9.9", "content-type": "application/json", authorization: `Bearer ${cred.token}`, accept: "application/json, text/event-stream", ...(sid ? { "mcp-session-id": sid } : {}) },
    body: JSON.stringify(body),
  });
const connect = async () => {
  const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "claude-code", version: "1" } } });
  const sid = init.headers.get("mcp-session-id")!;
  await init.body?.cancel();
  await (await post({ jsonrpc: "2.0", method: "notifications/initialized" }, sid)).body?.cancel();
  return sid;
};
const call = async (sid: string, name: string, args: object) => await (await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }, sid)).text();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("rejoin through the MCP endpoint", () => {
  test("the MCP server restarts and the chat joins again seconds later: same agent, no suffix, one in the list", async () => {
    const old = await connect();
    await call(old, "jam_join", { repo: "jamsesh", cwd: "/work/jamsesh" });
    const first = hub.session.agents().find((a) => a.cwd === "/work/jamsesh")!;
    await call(old, "jam_inbox", {}); // active a moment ago; the client then restarts and never says goodbye
    await wait(5);
    const fresh_ = await connect();
    await call(fresh_, "jam_join", { repo: "jamsesh", cwd: "/work/jamsesh" });
    const all = hub.session.agents().filter((a) => a.cwd === "/work/jamsesh");
    expect(all).toHaveLength(1);
    expect(all[0]!.id).toBe(first.id);
    expect(all[0]!.name).toBe(first.name);
    expect(all[0]!.chatId).toBe(`mcp:${fresh_}`);
  });

  test("a connection still in use is not taken over; one that was taken over joins again as its own agent", async () => {
    const a = await connect();
    await call(a, "jam_join", { repo: "api", cwd: "/work/api" });
    await wait(5);
    const b = await connect();
    await wait(5);
    await call(a, "jam_inbox", {}); // a speaks after b began: it is live
    await call(b, "jam_join", { repo: "api", cwd: "/work/api" });
    expect(hub.session.agents().filter((x) => x.cwd === "/work/api")).toHaveLength(2);
    // c goes quiet, d begins and joins over c's record; c then speaks and must join again, as a second agent.
    const c = await connect();
    await call(c, "jam_join", { repo: "web", cwd: "/work/web" });
    await wait(5);
    const d = await connect();
    await call(d, "jam_join", { repo: "web", cwd: "/work/web" });
    expect(hub.session.agents().filter((x) => x.cwd === "/work/web")).toHaveLength(1);
    expect(await call(c, "jam_inbox", {})).toContain("Call jam_join first");
    await call(c, "jam_join", { repo: "web", cwd: "/work/web" });
    expect(hub.session.agents().filter((x) => x.cwd === "/work/web")).toHaveLength(2);
  });
});
