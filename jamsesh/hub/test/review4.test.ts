// Phase 2, fourth review: the MCP server tells an uninvited chat to wait, observers can't claim through
// an update and a new claim by update is announced, a burst of decisions all arrive, and a named
// reassignment goes to that agent or fails.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../src/hub";
import { startHttp } from "../src/http";
import { JOIN_RULE } from "../src/skill";
import { hooksOf } from "./hooks";

const dir = mkdtempSync(join(tmpdir(), "jam-review4-"));
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
const join_ = (chatId: string, cwd: string, role?: "observer") =>
  s.registerAgent({ ownerName: "Chey", harness: "claude-code", repo: role ? "" : "app", cwd, machine: "m1", platform: "web", chatId, role }).agent;
const call = (agentId: string, name: string, args: object) => hub.mcp.call({ agentId, ip: "127.0.0.1", device: null }, name, args);

test("the MCP server's instructions say to join only when the person asks, in the skill's words", async () => {
  const agent = hub.auth.issue({ kind: "agent", label: "Agents", ip: "10.0.0.5", ownerDeviceId: "dev_mac" });
  const r = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { ...remote, authorization: `Bearer ${agent.token}`, accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } }),
  });
  const body = await r.text();
  const json = JSON.parse(body.includes("data:") ? body.split("data:").pop()!.trim() : body);
  const text: string = json.result.instructions;
  expect(text).toContain(JOIN_RULE);
  expect(text).not.toContain("Call jam_join first");
  expect(text).toContain("Until your person asks, don't call any JamSesh tool");
});

test("an observer's update claims nothing; a worker's update that takes up new work is announced", async () => {
  const obs = join_("chat-obs4", "/r4/obs", "observer");
  await call(obs.id, "jam_update", { kind: "progress", text: "looking around", workstream: "Checkout" });
  expect(s.store.all("workstreams").some((w) => w.title === "Checkout")).toBe(false);
  expect(s.store.recentEvents({ kinds: ["update"] }).find((e) => e.authorId === obs.id)?.workstreamId).toBeNull();
  await expect(call(obs.id, "jam_claim", { workstream: "Checkout" })).rejects.toThrow("observer");
  expect(() => s.claim(obs.id, "Checkout")).toThrow("observer");
  const worker = join_("chat-w4", "/r4/w");
  s.store.put("agents", { ...s.agent(worker.id)!, joinedAt: Date.now() - 60 * 60_000 }); // not its first claim after joining
  const system = () => s.store.recentEvents({ kinds: ["system"], limit: 500 }).filter((e) => e.authorId === worker.id).map((e) => e.text);
  await call(worker.id, "jam_update", { kind: "progress", text: "refactoring the cart", workstream: "Cart refactor" });
  expect(system().some((t) => t.includes('started "Cart refactor" on its own'))).toBe(true);
  // An update on work it already owns isn't announced again.
  const before = system().length;
  await call(worker.id, "jam_update", { kind: "progress", text: "halfway", workstream: "cart refactor" });
  expect(system()).toHaveLength(before);
});

test("a burst of more decisions than one handover holds all arrive, oldest first, none skipped", () => {
  const a = join_("chat-dec4", "/r4/dec");
  const h = hooksOf(hub);
  h.prompt(a, { prompt: "start" });
  h.tool(a, { tool_name: "Edit" }); // acknowledge anything from the start
  const texts = Array.from({ length: 15 }, (_, i) => `Decision ${i}`);
  for (const t of texts) s.store.addEvent({ kind: "decision", authorType: "brain", authorName: "Room decision", text: t, relevance: "work", data: {} });
  const got: string[] = [];
  for (let i = 0; i < 4; i++) {
    const out = JSON.stringify(h.tool(a, { tool_name: "Edit" }));
    for (const t of texts) if (out.includes(`Room decision: ${t}\\n`) || out.includes(`Room decision: ${t}"`)) got.push(t);
  }
  expect(got).toEqual(texts);
});

test("a named reassignment goes to that agent or is refused; with no name the best match takes it", async () => {
  const a = join_("chat-ra", "/r4/ra");
  const b = join_("chat-rb", "/r4/rb");
  const obs = join_("chat-ro", "/r4/ro", "observer");
  const offline = join_("chat-roff", "/r4/roff");
  s.store.put("agents", { ...s.agent(offline.id)!, lastSeen: Date.now() - 60 * 60_000 });
  const person = hub.auth.issue({ kind: "browser", label: "Laptop", ip: "10.0.0.9", personId: s.upsertPerson({ name: "Chey" }).id });
  const d = s.createDirective({ text: "Build the settings page", mode: "implement", targets: [a.id], requestedBy: "Chey" });
  const reassign = (to?: string) => fetch(`${base}/api/directives/${d.id}/reassign`, { method: "POST", headers: { ...remote, authorization: `Bearer ${person.token}` }, body: JSON.stringify({ agentId: a.id, ...(to ? { to } : {}) }) });
  for (const [to, why] of [["a_nobody", "no agent"], [obs.id, "only watches"], [offline.id, "offline"], [a.id, "already has"]] as const) {
    const r = await reassign(to);
    expect(r.status).toBe(400);
    expect((await r.json()).error).toContain(why);
  }
  expect(s.store.get("directives", d.id)!.progress[a.id]).toBe("pending"); // nothing moved
  const ok = await reassign(b.id);
  expect(ok.status).toBe(200);
  expect((await ok.json()).targets).toEqual([b.id]);
});
