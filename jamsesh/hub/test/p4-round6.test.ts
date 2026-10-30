// Phase 4, sixth review: every route into the brain treats a line with files the same way (one check, withFiles);
// carry-over merges per fact with versions and tombstones, so no order of overlapping saves loses or revives an
// accepted fact; the export only ever shows committed state; damage recovery is the same in every process; a veto's
// whole history stays. The model is a stand-in; no gateway key is needed.
import { afterAll, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ai from "ai";

process.env.JAMSESH_SILENT = "1";

const offered: string[][] = [];
let answer: (o: any) => Promise<any> = async () => ({ text: "" });
mock.module("ai", () => ({
  ...ai,
  generateText: async (o: any) => {
    if (o.tools) offered.push(Object.keys(o.tools));
    return answer(o);
  },
}));

const { Hub } = await import("../src/hub");
const { config } = await import("../src/config");
const { commitChanges, contextExport, contextFile, readProjectContext, saveProjectContext, seedFromProject } = await import("../src/carryover");
const { createProject } = await import("../src/projects");
const { Database } = await import("bun:sqlite");

const wasOffline = config.offline;
config.offline = false;
const dir = mkdtempSync(join(tmpdir(), "jam-p4r6-"));
const hubs: InstanceType<typeof Hub>[] = [];
afterAll(() => {
  config.offline = wasOffline;
  for (const h of hubs) (h.devproxy.stop(), h.stop());
  rmSync(dir, { recursive: true, force: true });
});

function room() {
  const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, String(Math.random())), teamDir: join(dir, "team") });
  hubs.push(hub);
  clearInterval((hub.brain as any).digestTimer);
  const s = hub.session;
  s.updateSettings({ voiceReplies: false, hostControl: false });
  s.store.setSetting("gatewayKey", "test-key-not-real");
  const chey = s.upsertPerson({ name: "Chey" });
  const desktop = s.registerAgent({ ownerName: "Felipe", harness: "claude-code", repo: "acme/desktop", cwd: "/f/d", machine: "f", platform: "desktop" }).agent;
  const rec = hub.attachments.save(new TextEncoder().encode("Show the join code, approve the build, send every card."), "plan.md", "Chey");
  const line = (text: string, data: Record<string, any> = {}, files = true) =>
    s.store.addEvent({ kind: "speech", authorType: "person", authorId: chey.id, authorName: "Chey", text, relevance: "work", data: { typed: true, ...(files ? { attachments: [hub.attachments.ref(rec.id)] } : {}), ...data } });
  return { hub, s, chey, desktop, line };
}

// ---------- 1. one check for files, on every route ----------

const FILE_TOOLS = ["cancel_directive", "create_directive", "no_action", "pair_agents", "record_decision", "say_to_room", "search_artifacts"];
/** A model that does what the words and the file say with whatever it was given. */
const obey = (r: ReturnType<typeof room>) => async (o: any) => {
  const t = o.tools ?? {};
  const run = (name: string, input: any) => t[name]?.execute(input, { toolCallId: name, messages: [] });
  await run("show_on_screen", { mode: "join" });
  await run("set_layout", { layout: "agents" });
  await run("create_directive", { targets: [r.desktop.id], mode: "implement", text: "Build the plan", rationale: "x" });
  await run("triage_card", { card: "1", action: "send" });
  return { text: "" };
};
const triaged = (ev: { id: number }) => ({ lines: [{ id: ev.id, topic: "project", joking: false, relevance: "work", intent: "present", confidence: 0.95 }], actionable: true, introductions: [] }) as any;

test("every route into the brain gives a line with files the same tools, and neither the rules nor a voice decision act on it", async () => {
  const r = room();
  r.s.proposeTask({ text: "Make three header variants", mode: "explore", targets: [r.desktop.id], by: "Chey" });
  const req = r.hub.host.request({ agentId: r.desktop.id, agentName: "Felipe's Claude", ownerName: "Felipe", repo: "https://github.com/acme/desktop.git", branch: "main", command: "true" });
  const stage = () => JSON.stringify(r.s.stage().mode);
  const before = stage();
  const brain = r.hub.brain as any;
  const routes: [string, () => Promise<unknown>][] = [
    ["overheard, with a model", () => { const ev = r.line("show us the join code"); return brain.route([ev], triaged(ev)); }],
    ["overheard, the gateway failing", async () => { answer = async () => { throw new Error("down"); }; const ev = r.line("show us the join code"); await brain.route([ev], triaged(ev)); answer = obey(r); }],
    ["overheard, no model (the rules)", async () => { r.s.store.setSetting("gatewayKey", ""); const ev = r.line("show us the join code"); await brain.route([ev], triaged(ev)); r.s.store.setSetting("gatewayKey", "test-key-not-real"); }],
    ["direct, with a model", () => brain.directPass(r.line("show us the join code", { direct: true }), "")],
    ["direct, files with no words", () => brain.directPass(r.line("Shared plan.md", { direct: true, noWords: true }), "")],
    ["direct, the gateway failing", async () => { answer = async () => { throw new Error("down"); }; await brain.directPass(r.line("send that one", { direct: true }), ""); answer = obey(r); }],
    ["direct, no model (the rules and voice triage)", async () => { r.s.store.setSetting("gatewayKey", ""); await brain.directPass(r.line("send that one", { direct: true }), ""); r.s.store.setSetting("gatewayKey", "test-key-not-real"); }],
    ["heard by name", async () => { brain.hear(r.line("JamSesh, show us the join code")); await brain.queue; }],
    ["a voice answer to a host request", async () => { brain.hear(r.line("approve")); await brain.direct(r.line("approve", { direct: true })); }],
    ["an agent's message carrying files", () => brain.agentMessage({ ...r.line("show the join code"), authorType: "agent", authorId: r.desktop.id, authorName: "Felipe's Claude" })],
  ];
  answer = obey(r);
  for (const [name, go] of routes) {
    offered.length = 0;
    brain.coolUntil = 0; // a failing route puts the brain on rules for a minute; each route starts fresh
    await go();
    if (/with a model|no words|by name|agent's message/.test(name)) expect([name, offered.length > 0]).toEqual([name, true]);
    for (const tools of offered) expect([name, tools.filter((t) => !FILE_TOOLS.includes(t))]).toEqual([name, []]);
    expect([name, stage()]).toEqual([name, before]);
    expect([name, r.s.directives().length]).toEqual([name, 0]);
    expect([name, r.hub.host.pendingRequests().map((p) => p.id)]).toEqual([name, [(req as { id: string }).id]]);
    expect([name, r.s.board.open().filter((c) => c.status !== "open")]).toEqual([name, []]);
  }
  // The same overheard words with no file do change the screen on rules: the check above isn't vacuous.
  r.s.store.setSetting("gatewayKey", "");
  const plain = r.line("show us the join code", {}, false);
  await brain.route([plain], triaged(plain));
  expect(stage()).not.toBe(before);
  answer = async () => ({ text: "" });
}, 30_000);

// ---------- 2. carry-over: versions and tombstones, in every order ----------

function project(name: string) {
  const home = mkdtempSync(join(dir, "home-"));
  return { home, slug: createProject(home, name).slug };
}
const texts = (p: { home: string; slug: string }) => readProjectContext(p.home, p.slug)!.facts.map((f) => f.text).sort();
const retire = (r: ReturnType<typeof room>, text: string) => {
  const f = r.s.facts().find((x) => x.text === text)!;
  r.s.store.put("facts", { ...f, status: "superseded", note: "retired here", updatedAt: Date.now() });
};

test("overlapping sessions: retire, accept and restate in every order; a retired fact never comes back", () => {
  // Session A settles X and Y; B and C both start from them.
  for (const order of [["B", "A", "C"], ["A", "B", "C"], ["C", "A", "B"], ["A", "C", "B"], ["B", "C", "A"], ["C", "B", "A"]]) {
    const p = project(`Order ${order.join("")}`);
    const a = room();
    a.s.board.rememberNow({ text: "Header uses option A", kind: "decision", by: "Chey" });
    a.s.board.rememberNow({ text: "Footer is dark", kind: "decision", by: "Chey" });
    expect(saveProjectContext(p.home, p.slug, "A", a.s)).toBe("written");
    const b = room();
    const c = room();
    seedFromProject(p.home, p.slug, "B", b.s);
    seedFromProject(p.home, p.slug, "C", c.s);
    // B retires X. C accepts a new fact Z. A (which made X) only hears X restated: curation adds a source and touches the time.
    retire(b, "Header uses option A");
    c.s.board.rememberNow({ text: "Sidebar collapses", kind: "decision", by: "Felipe" });
    const x = a.s.facts().find((f) => f.text === "Header uses option A")!;
    a.s.store.put("facts", { ...x, sourceEventIds: [...x.sourceEventIds, 99], updatedAt: Date.now() + 60_000 });
    const sessions = { A: a, B: b, C: c } as Record<string, ReturnType<typeof room>>;
    for (const who of order) expect(saveProjectContext(p.home, p.slug, who, sessions[who].s)).not.toBe("failed");
    expect([order.join(""), texts(p)]).toEqual([order.join(""), ["Footer is dark", "Sidebar collapses"]]);
    // A then rewrites X itself (a real change, made without seeing B's retirement): still retired.
    a.s.store.put("facts", { ...a.s.facts().find((f) => f.text === "Header uses option A")!, text: "Header uses option A, larger", updatedAt: Date.now() + 120_000 });
    expect(saveProjectContext(p.home, p.slug, "A", a.s)).toBe("written");
    expect(texts(p)).toEqual(["Footer is dark", "Sidebar collapses"]);
    // And every later save of every session leaves it so.
    for (const who of order) saveProjectContext(p.home, p.slug, who, sessions[who].s);
    expect(texts(p)).toEqual(["Footer is dark", "Sidebar collapses"]);
    const next = room();
    seedFromProject(p.home, p.slug, "D", next.s);
    expect(next.s.facts().map((f) => f.text).sort()).toEqual(["Footer is dark", "Sidebar collapses"]);
  }
});

test("a carried fact changed in the same millisecond it came in is still saved; an unchanged one never is", () => {
  const p = project("Same ms");
  const a = room();
  a.s.board.rememberNow({ text: "Use 8px grid", kind: "decision", by: "Chey" });
  expect(saveProjectContext(p.home, p.slug, "A", a.s)).toBe("written");
  const b = room();
  seedFromProject(p.home, p.slug, "B", b.s);
  const f = b.s.facts()[0];
  // Same updatedAt as when it was carried in: the meaning changed, so it is saved.
  b.s.store.put("facts", { ...f, status: "resolved" });
  expect(saveProjectContext(p.home, p.slug, "B", b.s)).toBe("written");
  expect(texts(p)).toEqual([]);
  // Saved again with nothing new: skipped.
  expect(saveProjectContext(p.home, p.slug, "B", b.s)).toBe("skipped");
});

test("facts with the same words in other kinds or workstreams all carry over; the same fact twice comes in once", () => {
  const p = project("Twins");
  const ch = (id: string, kind: any, workstream: string) => ({ id, base: null, changedAt: 1, status: "active" as const, kind, text: "Use the brand blue", workstream, by: "", note: "", ts: 1 });
  expect(commitChanges(p.home, p.slug, { session: "A", facts: [ch("f1", "decision", "Desktop"), ch("f2", "decision", "Mobile"), ch("f3", "preference", "Desktop"), ch("f4", "decision", "desktop ")], workstreams: [], brief: null, people: [] })).toBe("written");
  const r = room();
  expect(seedFromProject(p.home, p.slug, "B", r.s)).toBe(3);
  expect(r.s.facts().map((f) => `${f.kind}/${f.workstream}`).sort()).toEqual(["decision/Desktop", "decision/Mobile", "preference/Desktop"]);
});

test("a fact with a status the reader doesn't know makes the whole file unreadable, not silently smaller", () => {
  const p = project("Bad status");
  expect(commitChanges(p.home, p.slug, { session: "A", facts: [{ id: "f1", base: null, changedAt: 1, status: "active", kind: "fact", text: "Keep", workstream: "", by: "", note: "", ts: 1 }], workstreams: [], brief: null, people: [] })).toBe("written");
  const db = new Database(contextFile(p.home, p.slug));
  db.exec("UPDATE items SET status = 'archived' WHERE id = 'f1'");
  db.close();
  expect(() => readProjectContext(p.home, p.slug)).toThrow(); // visible failure, never a smaller session
});

// ---------- 3. the export shows only committed state, in order ----------

test("a save that fails leaves the export as it was; the export always matches the database", async () => {
  const p = project("Export");
  const ch = (id: string, text: string) => ({ session: "A", facts: [{ id, base: null, changedAt: Date.now(), status: "active" as const, kind: "fact" as const, text, workstream: "", by: "", note: "", ts: 1 }], workstreams: [], brief: null, people: [] });
  expect(commitChanges(p.home, p.slug, ch("f1", "First"))).toBe("written");
  const before = readFileSync(contextExport(p.home, p.slug), "utf8");
  // The lock is held elsewhere: the save fails, and nothing of it reaches the export.
  const holder = new Database(contextFile(p.home, p.slug));
  holder.exec("BEGIN IMMEDIATE");
  expect(commitChanges(p.home, p.slug, ch("f2", "Never committed"), { waitMs: 100 })).toBe("failed");
  holder.exec("ROLLBACK");
  holder.close();
  expect(readFileSync(contextExport(p.home, p.slug), "utf8")).toBe(before);
  // Many processes saving at once: afterwards the export is exactly the database, at its generation.
  const script = join(dir, "exp-writer.ts");
  writeFileSync(script, `const { commitChanges } = await import(${JSON.stringify(join(import.meta.dir, "../src/carryover.ts"))});
const [home, slug, who] = process.argv.slice(2);
for (let i = 0; i < 40; i++) commitChanges(home, slug, { session: who, facts: [{ id: who + i, base: null, changedAt: Date.now(), status: "active", kind: "fact", text: who + " " + i, workstream: "", by: "", note: "", ts: i }], workstreams: [], brief: null, people: [] }, { waitMs: 10000 });
`);
  const procs = ["p1", "p2", "p3"].map((who) => Bun.spawn(["bun", script, p.home, p.slug, who], { stdout: "ignore", stderr: "inherit", env: { ...process.env, JAMSESH_SILENT: "1" } }));
  for (const pr of procs) expect(await pr.exited).toBe(0);
  const exported = JSON.parse(readFileSync(contextExport(p.home, p.slug), "utf8"));
  const db = readProjectContext(p.home, p.slug)!;
  expect(exported.generation).toBe(db.generation);
  expect(exported.generation).toBe(121);
  expect(exported.facts.map((f: any) => f.text).sort()).toEqual(db.facts.map((f) => f.text).sort());
  expect(exported.facts).toHaveLength(121);
  expect(readdirSync(join(p.home, "projects", p.slug)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
}, 60_000);

// ---------- 4. damage recovery is the same in every process ----------

test("processes that find the database damaged at once all move to the same next generation, losing nothing", async () => {
  const p = project("Damaged");
  const ch = (who: string, i: number) => ({ session: who, facts: [{ id: `${who}${i}`, base: null, changedAt: Date.now(), status: "active" as const, kind: "fact" as const, text: `${who} ${i}`, workstream: "", by: "", note: "", ts: i }], workstreams: [], brief: null, people: [] });
  expect(commitChanges(p.home, p.slug, ch("seed", 0))).toBe("written");
  const first = contextFile(p.home, p.slug);
  for (const ext of ["-wal", "-shm"]) rmSync(first + ext, { force: true });
  writeFileSync(first, "not a database at all");
  const script = join(dir, "rec-writer.ts");
  writeFileSync(script, `const { commitChanges } = await import(${JSON.stringify(join(import.meta.dir, "../src/carryover.ts"))});
const [home, slug, who] = process.argv.slice(2);
let failed = 0;
for (let i = 0; i < 20; i++) if (commitChanges(home, slug, { session: who, facts: [{ id: who + i, base: null, changedAt: Date.now(), status: "active", kind: "fact", text: who + " " + i, workstream: "", by: "", note: "", ts: i }], workstreams: [], brief: null, people: [] }, { waitMs: 10000 }) !== "written") failed++;
process.exit(failed);
`);
  const procs = ["r1", "r2", "r3", "r4"].map((who) => Bun.spawn(["bun", script, p.home, p.slug, who], { stdout: "ignore", stderr: "inherit", env: { ...process.env, JAMSESH_SILENT: "1" } }));
  for (const pr of procs) expect(await pr.exited).toBe(0);
  // The damaged file is untouched; one new generation holds the export's facts and every process's.
  const files = readdirSync(join(p.home, "projects", p.slug)).filter((f) => /^context(-\d+)?\.db$/.test(f)).sort();
  expect(files).toEqual(["context-1.db", "context.db"]);
  expect(readFileSync(first, "utf8")).toBe("not a database at all");
  const all = texts(p);
  expect(all).toHaveLength(81);
  expect(all).toContain("seed 0");
  // Again: recovery doesn't happen twice.
  expect(commitChanges(p.home, p.slug, ch("later", 1))).toBe("written");
  expect(readdirSync(join(p.home, "projects", p.slug)).filter((f) => /^context(-\d+)?\.db$/.test(f))).toHaveLength(2);
}, 60_000);

// ---------- 5. a veto's whole history ----------

test("thirteen overrules keep all thirteen, with who and which lines", () => {
  const r = room();
  const card = r.s.proposeTask({ text: "Make three header variants", mode: "explore", targets: [r.desktop.id], by: "Chey" })!;
  for (let i = 0; i < 13; i++) r.s.board.overrule(card.id, `reason ${i}`, `Person ${i}`, [1000 + i]);
  const vetoes = r.s.board.get(card.id)!.vetoes!;
  expect(vetoes).toHaveLength(13);
  expect(vetoes[0]).toMatchObject({ reason: "reason 0", by: "Person 0", eventIds: [1000] });
  expect(vetoes[12]).toMatchObject({ reason: "reason 12", by: "Person 12", eventIds: [1012] });
});
