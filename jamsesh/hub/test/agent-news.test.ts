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
  s.postUpdate(desktop.id, "shipped", "Header: new spacing");
  s.postUpdate(desktop.id, "shipped", "Header: spacing fix");
  await wait(80);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain("new spacing");
  expect(calls[0]).toContain("spacing fix");
  expect(calls[0]).toContain("Call no_action only when nothing in it is something a person sees");
  s.postUpdate(desktop.id, "shipped", "Header: spacing fix again");
  await wait(80);
  expect(calls).toHaveLength(1);
  // A different agent still gets its own look.
  s.postUpdate(mobile.id, "shipped", "Tabs: new bar");
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

test("commits, refactors, fixes, tooling and platform-specific ships never reach the brain", async () => {
  const { hub, s, desktop, mobile, calls } = room();
  for (const t of ["Commit 1a2b: tidied the header", "Refactored the nav store", "Fixed the sidebar crash on resize", "Bumped expo to 52", "Shipped a fix for the crash on launch", "Updated CI pipeline and tooling", "Shipped the touch-bar shortcuts, desktop-only on purpose"])
    s.postUpdate(desktop.id, "shipped", t);
  // Marked through jam_update, the real tool path.
  await hub.mcp.call({ agentId: mobile.id, ip: "127.0.0.1", device: "host" }, "jam_update", { kind: "shipped", text: "Shipped haptic feedback on the tab bar", platformSpecific: true });
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
  s.postUpdate(desktop.id, "shipped", "Shipped the collapsible sidebar navigation");
  await wait(80);
  expect(calls).toHaveLength(0);
  void web2;
  void designer;
});

test("the parity tool needs a named cross-platform feature, and its directives are what lands in the inboxes", async () => {
  const { hub, s, desktop, mobile } = room();
  const tools = (hub.brain as any).parityTools([{ agent: desktop, text: "Shipped the collapsible sidebar navigation" }]);
  const said = async (input: object) => ((r: any) => r?.text ?? String(r))(await tools.coordinate_parity.execute(input));
  // Same platform only, or a shipper that isn't in the batch: refused, nothing sent.
  expect(await said({ feature: "Sidebar", shippedBy: [desktop.id], platforms: ["desktop"] })).toContain("isn't a cross-platform feature");
  expect(await said({ feature: "Sidebar", shippedBy: [mobile.id], platforms: ["desktop"] })).toContain("Name the shipping agents");
  expect(hub.mcp.inboxText(mobile, false)).toBe("Nothing new.");
  await tools.coordinate_parity.execute({ feature: "Collapsible sidebar navigation", shippedBy: [desktop.id], platforms: ["mobile"] });
  const inbox = hub.mcp.inboxText(mobile, false);
  expect(inbox).toContain("[coordinate]");
  expect(inbox).toContain("Collapsible sidebar navigation shipped on desktop");
  expect(hub.mcp.inboxText(desktop, false)).toContain("you shipped it on desktop");
  // Asked twice: one open coordinate directive each.
  await tools.coordinate_parity.execute({ feature: "Collapsible sidebar navigation", shippedBy: [desktop.id], platforms: ["mobile"] });
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
  for (let i = 0; i < 250; i++) add(`Checkout rule ${i}`, checkout.id);
  expect(s.roomDecisions(desktop.id, { limit: 10 }).map((e) => e.text)).toEqual(["Nav goes in a sidebar"]);
  // The prompt hook hands it over (and only then marks it seen).
  expect(JSON.stringify(hooksOf(hub).prompt(desktop, { prompt: "next" }))).toContain("Nav goes in a sidebar");
  // The driver acknowledges on its next call, so the decision is seen and not handed over again.
  expect(JSON.stringify(hooksOf(hub).prompt(desktop, { prompt: "again" }))).not.toContain("Nav goes in a sidebar");
});
