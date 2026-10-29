// Phase 4 round 9: recovery fails loudly rather than seeding empty; files never enter the saved brief by being sent;
// an export's generation is validated; the card says what couldn't be read.
import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.JAMSESH_SILENT = "1";

const { Hub } = await import("../src/hub");
const { acceptedEvent } = await import("../src/brain/brain");
const { ContextUnavailable, contextExport, readProjectContext, saveProjectContext, seedFromProject } = await import("../src/carryover");
const { createProject } = await import("../src/projects");
const { Attachments } = await import("../src/attachments");

const dir = mkdtempSync(join(tmpdir(), "jam-r9-"));
const hubs: InstanceType<typeof Hub>[] = [];
afterAll(() => {
  for (const h of hubs) (h.devproxy.stop(), h.stop());
  rmSync(dir, { recursive: true, force: true });
});
function room() {
  const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, String(Math.random())), teamDir: join(dir, "team") });
  hubs.push(hub);
  clearInterval((hub.brain as any).digestTimer);
  return { hub, s: hub.session, chey: hub.session.upsertPerson({ name: "Chey" }) };
}
function saved(name: string) {
  const p = createProject(dir, name);
  const r = room();
  r.s.board.rememberNow({ text: "Left nav, not top tabs", kind: "decision", by: "Chey" });
  expect(saveProjectContext(dir, p.slug, "s1", r.s)).toBe("written");
  return p;
}
const folderOf = (slug: string) => join(contextExport(dir, slug), "..");
const wipeDbs = (slug: string) => {
  for (const f of readdirSync(folderOf(slug))) if (/^context(-\d+)?\.db/.test(f)) rmSync(join(folderOf(slug), f));
};

test("a separate process holding the import lock past the wait: the read fails as unavailable, never as empty, and seeding doesn't start a session empty", async () => {
  const p = saved("Locked");
  wipeDbs(p.slug);
  const file = join(folderOf(p.slug), "context.db");
  const holder = Bun.spawn(["bun", "-e", `const {Database}=require("bun:sqlite");const d=new Database(${JSON.stringify(file)},{create:true});d.exec("PRAGMA journal_mode=WAL;");d.exec("BEGIN IMMEDIATE;");console.log("locked");setTimeout(()=>process.exit(0),6000);`], { stdout: "pipe", stderr: "ignore" });
  try {
    const reader = holder.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("locked");
    expect(() => readProjectContext(dir, p.slug, 300)).toThrow(ContextUnavailable);
    // Seeding waits on the lock (longer) rather than reading nothing: the holder exits after 6 s and the session gets the context.
    const r = room();
    expect(seedFromProject(dir, p.slug, "s2", r.s)).toBe(1);
  } finally {
    holder.kill();
    await holder.exited;
  }
  expect(readProjectContext(dir, p.slug)?.facts.map((f) => f.text)).toEqual(["Left nav, not top tabs"]);
}, 60_000);

test("a message with files is never accepted knowledge for the saved brief, however it was sent", () => {
  const ev = (data: object) => ({ kind: "speech", authorType: "person", data }) as any;
  expect(acceptedEvent(ev({ direct: true }))).toBe(true);
  expect(acceptedEvent(ev({ direct: true, attachments: [{ id: "att_1" }] }))).toBe(false);
  expect(acceptedEvent(ev({ direct: true, attachments: [], noWords: false }))).toBe(true);
});

test("an export's generation must be a count the database could have written: a bogus one is written over, not trusted", () => {
  const p = saved("Generation");
  const file = contextExport(dir, p.slug);
  for (const bad of [1_000_000, -5, 1.5, "7", null]) {
    const ex = JSON.parse(readFileSync(file, "utf8"));
    ex.generation = bad;
    writeFileSync(file, JSON.stringify(ex));
    const r = room();
    r.s.board.rememberNow({ text: `A call ${String(bad)}`, kind: "decision", by: "Chey" });
    expect(saveProjectContext(dir, p.slug, "s2", r.s)).toBe("written");
    const after = JSON.parse(readFileSync(file, "utf8"));
    expect(Number.isSafeInteger(after.generation) && after.generation < 1000).toBe(true);
    expect(after.facts.map((f: any) => f.text)).toContain(`A call ${String(bad)}`);
  }
});

test("a document card says which attachment couldn't be read", async () => {
  const r = room();
  const att = new Attachments(join(dir, "att-unread"));
  r.hub.attachments = att;
  const good = att.save(new TextEncoder().encode("Keep the greeting short.\n"), "notes.txt", "Chey");
  const pdf = att.save(new TextEncoder().encode("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF"), "scan.pdf", "Chey");
  const refs = [good, pdf].map((a) => ({ id: a.id, name: a.name, type: a.type, kind: a.kind, size: a.size }));
  const card = (await r.hub.proposeDocument({ id: 1, authorName: "Chey" } as any, refs))!;
  expect(card.text).toContain("Keep the greeting short.");
  expect(card.text).toContain("Couldn't read: scan.pdf");
  expect(card.needsWording).toBeFalsy();
});

// ---------- round 10 ----------

test("only a sealed export (checksum and completion marker, written last) counts: a plausible partial file is rewritten and never imported", () => {
  const p = saved("Sealed");
  const file = contextExport(dir, p.slug);
  const ex = JSON.parse(readFileSync(file, "utf8"));
  expect(Object.keys(ex).slice(-2)).toEqual(["checksum", "complete"]);
  // Partial: the right generation, no seal.
  writeFileSync(file, JSON.stringify({ generation: ex.generation }));
  const r = room();
  r.s.board.rememberNow({ text: "Another call", kind: "decision", by: "Chey" });
  expect(saveProjectContext(dir, p.slug, "s2", r.s)).toBe("written");
  const fixed = JSON.parse(readFileSync(file, "utf8"));
  expect(fixed.complete).toBe(true);
  expect(fixed.facts.length).toBeGreaterThan(0);
  // A body edited after sealing fails the checksum, so a damaged database doesn't recover from it.
  fixed.facts[0].text = "Edited by hand";
  writeFileSync(file, JSON.stringify(fixed));
  wipeDbs(p.slug);
  expect(readProjectContext(dir, p.slug)?.facts ?? []).toEqual([]);
});

test("an edited card doesn't absorb a later request for what it used to say", () => {
  const r = room();
  const a = r.s.proposeContext({ text: "Use option A", kind: "decision", by: "Chey" })!;
  expect(r.s.board.edit(a.id, { text: "Use option B" }, "Chey").ok).toBe(true);
  const again = r.s.proposeContext({ text: "Use option A", kind: "decision", by: "Felipe" })!;
  expect(again.id).not.toBe(a.id);
});

test("once shutdown begins nothing is taken in: typed messages, room lines and prompt windows are turned away", async () => {
  const r = room();
  const shutting = r.hub.shutdown();
  expect(r.hub.closing).toBe(true);
  expect(() => r.hub.typed(r.chey.id, "hello", false)).toThrow();
  const before = r.s.store.recentEvents({ limit: 50 }).length;
  expect(await r.hub.promptWindow({ deviceId: "d", personId: r.chey.id, t0: Date.now() - 1000, t1: Date.now(), pointer: [], typed: "late words" })).toMatchObject({ ok: false });
  (r.hub as any).roomLine({ id: "u1", eventId: 0, t0: 0, t1: 1, text: "late line", personId: r.chey.id, speakerName: "Chey" }, true);
  expect(r.s.store.recentEvents({ limit: 50 }).length).toBe(before);
  // And over HTTP: every write route is turned away at the router, reads still work.
  const { startHttp } = await import("../src/http");
  const server = startHttp(r.hub, 0);
  try {
    const dev = r.hub.auth.issue({ kind: "browser", label: "A laptop", ip: "10.0.0.5", personId: r.chey.id });
    const call = (method: string, path: string, body?: object) => fetch(`http://127.0.0.1:${server.port}/api${path}`, { method, headers: { "x-forwarded-for": "9.9.9.9", "content-type": "application/json", authorization: `Bearer ${dev.token}` }, body: body ? JSON.stringify(body) : undefined });
    for (const [path, body] of [["/say", { text: "late" }], ["/audio?deviceId=d&t0=1&t1=2", {}], ["/prompt-window", { deviceId: "d", t0: 1, t1: 2 }], ["/prompt-window/start", { deviceId: "d" }]] as const) expect((await call("POST", path, body)).status).toBe(503);
    expect((await call("GET", "/state")).status).toBe(200);
  } finally {
    server.stop(true);
  }
  await shutting;
});
