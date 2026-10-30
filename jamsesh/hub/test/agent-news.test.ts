import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../src/hub";

const dir = mkdtempSync(join(tmpdir(), "jam-news-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function room() {
  const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, String(Math.random())) });
  const s = hub.session;
  const reg = (ownerName: string, repo: string, platform: "desktop" | "mobile", cwd: string) => s.registerAgent({ ownerName, harness: "claude-code", repo, cwd, machine: "m1", platform, branch: "main" }).agent;
  const desktop = reg("Jonathan", "acme/desktop", "desktop", "/d");
  const mobile = reg("Chey", "acme/mobile", "mobile", "/m");
  const calls: string[] = [];
  (hub.brain as any).consider = async (note: string) => void calls.push(note);
  hub.brain.shipWindowMs = 20;
  return { hub, s, desktop, mobile, calls };
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A shipped update the way jam_update makes it, with what a person sees when the shipper says. */
const ship = (s: any, agentId: string, text: string, seen?: string) => s.postUpdate(agentId, "shipped", text, { data: seen ? { seen } : {} });

test("a shipped note is information: readable in jam_context, never in the inbox", () => {
  const { hub, s, desktop, mobile } = room();
  s.postUpdate(desktop.id, "shipped", "Commit abc: tidied the header");
  s.postUpdate(desktop.id, "shipped", "Commit def: tidied the footer");
  expect(hub.mcp.inboxText(mobile, false)).toBe("Nothing new.");
  const ctx = hub.mcp.context(mobile);
  expect(ctx).toContain("## Recently shipped by other agents");
  expect(ctx).toContain("tidied the footer");
  expect(ctx).toContain("+1 earlier on this branch");
  // And not repeated in the general feed of other agents' updates.
  expect(ctx.split("## Other agents, recent")[1]).not.toContain("tidied");
});

test("repeated ships from one agent in a window are considered once, and not again soon after", async () => {
  const { s, desktop, mobile, calls, hub } = room();
  ship(s, desktop.id, "Header: new spacing", "The header has more room around the title");
  ship(s, desktop.id, "Header: title alignment", "The header title lines up with the sidebar");
  await wait(80);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain("new spacing");
  // Two different things a person sees: two lines in the one look.
  expect(calls[0]).toContain("- ship-1: Jonathan's Claude (desktop, desktop): Header: new spacing\n  What a person sees, in the shipper's words: The header has more room around the title");
  expect(calls[0]).toContain("- ship-2: Jonathan's Claude (desktop, desktop): Header: title alignment\n  What a person sees, in the shipper's words: The header title lines up with the sidebar");
  expect(calls[0]).toContain("sends a parity check about it, not build work");
  ship(s, desktop.id, "Header: spacing tweak again", "The header has more room around the title");
  await wait(80);
  expect(calls).toHaveLength(1);
  // A different agent still gets its own look.
  ship(s, mobile.id, "Tabs: new bar", "A new tab bar at the bottom");
  await wait(80);
  expect(calls).toHaveLength(2);
  expect(s.directives()).toHaveLength(0);
  void hub;
});

test("an agent's decision is an update, not pushed to other agents; the brain's is", () => {
  const { hub, s, desktop, mobile } = room();
  const ev = s.postUpdate(desktop.id, "decision", "I'm using a sidebar for desktop nav");
  expect(ev.kind).toBe("update");
  expect(ev.data.updateKind).toBe("decision");
  expect(s.store.recentEvents({ kinds: ["decision"] })).toHaveLength(0);
  const out = hub.onPrompt({ agentId: mobile.id, prompt: "hi" }, "127.0.0.1");
  expect(JSON.stringify(out)).not.toContain("sidebar");
  s.store.addEvent({ kind: "decision", authorType: "brain", authorName: "Room decision", text: "Go with direction B", relevance: "work", data: {} });
  expect(JSON.stringify(hub.onPrompt({ agentId: mobile.id, prompt: "hi again" }, "127.0.0.1"))).toContain("Go with direction B");
  // The brain is asked about the agent's decision.
  expect(hub.mcp.context(mobile)).toContain("sidebar for desktop nav");
});

test("room decisions are filtered to the agent's workstream when it has one", () => {
  const { s, desktop, mobile } = room();
  const nav = s.claim(desktop.id, "Navigation").workstream;
  s.claim(mobile.id, "Checkout");
  const add = (text: string, workstreamId: string | null) => s.store.addEvent({ kind: "decision", authorType: "brain", authorName: "Room decision", text, workstreamId, relevance: "work", data: {} });
  add("Nav goes in a sidebar", nav.id);
  add("Checkout is one page", s.store.all("workstreams").find((w) => w.title === "Checkout")!.id);
  add("Use the brand blue everywhere", null);
  expect(s.roomDecisions(desktop.id, { limit: 10 }).map((e) => e.text)).toEqual(["Nav goes in a sidebar", "Use the brand blue everywhere"]);
  expect(s.roomDecisions(mobile.id, { limit: 10 }).map((e) => e.text)).toEqual(["Checkout is one page", "Use the brand blue everywhere"]);
});

test("an agent can message the brain by name (or alias) and the brain gets an event", () => {
  const { hub, s, desktop } = room();
  const heard: string[] = [];
  (hub.brain as any).agentMessage = (ev: any) => void heard.push(ev.text);
  s.sendMessage(desktop.id, "JamSesh", "Please log the nav pain points");
  s.updateSettings({ brainName: "Astra" });
  s.sendMessage(desktop.id, "astra", "Second note");
  s.store.setSetting("brainAliases", ["Jammy"]);
  s.sendMessage(desktop.id, "Jammy", "Third");
  expect(heard).toContain("Please log the nav pain points");
  expect(heard).toContain("Second note");
  expect(heard).toContain("Third");
  expect(() => s.sendMessage(desktop.id, "Nobody", "x")).toThrow(/No agent named/);
  expect(hub.mcp.roster()).toContain("Room brain");
  expect(hub.mcp.roster()).toContain("Astra");
});

test("question and blocked updates reach the brain", async () => {
  const { s, desktop, calls } = room();
  s.postUpdate(desktop.id, "blocked", "Need the API key");
  s.postUpdate(desktop.id, "question", "Which icon set?");
  s.postUpdate(desktop.id, "decision", "Icons from set A");
  expect(calls).toHaveLength(3);
  expect(calls[0]).toContain("blocked");
  expect(calls[2]).toContain("record_decision");
});

test("note mode: its own hint, no build or canvas warnings", () => {
  const { hub, s, desktop } = room();
  const d = s.createDirective({ text: "Log these pain points in docs/pain.md", mode: "note", targets: [desktop.id], requestedBy: "Chey" });
  const inbox = hub.mcp.inboxText(desktop, false);
  expect(inbox).toContain("[note]");
  expect(inbox).toContain("no dev server");
  expect(inbox).not.toContain("screenshot");
  expect((hub.mcp as any).checkWarning(desktop, "shipped", d.id)).toBe("");
  expect((hub.mcp as any).checkWarning(desktop, "shipped")).toContain("built");
});

test("commits, refactors, fixes, tooling, platform-specific ships and ships with no 'seen' never reach the brain", async () => {
  const { hub, s, desktop, mobile, calls } = room();
  for (const t of ["Commit 1a2b: tidied the header", "Refactored the nav store", "Fixed the sidebar crash on resize", "Bumped expo to 52", "Shipped a fix for the crash on launch", "Updated CI pipeline and tooling", "Shipped the touch-bar shortcuts, desktop-only on purpose"])
    ship(s, desktop.id, t, "Something on screen");
  // Marked through jam_update, the real tool path.
  await hub.mcp.call({ agentId: mobile.id, ip: "127.0.0.1", device: "host" }, "jam_update", { kind: "shipped", text: "Shipped haptic feedback on the tab bar", seen: "The tab bar taps back", platformSpecific: true });
  // Invisible work: the shipper said nothing a person sees, so nothing to check, whatever the text.
  await hub.mcp.call({ agentId: desktop.id, ip: "127.0.0.1", device: "host" }, "jam_update", { kind: "shipped", text: "Shipped background sync status telemetry to the metrics collector" });
  ship(s, desktop.id, "Shipped the collapsible sidebar navigation");
  await wait(80);
  expect(calls).toHaveLength(0);
  expect(hub.mcp.inboxText(mobile, false)).toBe("Nothing new.");
  expect(hub.mcp.inboxText(desktop, false)).toBe("Nothing new.");
});

test("fixes in any wording never become parity checks, even with a 'seen'", async () => {
  const { hub, s, desktop, mobile, calls } = room();
  for (const t of ["Shipped crash fix for sidebar", "Shipped corrected login flow", "Shipped a patch for the settings screen", "Shipped the sidebar crash resolved", "Shipped regression repair for tabs", "Shipped bug fixes in the editor", "Shipped workaround for slow load"])
    ship(s, desktop.id, t, "The sidebar looks different");
  await wait(80);
  expect(calls).toHaveLength(0);
  expect(s.directives()).toHaveLength(0);
  const { parityCandidate } = await import("../src/brain/brain");
  expect(parityCandidate("Shipped the collapsible sidebar navigation")).toBe(true);
  expect(parityCandidate("Shipped a dark mode toggle in settings")).toBe(true);
  void hub;
  void mobile;
});

test("a second inbox read with a parity check pending still asks for the comparison first", () => {
  const { hub, s, desktop, mobile } = room();
  s.createDirective({ text: "Parity check, not a build task: compare the sidebar with desktop.", mode: "coordinate", targets: [mobile.id], counterparts: [desktop.id], requestedBy: "JamSesh", rationale: "Parity" });
  s.createDirective({ text: "Add the footer", mode: "implement", targets: [mobile.id], requestedBy: "Jonathan", rationale: "" });
  hub.mcp.inboxText(mobile); // reads (and marks) them
  const again = hub.mcp.inboxText(mobile);
  expect(again).toContain("compare with the named agents through jam_message first");
  expect(again).not.toContain("don't wait for others to reply first");
  // With only a build task pending the old reminder stands.
  const { hub: h2, s: s2, mobile: m2 } = room();
  s2.createDirective({ text: "Add the footer", mode: "implement", targets: [m2.id], requestedBy: "Jonathan", rationale: "" });
  h2.mcp.inboxText(m2);
  expect(h2.mcp.inboxText(m2)).toContain("don't wait for others to reply first");
});

test("no coordination without an app on another platform in the room", async () => {
  const { s, desktop, mobile, calls } = room();
  s.touchAgent(mobile.id, { status: "offline" });
  const web2 = s.registerAgent({ ownerName: "Ana", harness: "codex", repo: "acme/desktop-2", cwd: "/d2", machine: "m2", platform: "desktop", branch: "main" }).agent;
  const designer = s.registerAgent({ ownerName: "Bo", harness: "codex", repo: "acme/design", cwd: "/x", machine: "m3", platform: "design", branch: "main" }).agent;
  ship(s, desktop.id, "Shipped the collapsible sidebar navigation", "A sidebar that collapses to icons");
  await wait(80);
  expect(calls).toHaveLength(0);
  void web2;
  void designer;
});

test("the parity tool uses the shipper's own 'seen', refuses without one, and its directives are what lands in the inboxes", async () => {
  const { hub, s, desktop, mobile } = room();
  const tools = (hub.brain as any).parityTools([{ id: "ship-1", agent: desktop, text: "Shipped the collapsible sidebar navigation", seen: "A left sidebar that collapses to icons" }]);
  const said = async (input: object) => ((r: any) => r?.text ?? String(r))(await tools.coordinate_parity.execute(input));
  // The brain can't supply what a person sees: the tool has no such input.
  expect(Object.keys(tools.coordinate_parity.inputSchema.shape).sort()).toEqual(["platforms", "shipments"]);
  // Same platform only, or a shipper that isn't in the batch: refused, nothing sent.
  expect(await said({ shipments: ["ship-1"], platforms: ["desktop"] })).toContain("isn't a cross-platform feature");
  expect(await said({ shipments: ["ship-9"], platforms: ["desktop"] })).toContain("Name the shipments");
  // A shipper who said nothing a person sees: refused.
  const none = (hub.brain as any).parityTools([{ id: "ship-1", agent: desktop, text: "Shipped background sync status telemetry to the metrics collector", seen: "" }]);
  expect(((r: any) => r?.text ?? String(r))(await none.coordinate_parity.execute({ shipments: ["ship-1"], platforms: ["mobile"] }))).toContain("didn't say what a person sees");
  expect(s.directives()).toHaveLength(0);
  expect(hub.mcp.inboxText(mobile, false)).toBe("Nothing new.");
  const check = { shipments: ["ship-1"], platforms: ["mobile"] };
  await tools.coordinate_parity.execute(check);
  const inbox = hub.mcp.inboxText(mobile, false);
  expect(inbox).toContain("[coordinate]");
  expect(inbox).toContain("Parity check, not a build task: Jonathan's");
  expect(inbox).toContain("shipped this on desktop: A left sidebar that collapses to icons"); // the shipper's words, verbatim
  expect(inbox).toContain("Does the mobile app have it, and does it match?");
  expect(inbox).toContain("Build only if you both confirm a gap");
  expect(inbox).toContain("Change code only for a gap you both confirm");
  const shipper = hub.mcp.inboxText(desktop, false);
  expect(shipper).toContain("Parity check, not a build task: you shipped this on desktop: A left sidebar that collapses to icons");
  expect(shipper).toContain("No code changes unless you both confirm a gap");
  // The brain's own name for the feature never reaches a directive.
  expect(hub.mcp.inboxText(mobile, false)).not.toContain("Collapsible sidebar navigation");
  // Asked twice: one check each.
  await tools.coordinate_parity.execute(check);
  expect(s.directives()).toHaveLength(2);
  // The pass gets only this tool and no_action, never pair_agents or create_directive.
  expect(Object.keys(tools).sort()).toEqual(["coordinate_parity", "no_action"]);
});

test("other workstreams' decisions can't crowd out an older relevant one, or move the seen mark past it", () => {
  const { hub, s, desktop, mobile } = room();
  const nav = s.claim(desktop.id, "Navigation").workstream;
  s.claim(mobile.id, "Checkout");
  const checkout = s.store.all("workstreams").find((w) => w.title === "Checkout")!;
  const add = (text: string, workstreamId: string | null) => s.store.addEvent({ kind: "decision", authorType: "brain", authorName: "Room decision", text, workstreamId, relevance: "work", data: {} });
  add("Nav goes in a sidebar", nav.id);
  for (let i = 0; i < 2_100; i++) add(`Checkout rule ${i}`, checkout.id); // more than 20 pages of 100
  expect(s.roomDecisions(desktop.id, { limit: 10 }).map((e) => e.text)).toEqual(["Nav goes in a sidebar"]);
  // The prompt hook hands it over (and only then marks it seen).
  expect(JSON.stringify(hub.onPrompt({ agentId: desktop.id, prompt: "next" }, "127.0.0.1"))).toContain("Nav goes in a sidebar");
  expect(JSON.stringify(hub.onPrompt({ agentId: desktop.id, prompt: "again" }, "127.0.0.1"))).not.toContain("Nav goes in a sidebar");
});

test("a burst of more relevant decisions than one prompt carries is handed over a page at a time, none skipped", () => {
  const { hub, s, desktop } = room();
  const nav = s.claim(desktop.id, "Navigation").workstream;
  for (let i = 0; i < 25; i++) s.store.addEvent({ kind: "decision", authorType: "brain", authorName: "Room decision", text: `Nav rule ${i}.`, workstreamId: nav.id, relevance: "work", data: {} });
  const handed = (prompt: string) => (JSON.stringify(hub.onPrompt({ agentId: desktop.id, prompt }, "127.0.0.1")).match(/Nav rule \d+\./g) ?? []).map((t) => Number(t.match(/\d+/)![0]));
  const all = [...handed("one"), ...handed("two"), ...handed("three"), ...handed("four")];
  expect(all).toEqual(Array.from({ length: 25 }, (_, i) => i));
});

test("two different features from one agent each get their look; the same feature again doesn't", async () => {
  const { s, desktop, calls } = room();
  ship(s, desktop.id, "Shipped the collapsible sidebar navigation", "A sidebar that collapses to icons");
  await wait(60);
  ship(s, desktop.id, "Shipped a dark mode toggle in settings", "A dark mode toggle in settings");
  await wait(60);
  ship(s, desktop.id, "Shipped the collapsible sidebar navigation, now animated", "A sidebar that collapses to icons");
  await wait(60);
  expect(calls).toHaveLength(2);
  expect(calls[1]).toContain("dark mode toggle");
});

test("parity checks are deduplicated by feature and agent, and a short feature doesn't swallow a longer, different one", async () => {
  const { hub, s, desktop, mobile } = room();
  const send = (seen: string) => (hub.brain as any).parityTools([{ id: "ship-1", agent: desktop, text: "Shipped", seen }]).coordinate_parity.execute({ shipments: ["ship-1"], platforms: ["mobile"] });
  await send("A sidebar that collapses to icons");
  await send("A sidebar that collapses to icons");
  await send("A dark mode toggle in settings");
  // Contained in a longer, different feature: still its own check.
  await send("A dark mode toggle in settings, with a schedule picker and per-screen overrides for the sidebar");
  expect(s.directives().filter((d) => d.targets.includes(mobile.id))).toHaveLength(3);
  expect(s.directives().filter((d) => d.targets.includes(desktop.id))).toHaveLength(3);
});

test("feature identity matches both ways", async () => {
  const { sameFeature } = await import("../src/brain/brain");
  expect(sameFeature("A sidebar that collapses to icons", "the sidebar collapses to icons")).toBe(true);
  expect(sameFeature("dark mode toggle", "dark mode toggle with a schedule picker and per-screen overrides")).toBe(false);
  expect(sameFeature("dark mode toggle", "sidebar")).toBe(false);
});

test("two different features shipped in one window stay separate: two looks' worth of lines, never one check for both", async () => {
  const { hub, s, desktop, mobile, calls } = room();
  ship(s, desktop.id, "Shipped the collapsible sidebar navigation", "A sidebar that collapses to icons");
  ship(s, desktop.id, "Shipped a dark mode toggle in settings", "A dark mode toggle in settings");
  ship(s, desktop.id, "Sidebar: animated the collapse", "A sidebar that collapses to icons, animated");
  await wait(80);
  expect(calls).toHaveLength(1);
  // One line per feature: the sidebar notes merged, the toggle on its own.
  expect(calls[0]).toContain("- ship-1: ");
  expect(calls[0]).toContain("Then: Sidebar: animated the collapse");
  expect(calls[0]).toContain("- ship-2: ");
  expect(calls[0]).toContain("What a person sees, in the shipper's words: A dark mode toggle in settings");
  // The tool refuses both features in one check; one per feature goes through.
  const batch = [
    { id: "ship-1", agent: desktop, text: "Shipped the collapsible sidebar navigation", seen: "A sidebar that collapses to icons" },
    { id: "ship-2", agent: desktop, text: "Shipped a dark mode toggle in settings", seen: "A dark mode toggle in settings" },
    { id: "ship-3", agent: mobile, text: "Shipped a profile photo picker", seen: "A profile photo picker on the account screen" },
  ];
  const tools = (hub.brain as any).parityTools(batch);
  const r = await tools.coordinate_parity.execute({ shipments: ["ship-1", "ship-2"], platforms: ["mobile"] });
  expect(r?.text ?? String(r)).toContain("different features");
  const mixed = await tools.coordinate_parity.execute({ shipments: ["ship-1", "ship-3"], platforms: [] });
  expect(mixed?.text ?? String(mixed)).toContain("different features");
  expect(s.directives()).toHaveLength(0);
  await tools.coordinate_parity.execute({ shipments: ["ship-1"], platforms: ["mobile"] });
  await tools.coordinate_parity.execute({ shipments: ["ship-2"], platforms: ["mobile"] });
  const inbox = hub.mcp.inboxText(mobile, false);
  expect(inbox.match(/\[coordinate\]/g)).toHaveLength(2);
  expect(inbox.split("\n").filter((l) => l.includes("[coordinate]")).every((l) => !(l.includes("sidebar") && l.includes("dark mode")))).toBe(true);
});

test("a coordinate directive stays open on jam_update and closes only after a reply from the named counterpart on that directive", async () => {
  const { hub, s, desktop, mobile } = room();
  const ctx = (a: any) => ({ agentId: a.id, ip: "127.0.0.1", device: "host" });
  const call = (a: any, tool: string, args: object) => hub.mcp.call(ctx(a), tool, args);
  const other = s.registerAgent({ ownerName: "Ana", harness: "codex", repo: "acme/web", cwd: "/w", machine: "m2", platform: "web", branch: "main" }).agent;
  const d = s.createDirective({ text: "Parity check, not a build task: compare the sidebar with desktop.", mode: "coordinate", targets: [mobile.id], counterparts: [desktop.id], requestedBy: "JamSesh", rationale: "Parity" });
  const state = () => s.store.get("directives", d.id)!.progress[mobile.id];
  const refused = (p: Promise<unknown>) => p.then(() => "accepted", (e: Error) => e.message);
  const done = () => refused(call(mobile, "jam_ack", { directiveId: d.id, status: "done", result: "same" }));
  // Reporting done or shipped against it posts the update but never closes it.
  for (const kind of ["done", "shipped"]) {
    const r: any = await call(mobile, "jam_update", { kind, text: "Our sidebar matches", directiveId: d.id, seen: "A sidebar" });
    expect(JSON.stringify(r)).toContain("stays open");
    expect(state()).not.toBe("done");
  }
  expect(await done()).toContain("send them what you found");
  // Only the target can ack it, or report on it.
  expect(await refused(call(desktop, "jam_ack", { directiveId: d.id, status: "done" }))).toContain("isn't addressed to you");
  expect(await refused(call(desktop, "jam_update", { kind: "done", text: "x", directiveId: d.id }))).toContain("isn't addressed to you");
  // A message with no directive id, or to someone who isn't the counterpart, is not the exchange.
  s.sendMessage(mobile.id, desktop.id, "no id on this one");
  s.sendMessage(mobile.id, other.id, "about the directive", { directiveId: d.id });
  expect(await done()).toContain("send them what you found");
  await call(mobile, "jam_message", { to: desktop.name, text: "Mobile has the sidebar, collapsed to a bar", directiveId: d.id });
  expect(await done()).toContain("wait for their reply");
  // Chatter from others, the brain, or without the id isn't their reply.
  s.sendMessage(other.id, mobile.id, "I think it matches", { directiveId: d.id });
  s.store.addEvent({ kind: "message", authorType: "brain", authorId: null, authorName: "JamSesh", text: "ok?", relevance: "work", data: { to: mobile.id, directiveId: d.id } });
  s.store.addEvent({ kind: "message", authorType: "agent", authorId: desktop.id, authorName: desktop.name, text: "untagged", relevance: "work", data: { to: mobile.id } });
  expect(await done()).toContain("wait for their reply");
  expect(hub.mcp.inboxText(desktop, false)).toContain(`reply with directiveId ${d.id}`);
  // Flood of unrelated traffic after: no window can push the exchange out.
  for (let i = 0; i < 450; i++) s.sendMessage(other.id, "all", `noise ${i}`);
  // The counterpart replies on the directive (its inbox told it to).
  await call(desktop, "jam_message", { to: mobile.name, text: "Agreed, same on ours", directiveId: d.id });
  await call(mobile, "jam_ack", { directiveId: d.id, status: "done", result: "same" });
  expect(state()).toBe("done");
  // Terminal and idempotent: a late ack or update doesn't reopen it, change its result or add an event.
  const result = s.store.get("directives", d.id)!.result;
  await call(mobile, "jam_ack", { directiveId: d.id, status: "acked" });
  await call(mobile, "jam_ack", { directiveId: d.id, status: "done", result: "again" });
  expect(state()).toBe("done");
  expect(s.store.get("directives", d.id)!.status).toBe("done");
  expect(s.store.get("directives", d.id)!.result).toBe(result);
});

test("an inline jam_ask answered with the directive id counts as the exchange", async () => {
  const { hub, s, desktop, mobile } = room();
  const ctx = (a: any) => ({ agentId: a.id, ip: "127.0.0.1", device: "host" });
  const d = s.createDirective({ text: "Parity check: compare.", mode: "coordinate", targets: [mobile.id], counterparts: [desktop.id], requestedBy: "JamSesh", rationale: "" });
  const asking = hub.mcp.call(ctx(mobile), "jam_ask", { to: desktop.name, question: "Do you have the sidebar?", directiveId: d.id, waitSeconds: 5 });
  await wait(30);
  const q = s.store.recentEvents({ kinds: ["message"], limit: 5 }).find((e) => e.data.askId)!;
  await hub.mcp.call(ctx(desktop), "jam_answer", { askId: q.data.askId, text: "Yes, same", directiveId: d.id });
  expect(JSON.stringify(await asking)).toContain("Yes, same");
  await hub.mcp.call(ctx(mobile), "jam_ack", { directiveId: d.id, status: "done", result: "same" });
  expect(s.store.get("directives", d.id)!.progress[mobile.id]).toBe("done");
});

test("a coordinate directive can always be dropped, and other modes close on jam_update as before", async () => {
  const { hub, s, desktop, mobile } = room();
  const ctx = { agentId: mobile.id, ip: "127.0.0.1", device: "host" };
  const c = s.createDirective({ text: "Parity check: compare.", mode: "coordinate", targets: [mobile.id], counterparts: [desktop.id], requestedBy: "JamSesh", rationale: "" });
  await hub.mcp.call(ctx, "jam_ack", { directiveId: c.id, status: "cancelled", result: "nobody answers" });
  expect(s.store.get("directives", c.id)!.status).toBe("cancelled");
  const i = s.createDirective({ text: "Add the footer", mode: "implement", targets: [mobile.id], requestedBy: "Jonathan", rationale: "" });
  await hub.mcp.call(ctx, "jam_update", { kind: "done", text: "Footer added", directiveId: i.id });
  expect(s.store.get("directives", i.id)!.status).toBe("done");
});

test("unread messages are found by recipient, however much other traffic came after", () => {
  const { hub, s, desktop, mobile } = room();
  const other = s.registerAgent({ ownerName: "Ana", harness: "codex", repo: "acme/web", cwd: "/w", machine: "m2", platform: "web", branch: "main" }).agent;
  s.sendMessage(desktop.id, mobile.id, "the one that matters");
  for (let i = 0; i < 120; i++) s.sendMessage(other.id, desktop.id, `unrelated ${i}`);
  const inbox = hub.mcp.inboxText(mobile);
  expect(inbox).toContain("the one that matters");
  expect(inbox).not.toContain("unrelated");
  // More than a page for one agent: the oldest page first, the rest on the next read, none lost.
  for (let i = 0; i < 70; i++) s.sendMessage(desktop.id, mobile.id, `note ${i}`);
  const first = hub.mcp.inboxText(mobile);
  expect(first).toContain("note 0");
  expect(first).not.toContain("note 69");
  expect(hub.mcp.inboxText(mobile)).toContain("note 69");
});

test("only the agent a question was asked of can answer it, and an old ask is still found", async () => {
  const { hub, s, desktop, mobile } = room();
  const other = s.registerAgent({ ownerName: "Ana", harness: "codex", repo: "acme/web", cwd: "/w", machine: "m2", platform: "web", branch: "main" }).agent;
  const { askId } = s.ask(mobile.id, desktop.id, "Which spacing?", 50);
  for (let i = 0; i < 450; i++) s.sendMessage(other.id, "all", `noise ${i}`); // far past any recent window
  expect(() => s.answer(other.id, askId, "I'll take that")).toThrow("wasn't asked of you");
  expect(() => s.answer(mobile.id, askId, "talking to myself")).toThrow("wasn't asked of you");
  s.answer(desktop.id, askId, "8px");
  expect(() => s.answer(desktop.id, askId, "again")).toThrow("already answered");
  expect(() => s.answer(desktop.id, "ask_nope", "x")).toThrow("No question");
  void hub;
});

test("the exchange must be with one named counterpart in both directions, and only an explicit directiveId links a message", async () => {
  const { hub, s, desktop, mobile } = room();
  const web = s.registerAgent({ ownerName: "Ana", harness: "codex", repo: "acme/web", cwd: "/w", machine: "m2", platform: "web", branch: "main" }).agent;
  const ctx = { agentId: mobile.id, ip: "127.0.0.1", device: "host" };
  const refused = (p: Promise<unknown>) => p.then(() => "accepted", (e: Error) => e.message);
  const d = s.createDirective({ text: "Parity check", mode: "coordinate", targets: [mobile.id], counterparts: [desktop.id, web.id], requestedBy: "JamSesh", rationale: "" });
  const done = () => refused(hub.mcp.call(ctx, "jam_ack", { directiveId: d.id, status: "done", result: "x" }));
  // Sent to desktop, answered by web: different counterparts don't add up to an exchange.
  s.sendMessage(mobile.id, desktop.id, "to desktop", { directiveId: d.id });
  s.sendMessage(web.id, mobile.id, "from web", { directiveId: d.id });
  expect(await done()).toContain("wait for their reply");
  // A reply without the id is not part of it, however it follows: nothing is inherited.
  s.sendMessage(desktop.id, mobile.id, "plain reply, no id");
  expect(s.store.recentEvents({ kinds: ["message"], limit: 1 })[0].data.directiveId).toBeUndefined();
  s.sendMessage(mobile.id, desktop.id, "and a plain answer");
  expect(s.store.recentEvents({ kinds: ["message"], limit: 1 })[0].data.directiveId).toBeUndefined();
  expect(await done()).toContain("wait for their reply");
  s.sendMessage(desktop.id, mobile.id, "from desktop", { directiveId: d.id });
  expect(await done()).toBe("accepted");
});

test("an answer counts only when jam_answer carries the directiveId, and the inbox tells the asked agent to pass it", async () => {
  const { hub, s, desktop, mobile } = room();
  const d = s.createDirective({ text: "Parity check", mode: "coordinate", targets: [mobile.id], counterparts: [desktop.id], requestedBy: "JamSesh", rationale: "" });
  const gap = () => s.exchangeGap(s.store.get("directives", d.id)!, mobile.id);
  const q1 = s.ask(mobile.id, desktop.id, "Do you have it?", 5000);
  const askId = s.store.recentEvents({ kinds: ["message"], limit: 1 })[0].data.askId;
  s.answer(desktop.id, askId, "yes"); // no id: not part of the exchange
  await q1.answer;
  expect(gap()).not.toBeNull();
  const q2 = s.ask(mobile.id, desktop.id, "And the footer?", 5000, { directiveId: d.id });
  const ask2 = s.store.recentEvents({ kinds: ["message"], limit: 1 })[0].data.askId;
  expect(hub.mcp.inboxText(desktop, false)).toContain(`directiveId ${d.id}`);
  await hub.mcp.call({ agentId: desktop.id, ip: "127.0.0.1", device: "host" }, "jam_answer", { askId: ask2, text: "yes", directiveId: d.id });
  await q2.answer;
  expect(gap()).toBeNull();
});

test("a coordinate directive must name a counterpart in the room, however it is made", async () => {
  const { hub, s, desktop, mobile } = room();
  const make = (counterparts?: string[], targets = [mobile.id]) => () => s.createDirective({ text: "Parity check", mode: "coordinate", targets, ...(counterparts ? { counterparts } : {}), requestedBy: "JamSesh", rationale: "" });
  // The session refuses one with nobody, only the target itself, or only agents that aren't here.
  for (const c of [undefined, [], [mobile.id], ["a_gone"]]) expect(make(c)).toThrow("has to name the agent(s) to compare with");
  // Two targets compare with each other, but each needs someone other than itself.
  expect(make([mobile.id], [mobile.id, desktop.id])).toThrow("has to name");
  expect(s.directives()).toHaveLength(0);
  // Only agents in the room are kept, once each.
  const d = make([desktop.id, desktop.id, "a_gone"])();
  expect(d.counterparts).toEqual([desktop.id]);
  expect(hub.mcp.inboxText(mobile)).toContain(`compare with: ${desktop.name}`);
  // The brain's generic tool: one target and no counterparts is refused; given counterparts or two targets, it goes.
  const tools: any = hub.brain.tools([], { effects: 0 });
  const create = (i: object) => tools.create_directive.execute({ mode: "coordinate", text: "Compare the onboarding flows", rationale: "parity", ...i }, { toolCallId: "t", messages: [] });
  const refused = await create({ targets: [mobile.id] });
  expect(String(refused?.text ?? refused)).toContain("needs another agent to compare with");
  expect(String(await create({ targets: [mobile.id], counterparts: ["a_gone"] }))).toContain("needs another agent");
  expect(s.directives()).toHaveLength(1);
  await create({ targets: [mobile.id], counterparts: [desktop.id], text: "Compare the settings screens" });
  expect(s.directives()[0].counterparts).toEqual([mobile.id, desktop.id]);
  await create({ targets: [mobile.id, desktop.id], text: "Compare the empty states" });
  expect(s.directives()[0].counterparts?.slice().sort()).toEqual([desktop.id, mobile.id].sort());
});

test("an older coordinate directive that names nobody can't be completed by talking to anyone, only dropped", async () => {
  const { hub, s, desktop, mobile } = room();
  const ctx = (a: any) => ({ agentId: a.id, ip: "127.0.0.1", device: "host" });
  // Stored before counterparts were required: nothing is inferred from who it talked to.
  const d = { ...s.createDirective({ text: "Parity check", mode: "coordinate", targets: [mobile.id], counterparts: [desktop.id], requestedBy: "JamSesh", rationale: "" }) };
  delete (d as any).counterparts;
  s.store.put("directives", d);
  await hub.mcp.call(ctx(mobile), "jam_message", { to: desktop.name, text: "Ours has it", directiveId: d.id });
  await hub.mcp.call(ctx(desktop), "jam_message", { to: mobile.name, text: "Ours too", directiveId: d.id });
  expect(s.exchangeGap(s.store.get("directives", d.id)!, mobile.id)).toContain("names nobody to compare with");
  await expect(hub.mcp.call(ctx(mobile), "jam_ack", { directiveId: d.id, status: "done", result: "same" })).rejects.toThrow("names nobody");
  await hub.mcp.call(ctx(mobile), "jam_ack", { directiveId: d.id, status: "cancelled", result: "no counterpart" });
  expect(s.store.get("directives", d.id)!.status).toBe("cancelled");
});
