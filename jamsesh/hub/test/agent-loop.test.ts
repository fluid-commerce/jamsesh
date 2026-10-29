// Agents work and listen at the same time (SPEC 6.3), their status tells the truth, observers only watch.
// Scripted fake agents drive the same hook and tool entry points a real Claude Code or Codex would.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bus } from "../src/bus";
import { Hub } from "../src/hub";
import { TASK_OFFER_MS, TASK_STALE_MS } from "../src/session";
import { startHttp } from "../src/http";
import { hookScript } from "../src/install-scripts";
import type { Agent } from "../src/types";

const dir = mkdtempSync(join(tmpdir(), "jam-loop-"));
const hubs: Hub[] = [];
// Stop every hub (its timers write to the data folder) before the folder goes.
afterAll(() => {
  for (const h of hubs) h.stop();
  bus.resolver = null; // a flush still pending would read the folder after it's gone
  rmSync(dir, { recursive: true, force: true });
});

function room() {
  const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, String(Math.random())) });
  hubs.push(hub);
  const s = hub.session;
  const reg = (owner: string, repo: string, cwd: string, harness: Agent["harness"] = "claude-code") => s.registerAgent({ ownerName: owner, harness, repo, cwd, machine: "m1", platform: "desktop" }).agent;
  const call = (agent: Agent, name: string, args: any = {}) => hub.mcp.call({ agentId: agent.id, ip: "127.0.0.1", device: null }, name, args);
  const out = (r: any) => r.content.map((c: any) => c.text).join("\n");
  return { hub, s, reg, call, out };
}
const directive = (s: any, text: string, targets: string[], mode = "implement") => s.createDirective({ text, mode, targets, requestedBy: "Chey" });
const ctxOf = (o: any) => JSON.stringify(o);

test("a busy agent gets room items between steps, once", () => {
  const { hub, s, reg, call, out } = room();
  const a = reg("Jonathan", "acme/desktop", "/d");
  hub.onPrompt({ agentId: a.id, prompt: "build the header" }, "127.0.0.1");
  expect(hub.onTool({ agentId: a.id, tool_name: "Edit" }, "127.0.0.1")).toEqual({});
  const d = directive(s, "Match the mobile tab bar", [a.id]);
  const first: any = hub.onTool({ agentId: a.id, tool_name: "Edit" }, "127.0.0.1");
  expect(first.hookSpecificOutput.hookEventName).toBe("PostToolUse");
  expect(first.hookSpecificOutput.additionalContext).toContain("Match the mobile tab bar");
  expect(first.hookSpecificOutput.additionalContext).toContain(d.id);
  // Not again: not on the next step, not at the next prompt, not in the inbox, not at Stop.
  expect(hub.onTool({ agentId: a.id, tool_name: "Bash" }, "127.0.0.1")).toEqual({});
  expect(hub.onPrompt({ agentId: a.id, prompt: "and the footer" }, "127.0.0.1")).toEqual({});
  expect(s.hasInbox(a.id)).toBe(false);
  expect(hub.onStop({ agentId: a.id }, "127.0.0.1")).toEqual({});
  // Messages from another agent arrive the same way.
  const b = reg("Chey", "acme/mobile", "/m");
  s.sendMessage(b.id, a.id, "Is the header sticky?");
  expect(ctxOf(hub.onTool({ agentId: a.id, tool_name: "Read" }, "127.0.0.1"))).toContain("Is the header sticky?");
  void call; void out;
});

test("the agent's own inbox and wait calls aren't repeated by the tool hook", () => {
  const { hub, s, reg } = room();
  const a = reg("Jonathan", "acme/desktop", "/d");
  directive(s, "Do the thing", [a.id]);
  // jam_inbox already handed it over; the hook for that very tool call must not add a second copy.
  expect(hub.mcp.inboxText(a, true)).toContain("Do the thing");
  expect(hub.onTool({ agentId: a.id, tool_name: "mcp__jamsesh__jam_inbox" }, "127.0.0.1")).toEqual({});
  directive(s, "Another one", [a.id]);
  expect(hub.onTool({ agentId: a.id, tool_name: "mcp__jamsesh__jam_inbox" }, "127.0.0.1")).toEqual({});
  expect(hub.mcp.inboxText(a, true)).toContain("Another one");
});

test("an idle agent returns to its person and is woken when the room has something", async () => {
  const { hub, s, reg } = room();
  const a = reg("Jonathan", "acme/desktop", "/d");
  // With the newer hooks (the tool hook has run) Stop lets the agent end its turn: the listener wakes it.
  hub.onTool({ agentId: a.id, tool_name: "Edit" }, "127.0.0.1");
  expect(hub.onStop({ agentId: a.id, last_assistant_message: "Header done." }, "127.0.0.1")).toEqual({});
  const woken = hub.onListen({ agentId: a.id }, "127.0.0.1");
  await Bun.sleep(30);
  directive(s, "Tighten the footer spacing", [a.id]);
  const text = await woken;
  expect(text).toContain("Tighten the footer spacing");
  expect(s.agent(a.id)?.status).toBe("working");
  // Delivered by the listener: nothing left for the next prompt or inbox.
  expect(hub.onPrompt({ agentId: a.id, prompt: "thanks" }, "127.0.0.1")).toEqual({});
  expect(s.hasInbox(a.id)).toBe(false);
});

test("a listener ends quietly when its person starts talking, and a newer listener replaces it", async () => {
  const { hub, s, reg } = room();
  const a = reg("Jonathan", "acme/desktop", "/d");
  const first = hub.onListen({ agentId: a.id }, "127.0.0.1");
  await Bun.sleep(20);
  const second = hub.onListen({ agentId: a.id }, "127.0.0.1");
  expect(await first).toBe("");
  await Bun.sleep(20);
  hub.onPrompt({ agentId: a.id, prompt: "hello" }, "127.0.0.1");
  expect(await second).toBe("");
  // Nothing was consumed by the ended listeners.
  directive(s, "Later task", [a.id]);
  expect(ctxOf(hub.onTool({ agentId: a.id, tool_name: "Edit" }, "127.0.0.1"))).toContain("Later task");
});

test("an agent in jam_wait gets its items there, not through the listener", async () => {
  const { hub, s, reg, call, out } = room();
  const a = reg("Jonathan", "acme/desktop", "/d");
  const listener = hub.onListen({ agentId: a.id }, "127.0.0.1", null, 400);
  const waiting = call(a, "jam_wait", { seconds: 5 });
  await Bun.sleep(30);
  directive(s, "Take this", [a.id]);
  expect(out(await waiting)).toContain("Take this");
  expect(await listener).toBe("");
});

test("Codex has no hooks: every JamSesh call says when the room has something", async () => {
  const { hub, s, reg, call, out } = room();
  const codex = reg("Jonathan", "acme/api", "/api", "codex");
  const claude = reg("Chey", "acme/web", "/web");
  directive(s, "Rename the endpoint", [codex.id]);
  directive(s, "Rename the page", [claude.id]);
  expect(out(await call(codex, "jam_agents"))).toContain("call jam_inbox");
  // Claude Code with working hooks gets the items from the hook instead, so no nudge in tool results.
  hub.onPrompt({ agentId: claude.id, prompt: "go" }, "127.0.0.1");
  directive(s, "Rename the modal", [claude.id]);
  expect(out(await call(claude, "jam_agents"))).not.toContain("call jam_inbox");
  expect(out(await call(codex, "jam_inbox"))).toContain("Rename the endpoint");
  expect(out(await call(codex, "jam_agents"))).not.toContain("call jam_inbox");
});

test("a finished agent reads Done until its next task; the repo card moves repository, platform and focus", async () => {
  const { hub, s, reg, call } = room();
  const a = reg("Jonathan", "acme/desktop", "/d");
  s.postUpdate(a.id, "done", "Header spacing fixed");
  expect(s.agent(a.id)).toMatchObject({ status: "idle", activity: "Done: Header spacing fixed" });
  // A Stop after it doesn't replace the summary.
  hub.onStop({ agentId: a.id, last_assistant_message: "Anything else?" }, "127.0.0.1");
  expect(s.agent(a.id)?.activity).toBe("Done: Header spacing fixed");
  // The next prompt starts a new task.
  hub.onPrompt({ agentId: a.id, prompt: "now fix the footer" }, "127.0.0.1");
  expect(s.agent(a.id)).toMatchObject({ status: "working", activity: "Working on: now fix the footer" });
  // A Stop with no jam_update still reads as done.
  hub.onStop({ agentId: a.id, last_assistant_message: "Footer is fixed.\nMore detail" }, "127.0.0.1");
  expect(s.agent(a.id)?.activity).toBe("Done: Footer is fixed.");
  // Switching projects: the card updates the tile.
  await call(a, "jam_repo_card", { stack: "Expo", designSystem: "tokens.ts", repo: "acme/mobile", platform: "mobile", focus: "Onboarding" });
  expect(s.agent(a.id)).toMatchObject({ repo: "acme/mobile", platform: "mobile", focus: "Onboarding" });
  expect(s.store.recentEvents({ kinds: ["system"] }).some((e) => e.text.includes("moved to mobile"))).toBe(true);
  // A card without those fields leaves them alone.
  await call(a, "jam_repo_card", { stack: "Expo", designSystem: "tokens.ts", recentChanges: "x" });
  expect(s.agent(a.id)).toMatchObject({ repo: "acme/mobile", platform: "mobile", focus: "Onboarding" });
});

test("an open task is asked about, then offered for reassignment; a workstream pauses when its owner goes offline", () => {
  const { hub, s, reg } = room();
  const a = reg("Jonathan", "acme/desktop", "/d");
  const b = reg("Chey", "acme/desktop2", "/d2");
  const d = directive(s, "Build the settings page", [a.id]);
  hub.onPrompt({ agentId: a.id, prompt: "hi" }, "127.0.0.1"); // takes the directive into its turn (delivered, not acked)
  const t0 = Date.now();
  s.tick(t0 + TASK_STALE_MS - 60_000);
  expect(s.store.get("directives", d.id)?.nudgedAt).toBeUndefined();
  s.tick(t0 + TASK_STALE_MS + 1000);
  expect(s.store.get("directives", d.id)?.nudgedAt?.[a.id]).toBeDefined();
  const nudge = hub.mcp.inboxText(a, true);
  expect(nudge).toContain("minutes since you reported");
  expect(nudge).toContain(d.id);
  // Asking again changes nothing, and no offer yet.
  s.tick(t0 + TASK_STALE_MS + 60_000);
  expect(s.store.get("directives", d.id)?.reassignOfferedAt?.[a.id]).toBeUndefined();
  // Still nothing after the grace: the room is offered the reassignment.
  s.tick(t0 + TASK_STALE_MS + TASK_OFFER_MS + 5000);
  expect(s.store.get("directives", d.id)?.reassignOfferedAt?.[a.id]).toBeDefined();
  expect(s.store.recentEvents({ kinds: ["system"] }).some((e) => e.data.reassignOffer)).toBe(true);
  const moved = s.reassignDirective(d.id, "Chey")!;
  expect(moved.targets).toEqual([b.id]);
  expect(s.store.get("directives", d.id)?.status).toBe("cancelled");
  expect(hub.mcp.inboxText(b, false)).toContain("Build the settings page");
});

test("an agent that answers the nudge keeps its task", () => {
  const { hub, s, reg, call } = room();
  const a = reg("Jonathan", "acme/desktop", "/d");
  const d = directive(s, "Build the settings page", [a.id]);
  hub.mcp.inboxText(a, true);
  const t0 = Date.now();
  s.tick(t0 + TASK_STALE_MS + 1000);
  void call;
  s.setDirectiveFor(d.id, a.id, "acked");
  s.store.patch("directives", d.id, { signs: { [a.id]: t0 + TASK_STALE_MS + 2000 } }); // the ack, as if it came a second after the nudge
  s.tick(t0 + TASK_STALE_MS + TASK_OFFER_MS + 5000);
  expect(s.store.get("directives", d.id)?.reassignOfferedAt?.[a.id]).toBeUndefined();
});

test("a workstream pauses when its owner goes offline and resumes when the owner returns", () => {
  const { s, reg } = room();
  const a = reg("Jonathan", "acme/desktop", "/d");
  const ws = s.claim(a.id, "Settings page").workstream;
  s.tick();
  expect(s.store.get("workstreams", ws.id)?.status).toBe("active");
  s.store.put("agents", { ...s.agent(a.id)!, lastSeen: Date.now() - 30 * 60_000 });
  s.tick();
  expect(s.store.get("workstreams", ws.id)?.status).toBe("paused");
  // Another agent can take it while it's paused.
  s.touchAgent(a.id);
  expect(s.store.get("workstreams", ws.id)?.status).toBe("active");
});

test("an offline agent's task is offered for reassignment without waiting on a nudge", () => {
  const { s, reg } = room();
  const a = reg("Jonathan", "acme/desktop", "/d");
  const d = directive(s, "Build the settings page", [a.id]);
  s.store.put("agents", { ...s.agent(a.id)!, lastSeen: Date.now() - 30 * 60_000 });
  s.tick(Date.now() + TASK_STALE_MS);
  expect(s.store.get("directives", d.id)?.reassignOfferedAt?.[a.id]).toBeDefined();
});

test("observers join without a repository, get no product tasks, and can skip broadcasts", async () => {
  const { hub, s, reg, call, out } = room();
  const worker = reg("Jonathan", "acme/desktop", "/d");
  const joinCtx = { agentId: null as string | null, ip: "127.0.0.1", device: null };
  const joined = await hub.mcp.call(joinCtx, "jam_join", { owner: "Chey", harness: "claude-code", cwd: "/triage", role: "observer", broadcasts: false });
  expect(joined.isError).toBeFalsy();
  const obs = s.agent(joinCtx.agentId)!;
  expect(obs).toMatchObject({ role: "observer", broadcasts: false, repo: "" });
  expect(s.workers().map((a) => a.id)).toEqual([worker.id]);
  // Product work never goes to an observer; answers and notes may.
  expect(directive(s, "Build the settings page", [obs.id, worker.id]).targets).toEqual([worker.id]);
  expect(directive(s, "Explore a dark mode", [obs.id], "explore").targets).toEqual([]);
  expect(directive(s, "Here is your answer", [obs.id], "answer").targets).toEqual([obs.id]);
  // A room-wide message reaches the worker, not the opted-out observer.
  const other = reg("Mo", "acme/api", "/api");
  s.sendMessage(other.id, "all", "Heads up: main is frozen");
  expect(hub.mcp.inboxText(obs, false)).not.toContain("main is frozen");
  expect(hub.mcp.inboxText(worker, false)).toContain("main is frozen");
  // Direct messages still reach it, and an observer that kept broadcasts on hears them.
  s.sendMessage(worker.id, obs.id, "Triage this please");
  expect(hub.mcp.inboxText(obs, false)).toContain("Triage this please");
  expect(out(await call(obs, "jam_agents"))).toContain("observer (only watches)");
});

test("work an agent starts on its own is announced; work its person asked for is not", async () => {
  const { hub, s, reg, call } = room();
  const a = reg("Jonathan", "acme/desktop", "/d");
  const first = await call(a, "jam_claim", { workstream: "Setup" });
  expect(first.isError).toBeFalsy();
  const lines = () => s.store.recentEvents({ kinds: ["system"] }).map((e) => e.text);
  // The first claim right after joining is what the join prompt asked for.
  expect(lines().some((t) => t.includes('"Setup" on its own'))).toBe(false);
  expect(lines().some((t) => t.includes('took "Setup"'))).toBe(true);
  await call(a, "jam_claim", { workstream: "Surprise refactor" });
  expect(lines().some((t) => t.includes('started "Surprise refactor" on its own'))).toBe(true);
  hub.onPrompt({ agentId: a.id, prompt: "please do the footer" }, "127.0.0.1");
  await call(a, "jam_claim", { workstream: "Footer" });
  expect(lines().some((t) => t.includes('took "Footer"'))).toBe(true);
  expect(lines().some((t) => t.includes('"Footer" on its own'))).toBe(false);
  // Work the room handed over counts as asked, too.
  const b = reg("Chey", "acme/mobile", "/m");
  directive(s, "Do the tabs", [b.id]);
  hub.mcp.inboxText(b, true);
  s.setDirectiveFor(s.directives()[0].id, b.id, "acked");
  await call(b, "jam_claim", { workstream: "Tabs" });
  expect(lines().some((t) => t.includes('"Tabs" on its own'))).toBe(false);
  // Codex reports no prompts, so it isn't accused.
  const c = reg("Mo", "acme/api", "/api", "codex");
  await call(c, "jam_claim", { workstream: "API cleanup" });
  expect(lines().some((t) => t.includes('"API cleanup" on its own'))).toBe(false);
});

test("hook.sh listen holds in the background and exits 2 with the room's news", async () => {
  const { hub, s, reg } = room();
  const server = startHttp(hub, 0);
  try {
    const a0 = reg("Jonathan", "acme/desktop", "/d");
    const a = hub.session.store.put("agents", { ...a0, chatId: "chat-1" }) as Agent; // the hooks find the agent by its chat
    const cred = hub.auth.issue({ kind: "agent", label: "Agents", ip: "127.0.0.1", ownerDeviceId: "host" });
    const home = join(dir, "client");
    require("node:fs").mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "hook.sh"), hookScript(hub), { mode: 0o755 });
    writeFileSync(join(home, "client.env"), `JAMSESH_ACTIVE=1\nJAMSESH_HUB=http://127.0.0.1:${server.port}\nJAMSESH_TOKEN=${cred.token}\n`);
    const run = (seconds: number) => Bun.spawn(["bash", join(home, "hook.sh"), "listen"], { stdin: new Blob([JSON.stringify({ session_id: "chat-1" })]), stdout: "pipe", stderr: "pipe", env: { ...process.env, JAMSESH_CLIENT_ENV: join(home, "client.env"), JAMSESH_DIR: home, JAMSESH_LISTEN_SECONDS: String(seconds) } });
    const waking = run(20);
    await Bun.sleep(400);
    directive(s, "Wake up and tighten the header", [a.id]);
    expect(await waking.exited).toBe(2);
    expect(await new Response(waking.stderr).text()).toContain("Wake up and tighten the header");
  } finally {
    server.stop(true);
    hub.devproxy.stop();
  }
});

test("an agent whose install predates the listener is still sent to jam_wait at Stop", () => {
  const { hub, reg } = room();
  const old = reg("Jonathan", "acme/desktop", "/d");
  const stop: any = hub.onStop({ agentId: old.id, last_assistant_message: "Done." }, "127.0.0.1");
  expect(stop.decision).toBe("block");
  expect(stop.reason).toContain("jam_wait");
  // Only once per stop, as before.
  expect(hub.onStop({ agentId: old.id, stop_hook_active: true }, "127.0.0.1")).toEqual({});
  // The first sign of the newer hooks switches it over, and it stays switched.
  hub.onListen({ agentId: old.id }, "127.0.0.1", null, 1);
  expect(hub.onStop({ agentId: old.id }, "127.0.0.1")).toEqual({});
});

test("reassigning records who did it", async () => {
  const { hub, s, reg } = room();
  const a = reg("Jonathan", "acme/desktop", "/d");
  const b = reg("Chey", "acme/mobile", "/m");
  const p = s.upsertPerson({ name: "Rae" });
  const d = directive(s, "Build it", [a.id]);
  const moved = s.reassignDirective(d.id, p.name)!;
  expect(moved.requestedBy).toBe("Rae");
  expect(moved.targets).toEqual([b.id]);
  void hub;
});

test("the tool and listen hooks find the agent by its chat, and do nothing for a chat that hasn't joined", async () => {
  const { hub, s, reg } = room();
  const a0 = reg("Jonathan", "acme/desktop", "/d");
  const a = s.store.put("agents", { ...a0, chatId: "chat-A" }) as Agent;
  directive(s, "Take this", [a.id]);
  expect(hub.onTool({ session_id: "stranger", tool_name: "Edit" }, "127.0.0.1")).toEqual({});
  expect(await hub.onListen({ session_id: "stranger" }, "127.0.0.1", null, 1)).toBe("");
  expect(s.hasInbox(a.id)).toBe(true);
  expect(JSON.stringify(hub.onTool({ session_id: "chat-A", tool_name: "Edit" }, "127.0.0.1"))).toContain("Take this");
  // Its newer-hooks mark belongs to the agent.
  expect(hub.onStop({ session_id: "chat-A" }, "127.0.0.1")).toEqual({});
});

test("a multi-target directive offers and reassigns per target; the others keep their work", () => {
  const { s, reg } = room();
  const a = reg("Jonathan", "acme/desktop", "/d");
  const b = reg("Chey", "acme/desktop2", "/d2");
  const c = reg("Mo", "acme/api", "/api");
  const d = directive(s, "Build the settings page", [a.id, b.id]);
  s.inbox(a.id);
  s.inbox(b.id);
  const t0 = Date.now();
  // b reports on this task late; a never does.
  s.postUpdate(b.id, "progress", "halfway there", { data: { directiveId: d.id } });
  s.noteProgress(d.id, b.id, t0 + TASK_STALE_MS);
  s.tick(t0 + TASK_STALE_MS + 1000);
  s.tick(t0 + TASK_STALE_MS + TASK_OFFER_MS + 5000);
  const offers = s.store.get("directives", d.id)!.reassignOfferedAt ?? {};
  expect(offers[a.id]).toBeDefined();
  expect(offers[b.id]).toBeUndefined();
  const moved = s.reassignDirective(d.id, "Chey", undefined, a.id)!;
  expect(moved.targets).toEqual([c.id]);
  const after = s.store.get("directives", d.id)!;
  expect(after.progress[a.id]).toBe("cancelled");
  expect(after.progress[b.id]).not.toBe("cancelled");
  expect(after.status).not.toBe("cancelled");
  expect(after.reassignOfferedAt?.[a.id]).toBeUndefined();
});

test("only progress on that task resets its clock, and progress clears an offer", () => {
  const { s, reg } = room();
  const a = reg("Jonathan", "acme/desktop", "/d");
  reg("Chey", "acme/desktop2", "/d2");
  const d = directive(s, "Build the settings page", [a.id]);
  s.inbox(a.id);
  const t0 = Date.now();
  // Unrelated work doesn't count.
  s.postUpdate(a.id, "progress", "fixing the footer");
  s.tick(t0 + TASK_STALE_MS + 1000);
  expect(s.store.get("directives", d.id)?.nudgedAt?.[a.id]).toBeDefined();
  s.tick(t0 + TASK_STALE_MS + TASK_OFFER_MS + 5000);
  expect(s.store.get("directives", d.id)?.reassignOfferedAt?.[a.id]).toBeDefined();
  // An update linked to the directive is progress: the offer goes.
  s.postUpdate(a.id, "progress", "settings page started", { data: { directiveId: d.id } });
  expect(s.store.get("directives", d.id)?.reassignOfferedAt?.[a.id]).toBeUndefined();
  expect(s.store.get("directives", d.id)?.signs?.[a.id]).toBeGreaterThanOrEqual(t0);
});

test("a jam_update(done) keeps Done through its own PostToolUse; the next real tool resets it", async () => {
  const { hub, s, reg, call } = room();
  const a0 = reg("Jonathan", "acme/desktop", "/d");
  const a = s.store.put("agents", { ...a0, chatId: "chat-D" }) as Agent;
  await call(a, "jam_update", { kind: "done", text: "Footer is fixed." });
  hub.onTool({ session_id: "chat-D", tool_name: "mcp__jamsesh__jam_update" }, "127.0.0.1");
  expect(s.agent(a.id)?.activity).toBe("Done: Footer is fixed.");
  expect(s.agent(a.id)?.status).toBe("idle");
  hub.onTool({ session_id: "chat-D", tool_name: "Edit" }, "127.0.0.1");
  expect(s.agent(a.id)?.activity).toBe("Working");
  expect(s.agent(a.id)?.status).toBe("working");
});

test("an observer stays an observer when it rejoins without a role, and can't claim", async () => {
  const { hub, s } = room();
  const ctx = { agentId: null as string | null, ip: "127.0.0.1", device: null };
  const joinArgs = { owner: "Chey", harness: "claude-code", cwd: "/triage", chat: "chat-O" };
  await hub.mcp.call(ctx, "jam_join", { ...joinArgs, role: "observer" });
  const id = ctx.agentId!;
  expect(s.agent(id)?.role).toBe("observer");
  const again = { agentId: null as string | null, ip: "127.0.0.1", device: null };
  await hub.mcp.call(again, "jam_join", { ...joinArgs, repo: "acme/x" });
  expect(again.agentId).toBe(id);
  expect(s.agent(id)).toMatchObject({ role: "observer", repo: "" });
  await expect(hub.mcp.call(again, "jam_claim", { workstream: "Anything" })).rejects.toThrow("observer");
  expect(s.store.all("workstreams")).toEqual([]);
  // Naming a role changes it.
  await hub.mcp.call({ agentId: null, ip: "127.0.0.1", device: null }, "jam_join", { ...joinArgs, repo: "acme/x", role: "worker" });
  expect(s.agent(id)?.role).toBe("worker");
});
