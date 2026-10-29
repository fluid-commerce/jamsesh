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
  // Its person saying "connect to jamsesh" in that chat lets it back, with or without its chat id.
  await (await fetch(`${base}/api/hooks/joined`, { method: "POST", headers: { ...remote, authorization: `Bearer ${cred.token}` }, body: JSON.stringify({ session_id: "chat-gone7", connect: true }) })).body?.cancel();
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
