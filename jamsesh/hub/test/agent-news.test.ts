import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bus } from "../src/bus";
import { Hub } from "../src/hub";
import { hooksOf } from "./hooks";

const dir = mkdtempSync(join(tmpdir(), "jam-news-"));
const hubs: Hub[] = [];
afterAll(() => {
  for (const h of hubs) h.stop();
  bus.resolver = null; // a flush still pending would read the folder after it's gone
  rmSync(dir, { recursive: true, force: true });
});

function room() {
  const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, String(Math.random())) });
  hubs.push(hub);
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
  ship(s, desktop.id, "Header: spacing fix", "The header title lines up with the sidebar");
  await wait(80);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain("new spacing");
  // Two different things a person sees: two lines in the one look.
  expect(calls[0]).toContain("- ship-1: Jonathan's Claude (desktop, desktop): Header: new spacing\n  What a person sees, in the shipper's words: The header has more room around the title");
  expect(calls[0]).toContain("- ship-2: Jonathan's Claude (desktop, desktop): Header: spacing fix\n  What a person sees, in the shipper's words: The header title lines up with the sidebar");
  expect(calls[0]).toContain("sends a parity check about it, not build work");
  ship(s, desktop.id, "Header: spacing fix again", "The header has more room around the title");
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
  const out = hooksOf(hub).prompt(mobile, { prompt: "hi" });
  expect(JSON.stringify(out)).not.toContain("sidebar");
  s.store.addEvent({ kind: "decision", authorType: "brain", authorName: "Room decision", text: "Go with direction B", relevance: "work", data: {} });
  expect(JSON.stringify(hooksOf(hub).prompt(mobile, { prompt: "hi again" }))).toContain("Go with direction B");
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
  // Questions and blockers go to the brain; a decision waits on the Tasks board for a person.
  expect(calls).toHaveLength(2);
  expect(calls[0]).toContain("blocked");
  const card = s.board.open()[0];
  expect(card).toMatchObject({ type: "context", kind: "decision", text: "Icons from set A", origin: "agent", by: desktop.name });
  expect(card.sources[0].eventId).not.toBeNull();
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
  expect(Object.keys(tools.coordinate_parity.inputSchema.shape).sort()).toEqual(["feature", "platforms", "shipments"]);
  // Same platform only, or a shipper that isn't in the batch: refused, nothing sent.
  expect(await said({ feature: "Sidebar", shipments: ["ship-1"], platforms: ["desktop"] })).toContain("isn't a cross-platform feature");
  expect(await said({ feature: "Sidebar", shipments: ["ship-9"], platforms: ["desktop"] })).toContain("Name the shipments");
  // A shipper who said nothing a person sees: refused.
  const none = (hub.brain as any).parityTools([{ id: "ship-1", agent: desktop, text: "Shipped background sync status telemetry to the metrics collector", seen: "" }]);
  expect(((r: any) => r?.text ?? String(r))(await none.coordinate_parity.execute({ feature: "Sync status badge", shipments: ["ship-1"], platforms: ["mobile"] }))).toContain("didn't say what a person sees");
  expect(s.directives()).toHaveLength(0);
  expect(hub.mcp.inboxText(mobile, false)).toBe("Nothing new.");
  const check = { feature: "Collapsible sidebar navigation", shipments: ["ship-1"], platforms: ["mobile"] };
  await tools.coordinate_parity.execute(check);
  const inbox = hub.mcp.inboxText(mobile, false);
  expect(inbox).toContain("[coordinate]");
  expect(inbox).toContain("Parity check, not a build task: Jonathan's");
  expect(inbox).toContain("(A left sidebar that collapses to icons)"); // the shipper's words, verbatim
  expect(inbox).toContain("Does the mobile app have it, and does it match?");
  expect(inbox).toContain("Build only if you both confirm a gap");
  expect(inbox).toContain("Change code only for a gap you both confirm");
  const shipper = hub.mcp.inboxText(desktop, false);
  expect(shipper).toContain("Parity check, not a build task: you shipped Collapsible sidebar navigation on desktop");
  expect(shipper).toContain("No code changes unless you both confirm a gap");
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
  expect(JSON.stringify(hooksOf(hub).prompt(desktop, { prompt: "next" }))).toContain("Nav goes in a sidebar");
  // The driver acknowledges on its next call, so the decision is seen and not handed over again.
  expect(JSON.stringify(hooksOf(hub).prompt(desktop, { prompt: "again" }))).not.toContain("Nav goes in a sidebar");
});

test("a burst of more relevant decisions than one prompt carries is handed over a page at a time, none skipped", () => {
  const { hub, s, desktop } = room();
  const nav = s.claim(desktop.id, "Navigation").workstream;
  for (let i = 0; i < 25; i++) s.store.addEvent({ kind: "decision", authorType: "brain", authorName: "Room decision", text: `Nav rule ${i}.`, workstreamId: nav.id, relevance: "work", data: {} });
  const handed = (prompt: string) => (JSON.stringify(hooksOf(hub).prompt(desktop, { prompt })).match(/Nav rule \d+\./g) ?? []).map((t) => Number(t.match(/\d+/)![0]));
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
  const send = (seen: string) => (hub.brain as any).parityTools([{ id: "ship-1", agent: desktop, text: "Shipped", seen }]).coordinate_parity.execute({ feature: seen, shipments: ["ship-1"], platforms: ["mobile"] });
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
  const r = await tools.coordinate_parity.execute({ feature: "Sidebar and dark mode", shipments: ["ship-1", "ship-2"], platforms: ["mobile"] });
  expect(r?.text ?? String(r)).toContain("different features");
  const mixed = await tools.coordinate_parity.execute({ feature: "Sidebar", shipments: ["ship-1", "ship-3"], platforms: [] });
  expect(mixed?.text ?? String(mixed)).toContain("different features");
  expect(s.directives()).toHaveLength(0);
  await tools.coordinate_parity.execute({ feature: "Collapsible sidebar", shipments: ["ship-1"], platforms: ["mobile"] });
  await tools.coordinate_parity.execute({ feature: "Dark mode toggle", shipments: ["ship-2"], platforms: ["mobile"] });
  const inbox = hub.mcp.inboxText(mobile, false);
  expect(inbox.match(/\[coordinate\]/g)).toHaveLength(2);
  expect(inbox.split("\n").filter((l) => l.includes("[coordinate]")).every((l) => !(l.includes("sidebar") && l.includes("dark mode")))).toBe(true);
});
