// Phase 4, seventh review: the export is a full copy of the rows (tombstones and versions), so recovery restores a
// retirement; seeding recovers a damaged database before reading; only a change the merge applied counts as saved,
// and one that lost comes back as the row stands with its wording on the Tasks board; an export that fails fails the
// save and is written by the next one; a multi-agent Send with one agent gone sends nothing; Merge stays within a
// fact's kind, workstream and platform.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.JAMSESH_SILENT = "1";

const { Hub } = await import("../src/hub");
const { commitChanges, contextExport, contextFile, readProjectContext, saveProjectContext, seedFromProject } = await import("../src/carryover");
const { createProject } = await import("../src/projects");

const dir = mkdtempSync(join(tmpdir(), "jam-p4r7-"));
const hubs: InstanceType<typeof Hub>[] = [];
afterAll(() => {
  for (const h of hubs) (h.devproxy.stop(), h.stop());
  rmSync(dir, { recursive: true, force: true });
});

function room() {
  const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, String(Math.random())), teamDir: join(dir, "team") });
  hubs.push(hub);
  clearInterval((hub.brain as any).digestTimer);
  const s = hub.session;
  s.updateSettings({ voiceReplies: false, hostControl: false });
  const reg = (owner: string, repo: string) => s.registerAgent({ ownerName: owner, harness: "claude-code", repo, cwd: `/${owner}/${repo}`, machine: owner, platform: "desktop" }).agent;
  return { hub, s, desktop: reg("Felipe", "acme/desktop"), web: reg("Chey", "acme/web") };
}
function project(name: string) {
  const home = mkdtempSync(join(dir, "home-"));
  return { home, slug: createProject(home, name).slug };
}
const texts = (p: { home: string; slug: string }) => readProjectContext(p.home, p.slug)!.facts.map((f) => f.text).sort();
const damage = (p: { home: string; slug: string }) => {
  const f = contextFile(p.home, p.slug);
  for (const ext of ["-wal", "-shm"]) rmSync(f + ext, { force: true });
  writeFileSync(f, "not a database");
};

// ---------- 1. recovery keeps tombstones ----------

test("retire, damage, recover, then an older session's edit: the fact stays retired", () => {
  const p = project("Tombstone");
  const a = room();
  a.s.board.rememberNow({ text: "Header uses option A", kind: "decision", by: "Chey" });
  a.s.board.rememberNow({ text: "Footer is dark", kind: "decision", by: "Chey" });
  expect(saveProjectContext(p.home, p.slug, "A", a.s)).toBe("written");
  const b = room();
  seedFromProject(p.home, p.slug, "B", b.s);
  const x = b.s.facts().find((f) => f.text === "Header uses option A")!;
  b.s.store.put("facts", { ...x, status: "superseded", updatedAt: Date.now() });
  expect(saveProjectContext(p.home, p.slug, "B", b.s)).toBe("written");
  // The export holds the tombstone and every version.
  const exported = JSON.parse(readFileSync(contextExport(p.home, p.slug), "utf8"));
  expect(exported.rows.items.find((r: any) => r.status === "superseded")).toMatchObject({ type: "fact", version: 2 });
  damage(p);
  // A (which never saw the retirement) rewrites the fact and saves: recovery restores the tombstone, and it holds.
  const mine = a.s.facts().find((f) => f.text === "Header uses option A")!;
  a.s.store.put("facts", { ...mine, text: "Header uses option A, larger", updatedAt: Date.now() + 1000 });
  expect(saveProjectContext(p.home, p.slug, "A", a.s)).toBe("written");
  expect(contextFile(p.home, p.slug)).toEndWith("context-1.db");
  expect(texts(p)).toEqual(["Footer is dark"]);
  // In A, the fact is now retired as the project has it, and A's wording waits on the Tasks board.
  expect(a.s.store.get("facts", mine.id)!.status).toBe("superseded");
  expect(a.s.board.open().map((c) => c.text)).toContain("Header uses option A, larger");
  // Saved again: nothing more to write.
  expect(saveProjectContext(p.home, p.slug, "A", a.s)).toBe("skipped");
});

// ---------- 2. seeding recovers first ----------

test("a new session of a project whose database is damaged is seeded from the recovered export, never empty", () => {
  const p = project("Seed after damage");
  const a = room();
  a.s.board.rememberNow({ text: "Use 8px grid", kind: "decision", by: "Chey" });
  a.s.store.put("workstreams", { id: "w_nav", title: "Nav", ownerAgentId: null, status: "active", brief: "", updatedAt: Date.now() });
  expect(saveProjectContext(p.home, p.slug, "A", a.s)).toBe("written");
  damage(p);
  const b = room();
  expect(seedFromProject(p.home, p.slug, "B", b.s)).toBe(2);
  expect(b.s.facts().map((f) => f.text)).toEqual(["Use 8px grid"]);
  expect(contextFile(p.home, p.slug)).toEndWith("context-1.db");
  // With the export unreadable as well, recovery has nothing to restore from: the start fails loudly rather than seeding an empty session.
  damage(p);
  writeFileSync(contextExport(p.home, p.slug), "{ broken");
  const c = room();
  expect(() => seedFromProject(p.home, p.slug, "C", c.s)).toThrow();
});

// ---------- 3. only an applied change counts as saved ----------

test("a stale edit that lost isn't marked saved: the session takes the winning row, and its wording waits on the board", () => {
  const p = project("Lost edit");
  const a = room();
  a.s.board.rememberNow({ text: "Grid is 8px", kind: "decision", by: "Chey" });
  expect(saveProjectContext(p.home, p.slug, "A", a.s)).toBe("written");
  const b = room();
  const c = room();
  seedFromProject(p.home, p.slug, "B", b.s);
  seedFromProject(p.home, p.slug, "C", c.s);
  const t = Date.now();
  // C edits first, B edits later; B saves first, then C: C's (earlier, blind) edit loses.
  c.s.store.put("facts", { ...c.s.facts()[0], text: "Grid is 10px", updatedAt: t + 1000 });
  b.s.store.put("facts", { ...b.s.facts()[0], text: "Grid is 12px", updatedAt: t + 2000 });
  expect(saveProjectContext(p.home, p.slug, "B", b.s)).toBe("written");
  expect(saveProjectContext(p.home, p.slug, "C", c.s)).toBe("written");
  expect(texts(p)).toEqual(["Grid is 12px"]);
  expect(c.s.facts().filter((f) => f.status === "active").map((f) => f.text)).toEqual(["Grid is 12px"]);
  expect(c.s.board.open().map((x) => x.text)).toContain("Grid is 10px");
  // C's next save doesn't retry the lost edit, and doesn't undo B's.
  expect(saveProjectContext(p.home, p.slug, "C", c.s)).toBe("skipped");
  // A person adds C's wording again from the card: that is a new accepted fact and is saved.
  const card = c.s.board.open().find((x) => x.text === "Grid is 10px")!;
  expect(c.s.board.add(card.id, "Chey").ok).toBe(true);
  expect(saveProjectContext(p.home, p.slug, "C", c.s)).toBe("written");
  expect(texts(p)).toEqual(["Grid is 10px", "Grid is 12px"]);
});

// ---------- 4. a failed export fails the save, and the next save writes it ----------

test("an export that can't be written fails the save with the reason; the next save writes it, even with nothing new", () => {
  const p = project("Export fails");
  const a = room();
  a.s.board.rememberNow({ text: "First", kind: "fact", by: "Chey" });
  expect(saveProjectContext(p.home, p.slug, "A", a.s)).toBe("written");
  // Something in the way of the export: a folder where the file goes.
  rmSync(contextExport(p.home, p.slug));
  mkdirSync(join(contextExport(p.home, p.slug), "blocker"), { recursive: true });
  a.s.board.rememberNow({ text: "Second", kind: "fact", by: "Chey" });
  const result = { applied: new Map(), superseded: new Map() } as any;
  const out = commitChanges(p.home, p.slug, { session: "A", facts: [{ id: "f_x", base: null, changedAt: Date.now(), status: "active", kind: "fact", text: "Third", workstream: "", by: "", note: "", ts: 1 }], workstreams: [], brief: null, people: [] }, { result });
  expect(out).toBe("failed");
  expect(result.committed).toBe(true);
  expect(result.reason).toContain("export");
  expect(saveProjectContext(p.home, p.slug, "A", a.s)).toBe("failed");
  // The database has both; the keeper reported the failure. Clear the way: the next save writes the export.
  expect(texts(p)).toEqual(["First", "Second", "Third"]);
  rmSync(contextExport(p.home, p.slug), { recursive: true, force: true });
  expect(saveProjectContext(p.home, p.slug, "A", a.s)).toBe("skipped");
  expect(JSON.parse(readFileSync(contextExport(p.home, p.slug), "utf8")).facts.map((f: any) => f.text).sort()).toEqual(["First", "Second", "Third"]);
});

// ---------- 5. a multi-agent Send with one agent gone sends nothing ----------

test("Send with one of two agents gone sends to neither, names the missing one on the card, and works after Edit", () => {
  const r = room();
  const card = r.s.proposeTask({ text: "Match the header on desktop and web", mode: "coordinate", targets: [r.desktop.id, r.web.id], by: "Chey" })!;
  r.s.removeAgent(r.web.id);
  const res = r.s.board.send(card.id, "Chey");
  expect(res).toMatchObject({ ok: false, status: 409 });
  expect((res as any).error).toContain("Chey's Claude");
  expect(r.s.directives()).toHaveLength(0);
  expect(r.s.board.get(card.id)).toMatchObject({ status: "open", unavailable: ["Chey's Claude"] });
  expect(r.s.board.send(card.id, "Chey", { targets: [r.desktop.id] }).ok).toBe(true);
  expect(r.s.directives().map((d) => d.targets)).toEqual([[r.desktop.id]]);
  expect(r.s.board.get(card.id)!.unavailable).toBeUndefined();
});

// ---------- 6. Merge stays within a fact's kind, workstream and platform ----------

test("Merge is refused into a fact of another kind, workstream or platform, and works within its own", () => {
  const r = room();
  const desk = r.s.board.rememberNow({ text: "Desktop header is 64px tall", kind: "requirement", workstream: "Header", by: "Chey" })!;
  const pref = r.s.board.rememberNow({ text: "Header feels airy", kind: "preference", workstream: "Header", by: "Chey" })!;
  const other = r.s.board.rememberNow({ text: "Footer links are grey", kind: "requirement", workstream: "Footer", by: "Chey" })!;
  const mobile = r.s.proposeContext({ text: "Mobile header has a back button", kind: "requirement", workstream: "Header", by: "Felipe" })!;
  for (const f of [desk, pref, other]) expect(r.s.board.merge(mobile.id, f.id, "Chey")).toMatchObject({ ok: false });
  expect(r.s.board.get(mobile.id)!.status).toBe("open");
  expect(r.s.facts().find((f) => f.id === desk.id)!.text).toBe("Desktop header is 64px tall");
  const card = r.s.proposeContext({ text: "Desktop header has the logo on the left", kind: "requirement", workstream: "Header", by: "Felipe" })!;
  expect(r.s.board.merge(card.id, desk.id, "Chey").ok).toBe(true);
});
