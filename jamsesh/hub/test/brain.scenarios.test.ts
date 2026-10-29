// Live scenario bench for the room brain (needs the gateway key in ~/.jamsesh/.env).
//   cd jamsesh/hub && bun test test/brain.scenarios.test.ts --timeout 120000
// Behaviours: 1 ignore banter, 2 explore vs implement, 3 routing, 4 role weights,
// 5 decision -> implement + spotlight, 6 show_on_screen, 7 no re-route of own prompts,
// 8 answer agent questions, 9 cross-platform parity, 10 no duplicate directives.
import { afterAll, describe, expect, test } from "bun:test";
import { config } from "../src/config";
import { printTable, runScenario, sleep } from "./bench";

const live = !!config.envGatewayKey && !config.offline;
const t = (live ? test : test.skip) as typeof test;
const T = 120_000;

afterAll(() => printTable("brain scenarios (live)"));

describe("1. banter and non-requests", () => {
  t("plain banter", async () => {
    await runScenario("banter: shirt joke", [1], async (r) => {
      r.say("jonathan", "dude your shirt is hilarious, did you get that at a gas station lol");
      r.say("chey", "haha shut up, it's vintage");
      await r.settle();
      expect(r.newDirectives()).toHaveLength(0);
      expect(r.decisions()).toHaveLength(0);
    });
  }, T);

  t("sarcasm that sounds like a command", async () => {
    await runScenario("sarcasm: delete the app", [1], async (r) => {
      r.say("jonathan", "yeah let's just delete the whole app lol");
      await r.settle();
      expect(r.newDirectives()).toHaveLength(0);
    });
  }, T);

  t("sarcasm 2", async () => {
    await runScenario("sarcasm: rewrite in rust", [1], async (r) => {
      r.say("chey", "oh sure, let's rewrite the whole thing in Rust, that'll go great");
      r.say("felipe", "ha, definitely, ship it by Friday");
      await r.settle();
      expect(r.newDirectives()).toHaveLength(0);
    });
  }, T);

  t("musing without an ask", async () => {
    await runScenario("musing: no ask", [1], async (r) => {
      r.say("chey", "I wonder if the navigation would feel better with the tabs at the bottom, hm, not sure");
      await r.settle();
      expect(r.newDirectives()).toHaveLength(0);
    });
  }, T);

  t("directive addressed to a human", async () => {
    await runScenario("human ask: lunch", [1], async (r) => {
      r.say("jonathan", "Felipe can you grab lunch for everyone, I'm starving");
      await r.settle();
      expect(r.newDirectives()).toHaveLength(0);
    });
  }, T);

  t("introduction creates a person", async () => {
    await runScenario("introduction: new person", [1], async (r) => {
      r.say("chey", "this is Dana, she runs customer support, she's just listening in");
      r.say("chey", "okay, back to it");
      await r.settle();
      expect(r.newDirectives()).toHaveLength(0);
      expect(r.hub.session.people().some((p) => p.name === "Dana")).toBe(true);
    });
  }, T);
});

describe("2. explore vs implement", () => {
  t("what-if is explore", async () => {
    await runScenario("explore: what if onboarding", [2], async (r) => {
      r.say("chey", "what if we tried three different onboarding flows for the mobile app, show me some options");
      await r.settle();
      const ds = r.newDirectives();
      expect(ds.length).toBeGreaterThanOrEqual(1);
      expect(ds.every((d) => d.mode === "explore")).toBe(true);
    });
  }, T);

  t("messy ASR explore", async () => {
    await runScenario("explore: messy ASR", [2], async (r) => {
      r.say("chey", "uh so lets like um try a cupple of uh settings screens, with the toggles on top, for the mobile app");
      await r.settle();
      const ds = r.newDirectives();
      expect(ds.length).toBeGreaterThanOrEqual(1);
      expect(ds.every((d) => d.mode === "explore")).toBe(true);
    });
  }, T);

  t("ship it is implement", async () => {
    await runScenario("implement: ship the sidebar", [2, 3], async (r) => {
      r.say("jonathan", "let's ship the sidebar nav in the desktop app, for real");
      await r.settle();
      const ds = r.newDirectives();
      expect(ds.some((d) => d.mode === "implement")).toBe(true);
      expect(ds.every((d) => d.mode !== "explore")).toBe(true);
      expect(r.targetsOf(ds).has(r.agents.desktop.id)).toBe(true);
      expect(r.targetsOf(ds).has(r.agents.mobile.id)).toBe(false);
    });
  }, T);

  t("messy ASR implement", async () => {
    await runScenario("implement: messy ASR 'bee'", [2, 3], async (r) => {
      r.say("jonathan", "okay ship bee in the desk top app, like for real in the code");
      await r.settle();
      const ds = r.newDirectives();
      expect(ds.some((d) => d.mode === "implement")).toBe(true);
      expect(r.targetsOf(ds).has(r.agents.desktop.id)).toBe(true);
      expect(ds.map((d) => d.text).join(" ")).toMatch(/sidebar/i);
    });
  }, T);
});

describe("3. routing by platform and person", () => {
  t("mobile only", async () => {
    await runScenario("route: mobile app", [3], async (r) => {
      r.say("britain", "build the bottom tabs for real in the mobile app please");
      await r.settle();
      const ds = r.newDirectives();
      expect(ds.some((d) => d.mode === "implement")).toBe(true);
      expect(r.targetsOf(ds).has(r.agents.mobile.id)).toBe(true);
      expect(r.targetsOf(ds).has(r.agents.desktop.id)).toBe(false);
    });
  }, T);

  t("my agent", async () => {
    await runScenario("route: 'my agent'", [3], async (r) => {
      r.say("chey", "my agent should add haptic feedback to the tab bar taps, go ahead and build it");
      await r.settle();
      const ds = r.newDirectives();
      expect(ds.length).toBeGreaterThanOrEqual(1);
      expect([...r.targetsOf(ds)]).toEqual([r.agents.mobile.id]);
    });
  }, T);

  t("someone else's agent by name", async () => {
    await runScenario("route: \"Jonathan's\" agent", [3], async (r) => {
      r.say("felipe", "Jonathan's agent, please fix the sidebar collapse bug in the app");
      await r.settle();
      const ds = r.newDirectives();
      expect(ds.length).toBeGreaterThanOrEqual(1);
      expect(r.targetsOf(ds).has(r.agents.desktop.id)).toBe(true);
      expect(r.targetsOf(ds).has(r.agents.mobile.id)).toBe(false);
    });
  }, T);

  t("platform-specific by description", async () => {
    await runScenario("route: dark mode on desktop", [3], async (r) => {
      r.say("britain", "the desktop app needs a dark mode toggle in settings, let's build it");
      await r.settle();
      const ds = r.newDirectives();
      expect(r.targetsOf(ds).has(r.agents.desktop.id)).toBe(true);
      expect(r.targetsOf(ds).has(r.agents.mobile.id)).toBe(false);
    });
  }, T);
});

describe("4. role weights", () => {
  t("CPO overrules designer", async () => {
    await runScenario("roles: CPO beats designer", [4], async (r) => {
      r.say("chey", "I want the tabs on the bottom, let's build the bottom tabs in the mobile app");
      await sleep(300);
      r.say("felipe", "no, I'm making the call, go with the sidebar and build that in the mobile app");
      await r.settle();
      const ds = r.newDirectives();
      expect(ds.length).toBeGreaterThanOrEqual(1);
      expect(ds.some((d) => /sidebar/i.test(d.text))).toBe(true);
      expect(ds.some((d) => /felipe/i.test(d.rationale + d.text))).toBe(true);
      // nothing tells an agent to build bottom tabs without the sidebar
      expect(ds.filter((d) => d.mode === "implement").every((d) => /sidebar/i.test(d.text))).toBe(true);
    });
  }, T);

  t("CPO overrules, across batches", async () => {
    await runScenario("roles: overrule after first routed", [4], async (r) => {
      r.say("chey", "let's build the bottom tabs in the mobile app");
      await r.settle();
      expect(r.newDirectives().length).toBeGreaterThanOrEqual(1);
      r.say("felipe", "actually no, drop the tabs, the sidebar is what we're doing in mobile");
      await r.settle();
      // The overruled proposal is dismissed from the Tasks board and the sidebar one waits in its place.
      const ds = r.newDirectives();
      expect(ds.length).toBeGreaterThanOrEqual(1);
      expect(ds.some((d) => /tabs/i.test(d.text) && !/sidebar/i.test(d.text))).toBe(false);
      const last = ds.find((d) => /sidebar/i.test(d.text))!;
      expect(last).toBeTruthy();
      expect(last.rationale + last.text).toMatch(/felipe/i);
    });
  }, T);
});

describe("5. decisions", () => {
  t("I like direction B", async () => {
    await runScenario("decision: 'I like direction B'", [5], async (r) => {
      r.stageNav();
      r.say("chey", "I like direction B, the sidebar one");
      await r.settle();
      expect(r.decisions().length).toBeGreaterThanOrEqual(1);
      const ds = r.newDirectives();
      expect(ds.some((d) => d.mode === "implement")).toBe(true);
      const st = r.stage();
      expect(st.mode).toBe("spotlight");
      expect(st.items).toContain(r.art.navB.id);
      expect(st.items).not.toContain(r.art.navA.id);
    });
  }, T);

  t("'that one' means what's on screen", async () => {
    await runScenario("decision: 'that one' on screen", [5, 6], async (r) => {
      r.hub.session.setStage({ mode: "spotlight", title: r.art.navB.title, items: [r.art.navB.id], pinned: false }, "Room brain");
      r.say("jonathan", "yeah that one, I like it, let's build that in the desktop app");
      await r.settle();
      const ds = r.newDirectives();
      expect(ds.some((d) => d.mode === "implement")).toBe(true);
      expect(ds.map((d) => d.text).join(" ")).toMatch(/sidebar/i);
      expect(r.targetsOf(ds).has(r.agents.desktop.id)).toBe(true);
    });
  }, T);

  t("decision from a CPO", async () => {
    await runScenario("decision: CPO 'ship B'", [4, 5], async (r) => {
      r.say("felipe", "ok we're going with B for the navigation, ship it");
      await r.settle();
      expect(r.decisions().length).toBeGreaterThanOrEqual(1);
      const ds = r.newDirectives();
      expect(ds.some((d) => d.mode === "implement")).toBe(true);
      expect(ds.map((d) => d.text).join(" ")).toMatch(/sidebar/i);
    });
  }, T);
});

describe("6. show on screen", () => {
  t("bring up the nav options", async () => {
    await runScenario("screen: nav options", [6], async (r) => {
      r.say("felipe", "can you bring up the nav options");
      await r.settle();
      const st = r.stage();
      expect(["compare", "spotlight"]).toContain(st.mode);
      expect(st.items).toContain(r.art.navA.id);
      expect(st.items).toContain(r.art.navB.id);
      expect(st.items).not.toContain(r.art.onbA.id);
      expect(r.newDirectives()).toHaveLength(0);
    });
  }, T);

  t("show a single variant", async () => {
    await runScenario("screen: pull up the sidebar one", [6], async (r) => {
      r.say("jonathan", "pull up the sidebar one real quick");
      await r.settle();
      const st = r.stage();
      expect(st.items).toContain(r.art.navB.id);
      expect(r.newDirectives()).toHaveLength(0);
    });
  }, T);

  t("show how to join, phone included", async () => {
    await runScenario("screen: how do I join on my phone", [6], async (r) => {
      r.say("jonathan", "wait how do I get on this from my phone");
      await r.settle();
      expect(r.stage().mode).toBe("join");
      expect(r.newDirectives()).toHaveLength(0);
    });
  }, T);

  t("put the code back up", async () => {
    await runScenario("screen: put the QR back up", [6], async (r) => {
      r.say("felipe", "can you put the QR code back up, Dev's still trying to join");
      await r.settle();
      expect(r.stage().mode).toBe("join");
      expect(r.newDirectives()).toHaveLength(0);
    });
  }, T);

  t("show what everyone's doing", async () => {
    await runScenario("screen: what everyone's doing", [6], async (r) => {
      r.say("felipe", "show me what everyone's doing right now");
      await r.settle();
      const st = r.stage();
      expect(["agents", "custom", "board"]).toContain(st.mode);
      expect(st.mode).not.toBe("welcome");
      expect(r.newDirectives()).toHaveLength(0);
    });
  }, T);
});

describe("7. prompts typed to your own agent", () => {
  t("own prompt is not re-routed", async () => {
    await runScenario("typed: not re-routed to owner", [7], async (r) => {
      r.prompt("desktop", "refactor the sidebar component to use the new design tokens and add a collapsed state");
      await r.settle();
      expect(r.targetsOf(r.newDirectives()).has(r.agents.desktop.id)).toBe(false);
    });
  }, T);

  t("typed prompt that involves others", async () => {
    await runScenario("typed: 'tell the mobile agent'", [7, 9], async (r) => {
      r.prompt("desktop", "add the sidebar nav to the desktop app, and have the mobile agent build the same sidebar so the two match");
      await r.settle();
      const ds = r.newDirectives();
      const tg = r.targetsOf(ds);
      expect(tg.has(r.agents.desktop.id)).toBe(false);
      expect(tg.has(r.agents.mobile.id)).toBe(true);
    });
  }, T);
});

describe("8. agent questions", () => {
  t("person answers an agent's question", async () => {
    await runScenario("question: answered by person", [8], async (r) => {
      r.hub.session.postUpdate(r.agents.desktop.id, "question", "Should the sidebar collapse to icons only, or hide completely when collapsed?");
      await sleep(200);
      r.say("chey", "icons only, it should collapse down to just the icons");
      await r.settle();
      const ds = r.newDirectives();
      expect(ds.some((d) => d.mode === "answer" && d.targets.includes(r.agents.desktop.id))).toBe(true);
    });
  }, T);

  t("question left unanswered", async () => {
    await runScenario("question: banter instead of answer", [8, 1], async (r) => {
      r.hub.session.postUpdate(r.agents.desktop.id, "question", "Should the sidebar collapse to icons only, or hide completely when collapsed?");
      await sleep(200);
      r.say("jonathan", "lol I just spilled coffee on my keyboard");
      r.say("britain", "classic Jonathan");
      await r.settle();
      expect(r.newDirectives().filter((d) => d.mode === "answer")).toHaveLength(0);
    });
  }, T);
});

describe("9. cross-platform parity", () => {
  t("shipped on desktop coordinates mobile", async () => {
    await runScenario("parity: desktop ships", [9], async (r) => {
      r.hub.session.postUpdate(r.agents.desktop.id, "shipped", "Shipped the collapsible sidebar navigation in the desktop app (acme/desktop, PR 214).");
      await r.settle();
      // the consider pass is not tracked by the debounce, so give it a moment to land
      const ds = r.newDirectives();
      expect(ds.length).toBeGreaterThanOrEqual(1);
      expect(ds.every((d) => d.mode === "coordinate" || d.mode === "implement")).toBe(true);
      expect(r.targetsOf(ds).has(r.agents.mobile.id)).toBe(true);
    });
  }, T);

  t("done mockups do not trigger parity", async () => {
    await runScenario("parity: 'done' mockups -> none", [9], async (r) => {
      r.hub.session.postUpdate(r.agents.design.id, "done", "Finished three nav mockups on the canvas: Nav / A, B and C.");
      r.hub.session.postUpdate(r.agents.mobile.id, "done", "Posted two onboarding mockups on the canvas.");
      await r.settle();
      await sleep(500);
      expect(r.newDirectives().filter((d) => d.mode === "coordinate")).toHaveLength(0);
    });
  }, T);

  t("platform-neutral feature shipped on mobile", async () => {
    await runScenario("parity: mobile ships onboarding", [9], async (r) => {
      r.hub.session.postUpdate(r.agents.mobile.id, "shipped", "Shipped the new three-step onboarding flow in the mobile app.");
      await r.settle();
      const ds = r.newDirectives();
      expect(ds.length).toBeGreaterThanOrEqual(1);
      expect(ds.every((d) => d.mode === "coordinate" || d.mode === "implement")).toBe(true);
      expect(r.targetsOf(ds).has(r.agents.desktop.id)).toBe(true);
      expect(r.targetsOf(ds).has(r.agents.mobile.id)).toBe(true);
    });
  }, T);

  t("explore across both platforms", async () => {
    await runScenario("parity: explore for both", [2, 9], async (r) => {
      r.say("britain", "mock up the profile screen for both desktop and mobile so we can compare them");
      await r.settle();
      const ds = r.newDirectives();
      expect(ds.length).toBeGreaterThanOrEqual(1);
      expect(ds.every((d) => d.mode === "explore" || d.mode === "coordinate")).toBe(true);
    });
  }, T);
});

describe("10. no duplicate directives", () => {
  t("repeat of an open directive", async () => {
    await runScenario("dedupe: repeated ask", [10], async (r) => {
      r.hub.session.createDirective({ text: "Build the collapsible sidebar navigation in the desktop app, matching Nav / B: sidebar.", mode: "implement", targets: [r.agents.desktop.id], requestedBy: "Felipe", rationale: "seed" });
      const before = r.directives().length;
      r.say("jonathan", "yeah build the sidebar in the desktop app, let's do it");
      await r.settle();
      expect(r.directives().length).toBe(before);
    });
  }, T);

  t("same ask from two people", async () => {
    await runScenario("dedupe: two people same ask", [10], async (r) => {
      r.say("chey", "let's try three profile screen variants for the mobile app");
      await sleep(2500); // lands in a separate pass
      r.say("britain", "yeah do the profile screen variants for mobile, three of them");
      await r.settle();
      const ds = r.newDirectives().filter((d) => d.mode === "explore");
      expect(ds.length).toBeGreaterThanOrEqual(1);
      expect(ds.length).toBeLessThanOrEqual(1);
    });
  }, T);
});

describe("split and messy utterances", () => {
  t("one request over two quick utterances", async () => {
    await runScenario("split: two quick utterances", [2], async (r) => {
      r.say("chey", "okay so for the mobile app");
      await sleep(500);
      r.say("chey", "let's try three variants of the profile screen");
      await r.settle();
      const ds = r.newDirectives();
      expect(ds.length).toBe(1);
      expect(ds[0].mode).toBe("explore");
    });
  }, T);

  t("one request over two separate passes", async () => {
    await runScenario("split: fragment then ask", [2], async (r) => {
      r.say("chey", "so the thing I really want to see is");
      await sleep(2600);
      r.say("chey", "mock up two onboarding options for the mobile app");
      await r.settle();
      const ds = r.newDirectives();
      expect(ds.length).toBeGreaterThanOrEqual(1);
      expect(ds.length).toBeLessThanOrEqual(2);
      expect(ds.every((d) => d.mode === "explore")).toBe(true);
    });
  }, T);
});

describe("speaking", () => {
  t("direct question to the brain gets a spoken answer", async () => {
    await runScenario("say: direct question", [6], async (r) => {
      r.say("felipe", "hey brain, which agents are connected right now?");
      await r.settle();
      expect(r.spoken().length).toBeGreaterThanOrEqual(1);
      expect(r.newDirectives()).toHaveLength(0);
    });
  }, T);
});

describe("banter is judged by topic, not tone (4.2)", () => {
  const lineOf = (r: any, text: string) => r.hub.session.store.recentEvents({ kinds: ["speech"], limit: 50 }).find((e: any) => e.text === text);
  const project = async (r: any) => {
    r.hub.session.upsertArtifact({ kind: "frame", stage: "mockup", title: "Checkout / A: one page", agentId: r.agents.design.id });
    r.hub.session.claim(r.agents.desktop.id, "Checkout", { quiet: true });
  };

  t("Felipe's real line about the left-hand nav is kept and saved as a reaction on the nav item", async () => {
    await runScenario("banter: the left-hand nav line", [1], async (r) => {
      r.stageNav();
      r.say("jonathan", "ha okay who's getting more chips, I'm going to the kitchen");
      r.say("chey", "lol dude you've been so quiet today");
      r.say("felipe", "This is actually feeling really good, the left-hand nav here.");
      r.say("jonathan", "Briton you want anything from the kitchen");
      await r.settle();
      const real = lineOf(r, "This is actually feeling really good, the left-hand nav here.");
      expect(real.relevance).not.toBe("banter");
      expect(real.relevance).not.toBe("chatter");
      const reacted = [r.art.navA, r.art.navB].some((a) => (r.hub.session.store.get("artifacts", a.id)?.reactions ?? []).some((x: any) => x.eventId === real.id));
      expect(reacted).toBe(true);
      expect(lineOf(r, "ha okay who's getting more chips, I'm going to the kitchen").relevance).toBe("banter");
      expect(r.newDirectives()).toHaveLength(0);
    });
  }, T);

  t("a joke about the product is feedback, not banter", async () => {
    await runScenario("banter: product jokes", [1], async (r) => {
      await project(r);
      r.say("jonathan", "lol the checkout looks like a tax form");
      r.say("chey", "haha the pay button is so ugly, who picked that grey");
      r.say("felipe", "my daughter got four points at school today for reading");
      await r.settle();
      expect(lineOf(r, "lol the checkout looks like a tax form").relevance).not.toBe("banter");
      expect(lineOf(r, "haha the pay button is so ugly, who picked that grey").relevance).not.toBe("banter");
      expect(lineOf(r, "my daughter got four points at school today for reading").relevance).toBe("banter");
      expect(r.newDirectives()).toHaveLength(0);
    });
  }, T);

  t("JamSesh's own trouble is kept out of the project's talk", async () => {
    await runScenario("banter: the mic line", [1], async (r) => {
      await project(r);
      r.say("felipe", "the mic keeps cutting out when Jonathan talks");
      await r.settle();
      expect(["banter", "chatter"]).toContain(lineOf(r, "the mic keeps cutting out when Jonathan talks").relevance);
      expect(r.newDirectives()).toHaveLength(0);
    });
  }, T);
});
