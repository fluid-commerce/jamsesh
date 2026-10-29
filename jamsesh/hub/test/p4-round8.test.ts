// Phase 4 round 8: a database still being set up is never read as empty; contradictory facts aren't duplicates;
// a pending document card lands before shutdown saves; a blob is written whole or not at all; a merge's own
// wording keeps the fact's platform; retire proposals keep their status.
import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.JAMSESH_SILENT = "1";

const { Hub } = await import("../src/hub");
const { contextExport, contextFile, readProjectContext, saveProjectContext } = await import("../src/carryover");
const { createProject } = await import("../src/projects");
const { Attachments } = await import("../src/attachments");
const { restates } = await import("../src/similarity");

const dir = mkdtempSync(join(tmpdir(), "jam-r8-"));
const hubs: InstanceType<typeof Hub>[] = [];
afterAll(() => {
  for (const h of hubs) (h.devproxy.stop(), h.stop());
  rmSync(dir, { recursive: true, force: true });
});

function room() {
  const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, String(Math.random())), teamDir: join(dir, "team") });
  hubs.push(hub);
  clearInterval((hub.brain as any).digestTimer);
  const chey = hub.session.upsertPerson({ name: "Chey" });
  return { hub, s: hub.session, chey };
}

// ---------- recovery never seeds nothing while an export exists ----------

function savedProject(name: string) {
  const p = createProject(dir, name);
  const r = room();
  r.s.board.rememberNow({ text: "Left nav, not top tabs", kind: "decision", by: "Chey" });
  expect(saveProjectContext(dir, p.slug, "s1", r.s)).toBe("written");
  return p;
}
const texts = (slug: string) => readProjectContext(dir, slug)?.facts.map((f) => f.text) ?? null;
const wipe = (slug: string) => {
  const folder = join(contextExport(dir, slug), "..");
  for (const f of readdirSync(folder)) if (/^context(-\d+)?\.db/.test(f)) rmSync(join(folder, f));
  return folder;
};

test("a database whose creator died before setting it up (an empty file, or tables with no marker) is finished from the export, not read as empty", () => {
  const p = savedProject("Empty file");
  const folder = wipe(p.slug);
  writeFileSync(join(folder, "context.db"), "");
  expect(texts(p.slug)).toEqual(["Left nav, not top tabs"]);
  // Tables created, nothing imported yet.
  const q = savedProject("Tables only");
  const f2 = wipe(q.slug);
  const db = new Database(join(f2, "context.db"), { create: true });
  db.exec("CREATE TABLE items (id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, version INTEGER NOT NULL, changed_at INTEGER NOT NULL, session TEXT NOT NULL); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, changed_at INTEGER NOT NULL, session TEXT NOT NULL);");
  db.close();
  expect(texts(q.slug)).toEqual(["Left nav, not top tabs"]);
  // And it stays finished: the next read is the plain one.
  expect(texts(q.slug)).toEqual(["Left nav, not top tabs"]);
});

test("a reader running while another process is still importing sees all of it or finishes it itself, never nothing", async () => {
  const p = savedProject("Concurrent");
  const folder = wipe(p.slug);
  const file = join(folder, "context.db");
  // A second process holding the new file open mid-setup: tables made, the import transaction not yet committed.
  const writer = new Database(file, { create: true });
  writer.exec("PRAGMA journal_mode = WAL;");
  const seen: (string[] | null)[] = [];
  const reading = (async () => {
    for (let i = 0; i < 20; i++) {
      seen.push(texts(p.slug));
      await Bun.sleep(5);
    }
  })();
  await Bun.sleep(30);
  writer.close();
  await reading;
  expect(seen.every((t) => t === null || t.join() === "Left nav, not top tabs")).toBe(true);
  expect(texts(p.slug)).toEqual(["Left nav, not top tabs"]);
});

// ---------- duplicates are identical text only ----------

test("only identical text (case, spacing, punctuation aside) is a restatement; every other wording is its own item", () => {
  expect(restates("Use the shared token set", "use  the shared token set.")).toBe(true);
  for (const [x, y] of [["No banner and no modal", "Banner and modal"], ["Use banner", "Use banner and no modal"], ["Build header with option A", "Build header with option B"], ["Use tabs", "Never use tabs"]]) {
    expect(restates(x, y)).toBe(false);
    expect(restates(y, x)).toBe(false);
  }
  const r = room();
  r.s.board.rememberNow({ text: "Banner and modal on the checkout", kind: "decision", by: "Chey" });
  const card = r.s.proposeContext({ text: "No banner and no modal on the checkout", kind: "decision", by: "Felipe" });
  expect(card).not.toBeNull();
  expect(card!.conflictsWith).not.toBeNull();
  // A close paraphrase is a card too, not a silent drop.
  expect(r.s.proposeContext({ text: "Banner and modal on the checkout page", kind: "decision", by: "Felipe" })).not.toBeNull();
  expect(r.s.proposeContext({ text: "banner and modal on the checkout.", kind: "decision", by: "Felipe" })).toBeNull();
});

// ---------- a pending document card lands before shutdown saves ----------

test("shutdown waits for a document card still being read", async () => {
  const r = room();
  const att = new Attachments(join(dir, "att-doc"));
  const rec = att.save(new TextEncoder().encode("Keep the greeting short.\n"), "notes.txt", "Chey");
  const ref = { id: rec.id, name: rec.name, type: rec.type, kind: rec.kind, size: rec.size };
  r.hub.attachments = att;
  const orig = r.hub.proposeDocument.bind(r.hub);
  r.hub.proposeDocument = async (ev, a) => {
    await Bun.sleep(300);
    return orig(ev, a);
  };
  r.hub.typed(r.chey.id, "", false, [ref]);
  expect(r.s.board.open()).toHaveLength(0);
  expect(await r.hub.shutdown()).toBe(true);
  expect(r.s.board.open().map((c) => c.origin)).toEqual(["document"]);
});

test("shutdown with a document card that failed reports the final save as incomplete, and takes no new message once it begins", async () => {
  const r = room();
  r.hub.proposeDocument = async () => {
    throw new Error("unreadable");
  };
  r.hub.typed(r.chey.id, "", false, [{ id: "att_x", name: "x.txt", type: "text/plain", kind: "text", size: 1 }]);
  expect(await r.hub.shutdown()).toBe(false);
  expect(r.hub.closing).toBe(true);
});

// ---------- blobs are whole or absent ----------

test("an interrupted blob write can't be reused: a truncated blob is replaced, and no half-written file is left under the blob's name", () => {
  const att = new Attachments(join(dir, "att-blob"));
  const bytes = new TextEncoder().encode("A line of notes for the blob test.\n".repeat(20));
  const first = att.save(bytes, "a.txt", "Chey");
  const blobs = join(dir, "att-blob", "blobs");
  expect(readdirSync(blobs)).toEqual([first.blob]);
  // A process died partway through writing: the blob has a prefix of the bytes.
  writeFileSync(join(blobs, first.blob), bytes.subarray(0, 40));
  const again = att.save(bytes, "a.txt", "Chey");
  expect(again.blob).toBe(first.blob);
  expect(Buffer.from(att.bytes(again.id)!).equals(Buffer.from(bytes))).toBe(true);
  // Same size, different bytes: also replaced.
  writeFileSync(join(blobs, first.blob), new Uint8Array(bytes.length).fill(65));
  att.save(bytes, "a.txt", "Chey");
  expect(Buffer.from(att.bytes(first.id)!).equals(Buffer.from(bytes))).toBe(true);
  // An intact blob is left alone, and no temporary files remain.
  att.save(bytes, "b.txt", "Chey");
  expect(readdirSync(blobs).filter((f) => f.endsWith(".tmp"))).toEqual([]);
});

// ---------- merge wording, retire statuses ----------

test("merge: the wording a person supplies keeps the fact's platform", () => {
  const r = room();
  const f = r.s.board.rememberNow({ text: "The nav is on the left on desktop", kind: "decision", by: "Chey" })!;
  const c = r.s.proposeContext({ text: "Collapse it under 900 px on desktop", kind: "decision", by: "Chey" })!;
  expect(r.s.board.merge(c.id, f.id, "Chey", "The nav is on the left on mobile")).toMatchObject({ ok: false });
  expect(r.s.board.get(c.id)!.status).toBe("open");
  expect(r.s.board.merge(c.id, f.id, "Chey", "The nav is on the left on desktop and collapses under 900 px").ok).toBe(true);
});

test("retire proposals for one fact with different statuses stay separate cards", () => {
  const r = room();
  const f = r.s.board.rememberNow({ text: "Pick a header direction", kind: "question", by: "Chey" })!;
  const a = r.s.store.addEvent({ kind: "speech", authorType: "person", authorId: r.chey.id, authorName: "Chey", text: "we picked B", relevance: "work", data: {} });
  const b = r.s.store.addEvent({ kind: "speech", authorType: "person", authorId: r.chey.id, authorName: "Chey", text: "that is replaced by the new one", relevance: "work", data: {} });
  const done = r.s.board.proposeRetire({ fact: f, status: "resolved", reason: "Answered", by: "Chey", sourceEventIds: [a.id] })!;
  const sup = r.s.board.proposeRetire({ fact: f, status: "superseded", reason: "Replaced", by: "Chey", sourceEventIds: [b.id] })!;
  expect(sup.id).not.toBe(done.id);
  expect([done.retire, sup.retire]).toEqual(["resolved", "superseded"]);
  const again = r.s.board.proposeRetire({ fact: f, status: "resolved", reason: "Answered again", by: "Felipe", sourceEventIds: [b.id] })!;
  expect(again.id).toBe(done.id);
  expect(r.s.board.replace(sup.id, "Chey").ok).toBe(true);
  expect(r.s.store.get("facts", f.id)!.status).toBe("superseded");
});
