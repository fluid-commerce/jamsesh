// Context that carries over (SPEC 12.7): a project's settled context is saved in its context database
// (exported as JSON) and seeds its next session, marked with where it came from.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contextExport, contextFile, readProjectContext, saveProjectContext, seedFromProject } from "../src/carryover";
import { Hub } from "../src/hub";
import { ProjectKeeper } from "../src/projectkeeper";
import { createProject, openSession } from "../src/projects";
import { newId } from "../src/store";

process.env.JAMSESH_SILENT = "1";
const home = mkdtempSync(join(tmpdir(), "jam-carry-"));
const hubs: Hub[] = [];
afterAll(() => {
  for (const h of hubs) {
    h.devproxy.stop();
    h.stop();
  }
  rmSync(home, { recursive: true, force: true });
});

/** A hub on a project session's directory, the way the host builds one. */
function sessionHub(slug: string, fresh: boolean) {
  const opened = openSession(home, slug, { fresh });
  const hub = new Hub({ canvas: false, whisper: false, dataDir: opened.dir, teamDir: join(home, "team") });
  hubs.push(hub);
  return { hub, id: opened.sessionId };
}

const fact = (hub: Hub, text: string, extra: object = {}) =>
  hub.store.put("facts", { id: newId("fact"), ts: Date.now(), updatedAt: Date.now(), kind: "decision", text, workstream: "Passport", by: "Chey", status: "active", note: "", sourceEventIds: [1], ...extra } as any);

test("a session's settled context is saved for the project and exported as JSON", () => {
  const p = createProject(home, "Passport redesign");
  const a = sessionHub(p.slug, false);
  fact(a.hub, "Left-hand nav, not top tabs");
  fact(a.hub, "Old idea", { status: "superseded" });
  a.hub.store.put("workstreams", { id: newId("w"), title: "Nav", ownerAgentId: null, status: "active", brief: "Rebuild the nav", updatedAt: 1 });
  a.hub.store.put("workstreams", { id: newId("w"), title: "Shipped thing", ownerAgentId: null, status: "done", brief: "", updatedAt: 1 });
  a.hub.session.upsertPerson({ name: "Chey", role: "Design lead" });
  a.hub.store.setDigest("brief-parts", JSON.stringify({ goal: "Ship the Passport nav.", decisions: [], questions: [], glossary: [{ term: "Passport", meaning: "the sign-in" }] }), 1);
  saveProjectContext(home, p.slug, a.id, a.hub.session);
  const ctx = JSON.parse(readFileSync(contextExport(home, p.slug), "utf8"));
  expect(ctx).toMatchObject({ version: 1, fromSession: a.id, goal: "Ship the Passport nav.", glossary: [{ term: "Passport", meaning: "the sign-in" }], brief: expect.stringContaining("GOAL: Ship the Passport nav.") });
  expect(ctx.facts.map((f: any) => f.text)).toEqual(["Left-hand nav, not top tabs"]);
  expect(ctx.workstreams.map((w: any) => w.title)).toEqual(["Nav"]);
  expect(ctx.people).toEqual([{ name: "Chey", role: "Design lead" }]);
});

test("the next session starts from it, every carried item marked with its source session", () => {
  const p = createProject(home, "Second");
  const a = sessionHub(p.slug, false);
  fact(a.hub, "Use the shared token set");
  a.hub.store.put("workstreams", { id: newId("w"), title: "Tokens", ownerAgentId: "agent_gone", status: "paused", brief: "Audit tokens", updatedAt: 1 });
  a.hub.store.setDigest("brief-parts", JSON.stringify({ goal: "Tokens everywhere.", decisions: [], questions: [], glossary: [{ term: "Tokens", meaning: "design tokens" }] }), 1);
  saveProjectContext(home, p.slug, a.id, a.hub.session);

  const b = sessionHub(p.slug, true);
  expect(b.id).not.toBe(a.id);
  expect(seedFromProject(home, p.slug, b.id, b.hub.session)).toBe(2);
  const carried = b.hub.store.all("facts");
  expect(carried).toHaveLength(1);
  expect(carried[0]).toMatchObject({ text: "Use the shared token set", status: "active", sourceEventIds: [], carriedFrom: { sessionId: a.id } });
  const ws = b.hub.store.all("workstreams");
  expect(ws[0]).toMatchObject({ title: "Tokens", status: "paused", ownerAgentId: null, carriedFrom: { sessionId: a.id } });
  // The brief shows in the agents' briefing until this session writes its own.
  const agent = b.hub.session.registerAgent({ ownerName: "Chey", harness: "codex", repo: "~/x", machine: "m" }).agent;
  expect(b.hub.mcp.briefing(agent, false)).toContain("GOAL: Tokens everywhere.");
  expect(b.hub.mcp.briefing(agent, false)).toContain("Tokens");
  b.hub.store.setDigest("brief-parts", JSON.stringify({ goal: "A newer goal.", decisions: [], questions: [], glossary: [] }), 2);
  expect(b.hub.mcp.briefing(agent, false)).not.toContain("Tokens everywhere");
  expect(b.hub.mcp.briefing(agent, false)).toContain("GOAL: A newer goal.");
});

test("seeding happens once, never into the session that wrote the file, and a settled item that was retired stays out", () => {
  const p = createProject(home, "Third");
  const a = sessionHub(p.slug, false);
  fact(a.hub, "Keep");
  const retire = fact(a.hub, "Will be replaced");
  saveProjectContext(home, p.slug, a.id, a.hub.session);
  expect(seedFromProject(home, p.slug, a.id, a.hub.session)).toBe(0); // its own file
  const b = sessionHub(p.slug, true);
  expect(seedFromProject(home, p.slug, b.id, b.hub.session)).toBe(2);
  expect(seedFromProject(home, p.slug, b.id, b.hub.session)).toBe(0); // once
  // B retires one carried item and settles a new one; C gets the live set, still pointing at A.
  const carried = b.hub.store.all("facts").find((f) => f.text === "Will be replaced")!;
  b.hub.store.put("facts", { ...carried, status: "superseded", updatedAt: carried.carriedFrom!.at + 1 });
  fact(b.hub, "New in B");
  saveProjectContext(home, p.slug, b.id, b.hub.session);
  const c = sessionHub(p.slug, true);
  seedFromProject(home, p.slug, c.id, c.hub.session);
  const texts = c.hub.store.all("facts").map((f) => f.text).sort();
  expect(texts).toEqual(["Keep", "New in B"]);
  expect(c.hub.store.all("facts").find((f) => f.text === "Keep")?.carriedFrom?.sessionId).toBe(a.id);
  expect(c.hub.store.all("facts").find((f) => f.text === "New in B")?.carriedFrom?.sessionId).toBe(b.id);
  void retire;
});

test("an empty new session never empties the file, and a resumed session isn't re-seeded", () => {
  const p = createProject(home, "Fourth");
  const a = sessionHub(p.slug, false);
  fact(a.hub, "Only fact");
  saveProjectContext(home, p.slug, a.id, a.hub.session);
  const empty = sessionHub(p.slug, true);
  saveProjectContext(home, p.slug, empty.id, empty.hub.session);
  expect(readProjectContext(home, p.slug)?.facts.map((f) => f.text)).toEqual(["Only fact"]);
  const again = sessionHub(p.slug, false); // today's session, resumed (the empty one)
  expect(again.id).toBe(empty.id);
  expect(seedFromProject(home, p.slug, empty.id, empty.hub.session)).toBe(1);
  expect(seedFromProject(home, p.slug, again.id, again.hub.session)).toBe(0);
});

test("a missing, corrupt or foreign file seeds nothing", () => {
  const p = createProject(home, "Fifth");
  const a = sessionHub(p.slug, false);
  expect(seedFromProject(home, p.slug, a.id, a.hub.session)).toBe(0);
  mkdirSync(join(home, "projects", p.slug), { recursive: true });
  for (const junk of ["{not json", '{"version":2}', "[]", '{"version":1,"fromSession":"x","facts":"nope","workstreams":[{"title":5}],"people":null}']) {
    rmSync(contextFile(home, p.slug), { force: true });
    writeFileSync(contextExport(home, p.slug), junk);
    const b0 = sessionHub(p.slug, true);
    expect(() => seedFromProject(home, p.slug, b0.id, b0.hub.session)).not.toThrow();
    expect(b0.hub.store.all("facts")).toHaveLength(0);
    writeFileSync(contextFile(home, p.slug), junk);
    const b = sessionHub(p.slug, true);
    expect(() => seedFromProject(home, p.slug, b.id, b.hub.session)).not.toThrow();
    expect(b.hub.store.all("facts")).toHaveLength(0);
  }
});

test("the keeper writes the file as the session runs and when it ends", async () => {
  const p = createProject(home, "Sixth");
  const a = sessionHub(p.slug, false);
  fact(a.hub, "Written by the keeper");
  const keeper = new ProjectKeeper(a.hub, home, { slug: p.slug, sessionId: a.id });
  expect(existsSync(contextFile(home, p.slug))).toBe(false);
  await keeper.save();
  expect(readProjectContext(home, p.slug)?.facts[0]?.text).toBe("Written by the keeper");
});
