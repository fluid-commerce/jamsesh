// Offline behaviour: with no model (JAMSESH_OFFLINE=1 semantics) the brain falls back
// to ruleTriage / ruleRoute. Flips config.offline for this file only.
//   cd jamsesh/hub && bun test test/brain.offline.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { config } from "../src/config";
import { printTable, runScenario } from "./bench";

const prev = config.offline;
beforeAll(() => {
  config.offline = true;
});
afterAll(() => {
  config.offline = prev;
  printTable("brain scenarios (offline rules)");
});

describe("offline rule-based brain", () => {
  test("banter is ignored", async () => {
    await runScenario("offline: banter", [1], async (r) => {
      r.say("jonathan", "dude your shirt is hilarious lol");
      await r.settle();
      expect(r.newDirectives()).toHaveLength(0);
    });
  }, 30_000);

  test("sarcastic delete is ignored", async () => {
    await runScenario("offline: sarcasm", [1], async (r) => {
      r.say("jonathan", "yeah let's just delete the whole app lol");
      await r.settle();
      expect(r.newDirectives()).toHaveLength(0);
    });
  }, 30_000);

  test("try is explore", async () => {
    await runScenario("offline: explore", [2], async (r) => {
      r.say("chey", "let's try some variants of the profile screen");
      await r.settle();
      const ds = r.newDirectives();
      expect(ds.length).toBe(1);
      expect(ds[0].mode).toBe("explore");
    });
  }, 30_000);

  test("ship in mobile app is implement on mobile", async () => {
    await runScenario("offline: implement mobile", [2, 3], async (r) => {
      r.say("chey", "let's ship the bottom tabs in the mobile app");
      await r.settle();
      const ds = r.newDirectives();
      expect(ds.length).toBe(1);
      expect(ds[0].mode).toBe("implement");
      expect(ds[0].targets).toEqual([r.agents.mobile.id]);
    });
  }, 30_000);

  test("bring up the nav options", async () => {
    await runScenario("offline: show nav options", [6], async (r) => {
      r.say("felipe", "bring up the nav options");
      await r.settle();
      const st = r.stage();
      expect(["compare", "spotlight"]).toContain(st.mode);
      expect(st.items).toContain(r.art.navA.id);
      expect(st.items).toContain(r.art.navB.id);
    });
  }, 30_000);

  test("show what everyone's doing", async () => {
    await runScenario("offline: show agents", [6], async (r) => {
      r.say("felipe", "show me what everyone is doing");
      await r.settle();
      expect(r.stage().mode).toBe("agents");
    });
  }, 30_000);

  test("decision is recorded", async () => {
    await runScenario("offline: decision", [5], async (r) => {
      r.say("chey", "I like direction B");
      await r.settle();
      expect(r.decisions().length).toBeGreaterThanOrEqual(1);
    });
  }, 30_000);

  test("show me options is presenting, not a request for work", async () => {
    await runScenario("offline: show me options", [6], async (r) => {
      r.say("felipe", "show me the options for the nav");
      await r.settle();
      expect(r.newDirectives()).toHaveLength(0);
      expect(["compare", "spotlight"]).toContain(r.stage().mode);
    });
  }, 30_000);

  test("how to join puts the Join view up without a model", async () => {
    await runScenario("offline: join", [6], async (r) => {
      r.say("jonathan", "wait what's the code again");
      await r.settle();
      expect(r.stage().mode).toBe("join");
    });
  }, 30_000);

  test("a decision has the chosen variant built by its agent", async () => {
    await runScenario("offline: decision builds", [6], async (r) => {
      r.say("felipe", "ok let's go with B");
      await r.settle();
      const ds = r.newDirectives();
      expect(ds.length).toBe(1);
      expect(ds[0].mode).toBe("implement");
      expect(ds[0].text).toContain(r.art.navB.title);
    });
  }, 30_000);
});
