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
  expect(calls[0]).toContain("call no_action");
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
