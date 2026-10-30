// Phase 4.1, the Tasks board's triage: overheard tasks and context wait as cards, things said to JamSesh on purpose
// go straight out, every card action obeys the rules, and spoken triage works. Simulated rooms, no sound.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forCuration, WAITING_MS } from "../src/board";
import { bus } from "../src/bus";
import { config } from "../src/config";
import { Hub } from "../src/hub";
import { startHttp } from "../src/http";
import type { Agent, JamEvent } from "../src/types";

process.env.JAMSESH_SILENT = "1";
// The rules path, deterministically; the live model has its own test at the end.
const wasOffline = config.offline;
config.offline = true;
const dir = mkdtempSync(join(tmpdir(), "jam-board-"));
const hubs: Hub[] = [];
afterAll(() => {
  config.offline = wasOffline;
  for (const h of hubs) h.stop();
  bus.resolver = null;
  rmSync(dir, { recursive: true, force: true });
});

function room() {
  const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, String(Math.random())) });
  hubs.push(hub);
  const s = hub.session;
  s.updateSettings({ voiceReplies: false, hostControl: false });
  const chey = s.upsertPerson({ name: "Chey" });
  const felipe = s.upsertPerson({ name: "Felipe" });
  const reg = (owner: string, repo: string, platform: Agent["platform"] = "desktop") => s.registerAgent({ ownerName: owner, harness: "claude-code", repo, cwd: `/${owner}`, machine: owner, platform }).agent;
  const desktop = reg("Felipe", "acme/desktop");
  const mobile = reg("Chey", "acme/mobile", "mobile");
  let id = 5000;
  const said = (who: { id: string; name: string }, text: string, data: Record<string, any> = {}) => s.store.addEvent({ kind: "speech", authorType: "person", authorId: who.id, authorName: who.name, text, relevance: "work", data });
  const tools = (batch: JamEvent[], from: "person" | "agent" = "person", route: "direct" | "overheard" = "direct") => (hub.brain as any).tools(batch, { effects: 0 }, from, route);
  const exec = async (t: any, input: any) => t.execute(input, { toolCallId: String(id++), messages: [] });
  return { hub, s, chey, felipe, desktop, mobile, said, tools, exec };
}

const task = (r: ReturnType<typeof room>, text = "Make three onboarding variants for the desktop app", extra: Record<string, any> = {}) =>
  r.s.proposeTask({ text, mode: "explore", targets: [r.desktop.id], by: "Chey", sourceEventIds: [r.said(r.chey, text).id], ...extra })!;

// ---------- routing: overheard versus on purpose ----------

test("an overheard task waits as a card with its source line; the same ask said again joins it", () => {
  const r = room();
  const a = task(r);
  expect(a).toMatchObject({ type: "task", status: "open", origin: "overheard", count: 1, text: "Make three onboarding variants for the desktop app" });
  expect(a.sources[0]).toMatchObject({ authorName: "Chey", text: a.text });
  expect(a.sources[0].eventId).not.toBeNull();
  expect(r.s.directives()).toHaveLength(0);
  // Said again (case and punctuation aside) by someone else: one card, two sources, a count.
  const again = r.s.proposeTask({ text: "make three onboarding variants for the desktop app.", mode: "explore", targets: [r.desktop.id], by: "Felipe", sourceEventIds: [r.said(r.felipe, "make three onboarding variants for the desktop app.").id] })!;
  expect(again.id).toBe(a.id);
  expect(again.count).toBe(2);
  expect(again.sources).toHaveLength(2);
  // The very same line twice (two microphones) isn't a repeat.
  expect(r.s.proposeTask({ text: a.text, mode: "explore", targets: [r.desktop.id], by: "Chey", sourceEventIds: [a.sources[0].eventId!] })!.count).toBe(2);
  // A different count is a different ask.
  expect(task(r, "Make five onboarding variants for the desktop app").id).not.toBe(a.id);
  expect(r.s.board.open()).toHaveLength(2);
});

test("the router's create_directive proposes when the line was overheard and sends when it was asked of JamSesh", async () => {
  const r = room();
  const overheard = r.said(r.chey, "let's try some profile variants");
  const input = { targets: [r.mobile.id], mode: "explore", text: "Try three profile screen variants", rationale: "Chey asked" };
  const out = await r.exec(r.tools([overheard], "person", "overheard").create_directive, input);
  expect(out).toContain("Proposed on the Tasks board");
  expect(r.s.directives()).toHaveLength(0);
  expect(r.s.board.open()).toHaveLength(1);
  expect(r.s.board.open()[0].targets).toEqual([r.mobile.id]);
  // Asked directly: it goes out, and no card is made.
  const asked = r.said(r.chey, "JamSesh, have the desktop agent try a settings page", { direct: true });
  await r.exec(r.tools([asked]).create_directive, { targets: [r.desktop.id], mode: "explore", text: "Try a settings page", rationale: "asked" });
  expect(r.s.directives().map((d) => d.text)).toEqual(["Try a settings page"]);
  expect(r.s.board.open()).toHaveLength(1);
});

test("record_decision: asked of JamSesh it is saved and shown to agents; overheard or agent-reported it waits", async () => {
  const r = room();
  const asked = r.said(r.chey, "JamSesh, remember we're going with option B for the header", { direct: true });
  await r.exec(r.tools([asked]).record_decision, { text: "The header uses option B" });
  expect(r.s.facts().map((f) => f.text)).toEqual(["The header uses option B"]);
  expect(r.s.store.recentEvents({ kinds: ["decision"] })).toHaveLength(1);
  expect(r.s.board.open()).toHaveLength(0);

  const heard = r.said(r.felipe, "I think the footer should be sticky");
  const out = await r.exec(r.tools([heard], "person", "overheard").record_decision, { text: "The footer is sticky" });
  expect(out).toContain("Tasks board");
  const fromAgent = r.s.store.addEvent({ kind: "message", authorType: "agent", authorId: r.mobile.id, authorName: r.mobile.name, text: "I settled on pull to refresh", relevance: "work" });
  await r.exec(r.tools([fromAgent], "agent").record_decision, { text: "Lists use pull to refresh" });
  const cards = r.s.board.open();
  expect(cards.map((c) => [c.text, c.origin])).toEqual([["The footer is sticky", "overheard"], ["Lists use pull to refresh", "agent"]]);
  expect(r.s.facts().filter((f) => f.status === "active")).toHaveLength(1);
  expect(r.s.store.recentEvents({ kinds: ["decision"] })).toHaveLength(1);
});

test("overheard lines through the offline rules wait on the board; the same words typed to JamSesh go out", async () => {
  const r = room();
  const spoken = r.said(r.chey, "let's try some variants of the profile screen");
  r.hub.brain.ruleRoute([spoken], (await import("../src/brain/brain")).ruleTriage([spoken]));
  expect(r.s.directives()).toHaveLength(0);
  expect(r.s.board.open()).toHaveLength(1);
  // Typed on purpose (the box that talks to JamSesh): straight through, same rules.
  r.hub.typed(r.felipe.id, "let's try some settings page layouts", true);
  await Bun.sleep(300);
  expect(r.s.directives().map((d) => d.text)).toContain("let's try some settings page layouts");
  expect(r.s.board.open()).toHaveLength(1);
});

test("agent decisions become cards linked to the update; shipped notes go to the changelog, not the board or curation", () => {
  const r = room();
  const decision = r.s.postUpdate(r.desktop.id, "decision", "Icons come from set A");
  const shipped = r.s.postUpdate(r.mobile.id, "shipped", "Pull to refresh landed in the app");
  r.s.postUpdate(r.mobile.id, "progress", "Working on the tabs");
  const cards = r.s.board.open();
  expect(cards).toHaveLength(1);
  expect(cards[0]).toMatchObject({ origin: "agent", by: r.desktop.name, kind: "decision", text: "Icons come from set A" });
  expect(cards[0].sources[0].eventId).toBe(decision.id);
  expect(r.s.changelog().map((e) => e.id)).toEqual([shipped.id]);
  expect(forCuration(shipped)).toBe(false);
  expect(forCuration(decision)).toBe(false);
  expect(forCuration(r.s.postUpdate(r.mobile.id, "question", "Which font?"))).toBe(true);
  expect(forCuration(r.said(r.chey, "hello"))).toBe(true);
});

test("context that is already known doesn't make a card; one that disagrees with a fact says which", () => {
  const r = room();
  const known = r.s.board.rememberNow({ text: "Settings header uses option A, the big greeting", kind: "decision", by: "Chey" })!;
  expect(r.s.proposeContext({ text: "settings header uses option A, the big greeting.", kind: "decision", by: "Felipe" })).toBeNull();
  // A paraphrase isn't dropped: it waits as a card for a person.
  expect(r.s.proposeContext({ text: "The settings header uses option A, the big greeting.", kind: "decision", by: "Felipe" })).not.toBeNull();
  const differs = r.s.proposeContext({ text: "Settings header uses option B, the big greeting", kind: "decision", by: "Felipe" })!;
  expect(differs.conflictsWith).toBe(known.id);
  expect(r.s.proposeContext({ text: "Use 16px gutters on phones", kind: "requirement", by: "Chey" })!.conflictsWith).toBeNull();
});

// ---------- card actions ----------

test("send: edits are kept beside what was heard, the directive carries the sources, and a second send is refused", () => {
  const r = room();
  const c = task(r);
  const sent = r.s.board.send(c.id, "Felipe", { text: "Make three onboarding variants, mobile first", mode: "implement", targets: [r.mobile.id], workstream: "Onboarding" });
  expect(sent.ok).toBe(true);
  if (!sent.ok) return;
  const d = r.s.store.get("directives", (sent as any).directiveId)!;
  expect(d).toMatchObject({ text: "Make three onboarding variants, mobile first", mode: "implement", targets: [r.mobile.id], requestedBy: "Chey" });
  expect(d.sourceEventIds).toEqual(c.sources.map((x) => x.eventId!));
  expect(d.rationale).toContain("Felipe sent it");
  expect(sent.card).toMatchObject({ status: "sent", resolvedBy: "Felipe", original: c.text, directiveId: d.id });
  expect(sent.card.edits[0].fields.sort()).toEqual(["mode", "targets", "text", "workstream"]);
  // A repeated click, or a second person: a clear conflict, and exactly one directive.
  const again = r.s.board.send(c.id, "Chey");
  expect(again).toMatchObject({ ok: false, status: 409 });
  expect(r.s.directives()).toHaveLength(1);
  expect(r.s.board.dismiss(c.id, "Chey")).toMatchObject({ ok: false, status: 409 });
});

test("a card for two agents sends one directive to both; the repeat of the click does nothing more", () => {
  const r = room();
  const c = task(r, "Keep the nav in parity between desktop and mobile", { mode: "coordinate", targets: [r.desktop.id, r.mobile.id] });
  expect(c.targets).toHaveLength(2);
  expect(r.s.board.send(c.id, "Chey").ok).toBe(true);
  expect(r.s.board.send(c.id, "Felipe").ok).toBe(false);
  expect(r.s.directives()).toHaveLength(1);
  expect(r.s.directives()[0].targets.sort()).toEqual([r.desktop.id, r.mobile.id].sort());
});

test("send needs an agent, and edit rejects things that aren't valid", () => {
  const r = room();
  const c = task(r, "Look into the checkout flow", { targets: [] });
  expect(r.s.board.send(c.id, "Chey")).toMatchObject({ ok: false, status: 400, error: expect.stringContaining("Pick an agent") });
  expect(r.s.board.edit(c.id, { mode: "ship it" }, "Chey")).toMatchObject({ ok: false });
  expect(r.s.board.edit(c.id, { targets: ["nobody"] }, "Chey")).toMatchObject({ ok: false });
  expect(r.s.board.edit(c.id, { text: "   " }, "Chey")).toMatchObject({ ok: false });
  expect(r.s.board.edit(c.id, { kind: "fact" }, "Chey").ok).toBe(true);
  expect(r.s.board.get(c.id)!.edits).toHaveLength(0);
  expect(r.s.board.send(c.id, "Chey", { targets: [r.desktop.id] }).ok).toBe(true);
  expect(r.s.board.send("tri_nope", "Chey")).toMatchObject({ ok: false, status: 404 });
});

test("context cards: add saves the edited fact (a decision reaches agents), merge folds in, replace supersedes, dismiss stays quiet", () => {
  const r = room();
  const c = r.s.proposeContext({ text: "Greeting uses the first name", kind: "requirement", by: "Chey", sourceEventIds: [r.said(r.chey, "greeting uses the first name").id] })!;
  expect(r.s.board.send(c.id, "Chey")).toMatchObject({ ok: false });
  const added = r.s.board.add(c.id, "Felipe", { text: "The greeting uses the person's first name", workstream: "Settings" });
  expect(added.ok).toBe(true);
  const fact = r.s.facts().find((f) => f.status === "active")!;
  expect(fact).toMatchObject({ text: "The greeting uses the person's first name", kind: "requirement", workstream: "Settings", by: "Chey" });
  expect(fact.sourceEventIds).toEqual(c.sources.map((x) => x.eventId!));
  expect(r.s.store.recentEvents({ kinds: ["decision"] })).toHaveLength(0);

  // Merge into the saved fact.
  const m = r.s.proposeContext({ text: "Never the email address", kind: "requirement", workstream: "Settings", by: "Chey" })!;
  expect(r.s.board.merge(m.id, "fact_nope", "Chey")).toMatchObject({ ok: false, status: 404 });
  expect(r.s.board.merge(m.id, fact.id, "Chey").ok).toBe(true);
  expect(r.s.store.get("facts", fact.id)!.text).toBe("The greeting uses the person's first name. Never the email address");

  // Replace: the old fact is superseded, the new one active, and a decision is announced to agents.
  const old = r.s.board.rememberNow({ text: "Settings header uses option A", kind: "decision", by: "Chey" })!;
  const rep = r.s.proposeContext({ text: "Settings header uses option B", kind: "decision", by: "Felipe" })!;
  expect(rep.conflictsWith).toBe(old.id);
  expect(r.s.board.replace(rep.id, "Chey").ok).toBe(true);
  expect(r.s.store.get("facts", old.id)!.status).toBe("superseded");
  expect(r.s.facts().find((f) => f.status === "active" && /option B/.test(f.text))).toBeTruthy();
  expect(r.s.store.recentEvents({ kinds: ["decision"] }).map((e) => e.text)).toEqual(["Settings header uses option B"]);
  // Replace with nothing left to replace is refused.
  const orphan = r.s.proposeContext({ text: "Header height is 56px", kind: "fact", by: "Chey" })!;
  expect(r.s.board.replace(orphan.id, "Chey")).toMatchObject({ ok: false, status: 409 });

  // Dismissed: said again soon, it stays dismissed (and counts).
  expect(r.s.board.dismiss(orphan.id, "Chey").ok).toBe(true);
  expect(r.s.proposeContext({ text: "Header height is 56px", kind: "fact", by: "Felipe" })!.status).toBe("dismissed");
  expect(r.s.board.open()).toHaveLength(0);
  expect(r.s.board.stats().context).toMatchObject({ proposed: 4, accepted: 3, dismissed: 1, edited: 1 });
});

test("cards never expire; ones waiting 30 minutes are labelled and mentioned out loud, with a cooldown and quiet while people talk", async () => {
  const r = room();
  const c = task(r);
  const { Board } = await import("../src/board");
  expect(Board.waitingMin(c, c.ts + WAITING_MS - 1000)).toBeNull();
  expect(Board.waitingMin(c, c.ts + 40 * 60_000)).toBe(40);
  // A day later it is still on the board.
  expect(r.s.board.open().map((x) => x.id)).toEqual([c.id]);
  // Make it 40 minutes old.
  r.s.store.put("triage", { ...c, ts: Date.now() - 40 * 60_000 });
  const heard: string[] = [];
  const off = bus.on((m) => m.type === "toast" && heard.push(m.detail ?? ""));
  const brain = r.hub.brain;
  const now = Date.now();
  // Too soon for a card made just now; and not while people are talking.
  expect(r.hub.brain.nagTriage(now - 25 * 60_000)).toBe(false);
  r.said(r.chey, "so about the header");
  expect(brain.nagTriage(now)).toBe(false);
  expect(brain.nagTriage(now + 30_000)).toBe(true);
  await Bun.sleep(50);
  expect(heard.some((h) => /waiting in triage.*4\d minutes/.test(h))).toBe(true);
  expect(r.s.board.get(c.id)!.mentionedAt).toBe(now + 30_000);
  // Not again within 20 minutes; after that, yes, and the card is still there.
  expect(brain.nagTriage(now + 10 * 60_000)).toBe(false);
  expect(brain.nagTriage(now + 51 * 60_000)).toBe(true);
  expect(r.s.board.open()).toHaveLength(1);
  off();
});

// ---------- spoken triage ----------

test("spoken triage on rules: send that one, dismiss the second one, add that", async () => {
  const r = room();
  const { brain } = r.hub as any;
  const first = task(r, "Make three onboarding variants for the desktop app");
  const second = task(r, "Mock up a dark mode for the mobile app", { targets: [r.mobile.id] });
  const ctx = r.s.proposeContext({ text: "Dark mode follows the system setting", kind: "requirement", by: "Chey" })!;
  const say = (text: string, who = r.chey) => brain.offlineDirect(r.said(who, text, { direct: true }));
  say("JamSesh, dismiss the second one");
  expect(r.s.board.get(second.id)!.status).toBe("dismissed");
  say("JamSesh, send that one"); // the newest open card is the context card: sending it adds it
  expect(r.s.board.get(ctx.id)!.status).toBe("added");
  say("hey JamSesh, send it");
  expect(r.s.board.get(first.id)).toMatchObject({ status: "sent", resolvedBy: "Chey" });
  expect(r.s.directives().map((d) => d.text)).toEqual([first.text]);
  // Nothing left: a plain answer, no crash. Other words aren't mistaken for triage.
  say("JamSesh, send that one");
  say("JamSesh, add a settings button to the header");
  expect(r.s.directives()).toHaveLength(1);
});

test("the triage_card tool: for a person who asked directly, not for overheard lines or agents", async () => {
  const r = room();
  const c = task(r);
  const ctx = r.s.proposeContext({ text: "Dark mode follows the system setting", kind: "requirement", by: "Chey" })!;
  expect(r.tools([r.said(r.chey, "yeah send it", {})], "person", "overheard").triage_card).toBeUndefined();
  expect(r.tools([], "agent").triage_card).toBeUndefined();
  // A direct pass with nobody who spoke to JamSesh (a note from the system): refused.
  expect(await r.exec(r.tools([]).triage_card, { card: "1", action: "send" })).toContain("Only a person");
  const asked = r.said(r.felipe, "JamSesh, send that one to Chey's agent, but make it implement", { direct: true });
  const tool = r.tools([asked]).triage_card;
  expect(await r.exec(tool, { card: "1", action: "send", agent: "nobody" })).toContain("No agent");
  expect(await r.exec(tool, { card: "1", action: "send", agent: r.mobile.name, mode: "implement" })).toContain(`Sent to ${r.mobile.name}`);
  expect(r.s.directives()[0]).toMatchObject({ mode: "implement", targets: [r.mobile.id], requestedBy: "Chey" });
  expect(r.s.board.get(c.id)!.resolvedBy).toBe("Felipe");
  expect(await r.exec(tool, { card: c.id, action: "dismiss" })).toContain("already sent");
  expect(await r.exec(tool, { card: "last", action: "add", text: "Dark mode follows the system theme", workstream: "Theming" })).toBe("Added.");
  expect(r.s.facts().find((f) => f.id === r.s.board.get(ctx.id)!.factId)).toMatchObject({ text: "Dark mode follows the system theme", workstream: "Theming" });
  expect(await r.exec(tool, { card: "7", action: "send" })).toContain("No card");
});

// ---------- the real routes ----------

test("the board's routes: people act through the host window, agents and strangers are refused, repeats are clean, state carries the cards", async () => {
  const r = room();
  const server = startHttp(r.hub, 0);
  try {
    const agentCred = r.hub.auth.issue({ kind: "agent", label: "Agents", ip: "127.0.0.1", ownerDeviceId: "host" });
    const win = () => `jam_window=${r.hub.auth.windows.take(r.hub.auth.windows.mint())}`;
    const call = (method: string, path: string, body: any, headers: Record<string, string> = {}) =>
      fetch(`http://127.0.0.1:${server.port}/api${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const c = task(r);
    const ctx = r.s.proposeContext({ text: "Greeting uses the first name", kind: "requirement", by: "Chey" })!;

    for (const [method, path] of [["PATCH", `/triage/${c.id}`], ["POST", `/triage/${c.id}/send`], ["POST", `/triage/${c.id}/dismiss`], ["POST", `/triage/${ctx.id}/add`]] as const) {
      // An agent's credential, another process on the host with no window key, and a window nobody has signed in to.
      expect((await call(method, path, { personId: r.chey.id, text: "x" }, { authorization: `Bearer ${agentCred.token}` })).status).toBe(403);
      expect((await call(method, path, { personId: r.chey.id, text: "x" })).status).toBe(403);
    }
    expect(r.s.board.get(c.id)!.status).toBe("open");

    // An agent can't read the proposals; the changelog is for everyone.
    const far = { "x-forwarded-for": "9.9.9.9" };
    const remoteAgent = r.hub.auth.issue({ kind: "agent", label: "Agents", ip: "9.9.9.9", ownerDeviceId: "host" });
    expect((await call("GET", "/triage", undefined, { ...far, authorization: `Bearer ${remoteAgent.token}` })).status).toBe(403);
    expect((await call("POST", `/triage/${c.id}/send`, {}, { ...far, authorization: `Bearer ${remoteAgent.token}` })).status).toBe(403);
    // GET shows the cards and what people do with them.
    expect((await call("GET", "/triage", undefined)).status).toBe(403); // loopback alone is not the host
    const listed = await (await call("GET", "/triage", undefined, { cookie: win() })).json();
    expect(listed.cards.map((x: any) => x.id).sort()).toEqual([c.id, ctx.id].sort());
    expect(listed.stats.task.open).toBe(1);

    // Edit, then send; the second send (another person, or a replay without the key) is a 409.
    expect((await call("PATCH", `/triage/${c.id}`, { personId: r.felipe.id, text: "Make three onboarding variants, desktop", targets: [r.desktop.id] }, { cookie: win() })).status).toBe(200);
    const sent = await call("POST", `/triage/${c.id}/send`, { personId: r.felipe.id }, { cookie: win() });
    expect(sent.status).toBe(200);
    expect((await sent.json()).directiveId).toBe(r.s.directives()[0].id);
    expect((await call("POST", `/triage/${c.id}/send`, { personId: r.chey.id }, { cookie: win() })).status).toBe(409);
    expect((await call("PATCH", `/triage/${c.id}`, { personId: r.chey.id, text: "late" }, { cookie: win() })).status).toBe(409);
    expect(r.s.directives()).toHaveLength(1);
    expect(r.s.directives()[0].text).toBe("Make three onboarding variants, desktop");
    expect(r.s.board.get(c.id)!.resolvedBy).toBe("Felipe");

    // Context card routes: merge needs a fact id, add saves, unknown cards are 404.
    expect((await call("POST", `/triage/${ctx.id}/merge`, { personId: r.chey.id }, { cookie: win() })).status).toBe(400);
    expect((await call("POST", `/triage/${ctx.id}/add`, { personId: r.chey.id, kind: "bogus" }, { cookie: win() })).status).toBe(400);
    expect((await call("POST", `/triage/${ctx.id}/add`, { personId: r.chey.id, kind: "constraint" }, { cookie: win() })).status).toBe(200);
    expect(r.s.facts()[0]).toMatchObject({ kind: "constraint", text: "Greeting uses the first name" });
    expect((await call("POST", "/triage/tri_nope/dismiss", { personId: r.chey.id }, { cookie: win() })).status).toBe(404);

    // A person on another laptop acts as their own person, whatever the body says; a device with no person is refused.
    const laptop = r.hub.auth.issue({ kind: "browser", label: "Felipe's laptop", ip: "9.9.9.9", personId: r.felipe.id });
    const stray = r.hub.auth.issue({ kind: "browser", label: "A laptop", ip: "9.9.9.9" });
    const next = task(r, "Try a pricing page with three tiers", { targets: [r.desktop.id] });
    expect((await call("POST", `/triage/${next.id}/dismiss`, {}, { ...far, authorization: `Bearer ${stray.token}` })).status).toBe(403);
    expect((await call("POST", `/triage/${next.id}/send`, { personId: r.chey.id }, { ...far, authorization: `Bearer ${laptop.token}` })).status).toBe(200);
    expect(r.s.board.get(next.id)).toMatchObject({ status: "sent", resolvedBy: "Felipe" });

    // The live state: a person's copy carries the cards; an agent's, over HTTP and over the socket, never does.
    expect((await (await call("GET", "/state", undefined, { cookie: win() })).json()).triage.length).toBeGreaterThan(0);
    expect((await (await call("GET", "/state", undefined, { ...far, authorization: `Bearer ${remoteAgent.token}` })).json()).triage).toEqual([]);
    const seen: any[] = [];
    const sock = new WebSocket(`ws://127.0.0.1:${server.port}/ws?device=agent-sock`, { headers: { ...far, authorization: `Bearer ${remoteAgent.token}`, origin: `http://127.0.0.1:${server.port}` } } as any);
    sock.onmessage = (m) => seen.push(JSON.parse(String(m.data)));
    await new Promise((res) => (sock.onopen = res));
    await Bun.sleep(100);
    task(r, "Try a profile page with a big avatar", { targets: [r.desktop.id] });
    r.s.board.rememberNow({ text: "Avatars are round", kind: "fact", by: "Chey" });
    await Bun.sleep(200);
    sock.close();
    expect(seen.find((m) => m.type === "state")?.state.triage).toEqual([]);
    expect(seen.some((m) => m.type === "patch" && m.key === "triage")).toBe(false);
    expect(seen.some((m) => m.type === "patch" && m.key === "facts")).toBe(true);

    // The live state carries the board, and the changelog is readable.
    const state = await (await call("GET", "/state", undefined, { cookie: win() })).json();
    expect(state.triage.some((x: any) => x.status === "sent")).toBe(true);
    r.s.postUpdate(r.mobile.id, "shipped", "Tabs are in");
    expect((await (await call("GET", "/changelog", undefined)).json()).map((e: any) => e.text)).toEqual(["Tabs are in"]);
  } finally {
    server.stop(true);
  }
});

test("curation: new facts wait as cards, a restatement still merges, and retiring or replacing a saved fact is a card too", () => {
  const r = room();
  const a = r.said(r.chey, "the header is option A");
  const old = r.s.board.rememberNow({ text: "Settings header uses option A, the big greeting", kind: "decision", by: "Chey" })!;
  const q = r.s.board.rememberNow({ text: "Is there a dark accent color defined?", kind: "question", by: "Britain" })!;
  const keep = r.s.board.rememberNow({ text: "Sidebar collapses to a 64 px icon rail under 1024 px", kind: "requirement", by: "Chey" })!;
  const b = r.said(r.felipe, "go with option B, compact search");
  const c = r.said(r.chey, "the dark accent is E85A3A, so that's answered");
  const d = r.said(r.chey, "narrow windows get the 64 px icon rail under 1024 px");
  const out = r.hub.brain.applyCuration(
    {
      add: [
        { kind: "decision", text: "Settings header uses option B, the compact search", eventIds: [b.id] },
        { kind: "requirement", text: "Sidebar collapses to a 64 px icon rail under 1024 px.", eventIds: [d.id] },
      ],
      update: [{ id: keep.id, text: "Sidebar collapses to a 64 px icon rail under 1024 px, remembered per window", reason: "more detail", eventIds: [d.id] }],
      resolve: [{ id: q.id, reason: "The dark accent is E85A3A", eventIds: [c.id] }],
      supersede: [{ id: old.id, reason: "Option B replaced it", eventIds: [b.id] }],
    },
    [a, b, c, d],
  );
  // Nothing was taken away, added or rewritten silently: the restatement merged into the accepted fact, and the
  // rewrite with new detail waits as a Replace card for it.
  expect(out.added).toHaveLength(0);
  expect(r.s.store.get("facts", old.id)!.status).toBe("active");
  expect(r.s.store.get("facts", q.id)!.status).toBe("active");
  expect(r.s.store.get("facts", keep.id)!.text).toBe("Sidebar collapses to a 64 px icon rail under 1024 px");
  expect(r.s.store.get("facts", keep.id)!.sourceEventIds).toContain(d.id);
  const cards = r.s.board.open();
  expect(cards).toHaveLength(3);
  expect(structuredClone(cards.find((x) => x.conflictsWith === keep.id))).toMatchObject({ text: expect.stringContaining("remembered per window"), kind: "requirement" });
  const replace = cards.find((x) => !x.retire && x.conflictsWith === old.id)!;
  const retire = cards.find((x) => x.retire)!;
  expect(replace).toMatchObject({ text: "Settings header uses option B, the compact search", conflictsWith: old.id });
  expect(retire).toMatchObject({ retire: "resolved", conflictsWith: q.id });
  expect(r.s.board.add(retire.id, "Chey")).toMatchObject({ ok: false });
  expect(r.s.board.replace(replace.id, "Chey").ok).toBe(true);
  expect(r.s.board.replace(retire.id, "Chey").ok).toBe(true);
  expect(r.s.board.replace(cards.find((x) => x.conflictsWith === keep.id)!.id, "Chey").ok).toBe(true);
  expect(r.s.store.get("facts", old.id)!.status).toBe("superseded");
  expect(r.s.store.get("facts", q.id)!.status).toBe("resolved");
  expect(r.s.facts().filter((f) => f.status === "active").map((f) => f.text).sort()).toEqual(["Settings header uses option B, the compact search", "Sidebar collapses to a 64 px icon rail under 1024 px, remembered per window"]);
});
