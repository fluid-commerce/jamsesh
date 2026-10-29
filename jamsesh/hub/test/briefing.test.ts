import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../src/hub";

const dir = mkdtempSync(join(tmpdir(), "jam-brief-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const tokens = (t: string) => Math.ceil(t.length / 4);

/** A session a few hours in: four people, four agents with repo cards, facts, decisions, directives, chatter. */
function busyRoom() {
  const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, String(Math.random())) });
  const s = hub.session;
  const reg = (ownerName: string, repo: string, platform: "desktop" | "mobile" | "web" | "backend", cwd: string) => s.registerAgent({ ownerName, harness: "claude-code", repo, cwd, machine: cwd, platform, branch: "feature/nav" }).agent;
  const agents = [reg("Jonathan", "acme/desktop", "desktop", "/d"), reg("Chey", "acme/mobile", "mobile", "/m"), reg("Felipe", "acme/web", "web", "/w"), reg("Ana", "acme/api", "backend", "/a")];
  for (const a of agents) {
    s.touchAgent(a.id, { card: { stack: "TypeScript, React 19, Vite, Tailwind, Zustand, Playwright", designSystem: "Tokens in src/theme.ts: 4px spacing grid, Inter 14/20 body, radius 8, brand #3E8BFF, surface #0B0D12, text #E8EAF0. ".repeat(3), components: "Button, Input, Sheet, Tabs, NavBar", branch: "feature/nav", recentChanges: "x".repeat(300), notes: "", updatedAt: Date.now() } });
    s.claim(a.id, `${a.ownerName}'s ${a.platform} navigation`, { quiet: true });
  }
  s.store.setDigest("session", "The room is redesigning navigation across desktop and mobile. ".repeat(40), 0);
  for (let i = 0; i < 14; i++) s.store.put("facts", { id: `f${i}`, ts: Date.now(), updatedAt: Date.now(), kind: "decision", text: `Settled point ${i}: the navigation keeps a persistent bottom bar on mobile and a left rail on desktop, with the same five destinations.`, workstream: i % 2 ? "" : "Jonathan's desktop navigation", by: "Felipe", status: "active", note: "", sourceEventIds: [] });
  for (let i = 0; i < 30; i++) s.store.addEvent({ kind: "decision", authorType: "brain", authorId: null, authorName: "Room brain", text: `Decision ${i}: use the shared tokens for spacing and keep the active tab filled, not outlined, on every platform.`, relevance: "work" });
  for (let i = 0; i < 40; i++) s.store.addEvent({ kind: "speech", authorType: "person", authorId: null, authorName: "Felipe", text: `Thinking out loud about navigation item ${i}, whether the profile belongs in the bar or behind the avatar.`, relevance: "work" });
  for (let i = 0; i < 24; i++) s.postUpdate(agents[i % 4].id, i % 3 ? "progress" : "shipped", `Update ${i}: wired the tab bar to the router and checked focus order with the keyboard on the build.`);
  for (let i = 0; i < 12; i++) s.createDirective({ text: `Make the ${i}th navigation variant and render it next to the current one.`, mode: "explore", targets: [agents[i % 4].id], requestedBy: "Felipe" });
  return { hub, s, agents };
}

test("the join briefing stays short on a busy session", () => {
  const { hub, agents } = busyRoom();
  const out = hub.mcp.briefing(agents[0], false, true, "http://127.0.0.1:4790");
  console.log("briefing tokens", tokens(out), "chars", out.length);
  expect(tokens(out)).toBeLessThan(1500);
  expect(out).toContain("jam_context");
  expect(out).toContain("jam_search");
  expect(out).toContain("jam_artifacts");
  expect(out).toContain("jam_directives");
  expect(out).toContain("Open directives for you");
});

test("a long note to everyone is stored once; the feed and other agents' inboxes carry a pointer", () => {
  const { hub, s, agents } = busyRoom();
  const long = `Design notes for navigation.\n${"The tab bar keeps five destinations and a filled active state. ".repeat(60)}`;
  expect(long.length).toBeGreaterThan(3000);
  s.sendMessage(agents[0].id, "all", long);
  const inbox = hub.mcp.inboxText(agents[1], false);
  expect(inbox.slice(inbox.indexOf("MESSAGE from")).length).toBeLessThan(450);
  const id = inbox.match(/id (doc_\w+)/)![1];
  expect(s.store.all("documents")).toHaveLength(1);
  expect(s.store.get("documents", id)!.text).toBe(long);
  // Fetching it by id returns the whole text.
  return hub.mcp.call({ agentId: agents[1].id, ip: "127.0.0.1", device: null }, "jam_artifacts", { id }).then((r) => {
    expect(r.content[0].type === "text" && r.content[0].text).toContain(long);
  });
});

test("a long update is stored once; short ones and direct messages are left alone", () => {
  const { s, agents } = busyRoom();
  const ev = s.postUpdate(agents[0].id, "progress", "y ".repeat(1000));
  expect(ev.text.length).toBeLessThan(400);
  expect(ev.data.documentId).toMatch(/^doc_/);
  expect(s.postUpdate(agents[0].id, "progress", "Short update").text).toBe("Short update");
  const direct = "z ".repeat(1000);
  expect(s.sendMessage(agents[0].id, agents[1].id, direct).text).toBe(direct);
  expect(s.store.all("documents")).toHaveLength(1);
});
