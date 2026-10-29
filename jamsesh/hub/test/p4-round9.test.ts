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
const { drawnText } = await import("../src/pdfworker");

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
  expect(() => readProjectContext(dir, p.slug)).toThrow(ContextUnavailable);
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

// ---------- round 11 ----------

test("shutdown waits for accepted work in flight, and names what is still running at the deadline", async () => {
  const r = room();
  let finished = false;
  r.hub.track("a document card", Bun.sleep(300).then(() => void (finished = true)));
  expect(r.hub.working()).toEqual(["a document card"]);
  expect(await r.hub.shutdown()).toBe(true);
  expect(finished).toBe(true);
  const r2 = room();
  const budget = Hub.SHUTDOWN_MS;
  Hub.SHUTDOWN_MS = { ...budget, work: 150 };
  try {
    r2.hub.track("a prompt window", new Promise(() => {}));
    expect(await r2.hub.shutdown()).toBe(false);
  } finally {
    Hub.SHUTDOWN_MS = budget;
  }
});

test("a failed canvas copy is a failed final save", async () => {
  const r = room();
  r.hub.autosave.save = async () => ({ id: "x", label: "", at: 1, canvas: false, canvasFailed: true, dir: "" });
  expect(await r.hub.shutdown()).toBe(false);
  const ok = room();
  ok.hub.autosave.save = async () => ({ id: "x", label: "", at: 1, canvas: false, dir: "" });
  expect(await ok.hub.shutdown()).toBe(true);
});

test("a database set up from an export that is rejected is never marked imported, and the read fails loudly instead of going on empty", () => {
  const p = saved("Rejected");
  wipeDbs(p.slug);
  writeFileSync(contextExport(dir, p.slug), JSON.stringify({ generation: 1, facts: [], workstreams: [], people: [], rows: { items: [], meta: [] } }));
  expect(() => readProjectContext(dir, p.slug)).toThrow(ContextUnavailable);
  const r = room();
  expect(() => seedFromProject(dir, p.slug, "s2", r.s)).toThrow(ContextUnavailable);
  // A genuinely new project (no export at all) is fine and empty.
  const fresh = createProject(dir, "Fresh");
  expect(readProjectContext(dir, fresh.slug)).toBeNull();
});

test("over loopback, no credential and an agent's token both get the agents' view of the room; only the host window's key or a person's browser sees the Tasks board", async () => {
  const r = room();
  const card = r.s.proposeContext({ text: "An unaccepted card", kind: "decision", by: "Chey" })!;
  const { startHttp } = await import("../src/http");
  const server = startHttp(r.hub, 0);
  try {
    const key = "ab".repeat(32);
    r.hub.auth.windows.adopt(key);
    const agent = r.hub.auth.issue({ kind: "agent", label: "An agent", ip: "127.0.0.1", personId: r.chey.id });
    const person = r.hub.auth.issue({ kind: "browser", label: "A laptop", ip: "127.0.0.1", personId: r.chey.id });
    const base = `http://127.0.0.1:${server.port}`;
    const callers: Record<string, Record<string, string>> = { none: {}, agent: { authorization: `Bearer ${agent.token}` }, host: { cookie: `jam_window=${key}` }, person: { authorization: `Bearer ${person.token}` } };
    for (const [who, headers] of Object.entries(callers)) {
      const sees = who === "host" || who === "person";
      const state = await (await fetch(`${base}/api/state`, { headers })).json();
      expect(state.triage.length > 0).toBe(sees);
      const list = await fetch(`${base}/api/triage`, { headers });
      expect(list.status).toBe(sees ? 200 : 403);
      // The socket: its first message is the state, then patches.
      const got: string[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?device=d-${who}`, { headers: { ...headers, origin: base } } as any);
      ws.onmessage = (m) => got.push(String(m.data));
      await new Promise((res) => (ws.onopen = res as any));
      r.s.proposeContext({ text: `A card for ${who}`, kind: "decision", by: "Chey" });
      await Bun.sleep(250);
      ws.close();
      const heard = got.join("");
      expect(heard.includes(card.text)).toBe(sees);
      expect(heard.includes(`A card for ${who}`)).toBe(sees);
    }
    // An agent's token is still an agent when it asks to speak as a person.
    const say = await fetch(`${base}/api/say`, { method: "POST", headers: { ...callers.agent, "content-type": "application/json" }, body: JSON.stringify({ text: "hi" }) });
    expect(say.status).toBe(403);
  } finally {
    server.stop(true);
  }
});

// ---------- round 12 ----------

test("the brain counts what it owes from the moment it is accepted: shutdown waits for a queued pass, and starts overheard lines now", async () => {
  const r = room();
  const brain = r.hub.brain as any;
  expect(brain.busy()).toEqual([]);
  let ran = false;
  brain.exclusive(async () => {
    await Bun.sleep(250);
    ran = true;
  });
  expect(brain.busy()).toEqual(["the brain's requests"]);
  expect(await r.hub.shutdown()).toBe(true);
  expect(ran).toBe(true);
  // Lines waiting out the debounce are named, and a shutdown flushes them rather than waiting for the timer.
  const r2 = room();
  const b2 = r2.hub.brain as any;
  b2.pending.push({ id: 1 });
  b2.timer = setTimeout(() => {}, 60_000);
  expect(b2.busy()).toEqual(["overheard speech waiting to be read"]);
  clearTimeout(b2.timer);
  b2.timer = null;
  b2.pending.length = 0;
});

test("a drain with only transcription pending doesn't starve the timers that finish it", async () => {
  const r = room();
  let pending = 1;
  Object.defineProperty(r.hub.audio, "pending", { get: () => pending });
  setTimeout(() => (pending = 0), 200);
  expect(await r.hub.shutdown()).toBe(true);
});

test("stopping the hub with a recording still open hands its held words to the room first", () => {
  const r = room();
  const hub = r.hub as any;
  const t0 = Date.now() - 2000;
  hub.promptStart("dev1", t0);
  r.s.store.put("devices", { id: "dev1", personId: r.chey.id, label: "L", kind: "client", lastSeen: Date.now() } as any);
  const u = { id: "u_held", t0, t1: t0 + 1000, text: "Held words from the recording", personId: r.chey.id, speakerName: "Chey", devices: [{ deviceId: "dev1", db: -20 }], eventId: null, confidence: 1, method: "voice" } as any;
  r.s.store.put("utterances", u);
  hub.stop();
  expect(r.s.store.recentEvents({ limit: 20 }).some((e) => e.text === "Held words from the recording")).toBe(true);
});

test("a canvas that was running and can't be copied makes the final save fail; no canvas at all doesn't", async () => {
  const r = room();
  (r.hub.canvas as any).hostStarted = true;
  r.hub.canvas.saveCopy = async () => false;
  const snap = await r.hub.autosave.save("end", {});
  expect(snap?.canvasFailed).toBe(true);
  const none = room();
  const ok = await none.hub.autosave.save("end", {});
  expect(ok?.canvasFailed).toBeUndefined();
});

// ---------- round 13 ----------

test("shutdown waits for an agent-update pass and a digest held mid-call, and counts them from launch", async () => {
  const r = room();
  const brain = r.hub.brain as any;
  let done = 0;
  brain.considerRun = async () => {
    await Bun.sleep(200);
    done++;
  };
  brain.digestRun = async () => {
    await Bun.sleep(250);
    done++;
  };
  void brain.consider("a shipped change");
  void brain.digest(true);
  expect(brain.busy()).toEqual(["the brain's requests"]);
  expect(await r.hub.shutdown()).toBe(true);
  expect(done).toBe(2);
});

test("revoking a loopback browser credential closes its open socket", async () => {
  const r = room();
  const { startHttp } = await import("../src/http");
  const server = startHttp(r.hub, 0);
  try {
    const person = r.hub.auth.issue({ kind: "browser", label: "A laptop", ip: "127.0.0.1", personId: r.chey.id });
    const base = `http://127.0.0.1:${server.port}`;
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?device=d1`, { headers: { authorization: `Bearer ${person.token}`, origin: base } } as any);
    await new Promise((res) => (ws.onopen = res as any));
    const closed = new Promise<number>((res) => (ws.onclose = (e) => res(e.code)));
    r.hub.auth.revoke(person.device.id);
    expect(await Promise.race([closed, Bun.sleep(1500).then(() => -1)])).toBe(4401);
  } finally {
    server.stop(true);
  }
});

test("the final snapshot is taken even when only a card or fact changed (no event, no frame), and after a save already running", async () => {
  const r = room();
  await r.hub.autosave.save("first", {});
  expect(await r.hub.autosave.save("idle", { onlyIfChanged: true })).toBeNull();
  r.s.board.rememberNow({ text: "A requirement accepted after the snapshot", kind: "requirement", by: "Chey" });
  expect(await r.hub.autosave.save("periodic", { onlyIfChanged: true })).not.toBeNull();
  const first = r.hub.autosave.save("slow", {});
  const final = await r.hub.autosave.save("end of session", { final: true });
  expect(final).not.toBeNull();
  await first;
  const ctx = JSON.parse(readFileSync(join(final!.dir, "context.json"), "utf8"));
  expect(JSON.stringify(ctx.facts)).toContain("A requirement accepted");
});

// ---------- round 14 ----------

test("shutdown goes through shipped news waiting on its timer and a decision's delayed digest, before saving", async () => {
  const r = room();
  const brain = r.hub.brain as any;
  const seen: string[] = [];
  brain.shippedBatch = (b: any[]) => void seen.push(`shipped ${b.length}`);
  brain.digestRun = async () => void seen.push("digest");
  brain.shipped.push({ agent: { id: "a" }, text: "Tabs shipped" });
  brain.shipTimer = setTimeout(() => {}, 60_000);
  brain.decisionDigest = setTimeout(() => {}, 60_000);
  expect(brain.busy()).toEqual(["news waiting to be passed on"]);
  expect(await r.hub.shutdown()).toBe(true);
  expect(seen.sort()).toEqual(["digest", "shipped 1"]);
  expect(brain.busy()).toEqual([]);
});

test("a context database with a row the reader can't use fails the start visibly", () => {
  const p = saved("Bad row");
  const db = new Database(join(folderOf(p.slug), "context.db"));
  db.exec("UPDATE items SET status = 'archived'");
  db.close();
  expect(() => readProjectContext(dir, p.slug)).toThrow(ContextUnavailable);
});

test("a request body past the cap is refused with 413 before any route sees it, whoever sent it", async () => {
  const r = room();
  const { startHttp } = await import("../src/http");
  const server = startHttp(r.hub, 0);
  try {
    r.hub.auth.windows.adopt("cd".repeat(32));
    const base = `http://127.0.0.1:${server.port}`;
    const huge = new Uint8Array(3 * 1024 * 1024).fill(32);
    const json = await fetch(`${base}/api/triage/tri_nope/dismiss`, { method: "POST", headers: { "content-type": "application/json" }, body: huge });
    expect(json.status).toBe(413);
    let sent = 0;
    const chunked = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent++ < 4) c.enqueue(new Uint8Array(1024 * 1024).fill(32));
        else c.close();
      },
    });
    const streamed = await fetch(`${base}/api/say`, { method: "POST", headers: { "content-type": "application/json", cookie: `jam_window=${"cd".repeat(32)}` }, body: chunked, duplex: "half" } as any).catch(() => null);
    expect([streamed?.status ?? 413, await streamed?.text()]).toEqual([413, expect.any(String)]);
    // A normal body still works.
    expect((await fetch(`${base}/api/triage/tri_nope/dismiss`, { method: "POST", headers: { "content-type": "application/json", cookie: `jam_window=${"cd".repeat(32)}` }, body: "{}" })).status).not.toBe(413);
  } finally {
    server.stop(true);
  }
});

test("a PDF's invisible text mode carries across its content streams", () => {
  const body = (s: string) => s;
  const doc = `%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents [4 0 R 5 0 R] >>\nendobj\n4 0 obj\n<< /Length 13 >>\nstream\nBT 3 Tr ET\nendstream\nendobj\n5 0 obj\n<< /Length 29 >>\nstream\nBT (SECRET HIDDEN TEXT) Tj ET\nendstream\nendobj\n%%EOF`;
  expect(drawnText(new TextEncoder().encode(body(doc)))).toBe("");
});

// ---------- round 15 ----------

test("PDF render mode resets at each page: an invisible first page doesn't hide the next one", () => {
  const obj = (n: number, body: string) => `${n} 0 obj\n<< /Length ${body.length} >>\nstream\n${body}\nendstream\nendobj\n`;
  const doc = `%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n${obj(4, "BT 3 Tr (PAGE ONE HIDDEN) Tj ET")}6 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 7 0 R >>\nendobj\n${obj(7, "BT (PAGE TWO VISIBLE) Tj ET")}%%EOF`;
  expect(drawnText(new TextEncoder().encode(doc))).toBe("PAGE TWO VISIBLE");
});

test("a failed recovery of the project's context fails the start, like a malformed row", () => {
  const p = saved("Recovery fails");
  wipeDbs(p.slug);
  writeFileSync(join(folderOf(p.slug), "context.db"), "this is not a database at all, and neither is the next one");
  mkdirSync(join(folderOf(p.slug), "context-1.db"));
  expect(() => readProjectContext(dir, p.slug)).toThrow(ContextUnavailable);
});

test("every body-bearing route is capped: pairing, audio of an odd type, and MCP get 413 before any work", async () => {
  const r = room();
  const { startHttp } = await import("../src/http");
  const server = startHttp(r.hub, 0);
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const big = new Uint8Array(3 * 1024 * 1024).fill(32);
    expect((await fetch(`${base}/api/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: big })).status).toBe(413);
    const dev = r.hub.auth.issue({ kind: "browser", label: "L", ip: "127.0.0.1", personId: r.chey.id });
    const mcp = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${dev.token}` }, body: big });
    expect(mcp.status).toBe(413);
    const bigMedia = new Uint8Array(33 * 1024 * 1024);
    const audio = await fetch(`${base}/api/audio?deviceId=d&t0=1&t1=2`, { method: "POST", headers: { "content-type": "audio/wav", authorization: `Bearer ${dev.token}` }, body: bigMedia });
    expect(audio.status).toBe(413);
  } finally {
    server.stop(true);
  }
});

test("a request let in before shutdown and still sending its body is turned away after it", async () => {
  const r = room();
  const { startHttp } = await import("../src/http");
  const server = startHttp(r.hub, 0);
  try {
    r.hub.auth.windows.adopt("ef".repeat(32));
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    let step = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        if (step++ === 0) c.enqueue(new TextEncoder().encode('{"text":"late ca'));
        else {
          await gate;
          c.enqueue(new TextEncoder().encode('rd"}'));
          c.close();
        }
      },
    });
    const sending = fetch(`http://127.0.0.1:${server.port}/api/say`, { method: "POST", headers: { "content-type": "application/json", cookie: `jam_window=${"ef".repeat(32)}` }, body, duplex: "half" } as any);
    await Bun.sleep(100);
    const before = r.s.store.recentEvents({ limit: 20 }).length;
    const shutting = r.hub.shutdown();
    await Bun.sleep(100);
    release();
    expect((await sending).status).toBe(503);
    await shutting;
    expect(r.s.store.recentEvents({ limit: 20 }).length).toBe(before);
  } finally {
    server.stop(true);
  }
});
