// Phase 2, third review: a named chat is never inherited by another chat or machine, the inbox reads
// forward from its cursor, the setup address can't be steered by a forwarded header, a disconnected
// device's open waits end, finished tasks stay finished, and simultaneous aging keeps every entry.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../src/hub";
import { originOf, startHttp } from "../src/http";
import { joinScript } from "../src/install-scripts";
import { AGENT_OFFLINE_MS, TASK_OFFER_MS, TASK_STALE_MS } from "../src/session";

const dir = mkdtempSync(join(tmpdir(), "jam-review3-"));
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
const join_ = (o: { chatId?: string; machine?: string; cwd?: string; harness?: "claude-code" | "codex" }) =>
  s.registerAgent({ ownerName: "Chey", harness: o.harness ?? "claude-code", repo: "app", cwd: o.cwd ?? "/work/app", machine: o.machine ?? "dev_macA", platform: "web", chatId: o.chatId });
const quiet = (id: string, ms = AGENT_OFFLINE_MS + 5 * 60_000) => s.store.put("agents", { ...s.agent(id)!, lastSeen: Date.now() - ms });

// ---- 1. a named chat is never inherited ----

test("a second chat in the same folder, or a chat on another Mac, never takes a quiet chat's record", () => {
  const first = join_({ chatId: "chat-1", cwd: "/r3/one" }).agent;
  s.claim(first.id, "Header");
  quiet(first.id); // 20 minutes and more: offline
  const second = join_({ chatId: "chat-2", cwd: "/r3/one" });
  expect(second.agent.id).not.toBe(first.id);
  expect(second.resumed).toBe(false);
  const elsewhere = join_({ chatId: "chat-1", machine: "dev_macB", cwd: "/r3/one" });
  expect(elsewhere.agent.id).not.toBe(first.id);
  expect(s.agent(first.id)).toMatchObject({ chatId: "chat-1", machine: "dev_macA" });
  // The same chat on its own machine resumes it.
  expect(join_({ chatId: "chat-1", cwd: "/r3/one" }).agent.id).toBe(first.id);
});

test("a record from before chats had ids still migrates to the chat that comes back", () => {
  const old = join_({ cwd: "/r3/legacy" }).agent;
  quiet(old.id);
  expect(join_({ chatId: "chat-new", machine: "dev_macC", cwd: "/r3/legacy" }).agent.id).toBe(old.id);
});

// ---- 2. the inbox reads forward from its cursor ----

test("messages to other agents never crowd out an unread one, and a burst arrives in order without loss", () => {
  const me = join_({ chatId: "chat-inbox-me", cwd: "/r3/me" }).agent;
  const other = join_({ chatId: "chat-inbox-other", cwd: "/r3/other" }).agent;
  s.sendMessage(other.id, me.id, "The one for you");
  for (let i = 0; i < 80; i++) s.sendMessage(me.id, other.id, `chatter ${i}`);
  expect(s.inbox(me.id, true).messages.map((m) => m.text)).toEqual(["The one for you"]);
  for (let i = 0; i < 70; i++) s.sendMessage(other.id, me.id, `burst ${i}`);
  const first = s.inbox(me.id, true).messages.map((m) => m.text);
  const rest = s.inbox(me.id, true).messages.map((m) => m.text);
  expect(first).toHaveLength(50);
  expect([...first, ...rest]).toEqual(Array.from({ length: 70 }, (_, i) => `burst ${i}`));
  expect(s.inbox(me.id, true).messages).toEqual([]);
});

// ---- 3. the setup address ----

test("a forwarded host counts only from a relay on the host, and only when it's plainly a host", async () => {
  const agent = hub.auth.issue({ kind: "agent", label: "Agents", ip: "127.0.0.1", ownerDeviceId: "host" });
  const setup = (headers: Record<string, string>) => fetch(`${base}/agent/setup.sh`, { headers: { ...headers, authorization: `Bearer ${agent.token}` } }).then((r) => r.text());
  const hubLine = (t: string) => t.split("\n").find((l) => l.startsWith("HUB="));
  const hostile = 'x$(touch /tmp/pwned)".local';
  // From loopback (the app's relay), a clean forwarded host is used; a hostile one is ignored.
  expect(hubLine(await setup({ "x-forwarded-host": "jam.example.com" }))).toBe("HUB='http://jam.example.com'");
  expect(hubLine(await setup({ "x-forwarded-host": hostile }))).toBe(`HUB='http://127.0.0.1:${server.port}'`);
  expect(hubLine(await setup({ "x-forwarded-host": "a.local rm -rf ~" }))).toBe(`HUB='http://127.0.0.1:${server.port}'`);
  // A request that didn't come from this computer: its forwarded headers are ignored however clean they look.
  const outside = new Request("http://127.0.0.1:4747/agent/setup.sh", { headers: { host: "192.168.1.5:4747", "x-forwarded-host": "evil.example.com", "x-forwarded-proto": "https" } });
  expect(originOf(outside, new URL(outside.url))).toBe("http://192.168.1.5:4747");
  // Whatever reaches the script is one quoted word: running it with a hostile origin runs nothing.
  const home = mkdtempSync(join(dir, "home-"));
  const proc = Bun.spawn(["/bin/bash", "-c", joinScript(hub, `http://x'$(touch "$HOME/pwned")'\`touch "$HOME/pwned2"\`"$(touch "$HOME/pwned3")"`, `t'$(touch "$HOME/pwned4")'`)], {
    env: { HOME: home, PATH: "/usr/bin:/bin", JAMSESH_CLI_DIRS: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
  for (const f of ["pwned", "pwned2", "pwned3", "pwned4"]) expect(existsSync(join(home, f))).toBe(false);
});

// ---- 5. revocation ends open waits ----

test("disconnecting a device ends its agents' open listener and jam_wait before they hand anything over", async () => {
  const window = hub.auth.issue({ kind: "browser", label: "Rae's Mac", ip: "10.0.0.20" });
  const cred = hub.auth.issue({ kind: "agent", label: "Rae's agents", ip: "10.0.0.20", ownerDeviceId: window.device.id });
  const a = join_({ chatId: "chat-revoke", machine: window.device.id, cwd: "/r3/revoke" }).agent;
  const listening = fetch(`${base}/api/hooks/listen`, { method: "POST", headers: { ...remote, authorization: `Bearer ${cred.token}`, "x-jam-room": hub.session.roomId() }, body: JSON.stringify({ session_id: "chat-revoke" }) }).then((r) => r.text());
  await Bun.sleep(100); // the listener is in place (a new listener ends any wait already running)
  const ctx = { agentId: a.id, ip: "relayed", device: cred.device.id, origin: base };
  const waiting = hub.mcp.call(ctx, "jam_wait", { seconds: 30 }).then(() => "handed something over", (e: Error) => e.message);
  await Bun.sleep(100);
  const t0 = Date.now();
  hub.auth.revoke(window.device.id); // Disconnect on Rae's Mac: its agents' credential goes too
  s.createDirective({ text: "Secret plan for the revoked device", mode: "implement", targets: [a.id], requestedBy: "Chey" });
  expect(await listening).toBe("");
  expect(await waiting).toContain("disconnected");
  expect(Date.now() - t0).toBeLessThan(2000);
  expect(s.hasInbox(a.id)).toBe(true); // nothing was handed over
});

// ---- 6. finished stays finished ----

test("a late ack never reopens a finished task, and ending a task through the API ends it for every target", async () => {
  const a = join_({ chatId: "chat-t1", cwd: "/r3/t1" }).agent;
  const b = join_({ chatId: "chat-t2", cwd: "/r3/t2" }).agent;
  const d = s.createDirective({ text: "Ship it", mode: "implement", targets: [a.id], requestedBy: "Chey" });
  s.setDirectiveFor(d.id, a.id, "done");
  s.setDirectiveFor(d.id, a.id, "acked");
  expect(s.store.get("directives", d.id)).toMatchObject({ status: "done", progress: { [a.id]: "done" } });
  const both = s.createDirective({ text: "Two of you", mode: "implement", targets: [a.id, b.id], requestedBy: "Chey" });
  s.setDirectiveFor(both.id, a.id, "acked");
  const person = hub.auth.issue({ kind: "browser", label: "Chey's laptop", ip: "10.0.0.30", personId: s.upsertPerson({ name: "Chey" }).id });
  const end = (status: string) => fetch(`${base}/api/directives/${both.id}`, { method: "POST", headers: { ...remote, authorization: `Bearer ${person.token}` }, body: JSON.stringify({ status }) });
  expect((await end("acked")).status).toBe(400);
  expect((await end("cancelled")).status).toBe(200);
  expect(s.store.get("directives", both.id)).toMatchObject({ status: "cancelled", progress: { [a.id]: "cancelled", [b.id]: "cancelled" } });
  expect(s.inbox(b.id, false).directives.map((x) => x.id)).not.toContain(both.id);
  expect(s.openFor(a.id).map((x) => x.id)).not.toContain(both.id);
  // Late acks and a second ending change nothing.
  s.setDirectiveFor(both.id, b.id, "acked");
  await (await end("done")).body?.cancel();
  expect(s.store.get("directives", both.id)!.status).toBe("cancelled");
  expect(s.store.get("directives", both.id)!.progress[b.id]).toBe("cancelled");
});

test("product work for observers alone is refused instead of reaching nobody", async () => {
  const obs = s.registerAgent({ ownerName: "Mo", harness: "claude-code", repo: "", cwd: "/r3/obs", machine: "dev_macO", role: "observer", chatId: "chat-obs" }).agent;
  const worker = join_({ chatId: "chat-worker", cwd: "/r3/worker" }).agent;
  const person = hub.auth.issue({ kind: "browser", label: "Laptop", ip: "10.0.0.31", personId: s.upsertPerson({ name: "Chey" }).id });
  const post = (targets: string[], mode = "implement") => fetch(`${base}/api/directives`, { method: "POST", headers: { ...remote, authorization: `Bearer ${person.token}` }, body: JSON.stringify({ text: "Build it", mode, targets }) });
  const refused = await post([obs.id]);
  expect(refused.status).toBe(400);
  expect((await refused.json()).error).toContain("observers");
  expect((await post([obs.id], "note")).status).toBe(200);
  expect((await post([obs.id, worker.id])).status).toBe(200);
});

// ---- should-fix: simultaneous aging ----

test("two targets going quiet in the same tick both keep their nudge, then both get their offer, once", () => {
  const a = join_({ chatId: "chat-age-a", cwd: "/r3/age-a" }).agent;
  const b = join_({ chatId: "chat-age-b", cwd: "/r3/age-b" }).agent;
  const d = s.createDirective({ text: "Pair on the checkout", mode: "implement", targets: [a.id, b.id], requestedBy: "Chey" });
  const t0 = Date.now();
  s.tick(t0 + TASK_STALE_MS + 1000);
  const nudged = s.store.get("directives", d.id)!.nudgedAt!;
  expect(Object.keys(nudged).sort()).toEqual([a.id, b.id].sort());
  const nudges = () => s.store.recentEvents({ kinds: ["message"], limit: 500 }).filter((e) => e.data.nudge === d.id).length;
  expect(nudges()).toBe(2);
  s.tick(t0 + TASK_STALE_MS + 2000);
  expect(nudges()).toBe(2);
  for (const id of [a.id, b.id]) s.touchAgent(id); // still live, just quiet on this task
  s.tick(t0 + TASK_STALE_MS + TASK_OFFER_MS + 5000);
  expect(Object.keys(s.store.get("directives", d.id)!.reassignOfferedAt ?? {}).sort()).toEqual([a.id, b.id].sort());
  const offers = () => s.store.recentEvents({ kinds: ["system"], limit: 500 }).filter((e) => e.data.reassignOffer && e.data.directiveId === d.id).length;
  expect(offers()).toBe(2);
  s.tick(t0 + TASK_STALE_MS + TASK_OFFER_MS + 6000);
  expect(offers()).toBe(2);
});
