// Phase 3 on the big screen: a person's cast is locked (3.1), a rebuilt screen is one item with versions
// (3.5), and each screen remembers what it showed (3.6). Simulated rooms: fake people and agents, no sound.
import { afterAll, expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { showVerdict } from "../src/brain/brain";
import { showRequestSpeech } from "../src/brain/speech";
import { bus } from "../src/bus";
import { Hub } from "../src/hub";
import { startHttp } from "../src/http";
import { buildKey, Session } from "../src/session";
import type { Agent, JamEvent, ShowRequest } from "../src/types";

process.env.JAMSESH_SILENT = "1";
const dir = mkdtempSync(join(tmpdir(), "jam-stage-"));
const hubs: Hub[] = [];
afterAll(() => {
  for (const h of hubs) h.stop();
  bus.resolver = null;
  rmSync(dir, { recursive: true, force: true });
});

/** A whole 1x1 PNG (uploads are checked to the end before they're written). */
const PNG = (() => {
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const v = new DataView(out.buffer);
    v.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    v.setUint32(8 + data.length, Bun.hash.crc32(out.subarray(4, 8 + data.length)) >>> 0);
    return out;
  };
  const ihdr = new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array(deflateSync(new Uint8Array(5)))), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) (out.set(p, at), (at += p.length));
  return out;
})();

function room() {
  const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, String(Math.random())) });
  hubs.push(hub);
  const s = hub.session;
  const chey = s.upsertPerson({ name: "Chey" });
  const felipe = s.upsertPerson({ name: "Felipe" });
  s.touchDevice("chey-mac", { label: "Chey's Mac", personId: chey.id, kind: "client" });
  s.touchDevice("felipe-laptop", { label: "Felipe's laptop", personId: felipe.id, kind: "client" });
  const reg = (owner: string, repo = "acme/app") => s.registerAgent({ ownerName: owner, harness: "claude-code", repo, cwd: `/${owner}/${repo}`, machine: "m1", platform: "desktop" }).agent;
  const call = (agent: Agent, name: string, args: any = {}) => hub.mcp.call({ agentId: agent.id, ip: "127.0.0.1", device: null }, name, args);
  const out = (r: any) => r.content.map((c: any) => c.text).join("\n");
  const tools = (batch: JamEvent[] = []) => (hub.brain as any).tools(batch, { effects: 0 });
  const said = (who: { id: string; name: string }, text: string, ts = Date.now()) => ({ id: Math.floor(Math.random() * 1e6), ts, kind: "speech", authorType: "person", authorId: who.id, authorName: who.name, text, data: {} }) as unknown as JamEvent;
  return { hub, s, chey, felipe, reg, call, out, tools, said };
}

/** Make a lock look `ms` old. */
function age(s: Session, ms: number, screen = "main") {
  const st = s.stage(screen);
  s.store.setSetting("stage", { ...st, lock: { ...st.lock!, since: Date.now() - ms, lastActive: Date.now() - Math.min(ms, 60_000) } });
}

const artifact = (s: Session, title: string, agentId: string | null = null) => s.upsertArtifact({ kind: "screenshot", stage: "built", title, agentId, image: `/renders/${title}.png` });

// ---------- 3.1 locks ----------

test("a person's cast is locked; unlocking leaves it up and ends the lock", () => {
  const { s, chey } = room();
  const a = artifact(s, "Checkout");
  const st = s.setStage({ mode: "spotlight", items: [a.id], title: "Checkout" }, "Chey", "main", { person: { id: chey.id, name: "Chey" } });
  expect(st.lock?.by).toBe("Chey");
  expect(s.stage().lock?.personId).toBe(chey.id);
  // The board is nothing to hold on to.
  s.setStage({ mode: "board" }, "Chey", "main", { person: { id: chey.id, name: "Chey" } });
  expect(s.stage().lock).toBeUndefined();
  s.setStage({ mode: "spotlight", items: [a.id] }, "Chey", "main", { person: { id: chey.id, name: "Chey" } });
  s.unlockStage();
  expect(s.stage().mode).toBe("spotlight");
  expect(s.stage().lock).toBeUndefined();
});

test("a locked screen refuses the brain and automatic changes, but people and housekeeping get through", () => {
  const { s, chey, felipe } = room();
  const a = artifact(s, "Checkout");
  s.setStage({ mode: "spotlight", items: [a.id], title: "Checkout" }, "Chey", "main", { person: { id: chey.id, name: "Chey" } });
  expect(s.setStage({ mode: "agents" }, "Room brain").mode).toBe("spotlight");
  expect(s.stage().mode).toBe("spotlight");
  // Another person's deliberate cast replaces it and takes the lock.
  s.setStage({ mode: "agents" }, "Felipe", "main", { person: { id: felipe.id, name: "Felipe" } });
  expect(s.stage().lock?.by).toBe("Felipe");
  // Housekeeping (a share ending, a timer) is never held back, and clears the lock.
  s.setStage({ mode: "board" }, "JamSesh", "main", { override: true });
  expect(s.stage().mode).toBe("board");
  expect(s.stage().lock).toBeUndefined();
});

test("a locked screen doesn't revert to the board on the timer; unlocking starts the usual wait", async () => {
  const old = Session.STAGE_REVERT_MS;
  Session.STAGE_REVERT_MS = 60;
  try {
    const { s, chey } = room();
    const a = artifact(s, "Checkout");
    s.setStage({ mode: "spotlight", items: [a.id] }, "Chey", "main", { person: { id: chey.id, name: "Chey" } });
    await Bun.sleep(150);
    expect(s.stage().mode).toBe("spotlight");
    s.unlockStage();
    await Bun.sleep(150);
    expect(s.stage().mode).toBe("board");
  } finally {
    Session.STAGE_REVERT_MS = old;
  }
});

test("a lock stays while its owner is here however long, and lets go when they leave", () => {
  const { s, chey, felipe } = room();
  const a = artifact(s, "Checkout");
  const cast = (p: { id: string; name: string }) => s.setStage({ mode: "spotlight", items: [a.id] }, p.name, "main", { person: p });
  cast(chey);
  s.store.setSetting("stage", { ...s.stage(), lock: { ...s.stage().lock!, since: Date.now() - 90 * 60_000, lastActive: Date.now() - 90 * 60_000 } });
  expect(s.lockOf()?.by).toBe("Chey");
  // A lock with no person behind it still lets go when untouched for 20 minutes.
  s.store.setSetting("stage", { ...s.stage(), lock: { by: "Host", personId: null, since: Date.now() - 30 * 60_000, lastActive: Date.now() - 21 * 60_000 } });
  expect(s.lockOf()).toBeNull();
  expect(s.stage().lock).toBeUndefined();
  cast(chey);
  // Owner removed from the room.
  cast(felipe);
  s.removePerson(felipe.id);
  expect(s.lockOf()).toBeNull();
  // Owner's windows all stopped checking in.
  cast(chey);
  s.store.put("devices", { ...s.store.get("devices", "chey-mac")!, lastSeen: Date.now() - 11 * 60_000 });
  s.sweepLocks();
  expect(s.stage().lock).toBeUndefined();
  expect(s.stage().mode).toBe("spotlight");
});

test("jam_show while locked waits as ready to show, and doesn't ask a young lock's owner", async () => {
  const { s, hub, chey, reg, call, out } = room();
  const asked: ShowRequest[] = [];
  s.onShowRequest = (r) => asked.push(r);
  const felipeAgent = reg("Felipe");
  const a = artifact(s, "Checkout build", felipeAgent.id);
  const mine = artifact(s, "Pricing");
  s.setStage({ mode: "spotlight", items: [mine.id], title: "Pricing" }, "Chey", "main", { person: { id: chey.id, name: "Chey" } });
  const text = out(await call(felipeAgent, "jam_show", { mode: "spotlight", artifactIds: [a.id], title: "Checkout build" }));
  expect(text).toContain("Chey has the big screen locked");
  expect(text).not.toContain("asked Chey");
  expect(s.stage().items).toEqual([mine.id]);
  expect(s.readyToShow()).toHaveLength(1);
  expect(s.readyToShow()[0]).toMatchObject({ agentName: felipeAgent.name, label: "Checkout build" });
  expect(asked).toHaveLength(0);
  // The same thing again replaces its entry; the queue doesn't grow.
  await call(felipeAgent, "jam_show", { mode: "spotlight", artifactIds: [a.id], title: "Checkout build" });
  expect(s.readyToShow()).toHaveLength(1);
  expect(hub.session.state().readyToShow).toHaveLength(1);
});

test("once the lock is 5 minutes old an agent's request asks its owner once, with the words from the plan", async () => {
  const { s, chey, reg, call, out } = room();
  const asked: ShowRequest[] = [];
  s.onShowRequest = (r) => asked.push(r);
  const agent = reg("Felipe");
  const a = artifact(s, "checkout build", agent.id);
  const mine = artifact(s, "Pricing");
  s.setStage({ mode: "spotlight", items: [mine.id] }, "Chey", "main", { person: { id: chey.id, name: "Chey" } });
  age(s, 6 * 60_000);
  const text = out(await call(agent, "jam_show", { mode: "spotlight", artifactIds: [a.id], title: "the checkout build" }));
  expect(text).toContain("asked Chey");
  expect(asked).toHaveLength(1);
  expect(showRequestSpeech(asked[0])).toBe("Chey, Felipe's agent has the checkout build ready. Can I put it up?");
  expect(s.state().showRequests).toHaveLength(1);
  // A second request while one is open doesn't ask again.
  await call(agent, "jam_show", { mode: "spotlight", artifactIds: [a.id], title: "the checkout build again" });
  expect(asked).toHaveLength(1);
  // Yes: it goes up, unlocked; the lock is gone and the queue is empty.
  s.answerShowRequest(asked[0].id, true, "Chey");
  expect(s.stage().items).toEqual([a.id]);
  expect(s.stage().lock).toBeUndefined();
  expect(s.readyToShow().map((r) => r.label)).toEqual(["the checkout build again"]);
});

test("no keeps the owner's screen, keeps the item queued, and the agent isn't asked again for a while", async () => {
  const { s, chey, reg, call } = room();
  const asked: ShowRequest[] = [];
  s.onShowRequest = (r) => asked.push(r);
  const agent = reg("Felipe");
  const a = artifact(s, "Checkout", agent.id);
  const mine = artifact(s, "Pricing");
  s.setStage({ mode: "spotlight", items: [mine.id] }, "Chey", "main", { person: { id: chey.id, name: "Chey" } });
  age(s, 6 * 60_000);
  await call(agent, "jam_show", { mode: "spotlight", artifactIds: [a.id], title: "Checkout" });
  s.answerShowRequest(asked[0].id, false, "Chey");
  expect(s.stage().items).toEqual([mine.id]);
  expect(s.stage().lock?.by).toBe("Chey");
  expect(s.lockOf()!.lastActive).toBeGreaterThan(Date.now() - 5_000); // answering counts as activity
  expect(s.readyToShow()).toHaveLength(1);
  await call(agent, "jam_show", { mode: "spotlight", artifactIds: [a.id], title: "Checkout" });
  expect(asked).toHaveLength(1);
  expect(s.answerShowRequest(asked[0].id, true, "Chey")).toBeNull(); // already answered
});

test("the owner's spoken yes or no answers the question; nobody else's words do", async () => {
  const { s, chey, felipe, reg, call, said } = room();
  const asked: ShowRequest[] = [];
  s.onShowRequest = (r) => asked.push(r);
  const agent = reg("Felipe");
  const a = artifact(s, "Checkout", agent.id);
  s.setStage({ mode: "spotlight", items: [artifact(s, "Pricing").id] }, "Chey", "main", { person: { id: chey.id, name: "Chey" } });
  age(s, 6 * 60_000);
  await call(agent, "jam_show", { mode: "spotlight", artifactIds: [a.id], title: "Checkout" });
  const req = asked[0];
  const t = req.at + 5_000;
  expect(showVerdict([said(chey, "yes, show it", t)], req)).toEqual({ approve: true, by: "Chey" });
  expect(showVerdict([said(chey, "Keep mine up.", t)], req)).toEqual({ approve: false, by: "Chey" });
  expect(showVerdict([said(chey, "JamSesh, keep mine up", t)], req)?.approve).toBe(false);
  expect(showVerdict([said(chey, "no", t)], req)?.approve).toBe(false);
  // Not the owner, not a whole answer, a question, before it was asked, a stale bare yes.
  expect(showVerdict([said(felipe, "yes show it", t)], req)).toBeNull();
  expect(showVerdict([said(chey, "yes I think we should show it later", t)], req)).toBeNull();
  expect(showVerdict([said(chey, "should I keep mine up?", t)], req)).toBeNull();
  expect(showVerdict([said(chey, "yes show it", req.at - 1000)], req)).toBeNull();
  expect(showVerdict([said(chey, "yes", req.at + 120_000)], req)).toBeNull();
  expect(showVerdict([said(chey, "yes show it", req.at + 120_000)], req)?.approve).toBe(true);
});

test("the brain's voice handling applies the owner's answer", async () => {
  const { hub, s, chey, reg, call, said } = room();
  s.onShowRequest = () => {};
  const agent = reg("Felipe");
  const a = artifact(s, "Checkout", agent.id);
  s.setStage({ mode: "spotlight", items: [artifact(s, "Pricing").id] }, "Chey", "main", { person: { id: chey.id, name: "Chey" } });
  age(s, 6 * 60_000);
  await call(agent, "jam_show", { mode: "spotlight", artifactIds: [a.id], title: "Checkout" });
  hub.brain.hear(said(chey, "yeah, show it"));
  expect(s.stage().items).toEqual([a.id]);
  expect(s.showRequests().find((r) => r.status === "approved")).toBeTruthy();
});

test("the room brain's show tools don't replace a lock; its owner asking does", async () => {
  const { s, chey, felipe, tools, said } = room();
  const a = artifact(s, "Checkout");
  const mine = artifact(s, "Pricing");
  s.setStage({ mode: "spotlight", items: [mine.id] }, "Chey", "main", { person: { id: chey.id, name: "Chey" } });
  // Felipe asks the brain to show something else: refused, with words telling it to ask the room.
  const t1 = tools([said(felipe, "show the checkout")]);
  const refused: any = await t1.show_on_screen.execute({ mode: "spotlight", artifactIds: [a.id] });
  expect(String(refused)).toContain("Chey has this screen locked");
  expect(s.stage().items).toEqual([mine.id]);
  for (const [name, args] of [["build_custom_view", { title: "x", html: "<p>x</p>" }], ["set_layout", { tiles: [{ kind: "artifact", ref: a.id }] }], ["restore_screen", {}]] as const) {
    const r: any = await (t1 as any)[name].execute(args);
    expect(String(r)).not.toBe("On screen.");
  }
  expect(s.stage().items).toEqual([mine.id]);
  // Unlock needs a person's yes in the lines.
  expect(String(await t1.unlock_screen.execute({}))).toContain("nobody in these lines said to replace it");
  const t2 = tools([said(felipe, "yeah go ahead and replace it")]);
  expect(await t2.unlock_screen.execute({})).toContain("Unlocked");
  expect(await t2.show_on_screen.execute({ mode: "spotlight", artifactIds: [a.id] })).toBe("On screen.");
  expect(s.stage().items).toEqual([a.id]);
  expect(s.stage().lock).toBeUndefined();
  // The owner themself asking just works.
  s.setStage({ mode: "spotlight", items: [mine.id] }, "Chey", "main", { person: { id: chey.id, name: "Chey" } });
  const t3 = tools([said(chey, "bring up the checkout")]);
  expect(await t3.show_on_screen.execute({ mode: "spotlight", artifactIds: [a.id] })).toBe("On screen.");
  expect(s.stage().items).toEqual([a.id]);
});

test("a finished variant set waits in the queue while a screen is locked", () => {
  const { hub, s, chey, reg } = room();
  const agent = reg("Felipe");
  const mine = artifact(s, "Pricing");
  s.setStage({ mode: "spotlight", items: [mine.id] }, "Chey", "main", { person: { id: chey.id, name: "Chey" } });
  const mk = (v: string) => s.upsertArtifact({ kind: "screenshot", stage: "built", title: `Nav / ${v}: tabs`, agentId: agent.id, image: `/renders/${v}.png` });
  const arts = [mk("A"), mk("B")];
  hub.brain.artifactsLanded(arts);
  expect(s.stage().items).toEqual([mine.id]);
  expect(s.readyToShow().map((r) => r.label)).toEqual(["Compare Nav"]);
  // Unlocked, the same landing shows the comparison.
  s.unlockStage();
  hub.brain.artifactsLanded(arts);
  expect(s.stage().mode).toBe("compare");
});

test("a share doesn't take a screen someone else locked, and shows over its own sharer's", async () => {
  const { hub, s, chey, felipe } = room();
  const a = artifact(s, "Pricing");
  s.setStage({ mode: "spotlight", items: [a.id] }, "Chey", "main", { person: { id: chey.id, name: "Chey" } });
  const sh = s.startShare("felipe-laptop", "screen");
  await hub.brain.placeShare(sh);
  expect(s.stage().mode).toBe("spotlight");
  s.endShare(sh.id);
  s.setStage({ mode: "spotlight", items: [a.id] }, "Felipe", "main", { person: { id: felipe.id, name: "Felipe" } });
  const mine = s.startShare("felipe-laptop", "screen");
  await hub.brain.placeShare(mine);
  expect(s.stage().mode).toBe("layout");
});

test("the http routes: /stage locks for the window's person, restore and unlock obey the lock, answers come from the owner", async () => {
  const { hub, s, chey, felipe } = room();
  const server = startHttp(hub, 0);
  try {
    const a = artifact(s, "Checkout");
    const b = artifact(s, "Pricing");
    const post = (path: string, body: any) => fetch(`http://127.0.0.1:${server.port}/api${path}`, { method: "POST", headers: { "content-type": "application/json", cookie: `jam_window=${hub.auth.windows.take(hub.auth.windows.mint())}` }, body: JSON.stringify(body) });
    expect((await post("/stage", { mode: "spotlight", items: [a.id], personId: chey.id, by: "Host" })).status).toBe(200);
    expect(s.stage().lock?.by).toBe("Chey");
    // Felipe's window casts the other: it replaces (people can), and the history remembers Chey's.
    await post("/stage", { mode: "spotlight", items: [b.id], personId: felipe.id });
    expect(s.stage().lock?.by).toBe("Felipe");
    const earlier = s.stageHistory().main.find((e) => e.by === "Chey")!;
    // Chey taps it in the strip while Felipe holds the screen: held off. Felipe unlocks, then Chey can.
    expect((await post("/stage/restore", { id: earlier.id, personId: chey.id })).status).toBe(409);
    expect((await post("/stage/unlock", {})).status).toBe(200);
    expect((await post("/stage/restore", { id: earlier.id, personId: chey.id })).status).toBe(200);
    expect(s.stage().items).toEqual([a.id]);
    expect(s.stage().lock?.by).toBe("Chey");
    // The queue: show and dismiss.
    const r1 = s.queueReady({ screen: "main", agentId: "x", agentName: "Agent", label: "One", stage: { mode: "spotlight", items: [b.id] } });
    const r2 = s.queueReady({ screen: "main", agentId: "x", agentName: "Agent", label: "Two", stage: { mode: "spotlight", items: [b.id] } });
    expect((await post(`/stage/ready/${r2.id}`, { action: "dismiss" })).status).toBe(200);
    expect(s.readyToShow().map((r) => r.id)).toEqual([r1.id]);
    expect((await post(`/stage/ready/${r1.id}`, { action: "show", personId: felipe.id })).status).toBe(200);
    expect(s.stage().by).toBe("Felipe");
    expect(s.readyToShow()).toHaveLength(0);
  } finally {
    server.stop(true);
  }
});

// ---------- 3.5 versions ----------

test("buildKey drops the marks of a rebuild but keeps variants apart", () => {
  expect(buildKey("Checkout (built)")).toBe("checkout");
  expect(buildKey("Checkout v2")).toBe("checkout");
  expect(buildKey("Checkout - v3")).toBe("checkout");
  expect(buildKey("Mobile nav / B: bottom tabs (built)")).toBe("mobile nav / b: bottom tabs");
  expect(buildKey("Mobile nav / A")).not.toBe(buildKey("Mobile nav / B"));
  expect(buildKey("Checkout")).toBe(buildKey("  checkout  "));
});

test("a new build of the same screen is the next version of one item, in place", async () => {
  const { hub, s, reg, call, out } = room();
  const agent = reg("Felipe");
  const img = Buffer.from(PNG).toString("base64");
  const first = await hub.saveUpload(agent, PNG, { title: "Checkout", stage: "built" });
  s.setStage({ mode: "spotlight", items: [first.id] }, "Felipe", "main", { override: true });
  const second = await hub.saveUpload(agent, PNG, { title: "Checkout (built)", stage: "built", note: "tighter spacing" });
  const third = out(await call(agent, "jam_post_image", { title: "Checkout v3", imageBase64: img }));
  expect(second.id).toBe(first.id);
  expect(third).toContain("version 3");
  const art = s.store.get("artifacts", first.id)!;
  expect(art.version).toBe(3);
  expect(art.versions?.map((v) => v.version)).toEqual([1, 2]);
  expect(art.title).toBe("Checkout");
  expect(art.versions![0].image).toBe(first.image); // the first build's image stays retrievable
  expect(art.image).not.toBe(first.image);
  expect(s.artifacts().filter((a) => a.title === "Checkout")).toHaveLength(1);
  // The screen showing it shows the new build without being touched.
  expect(s.stage().items).toEqual([first.id]);
  // A later upsert of the item (a canvas note, say) keeps its versions.
  s.upsertArtifact({ ...art, note: "x" });
  expect(s.store.get("artifacts", first.id)!.versions).toHaveLength(2);
  expect(s.store.recentEvents({ kinds: ["artifact"], limit: 10 }).some((e) => /New version \(v3\)/.test(e.text))).toBe(true);
});

test("different agents, stages and variants stay separate items; an explicit replaces folds across titles", async () => {
  const { hub, s, reg } = room();
  const felipe = reg("Felipe");
  const jon = reg("Jonathan", "acme/other");
  const a = await hub.saveUpload(felipe, PNG, { title: "Checkout", stage: "built" });
  const b = await hub.saveUpload(jon, PNG, { title: "Checkout", stage: "built" });
  const c = await hub.saveUpload(felipe, PNG, { title: "Checkout", stage: "mockup" });
  const d = await hub.saveUpload(felipe, PNG, { title: "Nav / A", stage: "built" });
  const e = await hub.saveUpload(felipe, PNG, { title: "Nav / B", stage: "built" });
  expect(new Set([a.id, b.id, c.id, d.id, e.id]).size).toBe(5);
  const renamed = await hub.saveUpload(felipe, PNG, { title: "Checkout, new layout", stage: "built", replaces: a.id });
  expect(renamed.id).toBe(a.id);
  expect(renamed.version).toBe(2);
  await expect(hub.saveUpload(felipe, PNG, { title: "Whatever", stage: "built", replaces: b.id })).rejects.toThrow(/someone else's agent/);
  await expect(hub.saveUpload(felipe, PNG, { title: "Whatever", stage: "built", replaces: "art-nope" })).rejects.toThrow(/No artifact/);
  expect(s.artifacts()).toHaveLength(5);
});

// ---------- 3.6 history ----------

test("each screen keeps what it showed and who put it up; restoring brings one back", () => {
  const { s, chey, felipe } = room();
  s.reportScreen("main", { width: 1920, height: 1080, dpr: 1, screenX: 0, screenY: 0, at: Date.now() });
  s.reportScreen("screen-2", { width: 1920, height: 1080, dpr: 1, screenX: 1920, screenY: 0, at: Date.now() });
  const a = artifact(s, "Checkout");
  const b = artifact(s, "Pricing");
  s.setStage({ mode: "spotlight", items: [a.id], title: "Checkout" }, "Chey", "main", { person: { id: chey.id, name: "Chey" } });
  s.setStage({ mode: "board" }, "JamSesh", "main", { override: true });
  s.setStage({ mode: "compare", items: [a.id, b.id] }, "Felipe", "main", { person: { id: felipe.id, name: "Felipe" } });
  s.setStage({ mode: "spotlight", items: [b.id], title: "Pricing" }, "Room brain", "screen-2");
  const main = s.stageHistory().main;
  expect(main.map((e) => [e.by, e.label])).toEqual([["Felipe", "Checkout and 1 more"], ["Chey", "Checkout"]]); // the board isn't kept
  expect(s.stageHistory()["screen-2"].map((e) => e.label)).toEqual(["Pricing"]);
  // The same thing again moves to the top instead of repeating.
  s.setStage({ mode: "spotlight", items: [a.id], title: "Checkout" }, "Felipe", "main", { person: { id: felipe.id, name: "Felipe" } });
  expect(s.stageHistory().main.map((e) => e.by)).toEqual(["Felipe", "Felipe"]);
  // "Bring back what Chey had up": found by name, newest first.
  s.setStage({ mode: "compare", items: [a.id, b.id], title: "Cmp" }, "Felipe", "main", { person: { id: felipe.id, name: "Felipe" } });
  expect(s.historyBy("felipe")?.label).toBe("Checkout");
  const hit = s.historyBy("Felipe")!;
  s.unlockStage();
  const back = s.restoreHistory(hit.id, "main", undefined, "Room brain")!;
  expect(back.mode).toBe("spotlight");
  expect(back.by).toBe("Room brain");
  // A locked screen holds off a restore that isn't a person's.
  s.setStage({ mode: "agents" }, "Chey", "main", { person: { id: chey.id, name: "Chey" } });
  expect(s.restoreHistory(s.previousScreens()[0].id, "main", undefined, "Room brain")!.mode).toBe("agents");
  expect(s.restoreHistory("his-nope", "main")).toBeNull();
});

test("the brain brings back what a person had up, and says so when nothing matches", async () => {
  const { s, chey, felipe, tools } = room();
  const a = artifact(s, "Checkout");
  const b = artifact(s, "Pricing");
  s.setStage({ mode: "spotlight", items: [a.id], title: "Checkout" }, "Chey", "main", { person: { id: chey.id, name: "Chey" } });
  s.setStage({ mode: "spotlight", items: [b.id], title: "Pricing" }, "Felipe", "main", { person: { id: felipe.id, name: "Felipe" } });
  s.unlockStage();
  const t = tools();
  expect(await t.restore_screen.execute({ by: "Chey" })).toContain("Brought back Checkout");
  expect(s.stage().items).toEqual([a.id]);
  expect(String(await t.restore_screen.execute({ by: "Jonathan" }))).toContain("Nothing Jonathan had up");
  expect(s.state().stageHistory.main.length).toBe(2);
});

test("history keeps at most 20 screens per screen", () => {
  const { s } = room();
  for (let i = 0; i < 30; i++) s.setStage({ mode: "spotlight", items: [], title: `Screen ${i}` }, "Room brain", "main", { override: true });
  expect(s.stageHistory().main).toHaveLength(Session.HISTORY_MAX);
  expect(s.stageHistory().main[0].label).toBe("Screen 29");
});

test("a direct request to JamSesh is a person's cast and locks to them; overheard talk and the brain's own moves don't", async () => {
  const { s, chey, felipe, tools, said } = room();
  const a = artifact(s, "Checkout");
  const direct = (who: { id: string; name: string }, text: string) => ({ ...said(who, text), data: { direct: true } }) as JamEvent;
  expect(await tools([direct(chey, "JamSesh, show the checkout")]).show_on_screen.execute({ mode: "spotlight", artifactIds: [a.id] })).toBe("On screen.");
  expect(s.stage().lock).toMatchObject({ by: "Chey", personId: chey.id });
  expect(s.stage().by).toBe("Room brain");
  s.unlockStage();
  await tools([direct(felipe, "put up a custom view")]).build_custom_view.execute({ title: "x", html: "<p>x</p>" });
  expect(s.stage().lock?.by).toBe("Felipe");
  s.unlockStage();
  s.saveLayout("review");
  s.setStage({ mode: "agents" }, "Room brain");
  await tools([direct(chey, "bring back the review layout")]).show_saved_layout.execute({ name: "review" });
  expect(s.stage().mode).toBe("custom");
  expect(s.stage().lock?.by).toBe("Chey");
  s.unlockStage();
  // Overheard, or the brain acting alone: no lock.
  await tools([said(felipe, "show the checkout")]).show_on_screen.execute({ mode: "spotlight", artifactIds: [a.id] });
  expect(s.stage().items).toEqual([a.id]);
  expect(s.stage().lock).toBeUndefined();
  await tools().show_on_screen.execute({ mode: "agents" });
  expect(s.stage().lock).toBeUndefined();
  // An agent's typed prompt to its own agent is not a request to the brain.
  const prompt = { ...direct(chey, "show it"), kind: "prompt" } as JamEvent;
  await tools([prompt]).show_on_screen.execute({ mode: "spotlight", artifactIds: [a.id] });
  expect(s.stage().lock).toBeUndefined();
});

test("the person at the host keeps their lock while the host's window is connected, and loses it when every window is gone", () => {
  const { s, chey } = room();
  s.store.setSetting("hostPersonId", chey.id);
  s.touchDevice("host", { label: "Room mic (host)", kind: "host" });
  s.store.put("devices", { ...s.store.get("devices", "chey-mac")!, lastSeen: Date.now() - 30 * 60_000 });
  s.store.put("devices", { ...s.store.get("devices", "host")!, lastSeen: Date.now() - 30 * 60_000 });
  const a = artifact(s, "Checkout");
  s.setStage({ mode: "spotlight", items: [a.id] }, "Chey", "main", { person: { id: chey.id, name: "Chey" } });
  s.deviceOnline = (id) => id === "host";
  expect(s.lockOf()?.by).toBe("Chey");
  s.deviceOnline = () => false;
  expect(s.lockOf()).toBeNull();
});

test("the people-only stage routes refuse an agent, a caller that isn't the host's window, and repeats", async () => {
  const { hub, s, chey, felipe, reg } = room();
  const server = startHttp(hub, 0);
  try {
    const a = artifact(s, "Checkout");
    const agent = reg("Felipe");
    const cred = hub.auth.issue({ kind: "agent", label: "Agents", ip: "127.0.0.1", ownerDeviceId: "host" });
    const win = () => `jam_window=${hub.auth.windows.take(hub.auth.windows.mint())}`;
    const post = (path: string, body: any, headers: Record<string, string>) => fetch(`http://127.0.0.1:${server.port}/api${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    s.setStage({ mode: "spotlight", items: [a.id] }, "Chey", "main", { person: { id: chey.id, name: "Chey" } });
    const item = s.queueReady({ screen: "main", agentId: agent.id, agentName: agent.name, label: "Build", stage: { mode: "spotlight", items: [a.id] } });
    s.onShowRequest = () => {};
    age(s, 6 * 60_000);
    const req = s.askOwner(item)!;
    const hist = s.stageHistory().main[0];
    const calls: [string, any][] = [["/stage", { mode: "agents" }], ["/stage/unlock", {}], ["/stage/restore", { id: hist.id }], [`/stage/ready/${item.id}`, { action: "show" }], [`/show-requests/${req.id}`, { approve: true }]];
    for (const [path, body] of calls) {
      // An agent's credential, with or without a person's name in the body.
      expect((await post(path, { ...body, personId: chey.id }, { authorization: `Bearer ${cred.token}` })).status).toBe(403);
      // Another process on the host with no window key.
      expect((await post(path, { ...body, personId: chey.id }, {})).status).toBe(403);
    }
    expect(s.stage().mode).toBe("spotlight");
    expect(s.stage().lock?.by).toBe("Chey");
    expect(s.readyToShow()).toHaveLength(1);
    expect(s.showRequests()[0].status).toBe("pending");
    // The host's window can answer; a repeat, a vanished item and an unknown id are clean refusals.
    expect((await post(`/show-requests/${req.id}`, { approve: false, personId: chey.id }, { cookie: win() })).status).toBe(200);
    expect((await post(`/show-requests/${req.id}`, { approve: true, personId: chey.id }, { cookie: win() })).status).toBe(404);
    expect((await post(`/stage/ready/${item.id}`, { action: "show", personId: felipe.id }, { cookie: win() })).status).toBe(200);
    expect((await post(`/stage/ready/${item.id}`, { action: "show", personId: felipe.id }, { cookie: win() })).status).toBe(404);
    expect((await post("/stage/restore", { id: "his-nope", personId: felipe.id }, { cookie: win() })).status).toBe(404);
    expect((await post("/stage", {}, { cookie: win() })).status).toBe(400);
  } finally {
    server.stop(true);
  }
});

test("locks, the queue and history are per screen: a lock on main doesn't hold the other display", async () => {
  const { s, chey, tools, said, felipe } = room();
  const info = { width: 1920, height: 1080, dpr: 1, screenY: 0, at: Date.now() };
  s.reportScreen("main", { ...info, screenX: 0 });
  s.reportScreen("screen-2", { ...info, screenX: 1920 });
  const a = artifact(s, "Checkout");
  s.setStage({ mode: "spotlight", items: [a.id] }, "Chey", "main", { person: { id: chey.id, name: "Chey" } });
  expect(s.lockOf("screen-2")).toBeNull();
  expect(await tools([said(felipe, "show it on the right")]).show_on_screen.execute({ mode: "agents", screen: "screen-2" })).toBe("On screen.");
  expect(s.stage("screen-2").mode).toBe("agents");
  expect(s.stage().lock?.by).toBe("Chey");
  // Locking the second display holds only it; its queue and history are its own.
  s.setStage({ mode: "spotlight", items: [a.id], title: "Right" }, "Felipe", "screen-2", { person: { id: felipe.id, name: "Felipe" } });
  expect(s.setStage({ mode: "agents" }, "Room brain", "screen-2").title).toBe("Right");
  s.queueReady({ screen: "screen-2", agentId: "x", agentName: "Agent", label: "For the right", stage: { mode: "agents" } });
  expect(s.readyToShow().map((r) => r.screen)).toEqual(["screen-2"]);
  expect(s.stageHistory()["screen-2"].map((e) => e.by)).toEqual(["Felipe", "Room brain"]);
  expect(s.stageHistory().main.map((e) => e.by)).toEqual(["Chey"]);
});

test("a paired window is the person it's bound to: another device naming the owner can't answer or take the lock", async () => {
  const { hub, s, chey, felipe, reg } = room();
  const server = startHttp(hub, 0);
  try {
    const a = artifact(s, "Checkout");
    // Three browsers paired from other machines: Chey's, Felipe's, and one that hasn't said who it is.
    const browser = (label: string, personId: string | null) => hub.auth.issue({ kind: "browser", label, personId, ip: "10.0.0.9" }).token;
    const [cheys, felipes, nobody] = [browser("Chey's Mac", chey.id), browser("Felipe's laptop", felipe.id), browser("Phone", null)];
    const as = (token: string) => (path: string, body: any) =>
      fetch(`http://127.0.0.1:${server.port}/api${path}`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.0.0.9", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    const me = async (token: string) => (await (await fetch(`http://127.0.0.1:${server.port}/api/me`, { headers: { "x-forwarded-for": "10.0.0.9", authorization: `Bearer ${token}` } })).json()).person?.id ?? null;

    // Felipe's browser says it's Chey when it casts: the lock is still Felipe's.
    expect((await as(felipes)("/stage", { mode: "spotlight", items: [a.id], personId: chey.id })).status).toBe(200);
    expect(s.stage().lock?.personId).toBe(felipe.id);
    // A browser that hasn't picked anyone is nobody in particular, not the person it names.
    await as(nobody)("/stage", { mode: "spotlight", items: [a.id], personId: chey.id, by: "Phone" });
    expect(s.stage().lock?.personId).toBeNull();
    expect((await as(cheys)("/stage", { mode: "spotlight", items: [a.id] })).status).toBe(200);
    expect(s.stage().lock?.personId).toBe(chey.id);

    const agent = reg("Felipe");
    const item = s.queueReady({ screen: "main", agentId: agent.id, agentName: agent.name, label: "Build", stage: { mode: "spotlight", items: [a.id] } });
    s.onShowRequest = () => {};
    age(s, 6 * 60_000);
    const req = s.askOwner(item)!;
    expect(req.ownerId).toBe(chey.id);
    // Felipe's browser claims Chey's id in the answer, then tries to become Chey: neither works, and it stays Felipe's.
    expect((await as(felipes)(`/show-requests/${req.id}`, { approve: true, personId: chey.id })).status).toBe(403);
    expect((await as(felipes)("/devices", { deviceId: "felipe-laptop", personId: chey.id })).status).toBe(200);
    expect(await me(felipes)).toBe(felipe.id);
    // One model: the device belongs to Felipe's window, and that window's devices are Felipe's.
    expect(s.store.get("devices", "felipe-laptop")?.personId).toBe(felipe.id);
    // Chey's browser can't take over the device Felipe's window registered (Phase 1's window-owned devices).
    expect((await as(cheys)("/devices", { deviceId: "felipe-laptop", personId: chey.id })).status).toBe(403);
    expect((await as(felipes)(`/show-requests/${req.id}`, { approve: true, personId: chey.id })).status).toBe(403);
    // The unbound browser naming Chey can't answer either.
    expect((await as(nobody)(`/show-requests/${req.id}`, { approve: true, personId: chey.id })).status).toBe(403);
    expect(s.showRequests()[0].status).toBe("pending");
    expect(s.stage().lock?.personId).toBe(chey.id);
    // Chey's own browser answers; the repeat is a clean refusal.
    expect((await as(cheys)(`/show-requests/${req.id}`, { approve: false })).status).toBe(200);
    expect((await as(cheys)(`/show-requests/${req.id}`, { approve: true })).status).toBe(404);

    // The unbound browser picks who it is once; picking again doesn't move it. A removed person frees it to pick again.
    const maya = s.upsertPerson({ name: "Maya" });
    await as(nobody)("/devices", { deviceId: "phone", personId: maya.id });
    expect(await me(nobody)).toBe(maya.id);
    await as(nobody)("/devices", { deviceId: "phone", personId: chey.id });
    expect(await me(nobody)).toBe(maya.id);
    // Assigning another device in Settings never moves the caller's own credential.
    await as(cheys)("/devices", { deviceId: "felipe-laptop", personId: felipe.id });
    expect(await me(cheys)).toBe(chey.id);
    s.removePerson(maya.id);
    // Freed, it picks again: not Felipe, whose own browser holds him (phase 5: only the host lets a laptop in as
    // someone another laptop is), but someone nobody has been.
    await as(nobody)("/devices", { deviceId: "phone", personId: felipe.id });
    expect(await me(nobody)).toBeNull();
    const nia = s.upsertPerson({ name: "Nia" });
    await as(nobody)("/devices", { deviceId: "phone", personId: nia.id });
    expect(await me(nobody)).toBe(nia.id);
    // Someone who doesn't exist is never bound.
    const fresh = browser("Tablet", null);
    await as(fresh)("/devices", { deviceId: "tablet", personId: "per_nope" });
    expect(await me(fresh)).toBeNull();
  } finally {
    server.stop(true);
  }
});

test("a named lock with no window of its owner's on record lets go after the grace period", () => {
  const { s, chey } = room();
  const a = artifact(s, "Checkout");
  s.setStage({ mode: "spotlight", items: [a.id] }, "Chey", "main", { person: { id: chey.id, name: "Chey" } });
  s.store.remove("devices", "chey-mac");
  // Recently active: it stays.
  s.store.setSetting("stage", { ...s.stage(), lock: { ...s.stage().lock!, lastActive: Date.now() - 60_000 } });
  expect(s.lockOf()?.by).toBe("Chey");
  s.store.setSetting("stage", { ...s.stage(), lock: { ...s.stage().lock!, lastActive: Date.now() - Session.LOCK_GONE_MS - 1000 } });
  s.sweepLocks();
  expect(s.stage().lock).toBeUndefined();
  expect(s.stage().mode).toBe("spotlight");
});

test("a stopped hub's screen timers stop too: none of them touches its store after it closes", () => {
  const { hub, s, chey } = room();
  const info = { width: 1920, height: 1080, dpr: 1, screenY: 0, at: Date.now() };
  s.reportScreen("screen-2", { ...info, screenX: 1920 });
  const a = artifact(s, "Checkout");
  s.setStage({ mode: "spotlight", items: [a.id] }, "Room brain");
  s.setStage({ mode: "spotlight", items: [a.id] }, "Room brain", "screen-2");
  s.setStage({ mode: "spotlight", items: [a.id] }, "Chey", "main", { person: { id: chey.id, name: "Chey" } });
  const timers = () => [(s as any).lockSweep, (s as any).stageRevert, (s as any).shareSweep, ...(s as any).screenReverts.values()].filter(Boolean);
  expect(timers().length).toBeGreaterThan(0);
  hub.stop();
  expect(timers()).toEqual([]);
});
