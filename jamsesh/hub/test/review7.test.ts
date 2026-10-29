// Phase 2, seventh review: a removed chat can't come back through a fresh MCP session that doesn't
// name its chat, removals never expire, and a hook call meant for one room is refused by another.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../src/hub";
import { startHttp } from "../src/http";
import { hookScript } from "../src/install-scripts";
import { hooksOf } from "./hooks";

const dir = mkdtempSync(join(tmpdir(), "jam-review7-"));
const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, "d") });
const server = startHttp(hub, 0);
const base = `http://127.0.0.1:${server.port}`;
afterAll(() => {
  server.stop(true);
  hub.stop();
  rmSync(dir, { recursive: true, force: true });
});
const s = hub.session;
const remote = { "x-forwarded-for": "9.9.9.9", "content-type": "application/json" };
const win = hub.auth.issue({ kind: "browser", label: "Chey's Mac", ip: "10.0.0.5", personId: s.upsertPerson({ name: "Chey" }).id });
const cred = hub.auth.issue({ kind: "agent", label: "Chey's agents", ip: "10.0.0.5", ownerDeviceId: win.device.id, personId: win.device.personId });

test("a removed Claude Code chat can't rejoin through a fresh MCP session that doesn't name its chat", async () => {
  const a = s.registerAgent({ ownerName: "Chey", harness: "claude-code", repo: "app", cwd: "/w/app", machine: win.device.id, chatId: "chat-gone7" }).agent;
  s.removeAgent(a.id);
  // A fresh connection: no agent on it, a new session id, no chat.
  const fresh = (device = cred.device.id) => ({ agentId: null as string | null, ip: "relayed", device, origin: base, sessionId: crypto.randomUUID() });
  await expect(hub.mcp.call(fresh(), "jam_join", { harness: "claude-code", repo: "app", cwd: "/w/app" })).rejects.toThrow("removed this chat");
  // Another folder on this Mac, or the same folder on another Mac, is another chat.
  expect((await hub.mcp.call(fresh(), "jam_join", { harness: "claude-code", repo: "app", cwd: "/w/other" })).isError).toBeFalsy();
  const otherWin = hub.auth.issue({ kind: "browser", label: "Mo's Mac", ip: "10.0.0.6" });
  const other = hub.auth.issue({ kind: "agent", label: "Mo's agents", ip: "10.0.0.6", ownerDeviceId: otherWin.device.id });
  expect((await hub.mcp.call(fresh(other.device.id), "jam_join", { owner: "Mo", harness: "claude-code", repo: "app", cwd: "/w/app" })).isError).toBeFalsy();
  // "connect to jamsesh" in that chat doesn't let it back, however it is sent: only a person's Allow again does.
  const said = await (await fetch(`${base}/api/hooks/joined`, { method: "POST", headers: { ...remote, authorization: `Bearer ${cred.token}` }, body: JSON.stringify({ session_id: "chat-gone7", connect: true }) })).json();
  expect(said).toMatchObject({ joined: false, removed: true });
  await expect(hub.mcp.call(fresh(), "jam_join", { harness: "claude-code", repo: "app", cwd: "/w/app" })).rejects.toThrow("removed this chat");
  expect(s.allowRejoin({ id: s.removedChats().find((r) => r.chatId === "chat-gone7")!.id })).toBe(true);
  expect((await hub.mcp.call(fresh(), "jam_join", { harness: "claude-code", repo: "app", cwd: "/w/app" })).isError).toBeFalsy();
});

test("removals never expire: the first of more than 200 still holds after a restart", async () => {
  const data = join(dir, "many");
  const one = new Hub({ canvas: false, whisper: false, dataDir: data });
  for (let i = 0; i < 205; i++) one.session.removeAgent(one.session.registerAgent({ ownerName: "Chey", harness: "claude-code", repo: "r", cwd: `/many/${i}`, machine: "host", chatId: `chat-many-${i}` }).agent.id);
  one.stop();
  const two = new Hub({ canvas: false, whisper: false, dataDir: data });
  expect(two.session.removedChats()).toHaveLength(205);
  await expect(two.mcp.call({ agentId: null, ip: "127.0.0.1", device: "host" }, "jam_join", { owner: "Chey", harness: "claude-code", cwd: "/many/0", chat: "chat-many-0" })).rejects.toThrow("removed this chat");
  two.stop();
});

test("a hook call meant for another room is refused before anything is recorded, read or acknowledged", async () => {
  const a = s.registerAgent({ ownerName: "Chey", harness: "claude-code", repo: "app", cwd: "/w/room", machine: win.device.id, chatId: "chat-room7" }).agent;
  s.createDirective({ text: "Room seven task", mode: "implement", targets: [a.id], requestedBy: "Chey" });
  const h = hooksOf(hub);
  const handed = JSON.stringify(h.tool(a, { tool_name: "Edit" }));
  expect(handed).toContain("Room seven task");
  const delivery = (s.store.setting<any[]>(`deliveries:${a.id}`, []) ?? [])[0]!.id;
  const prompts = () => s.store.recentEvents({ kinds: ["prompt"], limit: 500 }).length;
  const before = prompts();
  for (const kind of ["prompt", "tool", "stop", "listen"]) {
    const r = await fetch(`${base}/api/hooks/${kind}`, { method: "POST", headers: { ...remote, authorization: `Bearer ${cred.token}`, "x-jam-room": "another-room", "x-jam-ack": delivery }, body: JSON.stringify({ session_id: "chat-room7", prompt: "for the other room" }) });
    expect(r.status).toBe(409);
    expect((await r.json()).room).toBe(s.roomId());
  }
  expect(prompts()).toBe(before);
  expect(s.store.setting<any[]>(`deliveries:${a.id}`, []).map((d) => d.id)).toContain(delivery); // not acknowledged
  // The right room goes through.
  const ok = await fetch(`${base}/api/hooks/prompt`, { method: "POST", headers: { ...remote, authorization: `Bearer ${cred.token}`, "x-jam-room": s.roomId() }, body: JSON.stringify({ session_id: "chat-room7", prompt: "for this room" }) });
  expect(ok.status).toBe(200);
  expect(prompts()).toBe(before + 1);
});

test("hook.sh: a host switch between the room check and the replay leaves the prompt queued", async () => {
  // The relay says room A when asked, then the next request reaches room B, which refuses room A's prompt.
  const posted: string[] = [];
  const fake = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      await req.text();
      if (path.endsWith("/hooks/joined")) return Response.json({ joined: true, room: "room-A" });
      if (path.endsWith("/hooks/prompt")) {
        posted.push(req.headers.get("x-jam-room") ?? "");
        return Response.json({ error: "another room", room: "room-B" }, { status: 409 });
      }
      return Response.json({});
    },
  });
  try {
    const home = mkdtempSync(join(dir, "client-"));
    writeFileSync(join(home, "client.env"), `JAMSESH_HUB='http://127.0.0.1:${fake.port}'\nJAMSESH_ACTIVE=1\n`);
    mkdirSync(join(home, "outbox"), { recursive: true });
    const now = Math.floor(Date.now() / 1000);
    const entry = `${now}_pq-1_room-A`;
    writeFileSync(join(home, "outbox", entry), JSON.stringify({ session_id: "chat-sw", prompt: "for room A" }));
    const proc = Bun.spawn(["bash", "-c", hookScript(hub), "hook", "tool"], {
      stdin: new Blob([JSON.stringify({ session_id: "chat-sw", tool_name: "Edit" })]),
      env: { HOME: home, PATH: "/usr/bin:/bin", JAMSESH_CLIENT_ENV: join(home, "client.env"), JAMSESH_DIR: home },
    });
    await proc.exited;
    for (let i = 0; i < 100 && (posted.length === 0 || existsSync(join(home, "outbox/.replaying"))); i++) await Bun.sleep(50);
    expect(posted).toEqual(["room-A"]);
    expect(readdirSync(join(home, "outbox"))).toEqual([entry]);
  } finally {
    fake.stop(true);
  }
});

test("a removed Codex chat is keyed by the connection's harness and the folder's real path: a supplied chat, harness, repo or spelling of the folder doesn't give it a new identity", async () => {
  // The connection said it was Codex when it initialized; that is not something a tool argument can change.
  const fresh = (harness = "codex") => ({ agentId: null as string | null, ip: "relayed", device: cred.device.id, origin: base, sessionId: crypto.randomUUID(), harness });
  const first: any = await hub.mcp.call(fresh(), "jam_join", { harness: "codex", repo: "app", cwd: "/w/codex-gone" });
  expect(first.isError).toBeFalsy();
  const mine = s.store.all("agents").find((a: any) => a.harness === "codex" && a.cwd === "/w/codex-gone")!;
  s.removeAgent(mine.id);
  const gone = /removed this chat/;
  const attempt = (args: any) => hub.mcp.call(fresh(), "jam_join", { harness: "codex", repo: "app", cwd: "/w/codex-gone", ...args });
  await expect(attempt({})).rejects.toThrow(gone);
  await expect(attempt({ chat: "made-up" })).rejects.toThrow(gone);
  await expect(attempt({ harness: "other" })).rejects.toThrow(gone);
  await expect(attempt({ harness: "claude-code", chat: "made-up" })).rejects.toThrow(gone);
  await expect(attempt({ repo: "other", cwd: "/w/codex-gone/" })).rejects.toThrow(gone);
  await expect(attempt({ cwd: "/w/./codex-gone" })).rejects.toThrow(gone);
  await expect(attempt({ cwd: "/w/x/../codex-gone//" })).rejects.toThrow(gone);
  // A blank or relative folder is refused, not given an identity from the repo.
  for (const cwd of ["", "  ", "codex-gone", "./codex-gone", "../w/codex-gone"]) await expect(attempt({ cwd })).rejects.toThrow("absolute path");
  await expect(hub.mcp.call(fresh(), "jam_join", { harness: "codex", repo: "app" })).rejects.toThrow("absolute path");
  // Another folder is another chat.
  expect((await hub.mcp.call(fresh(), "jam_join", { harness: "codex", repo: "app", cwd: "/w/codex-other" })).isError).toBeFalsy();
});

test("an initialize names the harness: Claude Code, Codex, or other", async () => {
  const { harnessOfClient } = await import("../src/mcp");
  expect([harnessOfClient("claude-code"), harnessOfClient("codex-mcp-client"), harnessOfClient("Codex"), harnessOfClient("cursor"), harnessOfClient(undefined)]).toEqual(["claude-code", "codex", "codex", "other", "other"]);
});

test("on the host's own file system a folder is its real path, so a link to it is the same chat", async () => {
  const { canonicalCwd } = await import("../src/mcp");
  const real = mkdtempSync(join(dir, "real-"));
  const link = join(dir, "link-to-real");
  require("node:fs").symlinkSync(real, link);
  expect(canonicalCwd(link, true)).toBe(require("node:fs").realpathSync(real));
  expect(canonicalCwd(link, false)).toBe(link);
  expect(canonicalCwd("/no/such/./place/", true)).toBe("/no/such/place");
  expect(canonicalCwd("rel/path", true)).toBe("");
});

test("two long folders that share their first 300 characters are two Codex chats, and removing one leaves the other", async () => {
  const fresh = () => ({ agentId: null as string | null, ip: "relayed", device: cred.device.id, origin: base, sessionId: crypto.randomUUID(), harness: "codex" });
  const prefix = `/w/${"d".repeat(320)}`;
  const a = `${prefix}/one`;
  const b = `${prefix}/two`;
  expect((await hub.mcp.call(fresh(), "jam_join", { harness: "codex", repo: "app", cwd: a })).isError).toBeFalsy();
  expect((await hub.mcp.call(fresh(), "jam_join", { harness: "codex", repo: "app", cwd: b })).isError).toBeFalsy();
  const agents = s.store.all("agents").filter((x: any) => x.cwd === a || x.cwd === b);
  expect(agents).toHaveLength(2);
  expect(new Set(agents.map((x: any) => x.chatId)).size).toBe(2);
  expect(agents.every((x: any) => x.chatId.length < 100)).toBe(true);
  s.removeAgent(agents.find((x: any) => x.cwd === a)!.id);
  await expect(hub.mcp.call(fresh(), "jam_join", { harness: "codex", repo: "app", cwd: a })).rejects.toThrow("removed this chat");
  expect((await hub.mcp.call(fresh(), "jam_join", { harness: "codex", repo: "app", cwd: b })).isError).toBeFalsy();
});

test("when the store opens, records and removals under the old readable ids get today's keys from their stored harness, machine and real folder", async () => {
  const { chatKey } = await import("../src/chatkey");
  const data = join(dir, "legacy");
  const real = mkdtempSync(join(dir, "legacy-real-"));
  const link = join(dir, "legacy-link");
  require("node:fs").symlinkSync(real, link);
  const one = new Hub({ canvas: false, whisper: false, dataDir: data });
  const prefix = `/w/${"e".repeat(320)}`;
  const legacy = (machine: string, cwd: string) => `codex:${machine}:${cwd}`.slice(0, 300);
  const put = (cwd: string, machine = "host") => {
    const a = one.session.registerAgent({ ownerName: "Chey", harness: "codex", repo: "app", cwd, machine, chatId: `tmp-${cwd}` }).agent;
    one.session.store.put("agents", { ...one.session.store.get("agents", a.id)!, chatId: legacy(machine, cwd) }, false);
    return a;
  };
  const longA = put(`${prefix}/one`);
  const longB = put(`${prefix}/two`);
  expect(one.session.agent(longA.id)!.chatId).toBe(one.session.agent(longB.id)!.chatId); // the old collision (a, b share it)
  const dotted = put("/w/./dotted");
  const linked = put(link);
  for (const a of [longA, dotted, linked]) one.session.removeAgent(a.id);
  // Make the removal records look like the old ones: readable ids, the folder as typed.
  one.session.store.setSetting(
    "removedChats",
    one.session.removedChats().map((r) => ({ ...r, chatId: legacy(r.machine, r.cwd!) })),
  );
  // One that never stored its folder or machine can match nothing.
  one.session.store.setSetting("removedChats", [...one.session.removedChats(), { id: "rc_blank", agentId: "a_none", chatId: "codex:host:/w/blank", machine: "", harness: "codex", name: "x", ownerName: "Chey", at: 1 }]);
  one.stop();

  const two = new Hub({ canvas: false, whisper: false, dataDir: data });
  const agents = two.session.store.all("agents");
  const removal = (id: string) => two.session.removedChats().find((r) => r.agentId === id)!;
  const B = agents.find((x: any) => x.id === longB.id)!;
  expect(removal(longA.id).chatId).toBe(chatKey("codex", "host", `${prefix}/one`));
  expect(B.chatId).toBe(chatKey("codex", "host", `${prefix}/two`));
  expect(removal(longA.id).chatId).not.toBe(B.chatId);
  expect(removal(dotted.id).cwd).toBe("/w/dotted");
  expect(removal(linked.id).cwd).toBe(require("node:fs").realpathSync(real));
  const blank = two.session.removedChats().find((r) => r.id === "rc_blank")!;
  expect(blank.chatId).toBe("codex:host:/w/blank");

  const host = () => ({ agentId: null as string | null, ip: "127.0.0.1", device: "host", sessionId: crypto.randomUUID(), harness: "codex" });
  const joinAt = (cwd: string) => two.mcp.call(host(), "jam_join", { owner: "Chey", harness: "codex", repo: "app", cwd });
  // Removed ones stay out, by whichever spelling; the neighbour that shares their first 300 characters is let in.
  await expect(joinAt(`${prefix}/one`)).rejects.toThrow("removed this chat");
  await expect(joinAt("/w/dotted")).rejects.toThrow("removed this chat");
  await expect(joinAt("/w/./dotted")).rejects.toThrow("removed this chat");
  await expect(joinAt(real)).rejects.toThrow("removed this chat");
  await expect(joinAt(link)).rejects.toThrow("removed this chat");
  expect((await joinAt(`${prefix}/two`)).isError).toBeFalsy();
  // The record that was never removed kept its identity: one agent, not a second.
  expect(two.session.store.all("agents").filter((x: any) => x.cwd === `${prefix}/two`)).toHaveLength(1);
  // Opening again changes nothing more.
  two.stop();
  const three = new Hub({ canvas: false, whisper: false, dataDir: data });
  expect(three.session.removedChats().find((r) => r.agentId === longA.id)!.chatId).toBe(chatKey("codex", "host", `${prefix}/one`));
  three.stop();
});

test("over the MCP protocol: a connection that initializes as Codex stays Codex whatever jam_join says", async () => {
  const post = (body: object, sid?: string) =>
    fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${cred.token}`, "x-forwarded-for": "9.9.9.9", "content-type": "application/json", accept: "application/json, text/event-stream", ...(sid ? { "mcp-session-id": sid } : {}) }, body: JSON.stringify(body) });
  const open = async (name: string) => {
    const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name, version: "1" } } });
    const sid = init.headers.get("mcp-session-id")!;
    await init.body?.cancel();
    await (await post({ jsonrpc: "2.0", method: "notifications/initialized" }, sid)).body?.cancel();
    return sid;
  };
  const join = async (sid: string, args: object) => (await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "jam_join", arguments: args } }, sid)).text();
  const first = await join(await open("codex-mcp-client"), { harness: "codex", repo: "app", cwd: "/w/proto" });
  expect(first).not.toContain("removed this chat");
  const mine = s.store.all("agents").find((x: any) => x.cwd === "/w/proto")!;
  expect(mine.harness).toBe("codex");
  s.removeAgent(mine.id);
  // Calling itself another harness, or naming a chat, doesn't make a new identity.
  for (const args of [{ harness: "other" }, { harness: "claude-code", chat: "made-up" }, { harness: "codex" }]) {
    expect(await join(await open("codex-mcp-client"), { repo: "app", cwd: "/w/proto", ...args })).toContain("removed this chat");
  }
});
