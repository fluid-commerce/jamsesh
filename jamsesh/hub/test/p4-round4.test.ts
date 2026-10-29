// Phase 4, fourth review: curation and Replace stay within a fact's kind, workstream and platform; a failed
// carry-over save is a failed shutdown; one message can't carry 120 MB of PDFs; an unpaired process on loopback
// can't read attachments; an ask said again after a veto is a new card. The model is a stand-in; no gateway key is needed.
import { afterAll, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ai from "ai";

process.env.JAMSESH_SILENT = "1";

const calls: { prompt?: string; messages?: any[]; tools?: Record<string, any> }[] = [];
mock.module("ai", () => ({
  ...ai,
  generateText: async (o: any) => {
    calls.push({ prompt: o.prompt, messages: o.messages, tools: o.tools });
    return { text: "ok" };
  },
}));

const { Hub } = await import("../src/hub");
const { startHttp } = await import("../src/http");
const { config } = await import("../src/config");
const { contextFile, readProjectContext, saveProjectContext } = await import("../src/carryover");
const { Database } = await import("bun:sqlite");
const { createProject, openSession } = await import("../src/projects");
const { applyCuration } = await import("../src/brain/curation");
const { MAX_MESSAGE_BYTES, AttachmentError } = await import("../src/attachments");
const { ProjectKeeper } = await import("../src/projectkeeper");

const wasOffline = config.offline;
config.offline = false;
const dir = mkdtempSync(join(tmpdir(), "jam-p4r4-"));
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
  const felipe = s.upsertPerson({ name: "Felipe" });
  const desktop = s.registerAgent({ ownerName: "Felipe", harness: "claude-code", repo: "acme/desktop", cwd: "/f/d", machine: "f", platform: "desktop" }).agent;
  const said = (who: { id: string; name: string }, text: string, data: Record<string, any> = {}) => s.store.addEvent({ kind: "speech", authorType: "person", authorId: who.id, authorName: who.name, text, relevance: "work", data });
  return { hub, s, chey, felipe, desktop, said };
}

// ---------- 2. a replacement stays within a fact's kind, workstream and platform ----------

test("curation doesn't pair an addition with a retired fact of another platform, kind or workstream", () => {
  const r = room();
  const desk = r.s.board.rememberNow({ text: "Desktop header uses option A", kind: "decision", by: "Chey" })!;
  const ev = r.said(r.felipe, "mobile header uses option B, and drop the desktop one");
  const added: { text: string; replaces?: string }[] = [];
  const hold = { add: (f: any, replaces?: string) => void added.push({ text: f.text, replaces }), retire: () => {} };
  applyCuration(r.s, { add: [{ kind: "decision", text: "Mobile header uses option B", eventIds: [ev.id] }], update: [], resolve: [], supersede: [{ id: desk.id, reason: "dropped", eventIds: [ev.id] }] }, [ev], hold);
  expect(added).toEqual([{ text: "Mobile header uses option B", replaces: undefined }]);
  // Another kind is not paired either.
  const req = r.s.board.rememberNow({ text: "Header uses option A", kind: "requirement", by: "Chey" })!;
  const added2: { replaces?: string }[] = [];
  applyCuration(r.s, { add: [{ kind: "decision", text: "Header uses option B", eventIds: [ev.id] }], update: [], resolve: [], supersede: [{ id: req.id, reason: "changed", eventIds: [ev.id] }] }, [ev], { add: (_f: any, replaces?: string) => void added2.push({ replaces }), retire: () => {} });
  expect(added2).toEqual([{ replaces: undefined }]);
});

test("a named replacement across platforms is another fact, and Replace re-checks the card as edited", () => {
  const r = room();
  const desk = r.s.board.rememberNow({ text: "Desktop header uses option A", kind: "decision", by: "Chey" })!;
  // A named fact of another platform is not "replaced": the card is a new fact.
  const card = r.s.proposeContext({ text: "Mobile header uses option B", kind: "decision", by: "Felipe", replaces: desk.id })!;
  expect(card.conflictsWith).toBeNull();
  expect(r.s.board.replace(card.id, "Chey", desk.id)).toMatchObject({ ok: false, status: 400 });
  expect(r.s.store.get("facts", desk.id)!.status).toBe("active");
  // A card that does replace desktop's, edited to say mobile just before Replace, is refused too.
  const same = r.s.proposeContext({ text: "Desktop header uses option B", kind: "decision", by: "Felipe" })!;
  expect(same.conflictsWith).toBe(desk.id);
  const refused = r.s.board.replace(same.id, "Chey", undefined, { text: "Mobile header uses option B" });
  expect(refused).toMatchObject({ ok: false });
  expect(r.s.store.get("facts", desk.id)!.status).toBe("active");
  expect(r.s.board.get(same.id)!.status).toBe("open");
  // Edited to another workstream or kind: refused.
  expect(r.s.board.replace(same.id, "Chey", undefined, { workstream: "Settings" })).toMatchObject({ ok: false });
  expect(r.s.board.replace(same.id, "Chey", undefined, { kind: "preference" })).toMatchObject({ ok: false });
  // The honest case still works.
  expect(r.s.board.replace(same.id, "Chey")).toMatchObject({ ok: true });
  expect(r.s.store.get("facts", desk.id)!.status).toBe("superseded");
});

// ---------- 4. a failed carry-over save is a failed shutdown ----------

test("a context save that fails fails the keeper step and the shutdown; a deliberate skip doesn't", async () => {
  const home = mkdtempSync(join(dir, "home-"));
  const p = createProject(home, "Settings");
  const opened = openSession(home, p.slug, { fresh: true });
  const r = room();
  r.s.board.rememberNow({ text: "Header uses option A", kind: "decision", by: "Chey" });
  // Written: fine.
  const keeper = new ProjectKeeper(r.hub, home, { slug: p.slug, sessionId: opened.sessionId });
  await expect(keeper.save()).resolves.toBeUndefined();
  expect(readProjectContext(home, p.slug)!.facts).toHaveLength(1);
  // A session with nothing settled writes nothing: a skip, not a failure.
  const idle = room();
  expect(saveProjectContext(home, p.slug, "idle-session", idle.s)).toBe("skipped");
  await expect(new ProjectKeeper(idle.hub, home, { slug: p.slug, sessionId: "idle-session" }).save()).resolves.toBeUndefined();
  // The write lock held by another connection: the write can't happen. That is a failure the keeper reports.
  const holder = new Database(contextFile(home, p.slug));
  holder.exec("BEGIN IMMEDIATE");
  r.s.board.rememberNow({ text: "Sidebar uses option C", kind: "decision", by: "Chey" });
  expect(saveProjectContext(home, p.slug, opened.sessionId, r.s, 100)).toBe("failed");
  r.s.board.rememberNow({ text: "Footer uses option B", kind: "decision", by: "Chey" });
  const hung = new ProjectKeeper(r.hub, home, { slug: p.slug, sessionId: opened.sessionId });
  await expect(hung.save()).rejects.toThrow("wasn't saved");
  // And Hub.shutdown reports it (not a clean exit).
  (r.hub as any).keeper = hung;
  (r.hub as any).autosave.save = async () => {};
  (r.hub as any).net.stop = async () => {};
  expect(await r.hub.shutdown()).toBe(false);
  holder.exec("ROLLBACK");
  holder.close();
}, 30_000);

// ---------- 5. one message can't carry unbounded files ----------

test("six valid PDFs are refused as one message, and the model gets at most its byte cap of file parts", async () => {
  const r = room();
  const pdf = (n: number) => {
    const b = new Uint8Array(n);
    b.set(new TextEncoder().encode("%PDF-1.4\n"));
    b.fill(0x20, 9);
    b[0] = 0x25;
    return b;
  };
  const make = (n: number, i: number) => {
    const b = pdf(n);
    b[10] = 48 + i; // different bytes, so they are six files
    return r.hub.attachments.save(b, `doc${i}.pdf`, "Chey");
  };
  const recs = [0, 1, 2, 3, 4, 5].map((i) => make(19 * 1024 * 1024, i));
  expect(() => r.hub.attachments.refs(recs.map((x) => x.id))).toThrow(AttachmentError);
  try {
    r.hub.attachments.refs(recs.map((x) => x.id));
  } catch (e: any) {
    expect(e.status).toBe(413);
  }
  // One at a time is fine, up to the cap.
  expect(r.hub.attachments.refs([recs[0].id])).toHaveLength(1);
  expect(MAX_MESSAGE_BYTES).toBeLessThan(6 * 19 * 1024 * 1024);
  // Straight to the model (a message made before the cap, say): the parts are capped and the rest named.
  const seen = r.hub.attachments.brainInput(recs.map((x) => r.hub.attachments.ref(x.id)!));
  const bytes = seen.parts.reduce((n, p) => n + p.data.length, 0);
  expect(bytes).toBeLessThanOrEqual(15 * 1024 * 1024);
  expect(seen.parts.length).toBeLessThan(6);
  expect(seen.text).toContain("not shown");
});

// ---------- 6. attachments are read by the paired, not by any process on loopback ----------

test("an unpaired local process gets 401 for an attachment; the host window and a paired device get it", async () => {
  const r = room();
  const server = startHttp(r.hub, 0);
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const rec = r.hub.attachments.save(new TextEncoder().encode("hello"), "note.txt", "Chey");
    expect((await fetch(`${base}/api/attachments/${rec.id}`)).status).toBe(401);
    expect((await fetch(`${base}/api/attachments/${rec.id}`, { method: "HEAD" })).status).toBe(401);
    expect((await fetch(`${base}/api/attachments/${rec.id}`, { headers: { cookie: "jam_window=not-the-key" } })).status).toBe(401);
    const key = r.hub.auth.windows.take(r.hub.auth.windows.mint());
    const ok = await fetch(`${base}/api/attachments/${rec.id}`, { headers: { cookie: `jam_window=${key}` } });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("hello");
    const dev = r.hub.auth.issue({ kind: "browser", label: "Chey's laptop", ip: "10.0.0.5", personId: r.chey.id });
    expect((await fetch(`${base}/api/attachments/${rec.id}`, { headers: { "x-forwarded-for": "9.9.9.9", authorization: `Bearer ${dev.token}` } })).status).toBe(200);
  } finally {
    server.stop(true);
  }
});

// ---------- 7. files that can't be read keep the file-pass restrictions ----------

test("attached files that are gone still make a file pass, with the person told and no work tools", async () => {
  const r = room();
  const rec = r.hub.attachments.save(new TextEncoder().encode("secret plan"), "plan.txt", "Chey");
  const ref = r.hub.attachments.ref(rec.id)!;
  rmSync(join((r.hub.attachments as any).dir, "blobs", rec.blob));
  const ev = r.s.store.addEvent({ kind: "speech", authorType: "person", authorId: r.chey.id, authorName: "Chey", text: "What does this say?", relevance: "work", data: { typed: true, direct: true, attachments: [ref] } });
  calls.length = 0;
  await (r.hub.brain as any).directPass(ev, "");
  const call = calls.at(-1)!;
  expect(Object.keys(call.tools!).sort()).toEqual(["no_action", "say_to_room", "search_artifacts"]);
  expect(call.prompt).toContain("could not read");
});

// ---------- 8. the scenario: the same ask from a second person ----------

test("an ask said again after a veto is a new card; the vetoed card keeps its veto", () => {
  const r = room();
  const text = "Make three variants of the mobile profile screen";
  const first = r.s.proposeTask({ text, mode: "explore", targets: [r.desktop.id], by: "Chey" })!;
  r.s.board.overrule(first.id, "Room confirmed the request, so it is being sent directly");
  expect(r.s.board.get(first.id)!.overruled).toBeTruthy();
  const again = r.s.proposeTask({ text, mode: "explore", targets: [r.desktop.id], by: "Britain" })!;
  expect(again.id).not.toBe(first.id);
  expect(again.renews).toBe(first.id);
  expect(again.overruled).toBeUndefined();
  expect(r.s.board.get(first.id)!.overruled).toBeTruthy();
  // Said a third time: it joins the new card.
  expect(r.s.proposeTask({ text, mode: "explore", targets: [r.desktop.id], by: "Felipe" })!.id).toBe(again.id);
  expect(r.s.board.open()).toHaveLength(2);
});
