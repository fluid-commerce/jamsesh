// Work affinity: similar requests go to the agent that already has the context.
//   cd jamsesh/hub && bun test test/brain.affinity.test.ts --timeout 120000
import { afterAll, describe, expect, test } from "bun:test";
import { affinity, oneAgentPerRepo } from "../src/brain/affinity";
import { config } from "../src/config";
import { makeRoom, printTable, runScenario, type Room } from "./bench";

const live = !!config.envGatewayKey && !config.offline;
const t = (live ? test : test.skip) as typeof test;
const T = 120_000;

/** A second agent in Chey's mobile repo (Codex), and some history for each. */
function twoInOneRepo(r: Room) {
  const s = r.hub.session;
  const codex = s.registerAgent({ ownerName: "Chey", harness: "codex", repo: "acme/mobile", platform: "mobile", focus: "Settings screens", machine: "chey-mbp", cwd: "/work/acme/mobile-codex", branch: "settings" }).agent;
  const claude = r.agents.mobile;
  s.claim(claude.id, "Mobile onboarding");
  s.claim(codex.id, "Mobile settings");
  const d1 = s.createDirective({ text: "Make three onboarding carousel variants with progress dots", mode: "explore", targets: [claude.id], requestedBy: "Chey" });
  s.setDirectiveFor(d1.id, claude.id, "done", "Onboarding A, B, C on the canvas");
  s.postUpdate(claude.id, "done", "Onboarding carousel A, B and C are on the canvas: progress dots, skip button, welcome illustration.", { workstream: "Mobile onboarding" });
  const d2 = s.createDirective({ text: "Build the settings header with greeting and search", mode: "implement", targets: [codex.id], requestedBy: "Felipe" });
  s.setDirectiveFor(d2.id, codex.id, "done", "Settings header shipped");
  s.postUpdate(codex.id, "shipped", "Settings header with greeting and search bar shipped in the mobile app.", { workstream: "Mobile settings" });
  return { claude, codex };
}

afterAll(() => printTable("affinity"));

describe("affinity scoring (no gateway)", () => {
  test("a follow-up matches the agent that did the earlier work", () => {
    const r = makeRoom();
    const { claude, codex } = twoInOneRepo(r);
    expect(affinity(r.hub.session, "add an illustration to the onboarding carousel")[0].agent.id).toBe(claude.id);
    expect(affinity(r.hub.session, "the settings search bar needs more padding")[0].agent.id).toBe(codex.id);
    r.stop();
  });

  test("one request never goes to two agents in the same repository", () => {
    const r = makeRoom();
    const { claude, codex } = twoInOneRepo(r);
    const { kept, dropped } = oneAgentPerRepo(r.hub.session, [claude.id, codex.id, r.agents.desktop.id], "tighten the settings header spacing");
    expect(kept).toContain(codex.id);
    expect(kept).not.toContain(claude.id);
    expect(kept).toContain(r.agents.desktop.id);
    expect(dropped.map((a) => a.id)).toEqual([claude.id]);
    r.stop();
  });
});

describe("affinity routing (live)", () => {
  t("onboarding follow-up stays with the onboarding agent", async () => {
    await runScenario("affinity: onboarding follow-up", [3], async (r) => {
      const { claude, codex } = twoInOneRepo(r);
      const seeded = new Set(r.directives().map((d) => d.id));
      const routed = () => r.newDirectives().filter((d) => !seeded.has(d.id));
      r.say("chey", "Can we try a couple more onboarding variants, maybe one with a full-bleed illustration?");
      await r.settle();
      const ds = routed().filter((d) => d.text.toLowerCase().includes("onboarding"));
      expect(ds.length).toBeGreaterThan(0);
      const targets = r.targetsOf(ds);
      expect(targets.has(claude.id)).toBe(true);
      expect(targets.has(codex.id)).toBe(false);
    });
  }, T);

  t("settings tweak goes to the agent that built settings", async () => {
    await runScenario("affinity: settings tweak", [3], async (r) => {
      const { claude, codex } = twoInOneRepo(r);
      const seeded = new Set(r.directives().map((d) => d.id));
      const routed = () => r.newDirectives().filter((d) => !seeded.has(d.id));
      r.say("felipe", "On mobile, the settings search bar feels cramped. Give it more breathing room and ship it.");
      await r.settle();
      const targets = r.targetsOf(routed().filter((d) => d.mode === "implement" || d.mode === "explore"));
      expect(routed().filter((d) => d.mode === "implement")).toHaveLength(1);
      expect(targets.has(codex.id)).toBe(true);
      expect(targets.has(claude.id)).toBe(false);
    });
  }, T);

  t("a request across platforms still reaches one agent per repo", async () => {
    await runScenario("affinity: cross-repo fan-out", [3, 9], async (r) => {
      const { claude, codex } = twoInOneRepo(r);
      const seeded = new Set(r.directives().map((d) => d.id));
      const routed = () => r.newDirectives().filter((d) => !seeded.has(d.id));
      r.say("felipe", "Let's add a dark mode toggle to settings in both the desktop and mobile apps, for real.");
      await r.settle();
      const targets = r.targetsOf(routed());
      expect(targets.has(r.agents.desktop.id)).toBe(true);
      expect(targets.has(codex.id)).toBe(true);
      expect(targets.has(claude.id)).toBe(false);
    });
  }, T);
});
