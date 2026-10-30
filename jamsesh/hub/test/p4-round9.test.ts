// Phase 4 round 9: recovery fails loudly rather than seeding empty; files never enter the saved brief by being sent;
// an export's generation is validated; the card says what couldn't be read.
import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.JAMSESH_SILENT = "1";

const { Hub } = await import("../src/hub");
const { acceptedEvent } = await import("../src/brain/brain");
const { ContextUnavailable, contextExport, readProjectContext, saveProjectContext, seedFromProject, snapshotContext } = await import("../src/carryover");
const { createProject } = await import("../src/projects");
const { weightForRole } = await import("../src/session");
const { Attachments } = await import("../src/attachments");
const { usePdfTool, makePdf, pdfToolAvailable } = await import("./pdftool");
usePdfTool();

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
      // A browser page (it sends an Origin) with neither the window key nor a credential reads nothing at all.
      if (who === "none") {
        expect((await fetch(`${base}/api/state`, { headers: { origin: "http://evil.example" } })).status).toBe(403);
        continue;
      }
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


// ---------- round 15 ----------


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
    const mcp = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${dev.token}` }, body: new Uint8Array(18 * 1024 * 1024).fill(32) });
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

// ---------- round 16 ----------

test("one choke point: any route's body is read and capped before it runs, and shutdown starting while a body is still arriving refuses it (audio of an odd type, a project, a network config)", async () => {
  const r = room();
  const { startHttp } = await import("../src/http");
  const server = startHttp(r.hub, 0);
  try {
    r.hub.auth.windows.adopt("aa".repeat(32));
    const cookie = `jam_window=${"aa".repeat(32)}`;
    const base = `http://127.0.0.1:${server.port}`;
    const big = new Uint8Array(3 * 1024 * 1024).fill(32);
    for (const path of ["/api/projects", "/api/net/config"]) expect((await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: big })).status).toBe(413);
    // An audio upload of an unrecognised type stalls mid-body across shutdown: it is refused afterwards, nothing is transcribed.
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    let step = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        if (step++ === 0) c.enqueue(new Uint8Array(100));
        else {
          await gate;
          c.enqueue(new Uint8Array(100));
          c.close();
        }
      },
    });
    const sending = fetch(`${base}/api/audio?deviceId=d9&t0=1&t1=2`, { method: "POST", headers: { "content-type": "application/x-weird", cookie }, body, duplex: "half" } as any);
    await Bun.sleep(100);
    const shutting = r.hub.shutdown();
    await Bun.sleep(100);
    release();
    expect((await sending).status).toBe(503);
    await shutting;
  } finally {
    server.stop(true);
  }
});

test("a repeated document proposal puts its files on the card it joins", () => {
  const r = room();
  const card = r.s.proposeContext({ text: "Keep the greeting short.", kind: "fact", by: "Chey" })!;
  const att = { id: "att_1", name: "notes.txt", type: "text/plain", kind: "text" as const, size: 5 };
  const again = r.s.proposeContext({ text: "Keep the greeting short.", kind: "fact", by: "Felipe", attachments: [att], origin: "document" })!;
  expect(again.id).toBe(card.id);
  expect(again.attachments).toEqual([att]);
  expect(r.s.proposeContext({ text: "keep the greeting short", kind: "fact", by: "Felipe", attachments: [att] })!.attachments).toHaveLength(1);
});

test("share placement runs the real path under the brain's count, and a stopped brain leaves the stage alone", async () => {
  const r = room();
  r.s.upsertPerson({ name: "Felipe" });
  r.s.store.put("devices", { id: "dv1", personId: r.chey.id, label: "L", kind: "client", lastSeen: Date.now() } as any);
  const share = r.s.startShare("dv1", "screen", "sh1", "Chey's screen");
  const placing = r.hub.brain.placeShare(share);
  expect((r.hub.brain as any).busy()).toEqual(["the brain's requests"]);
  await placing;
  expect(JSON.stringify(r.s.stage())).toContain(share.id);
  const before = JSON.stringify(r.s.stage());
  r.hub.brain.stop();
  const second = r.s.startShare("dv1", "camera", "sh2", "Camera");
  await r.hub.brain.placeShare(second);
  expect(JSON.stringify(r.s.stage())).toBe(before);
});

// ---------- round 17 ----------


test("HEAD and OPTIONS never act, and a GET can't pair an agent while the session is closing", async () => {
  const r = room();
  const card = r.s.proposeContext({ text: "A card to leave alone", kind: "decision", by: "Chey" })!;
  const { startHttp } = await import("../src/http");
  const server = startHttp(r.hub, 0);
  try {
    r.hub.auth.windows.adopt("bb".repeat(32));
    const headers = { cookie: `jam_window=${"bb".repeat(32)}`, "content-type": "application/json" };
    const base = `http://127.0.0.1:${server.port}`;
    for (const method of ["HEAD", "OPTIONS", "PUT", "TRACE"]) {
      const res = await fetch(`${base}/api/triage/${card.id}/dismiss`, { method, headers });
      expect([204, 405]).toContain(res.status);
      expect(r.s.board.get(card.id)!.status).toBe("open");
    }
    const shutting = r.hub.shutdown();
    const code = r.hub.auth.current().code;
    const pair = await fetch(`${base}/agent?c=${code}`, { headers: { "x-forwarded-for": "9.9.9.9" } });
    expect(pair.status).toBe(503);
    await shutting;
  } finally {
    server.stop(true);
  }
});

test("a body that never finishes is dropped at the deadline, and bodies share a memory budget that stays charged until the request is answered", async () => {
  const { buffered, READ_MS } = await import("../src/body");
  const old = { ...READ_MS };
  const stalled = (url: string) => {
    let first = true;
    const body = new ReadableStream<Uint8Array>({
      pull: (c) =>
        new Promise((res) => {
          if (first) return (first = false), c.enqueue(new Uint8Array(10)), res();
          setTimeout(() => {
            try {
              c.enqueue(new Uint8Array(10));
            } catch {} // the reader gave up at its deadline
            res();
          }, 1500);
        }),
    });
    return new Request(url, { method: "POST", headers: { "content-type": url.includes("/audio") ? "audio/wav" : "application/json" }, body, duplex: "half" } as any);
  };
  const small = (url = "http://x/api/audio") => new Request(url, { method: "POST", headers: { "content-type": "audio/wav", "content-length": "10" }, body: new Uint8Array(10) });
  try {
    READ_MS.small = 200;
    expect(await buffered(stalled("http://x/api/say"))).toMatchObject({ status: 408 });
    READ_MS.media = 1000;
    // Two media reads fill the budget while they are arriving; a third is turned away at once.
    const open = [1, 2].map(() => buffered(stalled("http://x/api/audio")));
    await Bun.sleep(50);
    expect(await buffered(small())).toMatchObject({ status: 503 });
    expect((await Promise.all(open)).every((o) => "status" in o && o.status === 408)).toBe(true);
    // Once a body has arrived it holds what it really is (four times over), not its worst case, until its request is answered.
    const held = [1, 2, 3, 4, 5].map(() => buffered(small()));
    const got = await Promise.all(held);
    expect(got.every((g) => "req" in g)).toBe(true);
    for (const g of got) if ("release" in g) g.release();
    // Non-media routes take 1 MB of anything but JSON.
    expect(await buffered(new Request("http://x/api/say", { method: "POST", headers: { "content-type": "text/plain" }, body: new Uint8Array(2 * 1024 * 1024) }))).toMatchObject({ status: 413 });
  } finally {
    Object.assign(READ_MS, old);
  }
}, 20_000);


test("a database lost and replaced by a new generation with no export fails the start; a generation that isn't a count does too", () => {
  const p = saved("Lost export");
  rmSync(contextExport(dir, p.slug));
  wipeDbs(p.slug);
  writeFileSync(join(folderOf(p.slug), "context.db"), "this file is not a database, and is long enough to be read as one: ".repeat(40));
  expect(() => readProjectContext(dir, p.slug)).toThrow(ContextUnavailable);
  const q = saved("Bad generation");
  const db = new Database(join(folderOf(q.slug), "context.db"));
  db.exec("UPDATE meta SET value = 'garbage' WHERE key = 'generation'");
  db.close();
  expect(() => readProjectContext(dir, q.slug)).toThrow(ContextUnavailable);
  const r = room();
  r.s.board.rememberNow({ text: "More", kind: "decision", by: "Chey" });
  expect(saveProjectContext(dir, q.slug, "s9", r.s)).toBe("failed");
});

test("cards made from a file carry the file: a task, a decision, and a repeat", () => {
  const r = room();
  const att = { id: "att_9", name: "brief.pdf", type: "application/pdf", kind: "pdf" as const, size: 9 };
  const ev = r.s.store.addEvent({ kind: "speech", authorType: "person", authorId: r.chey.id, authorName: "Chey", text: "see the file", relevance: "work", data: { direct: true, attachments: [att] } });
  const tools = (r.hub.brain as any).tools([ev], { effects: 0 }, "person", "direct");
  const agent = r.s.registerAgent({ ownerName: "Chey", harness: "claude-code", repo: "acme/web", cwd: "/x", machine: "m", platform: "desktop" }).agent;
  return Promise.all([
    tools.create_directive.execute({ targets: [agent.id], text: "Build it", mode: "implement", rationale: "the file asks" }, { toolCallId: "1", messages: [] }),
    tools.record_decision.execute({ text: "Use the brief's grid" }, { toolCallId: "2", messages: [] }),
  ]).then(() => {
    const cards = r.s.board.open();
    expect(cards.length).toBeGreaterThan(0);
    for (const c of cards) expect(c.attachments).toEqual([att]);
  });
});


// ---------- round 19 ----------


test("a card shows what Send delivers: cancellations carry their file, and files past six make another card", () => {
  const r = room();
  const att = (n: number) => ({ id: `att_${n}`, name: `f${n}.txt`, type: "text/plain", kind: "text" as const, size: 5 });
  const agent = r.s.registerAgent({ ownerName: "Chey", harness: "claude-code", repo: "acme/web", cwd: "/x", machine: "m", platform: "desktop" }).agent;
  const d = r.s.createDirective({ text: "Make the header", mode: "implement", targets: [agent.id], requestedBy: "Chey" });
  const ev = r.s.store.addEvent({ kind: "speech", authorType: "person", authorId: r.chey.id, authorName: "Chey", text: "see file", relevance: "work", data: { direct: true, attachments: [att(0)] } });
  const cancel = r.s.board.proposeCancel({ directive: d, reason: "Scrap it", by: "Chey", sourceEventIds: [ev.id], attachments: [att(0)] })!;
  expect(cancel.attachments).toEqual([att(0)]);
  const say = (n: number) => r.s.store.addEvent({ kind: "speech", authorType: "person", authorId: r.chey.id, authorName: "Chey", text: `line ${n}`, relevance: "work", data: {} }).id;
  let card = r.s.proposeContext({ text: "Same words", kind: "fact", by: "Chey", attachments: [att(1)] })!;
  for (let i = 2; i <= 6; i++) card = r.s.proposeContext({ text: "Same words", kind: "fact", by: "Felipe", attachments: [att(i)], sourceEventIds: [say(i)] })!;
  expect(card.attachments).toHaveLength(6);
  const seventh = r.s.proposeContext({ text: "Same words", kind: "fact", by: "Felipe", attachments: [att(7)], sourceEventIds: [say(7)] })!;
  expect(seventh.id).not.toBe(card.id);
  expect(seventh.attachments).toEqual([att(7)]);
});

test("work scheduled after shutdown has quiesced the brain starts at once, in the count", async () => {
  const r = room();
  const brain = r.hub.brain as any;
  brain.quiesce();
  const ran: string[] = [];
  brain.digestRun = async () => void ran.push("digest");
  brain.shippedBatch = (b: any[]) => void ran.push(`shipped ${b.length}`);
  brain.shipWindowMs = 60_000;
  brain.agentUpdated({ id: "a1", name: "A", platform: "desktop", repo: "x/y" }, "shipped", "Added the tabs screen across the app", { data: {} });
  await Bun.sleep(20);
  expect(brain.shipTimer).toBeNull();
  expect(ran).toContain("shipped 1");
  expect(await r.hub.shutdown()).toBe(true);
});

test("HEAD never renders: /renders/full is not a file read", async () => {
  const { methodAllowed } = await import("../src/methods");
  expect((await methodAllowed(new Request("http://x/renders/full/art_1.png", { method: "HEAD" })))?.status).toBe(405);
  expect(await methodAllowed(new Request("http://x/renders/art_1.png", { method: "HEAD" }))).toBeNull();
});

// ---------- round 20 ----------

test.skipIf(!pdfToolAvailable)("a real PDF is read by the PDFKit helper, capped, and a file it can't read says so on its card", async () => {
  const { pdfText } = await import("../src/attachments");
  const dirp = mkdtempSync(join(tmpdir(), "jam-pdfhelper-"));
  const good = join(dirp, "good.pdf");
  writeFileSync(good, makePdf("Prices always include tax.\nCheckout is one page."));
  expect(await pdfText(good)).toContain("Prices always include tax.");
  expect((await pdfText(good, 6)).length).toBeLessThanOrEqual(6);
  const bad = join(dirp, "bad.pdf");
  writeFileSync(bad, "%PDF-1.4 not really");
  expect(await pdfText(bad)).toBe("");
  expect(await pdfText(join(dirp, "missing.pdf"))).toBe("");
  const r = room();
  const rec = r.hub.attachments.save(new TextEncoder().encode("%PDF-1.4\n%%EOF"), "scan.pdf", "Chey");
  const card = (await r.hub.proposeDocument({ id: 1, authorName: "Chey" } as any, [r.hub.attachments.ref(rec.id)!]))!;
  expect(card.text).toBe("Couldn't read this PDF; write what to keep.");
  expect(card.needsWording).toBe(true);
});

test("without the helper a PDF is unreadable, never guessed at", async () => {
  const saved = process.env.JAMSESH_PDFTEXT;
  process.env.JAMSESH_PDFTEXT = "/nonexistent/jamsesh-pdftext";
  try {
    const spec = "../src/attachments?nohelper"; // a fresh copy of the module, so its helper lookup runs again
    const mod = (await import(spec)) as typeof import("../src/attachments");
    expect(await mod.pdfText("/tmp/anything.pdf")).toBe("");
  } finally {
    if (saved) process.env.JAMSESH_PDFTEXT = saved;
  }
});

test("an upload for an agent comes from that agent's own credential: a named agent that isn't theirs is refused", async () => {
  const r = room();
  const { startHttp } = await import("../src/http");
  const server = startHttp(r.hub, 0);
  try {
    const cred = r.hub.auth.issue({ kind: "agent", label: "Agents", ip: "10.0.0.4", personId: r.chey.id, ownerDeviceId: "host" });
    const mine = r.s.registerAgent({ ownerName: "Chey", harness: "claude-code", repo: "a/web", cwd: "/x", machine: r.hub.auth.machineOf(cred.device.id)!, platform: "desktop" }).agent;
    const other = r.s.registerAgent({ ownerName: "Felipe", harness: "claude-code", repo: "a/ios", cwd: "/y", machine: "felipe-mac", platform: "mobile" }).agent;
    const person = r.hub.auth.issue({ kind: "browser", label: "L", ip: "10.0.0.5", personId: r.chey.id });
    const png = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
    const post = (token: string, agent?: string) => {
      const form = new FormData();
      form.set("file", new File([png], "s.png", { type: "image/png" }));
      if (agent) form.set("agent", agent);
      return fetch(`http://127.0.0.1:${server.port}/api/upload`, { method: "POST", headers: { authorization: `Bearer ${token}`, "x-forwarded-for": "10.0.0.4" }, body: form });
    };
    expect((await post(cred.token, mine.id)).status).toBe(200);
    expect((await post(cred.token, other.id)).status).toBe(403);
    expect((await post(cred.token, "agent_nope")).status).toBe(403);
    expect((await post(person.token, mine.id)).status).toBe(403);
    expect((await post(person.token)).status).toBe(200);
  } finally {
    server.stop(true);
  }
});

test("Send delivers exactly the files the card showed, and a card never shows more than a message can carry", () => {
  const r = room();
  const att = (n: number) => ({ id: `att_${n}`, name: `f${n}.txt`, type: "text/plain", kind: "text" as const, size: 5 });
  const agent = r.s.registerAgent({ ownerName: "Chey", harness: "claude-code", repo: "acme/web", cwd: "/x", machine: "m", platform: "desktop" }).agent;
  const lines = [0, 1, 2].map((n) => r.s.store.addEvent({ kind: "speech", authorType: "person", authorId: r.chey.id, authorName: "Chey", text: `line ${n}`, relevance: "work", data: { attachments: [att(90 + n)] } }));
  // Eight files offered on one proposal: the card holds six.
  const card = r.s.proposeTask({ text: "Build the page from the files", mode: "implement", targets: [agent.id], by: "Chey", sourceEventIds: lines.map((l) => l.id), attachments: [1, 2, 3, 4, 5, 6, 7, 8].map(att) })!;
  expect(card.attachments).toHaveLength(6);
  const sent = r.s.board.send(card.id, "Chey");
  expect(sent.ok).toBe(true);
  const d = r.s.directives()[0];
  expect(d.attachments?.map((a) => a.id)).toEqual(card.attachments!.map((a) => a.id));
  // Files that came on other lines of the source aren't added behind the person's back.
  expect(d.attachments?.some((a) => a.id.startsWith("att_9"))).toBe(false);
});

test("each snapshot has a directory of its own, and a failed canvas copy never leaves an earlier save's canvas beside the new context", async () => {
  const r = room();
  const canvasCopy = async (dest: string) => (writeFileSync(dest, "an earlier canvas"), true);
  r.hub.canvas.saveCopy = canvasCopy;
  const first = (await r.hub.autosave.save("same minute", {}))!;
  expect(existsSync(join(first.dir, "canvas.figcraft"))).toBe(true);
  (r.hub.canvas as any).hostStarted = true;
  r.hub.canvas.saveCopy = async () => false;
  const second = (await r.hub.autosave.save("same minute", {}))!;
  expect(second.dir).not.toBe(first.dir);
  expect(second.canvasFailed).toBe(true);
  expect(existsSync(join(second.dir, "canvas.figcraft"))).toBe(false);
  const listed = r.hub.autosave.list();
  expect(listed.map((s) => s.label)).toEqual(["same minute", "same minute"]);
  expect(listed.find((s) => s.id === second.id)!.canvas).toBe(false);
  expect(readdirSync(join(first.dir, "..")).some((d) => d.startsWith(".staging-"))).toBe(false);
});


// ---------- round 21 ----------

test("only this Mac's own .local names are accepted: a page can't pick one and rebind it to loopback", async () => {
  const { knownHost } = await import("../src/http");
  const r = room();
  const asHost = (host: string) => knownHost(new Request("http://x/", { headers: { host } }), r.hub);
  const own = (await import("node:os")).hostname().toLowerCase().replace(/\.local$/, "");
  expect(asHost(`${own}.local:4790`)).toBe(true);
  expect(asHost("localhost:4790")).toBe(true);
  expect(asHost("127.0.0.1:4790")).toBe(true);
  expect(asHost("evil.local:4790")).toBe(false);
  expect(asHost("attacker.example")).toBe(false);
});

test("an agent's credential can't upload as the host by leaving the agent out", async () => {
  const r = room();
  const { startHttp } = await import("../src/http");
  const server = startHttp(r.hub, 0);
  try {
    const cred = r.hub.auth.issue({ kind: "agent", label: "Agents", ip: "10.0.0.4", personId: r.chey.id, ownerDeviceId: "host" });
    const png = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
    const form = new FormData();
    form.set("file", new File([png], "s.png", { type: "image/png" }));
    form.set("replaces", "art_host_owned");
    const res = await fetch(`http://127.0.0.1:${server.port}/api/upload`, { method: "POST", headers: { authorization: `Bearer ${cred.token}`, "x-forwarded-for": "10.0.0.4" }, body: form });
    expect(res.status).toBe(403);
  } finally {
    server.stop(true);
  }
});

test("a cancellation sent from the board reaches its agents with the files the card showed, and the curl hint keeps the token out of the command line", () => {
  const r = room();
  const att = { id: "att_c1", name: "scrap.txt", type: "text/plain", kind: "text" as const, size: 5 };
  const agent = r.s.registerAgent({ ownerName: "Chey", harness: "claude-code", repo: "acme/web", cwd: "/x", machine: "m", platform: "desktop" }).agent;
  const d = r.s.createDirective({ text: "Make the header", mode: "implement", targets: [agent.id], requestedBy: "Chey" });
  const ev = r.s.store.addEvent({ kind: "speech", authorType: "person", authorId: r.chey.id, authorName: "Chey", text: "scrap it", relevance: "work", data: { attachments: [att] } });
  const card = r.s.board.proposeCancel({ directive: d, reason: "Scrap it", by: "Chey", sourceEventIds: [ev.id], attachments: [att] })!;
  expect(r.s.board.send(card.id, "Chey").ok).toBe(true);
  const msg = r.s.store.recentEvents({ kinds: ["message"], limit: 10 }).find((e) => e.data.directiveId === d.id)!;
  expect(msg.text).toContain(att.name); // the links are made at delivery, from the agent's own address
  expect(msg.data.attachments).toEqual([att]);
  const src = readFileSync(join(import.meta.dir, "../src/mcp.ts"), "utf8");
  expect(src).not.toContain("Bearer $JAMSESH_TOKEN");
});

test("a title changed in one session isn't put back by another session's later save", () => {
  const p = createProject(dir, "Titles");
  const a = room();
  const b = room();
  a.s.upsertPerson({ name: "Chey", role: "Designer" });
  expect(saveProjectContext(dir, p.slug, "A", a.s)).toBe("written");
  expect(readProjectContext(dir, p.slug)!.people).toMatchObject([{ name: "Chey", role: "Designer" }]);
  // B joins later, sees "Designer", changes it, and saves.
  const { seedFromProject: seed } = require("../src/carryover");
  b.s.upsertPerson({ name: "Chey" });
  seed(dir, p.slug, "B", b.s);
  b.s.upsertPerson({ name: "Chey", role: "Design lead" });
  expect(saveProjectContext(dir, p.slug, "B", b.s)).toBe("written");
  // A saves again (a fact changed), with the old title still in its copy: the title stays B's.
  a.s.board.rememberNow({ text: "A later call", kind: "decision", by: "Chey" });
  expect(saveProjectContext(dir, p.slug, "A", a.s)).toBe("written");
  expect(readProjectContext(dir, p.slug)!.people).toMatchObject([{ name: "Chey", role: "Design lead" }]);
});


// ---------- round 22 ----------

test("competing title edits: the one saved first stands, in either save order, and a session takes the winning title", () => {
  for (const firstIsA of [true, false]) {
    const p = createProject(dir, `Titles ${firstIsA}`);
    const seedRoom = room();
    seedRoom.s.upsertPerson({ name: "Chey", role: "Designer" });
    expect(saveProjectContext(dir, p.slug, "S", seedRoom.s)).toBe("written");
    const a = room();
    const b = room();
    for (const x of [a, b]) {
      x.s.upsertPerson({ name: "Chey" });
      seedFromProject(dir, p.slug, "x", x.s);
      expect(x.s.personByName("Chey")!.role).toBe("Designer");
    }
    a.s.upsertPerson({ name: "Chey", role: "Art director" });
    b.s.upsertPerson({ name: "Chey", role: "Design lead" });
    const [first, second] = firstIsA ? [a, b] : [b, a];
    const winner = first === a ? "Art director" : "Design lead";
    expect(saveProjectContext(dir, p.slug, "first", first.s)).toBe("written");
    expect(saveProjectContext(dir, p.slug, "second", second.s)).toBe("written");
    expect(readProjectContext(dir, p.slug)!.people).toMatchObject([{ name: "Chey", role: winner }]);
    expect(second.s.personByName("Chey")!.role).toBe(winner);
    // The title brings its weight with it.
    expect(second.s.personByName("Chey")!.weight).toBe(winner === "Art director" ? weightForRole("Art director") : weightForRole("Design lead"));
  }
});

test("a session started with its own title takes the project's, not the other way round", () => {
  const p = createProject(dir, "Titles seed");
  const base = room();
  base.s.upsertPerson({ name: "Chey", role: "Design lead" });
  expect(saveProjectContext(dir, p.slug, "S", base.s)).toBe("written");
  const old = room();
  old.s.upsertPerson({ name: "Chey", role: "Designer" });
  seedFromProject(dir, p.slug, "old", old.s);
  expect(old.s.personByName("Chey")!.role).toBe("Design lead");
  expect(old.s.personByName("Chey")!.weight).toBe(weightForRole("Design lead"));
  old.s.board.rememberNow({ text: "A call", kind: "decision", by: "Chey" });
  expect(saveProjectContext(dir, p.slug, "old", old.s)).toBe("written");
  expect(readProjectContext(dir, p.slug)!.people).toMatchObject([{ name: "Chey", role: "Design lead" }]);
});

test("a reassigned task keeps its reviewed files even when their lines are gone", () => {
  const r = room();
  const att = { id: "att_r1", name: "spec.txt", type: "text/plain", kind: "text" as const, size: 5 };
  const one = r.s.registerAgent({ ownerName: "Chey", harness: "claude-code", repo: "acme/web", cwd: "/x", machine: "m1", platform: "desktop" }).agent;
  const two = r.s.registerAgent({ ownerName: "Felipe", harness: "claude-code", repo: "acme/web2", cwd: "/y", machine: "m2", platform: "desktop" }).agent;
  const d = r.s.createDirective({ text: "Build from the spec", mode: "implement", targets: [one.id], requestedBy: "Chey", sourceEventIds: [], attachments: [att] });
  const moved = r.s.reassignDirective(d.id, "Chey", two.id);
  expect(moved && "attachments" in moved ? moved.attachments : undefined).toEqual([att]);
});

test("file links in an agent's inbox use the address that agent connected by, a cancellation's included", () => {
  const r = room();
  const att = { id: "att_u1", name: "scrap.txt", type: "text/plain", kind: "text" as const, size: 5 };
  const agent = r.s.registerAgent({ ownerName: "Chey", harness: "claude-code", repo: "acme/web", cwd: "/x", machine: "m", platform: "desktop" }).agent;
  const d = r.s.createDirective({ text: "Make the header", mode: "implement", targets: [agent.id], requestedBy: "Chey", attachments: [att] });
  r.s.cancelDirective(d, "Scrap it.", [att]);
  const out = (r.hub.mcp as any).inboxText(agent, true, "https://room.example.net");
  expect(out).toContain(`https://room.example.net/api/attachments/${att.id}`);
  expect(out).not.toContain(r.s.hubUrl + "/api/attachments");
});


test("the first-join briefing shows each file link once, from the agent's address; an explicit file list over six is refused", () => {
  const r = room();
  const att = { id: "att_b1", name: "brief.txt", type: "text/plain", kind: "text" as const, size: 5 };
  const agent = r.s.registerAgent({ ownerName: "Chey", harness: "claude-code", repo: "acme/web", cwd: "/x", machine: "m", platform: "desktop" }).agent;
  r.s.createDirective({ text: "Build from the brief", mode: "implement", targets: [agent.id], requestedBy: "Chey", attachments: [att] });
  const brief = (r.hub.mcp as any).briefing(agent, false, false, "https://room.example.net") as string;
  expect(brief.split(`/api/attachments/${att.id}`).length - 1).toBe(1);
  expect(brief).toContain(`https://room.example.net/api/attachments/${att.id}`);
  const seven = Array.from({ length: 7 }, (_, i) => ({ ...att, id: `att_${i}` }));
  expect(() => r.s.createDirective({ text: "Too many", mode: "note", targets: [agent.id], requestedBy: "Chey", attachments: seven })).toThrow();
});

// ---------- round 24 ----------

test("shutdown waits for any MCP tool call still writing, and a call that only waits for the room doesn't hold it up", async () => {
  const r = room();
  const mcp = r.hub.mcp as any;
  let wrote = false;
  mcp.callTool = async (_c: unknown, name: string) => {
    if (name === "jam_wait") return new Promise(() => {});
    await Bun.sleep(250);
    wrote = true;
    return { content: [{ type: "text", text: "ok" }] };
  };
  void mcp.call({ agentId: null }, "jam_wait", {});
  void mcp.call({ agentId: null }, "jam_post_image", {});
  expect(r.hub.working()).toEqual(["the jam_post_image call"]);
  expect(await r.hub.shutdown()).toBe(true);
  expect(wrote).toBe(true);
});

test("a host screenshot being kept is counted until its artifact exists", async () => {
  const r = room();
  const file = join(dir, "shot.png");
  writeFileSync(file, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
  const before = r.s.artifacts().length;
  (r.hub.host as any).onImage(file, "Simulator");
  expect(r.hub.working()).toEqual(["a screenshot being kept"]);
  expect(await r.hub.shutdown()).toBe(true);
  expect(r.s.artifacts().length).toBe(before + 1);
});

test("the transport counts a request until its response has been sent; a hook's listen is waiting, not work", async () => {
  const r = room();
  const { startHttp } = await import("../src/http");
  const server = startHttp(r.hub, 0);
  try {
    r.hub.auth.windows.adopt("dd".repeat(32));
    const base = `http://127.0.0.1:${server.port}`;
    // A body still arriving is work in flight.
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    let step = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        if (step++ === 0) c.enqueue(new TextEncoder().encode('{"text":"x'));
        else (await gate, c.enqueue(new TextEncoder().encode('"}')), c.close());
      },
    });
    const sending = fetch(`${base}/api/say`, { method: "POST", headers: { "content-type": "application/json", cookie: `jam_window=${"dd".repeat(32)}` }, body, duplex: "half" } as any);
    await Bun.sleep(100);
    // Still arriving: not accepted for dispatch yet, so not work (a stranger trickling a body can't hold the final save).
    expect(r.hub.working()).toEqual([]);
    release();
    await sending;
    await Bun.sleep(50);
    expect(r.hub.working()).not.toContain("POST /api/say");
    // An ordinary read is counted and released too.
    await (await fetch(`${base}/api/state`, { headers: { cookie: `jam_window=${"dd".repeat(32)}` } })).text();
    await Bun.sleep(30);
    expect(r.hub.working()).not.toContain("GET /api/state");
  } finally {
    server.stop(true);
  }
});

test("a person joining a fresh project session gets their saved title and its weight, and it isn't saved back as their change", () => {
  const p = createProject(dir, "Join titles");
  const base = room();
  base.s.upsertPerson({ name: "Dana", role: "Director" });
  expect(saveProjectContext(dir, p.slug, "S", base.s)).toBe("written");
  const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, `bare${Math.random()}`), teamDir: join(dir, `team${Math.random()}`) });
  hubs.push(hub);
  clearInterval((hub.brain as any).digestTimer);
  const fresh = { s: hub.session };
  seedFromProject(dir, p.slug, "N", fresh.s);
  expect(fresh.s.personByName("Dana")).toBeUndefined();
  const dana = fresh.s.upsertPerson({ name: "Dana" });
  expect(dana.role).toBe("Director");
  expect(dana.weight).toBe(weightForRole("Director"));
  expect(snapshotContext(fresh.s, "N").people).toEqual([]);
  // Back later with no title: the same.
  fresh.s.store.put("people", { ...dana, role: "", weight: 1 });
  expect(fresh.s.upsertPerson({ name: "Dana" }).role).toBe("Director");
});

test("the same instruction with a new file is not 'already sent': it becomes a card showing the file", async () => {
  const r = room();
  const att = (n: number) => ({ id: `att_n${n}`, name: `n${n}.txt`, type: "text/plain", kind: "text" as const, size: 5 });
  const agent = r.s.registerAgent({ ownerName: "Chey", harness: "claude-code", repo: "acme/web", cwd: "/x", machine: "m", platform: "desktop" }).agent;
  r.s.createDirective({ text: "Build the page", mode: "implement", targets: [agent.id], requestedBy: "Chey", attachments: [att(1)] });
  const ev = (a: ReturnType<typeof att>) => r.s.store.addEvent({ kind: "speech", authorType: "person", authorId: r.chey.id, authorName: "Chey", text: "build the page", relevance: "work", data: { direct: true, attachments: [a] } });
  const run = async (e: any) => (r.hub.brain as any).tools([e], { effects: 0 }, "person", "direct").create_directive.execute({ targets: [agent.id], text: "Build the page", mode: "implement", rationale: "x" }, { toolCallId: "1", messages: [] });
  expect(await run(ev(att(1)))).toContain("Already sent");
  const out = await run(ev(att(2)));
  expect(out).toContain("Proposed on the Tasks board");
  expect(r.s.board.open().at(-1)!.attachments).toEqual([att(2)]);
});

test("files past six are refused visibly on the card, never dropped silently", () => {
  const r = room();
  const att = (n: number) => ({ id: `att_x${n}`, name: `x${n}.txt`, type: "text/plain", kind: "text" as const, size: 5 });
  const card = r.s.proposeContext({ text: "Eight files", kind: "fact", by: "Chey", attachments: [1, 2, 3, 4, 5, 6, 7, 8].map(att) })!;
  expect(card.attachments).toHaveLength(6);
  expect(card.extraFiles).toBe(2);
});

test("/mcp takes a base64 image at the stated limit, from one shared constant, and refuses past it", async () => {
  const { MAX_IMAGE_BYTES, MCP_BODY_BYTES } = await import("../src/limits");
  const { limitFor } = await import("../src/body");
  expect(limitFor(new Request("http://x/mcp", { method: "POST", headers: { "content-type": "application/json" } }))).toBe(MCP_BODY_BYTES);
  expect(MCP_BODY_BYTES).toBeGreaterThan(Math.ceil((MAX_IMAGE_BYTES * 4) / 3));
  const tool = (r0: any) => r0.toolList().find((t: any) => t.name === "jam_post_image");
  expect(tool(room().hub.mcp).description).toContain(`${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
  expect(readFileSync(join(import.meta.dir, "../../SPEC.md"), "utf8")).toContain(`at most ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
  const r = room();
  const { startHttp } = await import("../src/http");
  const server = startHttp(r.hub, 0);
  try {
    const dev = r.hub.auth.issue({ kind: "agent", label: "A", ip: "127.0.0.1", personId: r.chey.id });
    const post = (n: number) => fetch(`http://127.0.0.1:${server.port}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${dev.token}` }, body: new Uint8Array(n).fill(32) });
    expect((await post(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 1000)).status).not.toBe(413);
    expect((await post(MCP_BODY_BYTES + 1)).status).toBe(413);
  } finally {
    server.stop(true);
  }
});

test("a cancellation for another reason is another card; the same reason joins", () => {
  const r = room();
  const agent = r.s.registerAgent({ ownerName: "Chey", harness: "claude-code", repo: "acme/web", cwd: "/x", machine: "m", platform: "desktop" }).agent;
  const d = r.s.createDirective({ text: "Build it", mode: "implement", targets: [agent.id], requestedBy: "Chey" });
  const a = r.s.board.proposeCancel({ directive: d, reason: "Scrap it", by: "Chey" })!;
  expect(r.s.board.proposeCancel({ directive: d, reason: "scrap it.", by: "Felipe" })!.id).toBe(a.id);
  expect(r.s.board.proposeCancel({ directive: d, reason: "The client changed their mind", by: "Felipe" })!.id).not.toBe(a.id);
});

// ---------- round 25 ----------

test("a real MCP jam_post_image call above the SDK's old 4 MB cap goes through the HTTP endpoint", async () => {
  const r = room();
  const { startHttp } = await import("../src/http");
  const server = startHttp(r.hub, 0);
  try {
    const dev = r.hub.auth.issue({ kind: "agent", label: "A", ip: "127.0.0.1", personId: r.chey.id });
    const base = `http://127.0.0.1:${server.port}`;
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${dev.token}` };
    const rpc = async (body: object, sid?: string) => fetch(`${base}/mcp`, { method: "POST", headers: { ...headers, ...(sid ? { "mcp-session-id": sid } : {}) }, body: JSON.stringify(body) });
    const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    const sid = init.headers.get("mcp-session-id")!;
    expect(init.status).toBe(200);
    await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, sid);
    await (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "jam_join", arguments: { harness: "other", repo: "a/b", owner: "Chey" } } }, sid)).text();
    // A PNG header plus padding, 5 MB of image: past the SDK's default and well inside the stated limit.
    const png = Buffer.concat([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"), Buffer.alloc(5 * 1024 * 1024)]);
    const res = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "jam_post_image", arguments: { title: "Big", imageBase64: png.toString("base64") } } }, sid);
    expect(res.status).toBe(200);
    const out = await res.text();
    expect(out).toContain("Posted as");
    expect(out).not.toContain("isError");
    expect(r.s.artifacts().some((a) => a.title === "Big")).toBe(true);
  } finally {
    server.stop(true);
  }
}, 30_000);

test("the body reserve stays charged through an MCP call, and a small body gives back the rest of its reserve", async () => {
  const { buffered } = await import("../src/body");
  const small = await buffered(new Request("http://x/mcp", { method: "POST", headers: { "content-type": "application/json", "content-length": "2" }, body: "{}" }));
  expect("req" in small).toBe(true);
  // Many agents' small calls fit (each holds what it actually sent, not its worst case).
  const many = await Promise.all(Array.from({ length: 40 }, () => buffered(new Request("http://x/mcp", { method: "POST", headers: { "content-type": "application/json", "content-length": "2" }, body: "{}" }))));
  expect(many.every((m) => "req" in m)).toBe(true);
  for (const m of many) if ("release" in m) m.release();
  if ("release" in small) small.release();
});

test("an oversized repeat keeps the overflow notice, on context, task and cancellation cards", () => {
  const r = room();
  const att = (n: number) => ({ id: `att_o${n}`, name: `o${n}.txt`, type: "text/plain", kind: "text" as const, size: 5 });
  const first = r.s.proposeContext({ text: "Same again", kind: "fact", by: "Chey", attachments: [1, 2, 3].map(att) })!;
  const again = r.s.proposeContext({ text: "Same again", kind: "fact", by: "Felipe", attachments: [1, 2, 3, 4, 5, 6, 7, 8, 9].map(att) })!;
  expect(again.id === first.id ? again.extraFiles : (again.extraFiles ?? 0) > 0).toBeTruthy();
});


// ---------- round 26 ----------

test("a real MCP tool call paused between admission and dispatch is counted: shutdown waits for it, while a jam_wait doesn't hold anything up", async () => {
  const r = room();
  const { startHttp } = await import("../src/http");
  const server = startHttp(r.hub, 0);
  try {
    const dev = r.hub.auth.issue({ kind: "agent", label: "A", ip: "127.0.0.1", personId: r.chey.id });
    const base = `http://127.0.0.1:${server.port}`;
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${dev.token}` };
    const rpc = (body: object, sid?: string) => fetch(`${base}/mcp`, { method: "POST", headers: { ...headers, ...(sid ? { "mcp-session-id": sid } : {}) }, body: JSON.stringify(body) });
    const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    const sid = init.headers.get("mcp-session-id")!;
    await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, sid);
    await (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "jam_join", arguments: { harness: "other", repo: "a/b", owner: "Chey" } } }, sid)).text();
    // A tool that is slow to finish writing.
    const mcp = r.hub.mcp as any;
    const real = mcp.callTool.bind(mcp);
    let wrote = false;
    mcp.callTool = async (ctx: unknown, name: string, args: unknown, extra: unknown) => {
      if (name === "jam_updates_slow") return real(ctx, "jam_inbox", {}, extra);
      await Bun.sleep(300);
      wrote = true;
      return real(ctx, name, args, extra);
    };
    const pending = rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "jam_inbox", arguments: {} } }, sid).then((x) => x.text());
    await Bun.sleep(60);
    expect(r.hub.working().length).toBeGreaterThan(0);
    // An idle wait is not work.
    const waitCall = rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "jam_wait", arguments: {} } }, sid).catch(() => null);
    await Bun.sleep(60);
    expect(r.hub.working().filter((w) => w.includes("jam_wait"))).toEqual([]);
    expect(await r.hub.shutdown()).toBe(true);
    expect(wrote).toBe(true);
    await pending;
    void waitCall;
  } finally {
    server.stop(true);
  }
}, 30_000);

test("when an MCP client disconnects, its payload's charge stays until the tools have settled", async () => {
  const r = room();
  const mcp = r.hub.mcp as any;
  expect(await Promise.race([mcp.whenQuiet().then(() => "quiet"), Bun.sleep(50).then(() => "busy")])).toBe("quiet");
  let finish!: () => void;
  mcp.callTool = () => new Promise((res) => (finish = () => res({ content: [{ type: "text", text: "ok" }] })));
  const call = mcp.call({ agentId: null }, "jam_post_image", {});
  expect(await Promise.race([mcp.whenQuiet().then(() => "quiet"), Bun.sleep(50).then(() => "busy")])).toBe("busy");
  finish();
  await call;
  expect(await Promise.race([mcp.whenQuiet().then(() => "quiet"), Bun.sleep(50).then(() => "busy")])).toBe("quiet");
});

test("attachments gathered from several lines are refused over six, like an explicit list; a same-event repeat with overflow isn't counted twice", () => {
  const r = room();
  const att = (n: number) => ({ id: `att_g${n}`, name: `g${n}.txt`, type: "text/plain", kind: "text" as const, size: 5 });
  const agent = r.s.registerAgent({ ownerName: "Chey", harness: "claude-code", repo: "acme/web", cwd: "/x", machine: "m", platform: "desktop" }).agent;
  const ids = [0, 1].map((i) => r.s.store.addEvent({ kind: "speech", authorType: "person", authorId: r.chey.id, authorName: "Chey", text: `l${i}`, relevance: "work", data: { attachments: [1, 2, 3, 4].map((n) => att(i * 10 + n)) } }).id);
  expect(() => r.s.createDirective({ text: "Eight files", mode: "note", targets: [agent.id], requestedBy: "Chey", sourceEventIds: ids })).toThrow();
  const ev = ids[0];
  const first = r.s.proposeTask({ text: "Many files", mode: "implement", targets: [agent.id], by: "Chey", sourceEventIds: [ev], attachments: [1, 2, 3, 4, 5, 6, 7, 8].map(att) })!;
  const again = r.s.proposeTask({ text: "Many files", mode: "implement", targets: [agent.id], by: "Chey", sourceEventIds: [ev], attachments: [1, 2, 3, 4, 5, 6, 7, 8].map(att) })!;
  expect(again.id).toBe(first.id);
  expect(again.extraFiles).toBe(2);
  expect(again.count).toBe(1);
  // A different line repeating it adds its overflow, on a task card and on a cancellation card.
  const ev2 = ids[1];
  const third = r.s.proposeTask({ text: "Many files", mode: "implement", targets: [agent.id], by: "Felipe", sourceEventIds: [ev2], attachments: [1, 2, 3, 4, 5, 6, 7, 8].map(att) })!;
  expect(third.extraFiles).toBe(4);
  const d = r.s.createDirective({ text: "Cancel me", mode: "implement", targets: [agent.id], requestedBy: "Chey" });
  const c1 = r.s.board.proposeCancel({ directive: d, reason: "Scrap", by: "Chey", sourceEventIds: [ev], attachments: [1, 2, 3, 4, 5, 6, 7].map(att) })!;
  expect(c1.extraFiles).toBe(1);
  expect(r.s.board.proposeCancel({ directive: d, reason: "Scrap", by: "Chey", sourceEventIds: [ev], attachments: [1, 2, 3, 4, 5, 6, 7].map(att) })!.extraFiles).toBe(1);
});

// ---------- round 27 ----------

async function mcpSession(r: ReturnType<typeof room>, server: { port?: number }) {
  const dev = r.hub.auth.issue({ kind: "agent", label: "A", ip: "127.0.0.1", personId: r.chey.id });
  const base = `http://127.0.0.1:${server.port}`;
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${dev.token}` };
  const rpc = (body: object, sid?: string, signal?: AbortSignal) => fetch(`${base}/mcp`, { method: "POST", headers: { ...headers, ...(sid ? { "mcp-session-id": sid } : {}) }, body: JSON.stringify(body), signal });
  const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  const sid = init.headers.get("mcp-session-id")!;
  await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, sid);
  await (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "jam_join", arguments: { harness: "other", repo: "a/b", owner: "Chey" } } }, sid)).text();
  const agent = r.s.agents().at(-1)!;
  return { rpc, sid, agent };
}

test("a mutating call with a nested name of jam_wait is still work: classification is by the parsed top-level tool", async () => {
  const r = room();
  const { startHttp } = await import("../src/http");
  const server = startHttp(r.hub, 0);
  try {
    const { rpc, sid } = await mcpSession(r, server);
    const mcp = r.hub.mcp as any;
    const real = mcp.callTool.bind(mcp);
    mcp.callTool = async (...a: unknown[]) => (await Bun.sleep(300), real(...a));
    const call = rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "jam_post_image", arguments: { title: "x", name: "jam_wait", imageBase64: "" } } }, sid).then((x) => x.text()).catch(() => "");
    await Bun.sleep(80);
    expect(r.hub.working().some((w) => w.includes("POST /mcp"))).toBe(true);
    expect(await r.hub.shutdown()).toBe(true);
    await call;
  } finally {
    server.stop(true);
  }
}, 30_000);

test("jam_wait: a disconnect mid-wait ends the wait and takes nothing; the message is there on the next call", async () => {
  const r = room();
  const { startHttp } = await import("../src/http");
  const server = startHttp(r.hub, 0);
  try {
    const { rpc, sid, agent } = await mcpSession(r, server);
    const ctrl = new AbortController();
    const waiting = rpc({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "jam_wait", arguments: { seconds: 30 } } }, sid, ctrl.signal).catch(() => null);
    await Bun.sleep(150);
    expect(r.s.isWaiting(agent.id)).toBe(true);
    // Idle: not work for shutdown.
    expect(r.hub.working().filter((w) => w.includes("mcp") || w.includes("jam_wait"))).toEqual([]);
    ctrl.abort();
    await waiting;
    await Bun.sleep(150);
    expect(r.s.isWaiting(agent.id)).toBe(false);
    const other = r.s.registerAgent({ ownerName: "Felipe", harness: "claude-code", repo: "a/other", cwd: "/o", machine: "fm", platform: "mobile" }).agent;
    r.s.sendMessage(other.id, agent.id, "Check the header spacing");
    const next = await (await rpc({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "jam_inbox", arguments: {} } }, sid)).text();
    expect(next).toContain("Check the header spacing");
  } finally {
    server.stop(true);
  }
}, 30_000);

test("jam_wait: what a wake carries is marked read only once the reply is sent; a disconnect after the wake, before the send, leaves it for the next call", async () => {
  const r = room();
  const mcp = r.hub.mcp as any;
  const agent = r.s.registerAgent({ ownerName: "Chey", harness: "other", repo: "a/b", cwd: "/x", machine: "m", platform: "desktop" }).agent;
  const call = async (id: number) => {
    const req = new Request("http://x/mcp", { method: "POST", headers: { "content-type": "application/json", "mcp-session-id": "s1", "content-length": "200" }, body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "jam_wait", arguments: { seconds: 5 } } }) });
    const kind = await mcp.classify(req);
    expect(kind.live).toBeDefined();
    const ctx = { agentId: agent.id, ip: "127.0.0.1", device: null, sessionId: "s1", owner: "host" };
    const out = await mcp.call(ctx, "jam_wait", { seconds: 5 }, { requestId: id });
    return { kind, out };
  };
  const other = r.s.registerAgent({ ownerName: "Felipe", harness: "claude-code", repo: "a/other", cwd: "/o", machine: "fm", platform: "mobile" }).agent;
  r.s.sendMessage(other.id, agent.id, "First thing");
  // Woken at once by what's waiting; the reply is cut off before it is sent.
  const a = await call(10);
  expect(a.out.content[0].text).toContain("First thing");
  expect(r.hub.working()).toContain("a jam_wait delivery");
  a.kind.live.drop();
  expect(r.hub.working()).not.toContain("a jam_wait delivery");
  // Not read: the next call gets it again (at least once).
  const b = await call(11);
  expect(b.out.content[0].text).toContain("First thing");
  // This time the reply goes out: it's read, and nothing more is delivered.
  b.kind.live.sent();
  expect(r.hub.working()).not.toContain("a jam_wait delivery");
  expect(mcp.inboxText(agent, false)).toContain("Nothing new");
});

test("a card remembers every line it took in: replaying the oldest one after thirteen repeats counts for nothing", () => {
  const r = room();
  const ev = (n: number) => r.s.store.addEvent({ kind: "speech", authorType: "person", authorId: r.chey.id, authorName: "Chey", text: `say ${n}`, relevance: "work", data: {} }).id;
  const ids = Array.from({ length: 14 }, (_, i) => ev(i));
  let card = r.s.proposeContext({ text: "Same call again", kind: "fact", by: "Chey", sourceEventIds: [ids[0]] })!;
  for (const id of ids.slice(1)) card = r.s.proposeContext({ text: "Same call again", kind: "fact", by: "Felipe", sourceEventIds: [id] })!;
  expect(card.count).toBe(14);
  const replay = r.s.proposeContext({ text: "Same call again", kind: "fact", by: "Felipe", sourceEventIds: [ids[0]] })!;
  expect(replay.count).toBe(14);
});


// ---------- round 28 ----------

test("every accepted jam_wait is tied to its request: a large body is classified, a batch with a wait is refused, and 1 and \"1\" are two requests", async () => {
  const r = room();
  const mcp = r.hub.mcp as any;
  const wait = (id: unknown, pad = 0) => new Request("http://x/mcp", { method: "POST", headers: { "content-type": "application/json", "mcp-session-id": "s9" }, body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "jam_wait", arguments: { seconds: 5, pad: "x".repeat(pad) } } }) });
  expect((await mcp.classify(wait(7, 80_000))).live).toBeDefined();
  const batch = new Request("http://x/mcp", { method: "POST", headers: { "content-type": "application/json", "mcp-session-id": "s9" }, body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "jam_wait", arguments: {} } }]) });
  expect((await mcp.classify(batch)).reject).toContain("batch");
  const one = (await mcp.classify(wait(1))).live;
  const text = (await mcp.classify(wait("1"))).live;
  expect(mcp.lives.size).toBe(3);
  one.sent();
  expect(mcp.lives.size).toBe(2);
  expect(mcp.lives.get("s9:string:1")).toBe(text);
  text.drop();
  text.gone();
  expect(text.signal.aborted).toBe(true);
  expect(one.signal.aborted).toBe(false);
});

test("an accepted wait counts as work through dispatch and until it is idle; shutdown ends open waits so none wakes after the save", async () => {
  const r = room();
  const { startHttp } = await import("../src/http");
  const server = startHttp(r.hub, 0);
  try {
    const { rpc, sid, agent } = await mcpSession(r, server);
    const waiting = rpc({ jsonrpc: "2.0", id: 20, method: "tools/call", params: { name: "jam_wait", arguments: { seconds: 60 } } }, sid).then((x) => x.text()).catch(() => "");
    await Bun.sleep(150);
    expect(r.s.isWaiting(agent.id)).toBe(true);
    expect(r.hub.working().filter((w) => w.includes("mcp") || w.includes("jam_wait"))).toEqual([]);
    expect(await r.hub.shutdown()).toBe(true);
    expect(r.s.isWaiting(agent.id)).toBe(false);
    await waiting;
  } finally {
    server.stop(true);
  }
}, 30_000);

test("a delivery that lands late never moves finished work backward", () => {
  const r = room();
  const agent = r.s.registerAgent({ ownerName: "Chey", harness: "other", repo: "a/b", cwd: "/x", machine: "m", platform: "desktop" }).agent;
  const d = r.s.createDirective({ text: "Do the thing", mode: "implement", targets: [agent.id], requestedBy: "Chey" });
  const taken = r.s.inbox(agent.id, false, true);
  expect(taken.directives.map((x) => x.id)).toEqual([d.id]);
  // Another reader delivers it, and the agent finishes, before the first reader's reply goes out.
  r.s.inbox(agent.id, true);
  r.s.setDirectiveFor(d.id, agent.id, "done", "ok");
  r.s.markInbox(agent.id, taken);
  expect(r.s.store.get("directives", d.id)!.progress[agent.id]).toBe("done");
});

// ---------- round 29 ----------

test("an inbox never skips a message: more than 50 for one agent arrive in order across calls, and newer ones for others hide nothing", () => {
  const r = room();
  const agent = r.s.registerAgent({ ownerName: "Chey", harness: "other", repo: "a/b", cwd: "/x", machine: "m", platform: "desktop" }).agent;
  const other = r.s.registerAgent({ ownerName: "Felipe", harness: "claude-code", repo: "a/o", cwd: "/o", machine: "fm", platform: "mobile" }).agent;
  const third = r.s.registerAgent({ ownerName: "Sam", harness: "claude-code", repo: "a/t", cwd: "/t", machine: "sm", platform: "mobile" }).agent;
  for (let i = 0; i < 55; i++) r.s.sendMessage(other.id, agent.id, `note ${i}`);
  for (let i = 0; i < 60; i++) r.s.sendMessage(other.id, third.id, `for someone else ${i}`);
  const first = r.s.inbox(agent.id, true).messages.map((m) => m.text);
  expect(first).toHaveLength(50);
  expect(first[0]).toBe("note 0");
  const second = r.s.inbox(agent.id, true).messages.map((m) => m.text);
  expect(second).toEqual(["note 50", "note 51", "note 52", "note 53", "note 54"]);
  expect(r.s.inbox(agent.id, true).messages).toHaveLength(0);
});

test("a wait dispatched after shutdown began returns at once and touches nothing; the shutdown still completes", async () => {
  const r = room();
  const { startHttp } = await import("../src/http");
  const server = startHttp(r.hub, 0);
  try {
    const { rpc, sid, agent } = await mcpSession(r, server);
    const mcp = r.hub.mcp as any;
    const real = mcp.callTool.bind(mcp);
    mcp.callTool = async (...a: unknown[]) => (await Bun.sleep(300), real(...a));
    const before = r.s.agent(agent.id)!.activity;
    const waiting = rpc({ jsonrpc: "2.0", id: 30, method: "tools/call", params: { name: "jam_wait", arguments: { seconds: 60 } } }, sid).then((x) => x.text()).catch(() => "");
    await Bun.sleep(100);
    const shutting = r.hub.shutdown();
    expect(await shutting).toBe(true);
    await waiting;
    expect(r.s.isWaiting(agent.id)).toBe(false);
    expect(r.s.agent(agent.id)!.activity).toBe(before);
  } finally {
    server.stop(true);
  }
}, 30_000);

// ---------- round 31 ----------

test("tokenless MCP on this Mac still works (the documented local setup): initialize and jam_join without a credential", async () => {
  const r = room();
  const { startHttp } = await import("../src/http");
  const server = startHttp(r.hub, 0);
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    const rpc = (body: object, sid?: string) => fetch(`${base}/mcp`, { method: "POST", headers: { ...headers, ...(sid ? { "mcp-session-id": sid } : {}) }, body: JSON.stringify(body) });
    const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    expect(init.status).toBe(200);
    const sid = init.headers.get("mcp-session-id")!;
    await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, sid);
    const joined = await (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "jam_join", arguments: { harness: "other", repo: "a/b", owner: "Chey" } } }, sid)).text();
    expect(joined).not.toContain("isError");
    // From another machine, with no credential, nothing is buffered.
    const far = await fetch(`${base}/mcp`, { method: "POST", headers: { ...headers, "x-forwarded-for": "9.9.9.9" }, body: "{}" });
    expect(far.status).toBe(401);
  } finally {
    server.stop(true);
  }
}, 30_000);

test("a request still trickling its body when the session ends was never work: shutdown stays clean", async () => {
  const r = room();
  const { startHttp } = await import("../src/http");
  const server = startHttp(r.hub, 0);
  try {
    const stalled = new ReadableStream<Uint8Array>({ pull: (c) => new Promise((res) => (c.enqueue(new TextEncoder().encode("{")), setTimeout(res, 3000))) });
    const slow = fetch(`http://127.0.0.1:${server.port}/api/say`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "9.9.9.9" }, body: stalled, duplex: "half" } as any).catch(() => null);
    await Bun.sleep(150);
    expect(r.hub.working()).toEqual([]);
    expect(await r.hub.shutdown()).toBe(true);
    void slow;
  } finally {
    server.stop(true);
  }
}, 30_000);

test("a device token in the URL is not accepted on ordinary routes", async () => {
  const r = room();
  const { startHttp } = await import("../src/http");
  const server = startHttp(r.hub, 0);
  try {
    const dev = r.hub.auth.issue({ kind: "browser", label: "L", ip: "10.0.0.5", personId: r.chey.id });
    const res = await fetch(`http://127.0.0.1:${server.port}/api/state?token=${dev.token}`, { headers: { "x-forwarded-for": "10.0.0.5" } });
    expect(res.status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${server.port}/api/state`, { headers: { "x-forwarded-for": "10.0.0.5", authorization: `Bearer ${dev.token}` } })).status).toBe(200);
  } finally {
    server.stop(true);
  }
});

test("two sessions retiring the same fact don't propose adding it back", () => {
  const p = createProject(dir, "Double retire");
  const a = room();
  const b = room();
  a.s.board.rememberNow({ text: "Use the old nav", kind: "decision", by: "Chey" });
  expect(saveProjectContext(dir, p.slug, "A", a.s)).toBe("written");
  b.s.store.setSetting("carried", null as any);
  seedFromProject(dir, p.slug, "B", b.s);
  const fa = a.s.facts().find((f) => f.text === "Use the old nav")!;
  a.s.store.put("facts", { ...fa, status: "superseded", updatedAt: Date.now() });
  const fb = b.s.facts().find((f) => f.text === "Use the old nav")!;
  b.s.store.put("facts", { ...fb, status: "superseded", updatedAt: Date.now() + 5 });
  expect(saveProjectContext(dir, p.slug, "A", a.s)).toBe("written");
  expect(saveProjectContext(dir, p.slug, "B", b.s)).toBe("written");
  expect(b.s.board.open().filter((c) => c.text.includes("Use the old nav"))).toEqual([]);
});

test("the inbox scan resumes after lines already seen not to be for the agent, and still finds every message", () => {
  const r = room();
  const agent = r.s.registerAgent({ ownerName: "Chey", harness: "other", repo: "a/b", cwd: "/x", machine: "m", platform: "desktop" }).agent;
  const other = r.s.registerAgent({ ownerName: "Felipe", harness: "claude-code", repo: "a/o", cwd: "/o", machine: "fm", platform: "mobile" }).agent;
  const third = r.s.registerAgent({ ownerName: "Sam", harness: "claude-code", repo: "a/t", cwd: "/t", machine: "sm", platform: "mobile" }).agent;
  for (let i = 0; i < 300; i++) r.s.sendMessage(other.id, third.id, `elsewhere ${i}`);
  expect(r.s.inbox(agent.id, false, true).messages).toHaveLength(0);
  expect(r.s.store.setting<number>(`msgScan:${agent.id}`, 0)).toBeGreaterThan(0);
  r.s.sendMessage(other.id, agent.id, "for you");
  expect(r.s.inbox(agent.id, true).messages.map((m) => m.text)).toEqual(["for you"]);
});

// ---------- round 32 ----------

test("a dev-server link works once: the code becomes the dev origin's own cookie, the address loses it, and the preview never sees a credential", async () => {
  const r = room();
  const seen: { url: string; cookie: string | null; auth: string | null }[] = [];
  const preview = Bun.serve({ port: 0, fetch: (req) => (seen.push({ url: new URL(req.url).pathname + new URL(req.url).search, cookie: req.headers.get("cookie"), auth: req.headers.get("authorization") }), new Response("preview")) });
  try {
    const agent = r.s.registerAgent({ ownerName: "Chey", harness: "claude-code", repo: "a/b", cwd: "/x", machine: "m", platform: "desktop" }).agent;
    const dev = await r.hub.devproxy.register({ agentId: agent.id, name: "web", target: `127.0.0.1:${preview.port}` });
    seen.length = 0; // registering probed the target
    const base = `http://127.0.0.1:${dev.hostPort}`;
    const device = r.hub.auth.issue({ kind: "browser", label: "Phone", ip: "10.0.0.7", personId: r.chey.id });
    const links = r.hub.auth.devLinks;
    const code = links.mint(device.device.id);
    // Redeeming sends the browser on without the code, with a cookie for this origin only.
    const first = await fetch(`${base}/app?x=1&jam_code=${code}`, { redirect: "manual" });
    expect(first.status).toBe(302);
    expect(first.headers.get("location")).toBe("/app?x=1");
    const set = first.headers.get("set-cookie")!;
    expect(set).toContain("HttpOnly");
    expect(set).toContain("SameSite=Strict");
    expect(set).not.toContain("Domain");
    expect(seen).toEqual([]);
    // A reused code is refused.
    expect((await fetch(`${base}/app?jam_code=${code}`, { redirect: "manual" })).status).toBe(401);
    // An expired one, and one for a revoked device, too.
    const old = links.mint(device.device.id, Date.now() - 120_000);
    expect(links.redeem(old)).toBeNull();
    const revoked = links.mint(device.device.id);
    r.hub.auth.revoke(device.device.id);
    expect(links.redeem(revoked)).toBeNull();
    // What the preview receives: nothing of ours, in the address, the cookies or the headers.
    const dev2 = r.hub.auth.issue({ kind: "browser", label: "Laptop", ip: "10.0.0.8", personId: r.chey.id });
    const session = links.open(dev2.device.id);
    expect(links.deviceOf(session)).toBe(dev2.device.id);
    await (await fetch(`${base}/page?token=${dev2.token}&jam_code=zzz&keep=1`.replace("&jam_code=zzz", ""), { headers: { cookie: `jam_dev=${session}; jam_token=${dev2.token}; theme=dark`, authorization: `Bearer ${dev2.token}` } })).text();
    const got = seen.at(-1)!;
    expect(got.url).toBe("/page?keep=1");
    expect(got.cookie).toBe("theme=dark");
    expect(got.auth).toBeNull();
    expect(JSON.stringify(got)).not.toContain(dev2.token);
    expect(JSON.stringify(got)).not.toContain(session);
  } finally {
    preview.stop(true);
  }
});

test("on the public address, the dev subdomain takes the same one-time code and sends nothing of ours on", async () => {
  const r = room();
  const seen: { url: string; cookie: string | null }[] = [];
  const preview = Bun.serve({ port: 0, fetch: (req) => (seen.push({ url: new URL(req.url).pathname + new URL(req.url).search, cookie: req.headers.get("cookie") }), new Response("preview")) });
  const { startHttp } = await import("../src/http");
  const server = startHttp(r.hub, 0);
  try {
    const agent = r.s.registerAgent({ ownerName: "Chey", harness: "claude-code", repo: "a/b", cwd: "/x", machine: "m", platform: "desktop" }).agent;
    const dev = await r.hub.devproxy.register({ agentId: agent.id, name: "web", target: `127.0.0.1:${preview.port}` });
    seen.length = 0;
    (r.hub.net as any).status = () => ({ domain: "room.example.net" });
    const device = r.hub.auth.issue({ kind: "browser", label: "Phone", ip: "10.0.0.7", personId: r.chey.id });
    const host = `dev-${dev.hostPort}.room.example.net`;
    const code = r.hub.auth.devLinks.mint(device.device.id);
    const base = `http://127.0.0.1:${server.port}`;
    const entry = await fetch(`${base}/x?jam_code=${code}`, { redirect: "manual", headers: { host } });
    expect(entry.status).toBe(302);
    expect(entry.headers.get("location")).toBe("/x");
    const cookieValue = entry.headers.get("set-cookie")!.match(/jam_dev=([^;]+)/)![1];
    await (await fetch(`${base}/x?token=${device.token}`, { headers: { host, cookie: `jam_dev=${cookieValue}; a=b` } })).text();
    expect(seen.at(-1)).toEqual({ url: "/x", cookie: "a=b" });
    expect((await fetch(`${base}/x?jam_code=${code}`, { redirect: "manual", headers: { host } })).status).toBe(401);
  } finally {
    server.stop(true);
    preview.stop(true);
  }
});

test("a person's device asks the hub for a dev-server link and gets a one-time code on it", async () => {
  const r = room();
  const { startHttp } = await import("../src/http");
  const server = startHttp(r.hub, 0);
  try {
    const agent = r.s.registerAgent({ ownerName: "Chey", harness: "claude-code", repo: "a/b", cwd: "/x", machine: "m", platform: "desktop" }).agent;
    const dev = await r.hub.devproxy.register({ agentId: agent.id, name: "web", target: "127.0.0.1:1" });
    const person = r.hub.auth.issue({ kind: "browser", label: "L", ip: "10.0.0.5", personId: r.chey.id });
    const bot = r.hub.auth.issue({ kind: "agent", label: "A", ip: "10.0.0.6", personId: r.chey.id });
    const ask = (token: string, url: string) => fetch(`http://127.0.0.1:${server.port}/api/devserver/link`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-forwarded-for": "10.0.0.5" }, body: JSON.stringify({ url }) });
    const ok = await ask(person.token, `${dev.url}/page`);
    expect(ok.status).toBe(200);
    const link = new URL((await ok.json()).url);
    expect(link.searchParams.get("jam_code")).toBeTruthy();
    expect(r.hub.auth.devLinks.redeem(link.searchParams.get("jam_code"))).toBe(person.device.id);
    expect((await ask(bot.token, dev.url)).status).toBe(403);
    expect((await ask(person.token, "http://evil.example/")).status).toBe(404);
  } finally {
    server.stop(true);
  }
});

test("accepting a card whose final wording a saved fact already has is refused inside the save, for Add and Replace", () => {
  const r = room();
  const a = r.s.proposeContext({ text: "Use the left nav", kind: "decision", by: "Chey" })!;
  const b = r.s.proposeContext({ text: "Keep the footer slim", kind: "decision", by: "Chey" })!;
  expect(r.s.board.add(a.id, "Chey").ok).toBe(true);
  // The second card is edited to say what the first already saved.
  const dup = r.s.board.add(b.id, "Chey", { text: "use the left nav." });
  expect(dup).toMatchObject({ ok: false, status: 409 });
  expect(r.s.facts().filter((f) => f.status === "active" && f.text.toLowerCase().includes("left nav"))).toHaveLength(1);
  expect(r.s.board.get(b.id)!.status).toBe("open");
  // Replace: the old fact must still stand, and the new wording must not duplicate another.
  const old = r.s.board.rememberNow({ text: "Header is 64px", kind: "requirement", by: "Chey" })!;
  const other = r.s.board.rememberNow({ text: "Header is 72px", kind: "requirement", by: "Chey" })!;
  const rep = r.s.proposeContext({ text: "Header is 72px", kind: "requirement", by: "Felipe", replaces: old.id });
  expect(rep).not.toBeNull();
  expect(r.s.board.replace(rep!.id, "Chey", old.id)).toMatchObject({ ok: false, status: 409 });
  expect(r.s.store.get("facts", old.id)!.status).toBe("active");
  void other;
});

test("a stored title version that isn't a positive integer fails the start, and doesn't wait for the next save to block it", () => {
  const p = createProject(dir, "Bad personver");
  const a = room();
  a.s.upsertPerson({ name: "Dana", role: "Designer" });
  expect(saveProjectContext(dir, p.slug, "A", a.s)).toBe("written");
  const db = new Database(join(folderOf(p.slug), "context.db"));
  db.exec("UPDATE meta SET value = '1.5' WHERE key LIKE 'personver:%'");
  db.close();
  expect(() => readProjectContext(dir, p.slug)).toThrow(ContextUnavailable);
});

// ---------- round 33 ----------

test("an old dev link with a device token in it is sent on to the clean address before the preview is served, on both proxies", async () => {
  const r = room();
  const seen: string[] = [];
  const preview = Bun.serve({ port: 0, fetch: (req) => (seen.push(new URL(req.url).pathname + new URL(req.url).search), new Response("preview")) });
  const { startHttp } = await import("../src/http");
  const server = startHttp(r.hub, 0);
  try {
    const agent = r.s.registerAgent({ ownerName: "Chey", harness: "claude-code", repo: "a/b", cwd: "/x", machine: "m", platform: "desktop" }).agent;
    const dev = await r.hub.devproxy.register({ agentId: agent.id, name: "web", target: `127.0.0.1:${preview.port}` });
    seen.length = 0;
    const lan = await fetch(`http://127.0.0.1:${dev.hostPort}/p?token=jst_oldtoken&a=1`, { redirect: "manual" });
    expect(lan.status).toBe(302);
    expect(lan.headers.get("location")).toBe("/p?a=1");
    expect(lan.headers.get("referrer-policy")).toBe("no-referrer");
    (r.hub.net as any).status = () => ({ domain: "room.example.net" });
    const sub = await fetch(`http://127.0.0.1:${server.port}/p?token=jst_oldtoken&a=1`, { redirect: "manual", headers: { host: `dev-${dev.hostPort}.room.example.net` } });
    expect(sub.status).toBe(302);
    expect(sub.headers.get("location")).toBe("/p?a=1");
    expect(seen).toEqual([]);
  } finally {
    server.stop(true);
    preview.stop(true);
  }
});

test("Merge refuses final wording that another active fact already has, inside the save", () => {
  const r = room();
  const a = r.s.board.rememberNow({ text: "Header is 64px", kind: "requirement", by: "Chey" })!;
  r.s.board.rememberNow({ text: "Footer is slim", kind: "requirement", by: "Chey" });
  const card = r.s.proposeContext({ text: "Footer has a border", kind: "requirement", by: "Felipe" })!;
  const dup = r.s.board.merge(card.id, a.id, "Chey", "footer is slim.");
  expect(dup).toMatchObject({ ok: false, status: 409 });
  expect(r.s.board.get(card.id)!.status).toBe("open");
  expect(r.s.store.get("facts", a.id)!.text).toBe("Header is 64px");
});

// ---------- round 34 ----------

test("a page on another origin (a dev preview on this host) can't post, whoever's cookie the browser would send", async () => {
  const r = room();
  const { startHttp } = await import("../src/http");
  const server = startHttp(r.hub, 0);
  try {
    const other = r.s.registerAgent({ ownerName: "Felipe", harness: "claude-code", repo: "a/o", cwd: "/o", machine: "fm", platform: "mobile" }).agent;
    const person = r.hub.auth.issue({ kind: "browser", label: "L", ip: "10.0.0.5", personId: r.chey.id });
    const base = `http://127.0.0.1:${server.port}`;
    const post = (origin?: string) => fetch(`${base}/api/agents/${other.id}/remove`, { method: "POST", headers: { cookie: `jam_token=${person.token}`, "x-forwarded-for": "10.0.0.5", ...(origin ? { origin } : {}) } });
    expect((await post("http://10.0.0.9:5100")).status).toBe(403);
    expect(r.s.agent(other.id)).toBeTruthy();
    // The hub's own page still can.
    const own = await post(base);
    expect(own.status).not.toBe(403);
  } finally {
    server.stop(true);
  }
});

test("the dev-link request for the host's own window is the plain address; a paired device gets a code; nothing else is served", async () => {
  const r = room();
  const { startHttp } = await import("../src/http");
  const server = startHttp(r.hub, 0);
  try {
    const agent = r.s.registerAgent({ ownerName: "Chey", harness: "claude-code", repo: "a/b", cwd: "/x", machine: "m", platform: "desktop" }).agent;
    const dev = await r.hub.devproxy.register({ agentId: agent.id, name: "web", target: "127.0.0.1:1" });
    r.hub.auth.windows.adopt("ee".repeat(32));
    const res = await fetch(`http://127.0.0.1:${server.port}/api/devserver/link`, { method: "POST", headers: { cookie: `jam_window=${"ee".repeat(32)}`, "content-type": "application/json" }, body: JSON.stringify({ url: dev.url }) });
    expect(res.status).toBe(200);
    expect((await res.json()).url).toBe(dev.url);
  } finally {
    server.stop(true);
  }
});

test("a read whose client has stalled (a streamed download) is not work in flight: shutdown stays clean", async () => {
  const r = room();
  const { startHttp } = await import("../src/http");
  const { config } = await import("../src/config");
  const server = startHttp(r.hub, 0);
  const home = config.home;
  const dir2 = mkdtempSync(join(tmpdir(), "jam-dl-"));
  try {
    writeFileSync(join(dir2, "JamSesh.dmg"), Buffer.alloc(64 * 1024 * 1024, 1));
    config.home = dir2;
    // A raw socket that reads the headers and a little of the body and then stops reading: the answer cannot drain.
    let head = "";
    let received = 0;
    const sock = await Bun.connect({
      hostname: "127.0.0.1",
      port: server.port!,
      socket: {
        data(s, chunk) {
          // Stop reading on the first chunk: the answer began, and the client never takes the rest.
          if (!received) s.pause();
          received += chunk.length;
          if (head.length < 200) head += Buffer.from(chunk).toString("latin1");
        },
        open(s) {
          s.write(`GET /download/mac HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nConnection: close\r\n\r\n`);
        },
      },
    });
    await Bun.sleep(300);
    expect(head).toContain("200 OK");
    // Far fewer bytes than the file arrived, so the response is still open on the server's side.
    expect(received).toBeLessThan(32 * 1024 * 1024);
    expect(r.hub.working()).toEqual([]);
    expect(await r.hub.shutdown()).toBe(true);
    sock.end();
  } finally {
    config.home = home;
    rmSync(dir2, { recursive: true, force: true });
    server.stop(true);
  }
});

test("clients are told where an HTTPS page reaches each dev server, only while the hub serves that subdomain", async () => {
  const r = room();
  const agent = r.s.registerAgent({ ownerName: "Chey", harness: "claude-code", repo: "a/b", cwd: "/x", machine: "m", platform: "desktop" }).agent;
  const dev = await r.hub.devproxy.register({ agentId: agent.id, name: "web", target: "127.0.0.1:1" });
  const status = (over: object) => ((r.hub.net as any).status = () => ({ enabled: true, domain: "room.example.net", cert: { state: "ok" }, ...over }));
  status({});
  expect(r.s.state().devservers[0].publicUrl).toBe(`https://dev-${dev.hostPort}.room.example.net`);
  status({ cert: { state: "pending" } });
  expect(r.s.state().devservers[0].publicUrl).toBeUndefined();
  status({ domain: undefined });
  expect(r.s.state().devservers[0].publicUrl).toBeUndefined();
});

test("the dev subdomain address keeps a non-standard external port, and connected clients are told when remote access changes it", async () => {
  const r = room();
  const agent = r.s.registerAgent({ ownerName: "Chey", harness: "claude-code", repo: "a/b", cwd: "/x", machine: "m", platform: "desktop" }).agent;
  const dev = await r.hub.devproxy.register({ agentId: agent.id, name: "web", target: "127.0.0.1:1" });
  const net = r.hub.net as any;
  net.status = () => ({ enabled: true, domain: "room.duckdns.org", publicUrl: "https://room.duckdns.org:8443", cert: { state: "ok" } });
  expect(r.s.state().devservers[0].publicUrl).toBe(`https://dev-${dev.hostPort}.room.duckdns.org:8443`);
  net.status = () => ({ enabled: true, domain: "room.duckdns.org", publicUrl: "https://room.duckdns.org", cert: { state: "ok" } });
  expect(r.s.state().devservers[0].publicUrl).toBe(`https://dev-${dev.hostPort}.room.duckdns.org`);
  // A connected client hears about it: the hub's watcher publishes a devservers patch when the address changes.
  const { bus } = await import("../src/bus");
  const heard: string[] = [];
  const off = bus.on((m: any) => m.type === "patch" && m.key === "devservers" && heard.push(m.value[0]?.publicUrl ?? ""));
  try {
    net.status = () => ({ enabled: false, cert: { state: "none" } });
    await r.hub.start();
    net.status = () => ({ enabled: true, domain: "room.duckdns.org", publicUrl: "https://room.duckdns.org", cert: { state: "ok" } });
    await Bun.sleep(3400);
    expect(heard.some((u) => u.includes("dev-"))).toBe(true);
  } finally {
    off();
    r.hub.stop();
  }
}, 20_000);
