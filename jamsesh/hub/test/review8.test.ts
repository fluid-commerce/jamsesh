// Phase 2, eighth review: product work never becomes a task nobody can receive (the brain's pairing
// and parity tools included), and a replayed prompt is recognised however many prompts came between.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../src/hub";
import { hooksOf } from "./hooks";

const dir = mkdtempSync(join(tmpdir(), "jam-review8-"));
const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, "d") });
afterAll(() => {
  hub.stop();
  rmSync(dir, { recursive: true, force: true });
});
const s = hub.session;
const reg = (owner: string, cwd: string, platform: "desktop" | "mobile" | "web", role?: "observer") =>
  s.registerAgent({ ownerName: owner, harness: "claude-code", repo: role ? "" : `acme${cwd}`, cwd, machine: "m1", platform, chatId: `chat${cwd}`, role }).agent;
const said = (r: any) => (typeof r === "string" ? r : r?.text ?? JSON.stringify(r));

test("observers are never paired into work, and pairing with only one working agent is refused", async () => {
  const worker = reg("Chey", "/r8/w", "desktop");
  const obs = reg("Mo", "/r8/o", "desktop", "observer");
  const tools = (hub.brain as any).tools([], { effects: 0 });
  const before = s.directives().length;
  expect(said(await tools.pair_agents.execute({ agentIds: [worker.id, obs.id], goal: "Match the nav" }))).toContain("observers only watch");
  expect(s.directives()).toHaveLength(before);
});

test("a parity check never names an observer, and no task is made for one", async () => {
  const desktop = reg("Chey", "/r8/d", "desktop");
  const watcher = reg("Rae", "/r8/m", "mobile", "observer");
  const tools = (hub.brain as any).parityTools([{ agent: desktop, text: "Shipped the collapsible sidebar navigation" }]);
  const before = s.directives().length;
  const out = said(await tools.coordinate_parity.execute({ feature: "Sidebar", seen: "collapsible sidebar navigation", shippedBy: [desktop.id], platforms: ["mobile"] }));
  expect(out).toContain("isn't a cross-platform feature");
  expect(s.directives()).toHaveLength(before);
  expect(s.directives().some((d) => d.targets.includes(watcher.id))).toBe(false);
});

test("a directive for observers alone is refused where it's made, and nothing is saved", () => {
  const obs = reg("Jo", "/r8/o2", "web", "observer");
  const before = s.directives().length;
  expect(() => s.createDirective({ text: "Build it", mode: "implement", targets: [obs.id], requestedBy: "Chey" })).toThrow("only watch");
  expect(s.directives()).toHaveLength(before);
  // A note to an observer is fine.
  expect(s.createDirective({ text: "FYI", mode: "note", targets: [obs.id], requestedBy: "Chey" }).targets).toEqual([obs.id]);
});

test("a replayed prompt is recorded once even after hundreds of other prompts, and ids are forgotten only after the replay window", () => {
  const a = reg("Chey", "/r8/p", "web");
  const h = hooksOf(hub);
  const prompts = () => s.store.recentEvents({ kinds: ["prompt"], limit: 2000 }).filter((e) => e.text === "make the header sticky").length;
  h.prompt(a, { prompt: "make the header sticky", jamPromptId: "p-original" });
  for (let i = 0; i < 600; i++) h.prompt(a, { prompt: `other ${i}`, jamPromptId: `p-other-${i}` });
  h.prompt(a, { prompt: "make the header sticky", jamPromptId: "p-original" }); // the outbox replays it
  expect(prompts()).toBe(1);
  // Long after the outbox would have dropped it, the id is let go.
  const old = Date.now() - Hub.PROMPT_ID_MS - 1000;
  s.store.setSetting("promptIdsSeen", [{ id: "p-ancient", at: old }]);
  h.prompt(a, { prompt: "tidy", jamPromptId: "p-new" });
  expect(s.store.setting<{ id: string }[]>("promptIdsSeen", []).map((p) => p.id)).toEqual(["p-new"]);
  expect(Hub.PROMPT_ID_MS).toBeGreaterThan(10 * 60_000);
});
