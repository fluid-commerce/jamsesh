// Phase 4 (brain): banter by topic, curation that updates instead of restating, the session brief, filing.
// Offline: no gateway key needed. The live behaviour is in brain.scenarios.test.ts and brain.curate.test.ts.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../src/hub";
import { buildBrief, BRIEF_EXCERPT } from "../src/brief";
import { confidentBanter, projectCard, vocabulary } from "../src/brain/card";
import { judged, ruleTriage, type Triage } from "../src/brain/brain";
import { applyCuration, type Curation } from "../src/brain/curation";
import { groupKey, tidyTitle } from "../src/session";

const dir = mkdtempSync(join(tmpdir(), "jam-p4brain-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function room() {
  const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, String(Math.random())) });
  clearInterval((hub.brain as any).digestTimer);
  const s = hub.session;
  const reg = (owner: string, repo: string, platform: "desktop" | "mobile" | "design") => s.registerAgent({ ownerName: owner, harness: "claude-code", repo, cwd: `/w/${repo}`, machine: owner, platform, branch: "main" }).agent;
  const jon = reg("Jonathan", "acme/desktop", "desktop");
  const britain = reg("Britain", "acme/design", "design");
  const say = (text: string, name = "Felipe") => s.store.addEvent({ kind: "speech", authorType: "person", authorId: null, authorName: name, text });
  return { hub, s, jon, britain, say, brain: hub.brain as any };
}

const noChange = { update: [], resolve: [], supersede: [] };
const fact = (s: ReturnType<typeof room>["s"], text: string, over: Record<string, unknown> = {}) => {
  s.store.put("facts", { id: `f_${Math.random().toString(36).slice(2)}`, ts: 1, updatedAt: 1, kind: "decision", text, workstream: "", by: "", status: "active", note: "", sourceEventIds: [1], ...over } as any);
};

describe("4.2 banter is judged by topic", () => {
  const line = (over: Partial<Triage["lines"][number]>): Triage => ({ lines: [{ id: 1, topic: "project", joking: false, relevance: "discussion", intent: "none", confidence: 0.9, ...over }], actionable: false, introductions: [] });

  test("a joke about the product is not banter; an unrelated line is", () => {
    expect(judged(line({ topic: "project", joking: true, relevance: "banter" })).lines[0].relevance).toBe("discussion");
    expect(judged(line({ topic: "unrelated", joking: true, relevance: "discussion" })).lines[0].relevance).toBe("banter");
    expect(judged(line({ topic: "tool", relevance: "work" })).lines[0].relevance).toBe("banter");
  });

  test("filler stays chatter, and a reaction to a screen is never chatter", () => {
    expect(judged(line({ topic: "unrelated", relevance: "chatter" })).lines[0].relevance).toBe("chatter");
    expect(judged(line({ topic: "project", relevance: "chatter", reactionTo: "art_1" })).lines[0].relevance).toBe("discussion");
  });

  test("an answer with no topic (an older reply) is read as about the project", () => {
    expect(judged(line({ topic: undefined, relevance: "banter" })).lines[0].relevance).toBe("discussion");
  });

  test("the offline rules call a casual line banter only when it uses none of the project's words, and doubtfully", () => {
    const r = room();
    r.s.claim(r.jon.id, "Checkout", { quiet: true });
    const vocab = vocabulary(r.s);
    const a = r.say("lol the checkout looks like a tax form");
    const b = r.say("dude did you see the game lol");
    const t = ruleTriage([a, b], vocab);
    expect(t.lines[0].relevance).not.toBe("banter");
    expect(t.lines[1].relevance).toBe("banter");
    expect(confidentBanter({ ...b, relevance: "banter", data: { confidence: t.lines[1].confidence } })).toBe(false);
    r.hub.stop();
  });

  test("only confident banter is dropped; a doubtful line is kept", () => {
    const base = { id: 1, ts: 1, kind: "speech", authorType: "person", authorId: null, authorName: "x", text: "t", workstreamId: null } as any;
    expect(confidentBanter({ ...base, relevance: "banter", data: { confidence: 0.95 } })).toBe(true);
    expect(confidentBanter({ ...base, relevance: "banter", data: { confidence: 0.6 } })).toBe(false);
    expect(confidentBanter({ ...base, relevance: "discussion", data: {} })).toBe(false);
  });

  test("the project card carries the goal, workstreams, decisions, terms and what is on screen with ids", () => {
    const r = room();
    const { s } = r;
    s.claim(r.jon.id, "Checkout", { quiet: true });
    s.store.setDigest("brief-parts", JSON.stringify({ goal: "Redesign the merchant app", decisions: [], questions: [], glossary: [{ term: "Passport", meaning: "customer login" }] }), 0);
    fact(s, "Checkout is one page.");
    const art = s.upsertArtifact({ kind: "frame", stage: "mockup", title: "Checkout / A: one page", agentId: r.britain.id });
    s.setStage({ mode: "spotlight", title: "Checkout", items: [art.id], pinned: false }, "Britain", "main", { claim: s.stageClaim() });
    const card = projectCard(s);
    expect(card).toContain("Redesign the merchant app");
    expect(card).toContain("Checkout");
    expect(card).toContain("Passport (customer login)");
    expect(card).toContain("Checkout is one page.");
    expect(card).toContain(`[${art.id}] Checkout / A: one page`);
    expect(card).toContain("put up by Britain");
    r.hub.stop();
  });

  describe("reactions", () => {
    const setup = () => {
      const r = room();
      const art = r.s.upsertArtifact({ kind: "frame", stage: "mockup", title: "Nav / B: sidebar", agentId: r.britain.id });
      r.s.setStage({ mode: "spotlight", title: "Nav", items: [art.id], pinned: false }, "Britain", "main", { claim: r.s.stageClaim() });
      return { ...r, art };
    };
    const tri = (id: number, over: object): Triage => ({ lines: [{ id, topic: "project", relevance: "discussion", intent: "none", confidence: 0.9, ...over } as any], actionable: false, introductions: [] });

    test("a reaction right after something goes up is saved on that item, once", () => {
      const r = setup();
      const ev = r.s.store.addEvent({ kind: "speech", authorType: "person", authorId: null, authorName: "Felipe", text: "This is actually feeling really good, the left-hand nav here." });
      const t = tri(ev.id, { reactionTo: r.art.id });
      r.brain.applyTriage([ev], t);
      r.brain.applyTriage([ev], t);
      const art = r.s.store.get("artifacts", r.art.id)!;
      expect(art.reactions).toHaveLength(1);
      expect(art.reactions![0]).toMatchObject({ by: "Felipe", eventId: ev.id });
      expect(r.s.store.event(ev.id)!.data.reactionTo).toBe(r.art.id);
      r.hub.stop();
    });

    test("an unknown item, an agent's line, banter, or an item long gone is not recorded", () => {
      const r = setup();
      const person = (text: string) => r.s.store.addEvent({ kind: "speech", authorType: "person", authorId: null, authorName: "Felipe", text });
      const a = person("love it");
      r.brain.applyTriage([a], tri(a.id, { reactionTo: "art_nope" }));
      const b = r.s.store.addEvent({ kind: "update", authorType: "agent", authorId: null, authorName: "Bot", text: "love it" });
      r.brain.applyTriage([b], tri(b.id, { reactionTo: r.art.id }));
      const c = person("lol");
      r.brain.applyTriage([c], tri(c.id, { reactionTo: r.art.id, relevance: "banter", topic: "unrelated" }));
      const old = r.s.upsertArtifact({ kind: "frame", stage: "mockup", title: "Old / A: thing", agentId: r.britain.id });
      r.s.store.put("artifacts", { ...old, updatedAt: Date.now() - 3600_000 });
      const d = person("nice");
      r.brain.applyTriage([d], tri(d.id, { reactionTo: old.id }));
      expect(r.s.store.get("artifacts", r.art.id)!.reactions ?? []).toHaveLength(0);
      expect(r.s.store.get("artifacts", old.id)!.reactions ?? []).toHaveLength(0);
      r.hub.stop();
    });

    test("a later line rescues an earlier line labeled banter", () => {
      const r = setup();
      const first = r.s.store.addEvent({ kind: "speech", authorType: "person", authorId: null, authorName: "Felipe", text: "what if the cart slid in like a drawer haha", relevance: "banter" });
      const second = r.s.store.addEvent({ kind: "speech", authorType: "person", authorId: null, authorName: "Chey", text: "actually that's a good idea" });
      r.brain.applyTriage([second], tri(second.id, { rescues: [first.id] }));
      expect(r.s.store.event(first.id)!.relevance).toBe("discussion");
      // A line cannot rescue one that came after it.
      r.brain.applyTriage([first], tri(first.id, { rescues: [second.id + 5] }));
      r.hub.stop();
    });
  });
});

describe("4.3 curation updates instead of restating", () => {
  const events = (r: ReturnType<typeof room>, n = 3) => Array.from({ length: n }, (_, i) => r.say(`line ${i}`));
  /** A hold that records what curation hands the board. */
  const hold = () => {
    const h = { added: [] as { text: string; replaces?: string; workstream?: string }[], retired: [] as { id: string; status: string }[], add: (f: { text: string; workstream: string }, replaces?: string) => void h.added.push({ text: f.text, replaces, workstream: f.workstream }), retire: (f: { id: string }, status: string) => void h.retired.push({ id: f.id, status }) };
    return h;
  };

  test("an addition without a source event is not saved; one citing events outside the batch is not either", () => {
    const r = room();
    const evs = events(r);
    const c: Curation = { add: [{ kind: "decision", text: "Nav uses option B.", eventIds: [9999] }], ...noChange };
    const h = hold();
    const res = applyCuration(r.s, c, evs, h);
    expect(h.added).toHaveLength(0);
    expect(res.dropped[0].why).toBe("no source event");
    r.hub.stop();
  });

  test("ship notes and JamSesh's own trouble never become facts", () => {
    const r = room();
    const evs = events(r);
    const add = (text: string): Curation["add"][number] => ({ kind: "fact", text, eventIds: [evs[0].id] });
    const h = hold();
    const res = applyCuration(r.s, { add: [add("The sidebar collapse is implemented in commit 813f5c7452 on branch jonathan/nav."), add("The TV is flickering on the big screen."), add("The mic keeps cutting out when Jonathan talks."), add("The collab.join call failed again."), add("Brand orange is E8672C.")], ...noChange }, evs, h);
    expect(h.added.map((f) => f.text)).toEqual(["Brand orange is E8672C."]);
    expect(res.dropped).toHaveLength(4);
    r.hub.stop();
  });

  test("only identical text merges into the fact it repeats (its event joins the sources); reordered wording is a card", () => {
    const r = room();
    const evs = events(r);
    fact(r.s, "The sidebar collapses to an icon rail under 1024 pixels.", { kind: "requirement", sourceEventIds: [1] });
    const h = hold();
    const res = applyCuration(r.s, { add: [{ kind: "requirement", text: "Under 1024 pixels the sidebar collapses to an icon rail.", eventIds: [evs[1].id] }], ...noChange }, evs, h);
    expect(h.added).toHaveLength(1);
    expect(res.merged).toHaveLength(0);
    const same = applyCuration(r.s, { add: [{ kind: "requirement", text: "the sidebar collapses to an icon rail under 1024 pixels", eventIds: [evs[1].id] }], ...noChange }, evs, hold());
    expect(same.merged).toHaveLength(1);
    const active = r.s.facts().filter((f) => f.status === "active");
    expect(active).toHaveLength(1);
    expect(active[0].sourceEventIds).toEqual([1, evs[1].id]);
    r.hub.stop();
  });

  test("a different specific is a new fact, not a restatement", () => {
    const r = room();
    const evs = events(r);
    fact(r.s, "The icon rail is 64 pixels wide.", { kind: "requirement" });
    const h = hold();
    applyCuration(r.s, { add: [{ kind: "requirement", text: "The icon rail is 48 pixels wide.", eventIds: [evs[0].id] }], ...noChange }, evs, h);
    expect(h.added).toHaveLength(1);
    r.hub.stop();
  });

  test("an update, a resolve and a supersede change nothing on their own: they go to the hold; stale ids are ignored", () => {
    const r = room();
    const evs = events(r);
    fact(r.s, "Product grid is masonry.", { sourceEventIds: [1] });
    fact(r.s, "Do we show prices with tax?", { kind: "question", sourceEventIds: [2] });
    fact(r.s, "Badge is a dot.", { sourceEventIds: [3] });
    const byText = (t: string) => r.s.store.all("facts").find((f) => f.text === t)!;
    const m = byText("Product grid is masonry."), tax = byText("Do we show prices with tax?"), bd = byText("Badge is a dot.");
    const h = hold();
    applyCuration(r.s, { add: [], update: [{ id: bd.id, text: "Badge is a dot with a count.", reason: "detail", eventIds: [evs[0].id, 9999] }], resolve: [{ id: tax.id, reason: "answered", eventIds: [evs[1].id] }], supersede: [{ id: m.id, reason: "even grid", eventIds: [evs[2].id] }, { id: "fact_gone", reason: "x" }] }, evs, h);
    expect(h.added).toEqual([{ text: "Badge is a dot with a count.", replaces: bd.id, workstream: "" }]);
    expect(h.retired).toEqual([{ id: tax.id, status: "resolved" }, { id: m.id, status: "superseded" }]);
    for (const f of [m, tax, bd]) expect(r.s.store.get("facts", f.id)).toMatchObject({ status: "active", text: f.text });
    r.hub.stop();
  });

  test("a workstream is kept only when it exists", () => {
    const r = room();
    const evs = events(r);
    r.s.claim(r.jon.id, "Checkout", { quiet: true });
    const h = hold();
    applyCuration(r.s, { add: [{ kind: "fact", text: "Checkout dev server is at http://192.168.1.20:5100.", workstream: "checkout", eventIds: [evs[0].id] }, { kind: "fact", text: "Tokens live in theme/tokens.ts.", workstream: "Invented", eventIds: [evs[0].id] }], ...noChange }, evs, h);
    expect(h.added.map((f) => f.workstream)).toEqual(["Checkout", ""]);
    r.hub.stop();
  });
});

describe("4.4 the session brief onboards", () => {
  test("fixed sections come from state: owners, repos, live builds, what's in progress; the model adds goal and terms", () => {
    const r = room();
    const { s } = r;
    s.claim(r.jon.id, "Checkout", { quiet: true });
    // An older brief's model-written decisions and questions are ignored: those sections are the accepted facts.
    s.store.setDigest("brief-parts", JSON.stringify({ goal: "Redesign the merchant app", decisions: ["Header uses option C (overheard)"], questions: ["Unaccepted question?"], glossary: [{ term: "Passport", meaning: "customer login" }] }), 0);
    fact(s, "Checkout is one page.", { by: "Felipe" });
    fact(s, "Prices with tax?", { kind: "question" });
    s.upsertArtifact({ kind: "frame", stage: "mockup", title: "Checkout / A: one page", agentId: r.jon.id });
    s.store.put("devservers", { id: "dev1", agentId: r.jon.id, name: "Checkout", target: "localhost:5173", hostPort: 5100, url: "http://192.168.1.20:5100", platform: "desktop", createdAt: 1, up: true } as any);
    const { full, short } = buildBrief(s);
    for (const part of ["GOAL: Redesign the merchant app", "OWNERS:", "Checkout: ", "REPOS:", "acme/desktop@main", "LIVE:", "http://192.168.1.20:5100", "IN PROGRESS:", "1 mocked", "DECISIONS:", "OPEN QUESTIONS:", "GLOSSARY:", "Passport: customer login"]) expect(full).toContain(part);
    expect(full).toContain("Checkout is one page. (Felipe)");
    expect(full).toContain("Prices with tax?");
    expect(full).not.toContain("option C");
    expect(full).not.toContain("Unaccepted question");
    expect(short).toContain("Redesign the merchant app");
    expect(short).toContain("http://192.168.1.20:5100");
    expect(short.length).toBeLessThanOrEqual(BRIEF_EXCERPT);
    r.hub.stop();
  });

  test("the excerpt stays within 600 characters however much there is, and keeps the goal", () => {
    const r = room();
    const { s } = r;
    for (let i = 0; i < 12; i++) {
      const a = s.registerAgent({ ownerName: `Person ${i}`, harness: "claude-code", repo: `acme/service-number-${i}`, cwd: `/w${i}`, machine: `m${i}`, platform: "desktop", branch: `feature/long-branch-name-${i}` }).agent;
      s.claim(a.id, `A rather long workstream title number ${i}`, { quiet: true });
      s.store.put("devservers", { id: `d${i}`, agentId: a.id, name: `Build ${i}`, target: "localhost:1", hostPort: 5100 + i, url: `http://192.168.1.20:${5100 + i}`, platform: "desktop", createdAt: 1, up: true } as any);
    }
    s.store.setDigest("brief-parts", JSON.stringify({ goal: "G".repeat(400), decisions: [], questions: [], glossary: Array.from({ length: 30 }, (_, i) => ({ term: `Term${i}`, meaning: "m" })) }), 0);
    const { short, full } = buildBrief(s);
    expect(short.length).toBeLessThanOrEqual(BRIEF_EXCERPT);
    expect(short.startsWith("GOAL: ")).toBe(true);
    expect(full.length).toBeGreaterThan(short.length);
    r.hub.stop();
  });

  test("with no model pass yet it still onboards from state, and the join briefing uses the excerpt", () => {
    const r = room();
    r.s.claim(r.jon.id, "Checkout", { quiet: true });
    const { short } = buildBrief(r.s);
    expect(short).toContain("OWNERS: Checkout");
    const joined = r.hub.mcp.briefing(r.jon, false, false, "http://hub");
    expect(joined).toContain(short);
    r.hub.stop();
  });
});

describe("4.5 work is filed under its workstream", () => {
  test("an item lands under its posting agent's workstream, with no help from the agent", () => {
    const r = room();
    r.s.claim(r.jon.id, "Checkout", { quiet: true });
    const a = r.s.upsertArtifact({ kind: "screenshot", stage: "built", title: "Checkout / A: one page", agentId: r.jon.id });
    expect(a.workstreamId).toBe(r.s.store.all("workstreams").find((w) => w.title === "Checkout")!.id);
    r.hub.stop();
  });

  test("with two workstreams the one named like the item wins; an agent with none leaves it unfiled until it claims one", () => {
    const r = room();
    r.s.claim(r.jon.id, "Checkout", { quiet: true });
    r.s.claim(r.jon.id, "Nav", { quiet: true });
    const nav = r.s.store.all("workstreams").find((w) => w.title === "Nav")!;
    expect(r.s.upsertArtifact({ kind: "screenshot", stage: "built", title: "Nav / A: rail", agentId: r.jon.id }).workstreamId).toBe(nav.id);
    const lone = r.s.upsertArtifact({ kind: "screenshot", stage: "built", title: "Orders / A: list", agentId: r.britain.id });
    expect(lone.workstreamId).toBeNull();
    r.s.claim(r.britain.id, "Orders", { quiet: true });
    expect(r.s.store.get("artifacts", lone.id)!.workstreamId).toBe(r.s.store.all("workstreams").find((w) => w.title === "Orders")!.id);
    r.hub.stop();
  });

  test("a canvas frame with no agent is filed by its page", () => {
    const r = room();
    r.s.claim(r.jon.id, "Checkout", { quiet: true });
    const f = r.s.upsertArtifact({ kind: "frame", stage: "mockup", title: "Checkout / B: two step", page: "Checkout" });
    expect(f.workstreamId).toBe(r.s.store.all("workstreams").find((w) => w.title === "Checkout")!.id);
    r.hub.stop();
  });

  test("an explicit workstream is kept", () => {
    const r = room();
    r.s.claim(r.jon.id, "Checkout", { quiet: true });
    expect(r.s.upsertArtifact({ kind: "frame", stage: "mockup", title: "X / A: y", agentId: r.jon.id, workstreamId: "w_other" }).workstreamId).toBe("w_other");
    r.hub.stop();
  });

  test("titles are tidied on arrival; groups share one spelling", () => {
    expect(tidyTitle("  Nav/b:   rail   (built) ")).toBe("Nav / B: rail");
    expect(tidyTitle("Mist Mobile rep / A: home (Built)")).toBe("Mist Mobile rep / A: home");
    expect(tidyTitle("Order status page")).toBe("Order status page");
    expect(tidyTitle("http://x.dev/a: b")).toBe("http://x.dev/a: b");
    expect(groupKey("Mist Mobile rep mode")).toBe(groupKey("mist mobile rep"));
    const r = room();
    const a = r.s.upsertArtifact({ kind: "frame", stage: "mockup", title: "Mist Mobile rep / A: home", agentId: r.britain.id });
    const b = r.s.upsertArtifact({ kind: "frame", stage: "mockup", title: "Mist Mobile rep mode / B: home", agentId: r.britain.id });
    expect(b.group).toBe(a.group);
    expect(b.variant).toBe("B");
    r.hub.stop();
  });

  test("once an item has versions its title stays put, even when the agent posts '(built)' or a new spelling", () => {
    const r = room();
    const one = r.s.upsertVersion({ kind: "screenshot", stage: "built", title: "Checkout / A: one page", agentId: r.jon.id, image: "/a.png" });
    const two = r.s.upsertVersion({ kind: "screenshot", stage: "built", title: "Checkout / A: one page (built)", agentId: r.jon.id, image: "/b.png" });
    const three = r.s.upsertVersion({ kind: "screenshot", stage: "built", title: "checkout/a:  one page [built]", agentId: r.jon.id, image: "/c.png" });
    expect(two.id).toBe(one.id);
    expect(three.id).toBe(one.id);
    expect(three.title).toBe("Checkout / A: one page");
    expect(three.version).toBe(3);
    // Posting the same id again with another title keeps the versioned title.
    expect(r.s.upsertArtifact({ kind: "screenshot", stage: "built", title: "Something else", id: one.id, agentId: r.jon.id }).title).toBe("Checkout / A: one page");
    r.hub.stop();
  });
});
