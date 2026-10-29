// Phase 3 on the big screen: a person's cast is locked (3.1), a rebuilt screen is one item with versions
// (3.5), and each screen remembers what it showed (3.6). Simulated rooms: fake people and agents, no sound.
import { afterAll, expect, test } from "bun:test";
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

// A 1x1 PNG and a 1x1 JPEG header are enough: uploads only sniff the format and read the size.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);

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
  (s as any).dropLock("main");
  expect(s.stage().mode).toBe("spotlight");
  expect(s.stage().lock).toBeUndefined();
});

test("a locked screen refuses the brain and automatic changes, but people and housekeeping get through", () => {
  const { s, chey, felipe } = room();
  const a = artifact(s, "Checkout");
  s.setStage({ mode: "spotlight", items: [a.id], title: "Checkout" }, "Chey", "main", { person: { id: chey.id, name: "Chey" } });
  expect(s.setStage({ mode: "agents" }, "Room brain", "main", { claim: s.stageClaim() }).mode).toBe("spotlight");
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
    (s as any).dropLock("main");
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
  expect(showVerdict([said(chey, "yes, show it", t)], req)).toMatchObject({ approve: true, by: "Chey" });
  expect(showVerdict([said(chey, "Keep mine up.", t)], req)).toMatchObject({ approve: false, by: "Chey" });
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
  // Unlock needs a person's plain yes, named by its line, in answer to the question the brain asked.
  (s as any).gatewayKey = () => "";
  await t1.ask_to_replace_screen.execute({});
  const asking = said(felipe, "show the checkout");
  expect(String(await tools([asking]).unlock_screen.execute({ line: asking.id }))).toContain("no line here plainly says to replace it");
  const yes = said(felipe, "yeah go ahead and replace it");
  const t2 = tools([yes]);
  expect(await t2.unlock_screen.execute({ line: yes.id })).toContain("Unlocked");
  expect(await t2.show_on_screen.execute({ mode: "spotlight", artifactIds: [a.id] })).toBe("On screen.");
  expect(s.stage().items).toEqual([a.id]);
  expect(s.stage().lock).toBeUndefined();
  // The owner themself asking JamSesh directly just works.
  s.setStage({ mode: "spotlight", items: [mine.id] }, "Chey", "main", { person: { id: chey.id, name: "Chey" } });
  const t3 = tools([{ ...said(chey, "bring up the checkout"), data: { direct: true } } as JamEvent]);
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
  (s as any).dropLock("main");
  hub.brain.artifactsLanded(arts);
  expect(s.stage().mode).toBe("compare");
});

test("a share doesn't take a screen someone else locked, and shows over its own sharer's", async () => {
  const { hub, s, chey, felipe } = room();
  // No model: the placement's own fallback, not a network call that can outlast the test.
  (s as any).gatewayKey = () => "";
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
    // Chey taps it in the strip while Felipe holds the screen: held off. The host's window can't let go of Felipe's lock
    // (naming Felipe doesn't make it his); his own window can, then Chey can.
    expect((await post("/stage/restore", { id: earlier.id, personId: chey.id })).status).toBe(409);
    expect((await post("/stage/unlock", { personId: felipe.id })).status).toBe(403);
    expect(s.stage().lock?.by).toBe("Felipe");
    const felipes = hub.auth.issue({ kind: "browser", label: "Felipe's laptop", ip: "127.0.0.1", personId: felipe.id });
    const asFelipe = (path: string, body: any) => fetch(`http://127.0.0.1:${server.port}/api${path}`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.0.0.8", authorization: `Bearer ${felipes.token}` }, body: JSON.stringify(body) });
    expect((await asFelipe("/stage/unlock", {})).status).toBe(200);
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
  s.setStage({ mode: "spotlight", items: [b.id], title: "Pricing" }, "Room brain", "screen-2", { claim: s.stageClaim() });
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
  (s as any).dropLock("main");
  const back = s.restoreHistory(hit.id, "main", { claim: s.stageClaim() }, "Room brain")!;
  expect(back.mode).toBe("spotlight");
  expect(back.by).toBe("Room brain");
  // A locked screen holds off a restore that isn't a person's.
  s.setStage({ mode: "agents" }, "Chey", "main", { person: { id: chey.id, name: "Chey" } });
  expect(s.restoreHistory(s.previousScreens()[0].id, "main", { claim: s.stageClaim() }, "Room brain")!.mode).toBe("agents");
  expect(s.restoreHistory("his-nope", "main", { claim: s.stageClaim() })).toBeNull();
});

test("the brain brings back what a person had up, and says so when nothing matches", async () => {
  const { s, chey, felipe, tools } = room();
  const a = artifact(s, "Checkout");
  const b = artifact(s, "Pricing");
  s.setStage({ mode: "spotlight", items: [a.id], title: "Checkout" }, "Chey", "main", { person: { id: chey.id, name: "Chey" } });
  s.setStage({ mode: "spotlight", items: [b.id], title: "Pricing" }, "Felipe", "main", { person: { id: felipe.id, name: "Felipe" } });
  (s as any).dropLock("main");
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
  (s as any).dropLock("main");
  await tools([direct(felipe, "put up a custom view")]).build_custom_view.execute({ title: "x", html: "<p>x</p>" });
  expect(s.stage().lock?.by).toBe("Felipe");
  (s as any).dropLock("main");
  s.saveLayout("review");
  s.setStage({ mode: "agents" }, "Room brain", "main", { claim: s.stageClaim() });
  await tools([direct(chey, "bring back the review layout")]).show_saved_layout.execute({ name: "review" });
  expect(s.stage().mode).toBe("custom");
  expect(s.stage().lock?.by).toBe("Chey");
  (s as any).dropLock("main");
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
  expect(s.setStage({ mode: "agents" }, "Room brain", "screen-2", { claim: s.stageClaim() }).title).toBe("Right");
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
    await as(nobody)("/devices", { deviceId: "phone", personId: felipe.id });
    expect(await me(nobody)).toBe(felipe.id);
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
  s.setStage({ mode: "spotlight", items: [a.id] }, "Room brain", "main", { claim: s.stageClaim() });
  s.setStage({ mode: "spotlight", items: [a.id] }, "Room brain", "screen-2", { claim: s.stageClaim() });
  s.setStage({ mode: "spotlight", items: [a.id] }, "Chey", "main", { person: { id: chey.id, name: "Chey" } });
  const timers = () => [(s as any).lockSweep, (s as any).stageRevert, (s as any).shareSweep, ...(s as any).screenReverts.values()].filter(Boolean);
  expect(timers().length).toBeGreaterThan(0);
  hub.stop();
  expect(timers()).toEqual([]);
});

test("only the owner's own direct request lets the brain replace their lock; their other words nearby don't", async () => {
  const { s, chey, felipe, tools, said } = room();
  const a = artifact(s, "Checkout");
  const mine = artifact(s, "Pricing");
  const direct = (who: { id: string; name: string }, text: string) => ({ ...said(who, text), data: { direct: true } }) as JamEvent;
  const cast = () => s.setStage({ mode: "spotlight", items: [mine.id] }, "Chey", "main", { person: { id: chey.id, name: "Chey" } });
  cast();
  // Chey's unrelated remark in the same batch as Felipe's request isn't consent.
  const r1: any = await tools([said(chey, "this coffee is great"), direct(felipe, "JamSesh, show the checkout")]).show_on_screen.execute({ mode: "spotlight", artifactIds: [a.id] });
  expect(String(r1)).toContain("Chey has this screen locked");
  expect(s.stage().lock?.by).toBe("Chey");
  // Nor is Chey talking (not to JamSesh) while the brain acts on its own.
  expect(String(await tools([said(chey, "bring up the checkout")]).show_on_screen.execute({ mode: "spotlight", artifactIds: [a.id] }))).toContain("locked");
  // Chey and Felipe both asking JamSesh in one batch: whose ask this is isn't clear, so it stays.
  expect(String(await tools([direct(chey, "JamSesh, show pricing"), direct(felipe, "JamSesh, show the checkout")]).show_on_screen.execute({ mode: "spotlight", artifactIds: [a.id] }))).toContain("locked");
  expect(s.stage().items).toEqual([mine.id]);
  // Chey asking directly, alone: it goes up.
  expect(await tools([direct(chey, "JamSesh, show the checkout")]).show_on_screen.execute({ mode: "spotlight", artifactIds: [a.id] })).toBe("On screen.");
  expect(s.stage().items).toEqual([a.id]);
});

test("unlock_screen takes only a whole plain yes: negations, questions and mixed answers don't unlock", async () => {
  const { s, chey, felipe, tools, said } = room();
  const mine = artifact(s, "Pricing");
  s.setStage({ mode: "spotlight", items: [mine.id] }, "Chey", "main", { person: { id: chey.id, name: "Chey" } });
  // The brain was refused and asked the room, so a yes now answers that question.
  (s as any).gatewayKey = () => "";
  const t0 = tools([said(felipe, "show something else")]);
  await t0.show_on_screen.execute({ mode: "agents" });
  await t0.ask_to_replace_screen.execute({});
  for (const text of ["No, don't unlock it", "don't unlock it", "should I unlock it?", "Yes, keep mine up", "yes but not yet", "I wouldn't unlock it", "unlock it?", "no", "keep it up", "maybe go ahead"]) {
    const line = said(felipe, text);
    const r: any = await tools([line]).unlock_screen.execute({ line: line.id });
    expect([text, String(r)]).toEqual([text, expect.stringContaining("plainly says")]);
    expect(s.stage().lock?.by).toBe("Chey");
  }
  // The line has to be one of these lines, from a person.
  expect(String(await tools([said(felipe, "yes")]).unlock_screen.execute({ line: 999_999_999 }))).toContain("plainly says");
  // A plain yes, said to the brain by name too, does.
  const yes = said(felipe, "JamSesh, yes, go ahead and replace it");
  expect(await tools([yes]).unlock_screen.execute({ line: yes.id })).toContain("Unlocked");
});

test("a bystander's yes counts only as the answer to the brain's question, about that lock; the owner may ask to unlock directly", async () => {
  const { s, chey, felipe, tools, said } = room();
  const mine = artifact(s, "Pricing");
  const cast = () => s.setStage({ mode: "spotlight", items: [mine.id] }, "Chey", "main", { person: { id: chey.id, name: "Chey" } });
  cast();
  (s as any).gatewayKey = () => "";
  const yesTo = async (text = "yes, replace it", ts = Date.now()) => {
    const line = said(felipe, text, ts);
    return String(await tools([line]).unlock_screen.execute({ line: line.id }));
  };
  // Nobody asked: Felipe's "unlock it" out of the blue does nothing.
  expect(await yesTo("unlock it")).toContain("plainly says");
  // The brain was refused but hasn't asked anyone yet: still nothing.
  const t = tools([said(felipe, "show the agents")]);
  await t.show_on_screen.execute({ mode: "agents" });
  expect(await yesTo()).toContain("plainly says");
  // Asked: a yes said before the question doesn't answer it; one said too long after doesn't either.
  const before = Date.now() - 1000;
  const t1 = tools([said(felipe, "show the agents")]);
  await t1.show_on_screen.execute({ mode: "agents" });
  expect(await t1.ask_to_replace_screen.execute({})).toBe("Asked the room.");
  expect(await yesTo("yes, replace it", before)).toContain("plainly says");
  const questions = (s as any).lockQuestions as Map<string, { id: string; since: number; at: number }>;
  const asked = questions.get("main")!;
  expect(asked.since).toBe(s.stage().lock!.since);
  questions.set("main", { ...asked, at: Date.now() - 4 * 60_000 });
  expect(await yesTo("yes, replace it", Date.now() - 4 * 60_000 + 10)).toContain("plainly says");
  questions.set("main", asked);
  // The lock changed since the question (Chey cast again): the question was about the old lock.
  cast();
  expect(await yesTo()).toContain("plainly says");
  expect(s.stage().lock?.by).toBe("Chey");
  // A question asked about this lock, then a yes: that works.
  const t2 = tools([said(felipe, "show the agents")]);
  await t2.show_on_screen.execute({ mode: "agents" });
  await t2.ask_to_replace_screen.execute({});
  expect(await yesTo()).toContain("Unlocked");
  cast();
  // Chey asking JamSesh to unlock her own screen does.
  const own = { ...said(chey, "JamSesh, unlock my screen"), data: { direct: true } } as JamEvent;
  expect(await tools([own]).unlock_screen.execute({ line: own.id })).toContain("Unlocked");
});

test("a show request answers only the lock it asked about: a later cast or an unlock expires it, and a late yes does nothing", async () => {
  const { hub, s, chey, felipe, reg } = room();
  const server = startHttp(hub, 0);
  try {
    const a = artifact(s, "Checkout");
    const agent = reg("Rae");
    s.onShowRequest = () => {};
    const ask = () => {
      const item = s.queueReady({ screen: "main", agentId: agent.id, agentName: agent.name, label: "Build", stage: { mode: "agents" } });
      age(s, 6 * 60_000);
      return { item, req: s.askOwner(item)! };
    };
    s.setStage({ mode: "spotlight", items: [a.id] }, "Chey", "main", { person: { id: chey.id, name: "Chey" } });
    const first = ask();
    expect(first.req.lockSince).toBe(s.stage().lock!.since);
    // Felipe casts over it before Chey answers: the question is over, and Chey's late yes doesn't replace Felipe's cast.
    s.setStage({ mode: "spotlight", items: [a.id], title: "Felipe's" }, "Felipe", "main", { person: { id: felipe.id, name: "Felipe" } });
    expect(s.showRequests().find((r) => r.id === first.req.id)?.status).toBe("expired");
    expect(s.answerShowRequest(first.req.id, true, "Chey")).toBeNull();
    expect(s.stage().title).toBe("Felipe's");
    expect(s.readyToShow().map((r) => r.id)).toContain(first.item.id);
    // Unlocked, then locked again by the same person: a new lock, so the old question still doesn't count.
    s.dismissReady(first.item.id);
    const second = ask();
    expect(second.req.ownerId).toBe(felipe.id);
    (s as any).dropLock("main");
    s.setStage({ mode: "spotlight", items: [a.id], title: "Felipe again" }, "Felipe", "main", { person: { id: felipe.id, name: "Felipe" } });
    const post = (path: string, body: any) => fetch(`http://127.0.0.1:${server.port}/api${path}`, { method: "POST", headers: { "content-type": "application/json", cookie: `jam_window=${hub.auth.windows.take(hub.auth.windows.mint())}` }, body: JSON.stringify(body) });
    expect((await post(`/show-requests/${second.req.id}`, { approve: true })).status).toBeGreaterThanOrEqual(404);
    expect(s.stage().title).toBe("Felipe again");
    // A question whose lock still stands but whose item went away: the yes doesn't claim it went up.
    s.dismissReady(second.item.id);
    const third = ask();
    s.dismissReady(third.item.id);
    expect((await post(`/show-requests/${third.req.id}`, { approve: true })).status).toBe(409);
    expect(s.stage().title).toBe("Felipe again");
    expect(s.store.recentEvents({ kinds: ["system"], limit: 20 }).some((e) => /is on the big screen/.test(e.text))).toBe(false);
    // The same lock, the same item: the owner's yes still works.
    const fourth = ask();
    expect((await post(`/show-requests/${fourth.req.id}`, { approve: true })).status).toBe(200);
    expect(s.stage().mode).toBe("agents");
  } finally {
    server.stop(true);
  }
});

test("the owner's own share keeps their lock, and their cast comes back locked when it ends", async () => {
  const { hub, s, felipe } = room();
  // No model: the share goes up the brain's own way (the path every share falls back to).
  (s as any).gatewayKey = () => "";
  const a = artifact(s, "Pricing");
  s.setStage({ mode: "spotlight", items: [a.id], title: "Felipe's cast" }, "Felipe", "main", { person: { id: felipe.id, name: "Felipe" } });
  const since = s.stage().lock!.since;
  const sh = s.startShare("felipe-laptop", "screen");
  await hub.brain.placeShare(sh);
  expect(s.stage().mode).toBe("layout");
  expect(s.stage().lock).toMatchObject({ personId: felipe.id, since });
  s.endShare(sh.id);
  expect(s.stage().title).toBe("Felipe's cast");
  expect(s.stage().lock).toMatchObject({ personId: felipe.id, since });
  // Let go of during the share: what comes back is unlocked.
  const again = s.startShare("felipe-laptop", "screen");
  await hub.brain.placeShare(again);
  (s as any).dropLock("main");
  s.endShare(again.id);
  expect(s.stage().title).toBe("Felipe's cast");
  expect(s.stage().lock).toBeUndefined();
});

test("the lock question is its own fixed action: a problem said some other way opens no window for a bystander's yes", async () => {
  const { s, chey, felipe, tools, said } = room();
  const mine = artifact(s, "Pricing");
  s.setStage({ mode: "spotlight", items: [mine.id] }, "Chey", "main", { person: { id: chey.id, name: "Chey" } });
  (s as any).gatewayKey = () => "";
  const t = tools([said(felipe, "show the agents")]);
  // Asking without having been refused does nothing.
  expect(String(await t.ask_to_replace_screen.execute({}))).toContain("Nothing here was refused");
  await t.show_on_screen.execute({ mode: "agents" });
  // Any other problem the brain voices (a different question, an unrelated complaint) doesn't count as asking.
  await t.say_to_room.execute({ text: "I can't do that right now.", kind: "problem" });
  await t.say_to_room.execute({ text: "Want me to show the agents instead?", kind: "problem" });
  const early = said(felipe, "yes, replace it");
  expect(String(await tools([early]).unlock_screen.execute({ line: early.id }))).toContain("plainly says");
  // The fixed question names the lock, and only after it is delivered does a yes count (a new pass, refused again).
  const t2 = tools([said(felipe, "show the agents")]);
  await t2.show_on_screen.execute({ mode: "agents" });
  expect(await t2.ask_to_replace_screen.execute({})).toBe("Asked the room.");
  expect(s.store.recentEvents({ limit: 3 }).map((e) => e.text)).toContain("Chey has the screen locked. Want me to replace it?");
  const yes = said(felipe, "yes, replace it");
  expect(await tools([yes]).unlock_screen.execute({ line: yes.id })).toContain("Unlocked");
});

test("the owner's unrelated direct question doesn't clear their lock, but a request to change the screen does", async () => {
  const { s, chey, tools, said } = room();
  const a = artifact(s, "Checkout");
  const mine = artifact(s, "Pricing");
  const direct = (text: string, data: Record<string, unknown> = {}) => ({ ...said(chey, text), data: { direct: true, ...data } }) as JamEvent;
  const cast = () => s.setStage({ mode: "spotlight", items: [mine.id] }, "Chey", "main", { person: { id: chey.id, name: "Chey" } });
  cast();
  const show = (line: JamEvent) => tools([line]).show_on_screen.execute({ mode: "spotlight", artifactIds: [a.id] });
  for (const q of ["JamSesh, what is Felipe's agent doing?", "JamSesh, how many agents are running", "JamSesh, did the build pass?", "JamSesh, thanks"]) {
    expect([q, String(await show(direct(q)))]).toEqual([q, expect.stringContaining("locked")]);
    expect(s.stage().lock?.by).toBe("Chey");
  }
  // Triage's reading wins when it exists: a line it called a question stays one.
  expect(String(await show(direct("JamSesh, show me the status", { intent: "question" })))).toContain("locked");
  expect(s.stage().items).toEqual([mine.id]);
  expect(await show(direct("JamSesh, show the checkout"))).toBe("On screen.");
  cast();
  expect(await show(direct("JamSesh, anything on pricing?", { intent: "present" }))).toBe("On screen.");
});

// ---------- round 6: one consent gate for every unlock, and no stale screen targets ----------

test("releaseLock is the one gate: the owner, the host's windows for the host's or nobody's lock, or a timely answer to the question", async () => {
  const { s, chey, felipe } = room();
  const a = artifact(s, "Checkout");
  const lockAs = (p: { id: string | null; name: string }) => s.setStage({ mode: "spotlight", items: [a.id] }, p.name, "main", { person: p });
  lockAs(chey);
  // Someone else, nobody, or the host's window for a guest's lock: no.
  expect(s.releaseLock("main", { owner: felipe.id })).toBe(false);
  expect(s.releaseLock("main", { owner: null })).toBe(false);
  expect(s.releaseLock("main", { hostWindow: true })).toBe(false);
  // A yes with no question asked, or to a question about an earlier lock: no.
  expect(s.releaseLock("main", { answeredAt: Date.now(), by: felipe.id })).toBe(false);
  s.askedAboutLock("main");
  await Bun.sleep(2);
  lockAs(chey);
  expect(s.releaseLock("main", { answeredAt: Date.now() + 1, by: felipe.id })).toBe(false);
  expect(s.stage().lock?.by).toBe("Chey");
  // Asked about this lock: a yes said before the question doesn't answer it; one after does, once.
  s.askedAboutLock("main");
  expect(s.releaseLock("main", { answeredAt: Date.now() - 5_000, by: felipe.id })).toBe(false);
  expect(s.releaseLock("main", { answeredAt: Date.now() + 1, by: felipe.id })).toBe(true);
  expect(s.stage().lock).toBeUndefined();
  lockAs(chey);
  // The question was used up.
  expect(s.releaseLock("main", { answeredAt: Date.now() + 1, by: felipe.id })).toBe(false);
  // The owner always can.
  expect(s.releaseLock("main", { owner: chey.id })).toBe(true);
  // The host's window: a lock held by nobody in particular, or by the person at the host.
  lockAs({ id: null, name: "Host" });
  expect(s.releaseLock("main", { hostWindow: true })).toBe(true);
  s.store.setSetting("hostPersonId", chey.id);
  lockAs(chey);
  expect(s.releaseLock("main", { hostWindow: true })).toBe(true);
});

test("/stage/unlock: only the owner's own window, or the host's window for the host's own lock; a stale screen id is refused", async () => {
  const { hub, s, chey, felipe } = room();
  const server = startHttp(hub, 0);
  try {
    const a = artifact(s, "Checkout");
    const as = (who: { id: string }) => hub.auth.issue({ kind: "browser", label: "laptop", ip: "10.0.0.9", personId: who.id }).token;
    const [cheys, felipes] = [as(chey), as(felipe)];
    const post = (path: string, body: any, headers: Record<string, string>) => fetch(`http://127.0.0.1:${server.port}/api${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    const remote = (token: string) => ({ "x-forwarded-for": "10.0.0.9", authorization: `Bearer ${token}` });
    const host = () => ({ cookie: `jam_window=${hub.auth.windows.take(hub.auth.windows.mint())}` });
    s.setStage({ mode: "spotlight", items: [a.id] }, "Chey", "main", { person: { id: chey.id, name: "Chey" } });
    // Felipe's window, with or without Chey's name in the body; the host's window naming Chey: no.
    const refused = await post("/stage/unlock", { personId: chey.id }, remote(felipes));
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as any).error).toBe("Only Chey can unlock this screen.");
    expect((await post("/stage/unlock", { personId: chey.id }, host())).status).toBe(403);
    expect(s.stage().lock?.by).toBe("Chey");
    // A screen that's gone: refused, and main isn't touched in its place.
    for (const [path, body] of [["/stage/unlock", {}], ["/stage", { mode: "agents" }], ["/stage/restore", { id: "x" }], ["/stage/expand", { tile: null }]] as const) {
      const r = await post(path, { ...body, screen: "screen-unplugged" }, remote(cheys));
      expect([path, r.status]).toEqual([path, 404]);
    }
    expect(s.stage().mode).toBe("spotlight");
    expect(s.stage().lock?.by).toBe("Chey");
    // Chey's own window: yes. Leaving out the screen means the main one.
    expect((await post("/stage/unlock", {}, remote(cheys))).status).toBe(200);
    expect(s.stage().lock).toBeUndefined();
    // The person at the host locks from the host's window, and the host's window lets go of it.
    s.store.setSetting("hostPersonId", chey.id);
    expect((await post("/stage", { mode: "spotlight", items: [a.id] }, host())).status).toBe(200);
    expect(s.stage().lock?.personId).toBe(chey.id);
    expect((await post("/stage/unlock", {}, host())).status).toBe(200);
    expect(s.stage().lock).toBeUndefined();
  } finally {
    server.stop(true);
  }
});

test("the owner's bare yes to something else doesn't unlock; their yes to the lock question, or saying to unlock it, does", async () => {
  const { s, chey, felipe, tools, said } = room();
  const a = artifact(s, "Pricing");
  const cast = () => s.setStage({ mode: "spotlight", items: [a.id] }, "Chey", "main", { person: { id: chey.id, name: "Chey" } });
  cast();
  (s as any).gatewayKey = () => "";
  const direct = (text: string) => ({ ...said(chey, text), data: { direct: true } }) as JamEvent;
  // Chey answers some other question of JamSesh's with "yes" (and "go ahead", "show it"): the model cites it, nothing unlocks.
  for (const text of ["yes", "JamSesh, go ahead", "sure, do it", "show it"]) {
    const line = direct(text);
    expect([text, String(await tools([line]).unlock_screen.execute({ line: line.id }))]).toEqual([text, expect.stringContaining("plainly says")]);
  }
  expect(s.stage().lock?.by).toBe("Chey");
  // Asked about her lock, her bare yes answers it.
  const t = tools([said(felipe, "show the agents")]);
  await t.show_on_screen.execute({ mode: "agents" });
  await t.ask_to_replace_screen.execute({});
  const yes = direct("yes");
  expect(await tools([yes]).unlock_screen.execute({ line: yes.id })).toContain("Unlocked");
  // With no question, her own words to unlock it do; overheard (not said to JamSesh), they don't.
  cast();
  const overheard = said(chey, "unlock it");
  expect(String(await tools([overheard]).unlock_screen.execute({ line: overheard.id }))).toContain("plainly says");
  const own = direct("replace mine");
  expect(await tools([own]).unlock_screen.execute({ line: own.id })).toContain("Unlocked");
});

test("the brain refuses a screen that isn't there instead of changing the main one", async () => {
  const { s, chey, tools, said } = room();
  const a = artifact(s, "Checkout");
  s.setStage({ mode: "spotlight", items: [a.id] }, "Chey", "main", { person: { id: chey.id, name: "Chey" } });
  const own = { ...said(chey, "JamSesh, show the agents on the left TV"), data: { direct: true } } as JamEvent;
  const t = tools([own]);
  for (const [name, args] of [["show_on_screen", { mode: "agents", screen: "Left TV" }], ["build_custom_view", { title: "x", html: "<p>x</p>", screen: "Left TV" }], ["expand_tile", { position: 1, screen: "Left TV" }], ["restore_screen", { screen: "Left TV" }], ["ask_to_replace_screen", { screen: "Left TV" }], ["unlock_screen", { line: own.id, screen: "Left TV" }]] as const)
    expect([name, String(await t[name].execute(args))]).toEqual([name, expect.stringContaining("no screen by that name")]);
  expect(s.stage().mode).toBe("spotlight");
  expect(s.stage().lock?.by).toBe("Chey");
});

// ---------- round 7: one answer settles one question; screens by exact name or a unique start ----------

test("with two questions open for the same owner, a spoken yes settles neither and JamSesh asks which; the card still does", async () => {
  const { hub, s, chey, reg, said } = room();
  s.onShowRequest = () => {};
  const info = { width: 1920, height: 1080, dpr: 1, screenY: 0, at: Date.now() };
  s.reportScreen("main", { ...info, screenX: 0 });
  s.reportScreen("screen-2", { ...info, screenX: 1920 });
  const agent = reg("Felipe");
  const [x, y] = [artifact(s, "Checkout", agent.id), artifact(s, "Pricing", agent.id)];
  for (const screen of ["main", "screen-2"]) s.setStage({ mode: "spotlight", items: [x.id] }, "Chey", screen, { person: { id: chey.id, name: "Chey" } });
  // Both of Chey's locks are old enough to ask about.
  age(s, 6 * 60_000);
  const side = s.stage("screen-2");
  s.store.setSetting("screenStages", { "screen-2": { ...side, lock: { ...side.lock!, since: Date.now() - 6 * 60_000 } } });
  const ask = (screen: string, art: typeof x, label: string) => s.askOwner(s.queueReady({ screen, agentId: agent.id, agentName: agent.name, label, stage: { mode: "spotlight", items: [art.id] } }))!;
  const one = ask("main", y, "Pricing");
  const two = ask("screen-2", y, "Pricing v2");
  expect(s.openQuestionsFor(chey.id).map((q) => q.id)).toEqual([one.id, two.id]);
  (hub.brain as any).decideByVoice([said(chey, "yes, show it")]);
  expect(s.showRequests().filter((r) => r.status === "pending").map((r) => r.id)).toEqual([one.id, two.id]);
  expect(s.stage().items).toEqual([x.id]);
  expect(s.stage("screen-2").items).toEqual([x.id]);
  const asked = s.store.recentEvents({ limit: 20 }).filter((e) => e.kind === "brain").map((e) => e.text);
  expect(asked.some((t) => /which one\?/.test(t) && t.includes("Pricing") && t.includes("Pricing v2"))).toBe(true);
  // The card names its question: that one is settled, and then her spoken yes has one question to answer, once.
  expect(s.answerShowRequest(two.id, false, "Chey")?.status).toBe("denied");
  const yes = said(chey, "yes, show it");
  (hub.brain as any).decideByVoice([yes]);
  expect(s.showRequests().find((r) => r.id === one.id)?.status).toBe("approved");
  expect(s.stage().items).toEqual([y.id]);
});

test("one line answers one question: a lock question open too makes the owner's bare yes ambiguous, and a used line can't unlock", async () => {
  const { hub, s, chey, felipe, reg, tools, said } = room();
  s.onShowRequest = () => {};
  (s as any).gatewayKey = () => "";
  const agent = reg("Rae");
  const mine = artifact(s, "Pricing");
  s.setStage({ mode: "spotlight", items: [mine.id] }, "Chey", "main", { person: { id: chey.id, name: "Chey" } });
  age(s, 6 * 60_000);
  s.askOwner(s.queueReady({ screen: "main", agentId: agent.id, agentName: agent.name, label: "Build", stage: { mode: "agents" } }));
  const t = tools([said(felipe, "show the agents")]);
  await t.show_on_screen.execute({ mode: "agents" });
  expect(await t.ask_to_replace_screen.execute({})).toBe("Asked the room.");
  // Chey now has two open: her show request and the room's lock question. Her yes says neither.
  const hers = said(chey, "yes");
  expect(String(await tools([hers]).unlock_screen.execute({ line: hers.id }))).toContain("more than one question open");
  expect(s.stage().lock?.by).toBe("Chey");
  // Felipe has only the lock question: his yes answers it. A line that already answered a show request can't.
  const felipes = said(felipe, "yes, replace it");
  (hub.brain as any).usedLine(felipes.id);
  expect(String(await tools([felipes]).unlock_screen.execute({ line: felipes.id }))).toContain("already answered");
  const again = said(felipe, "yes, replace it");
  expect(await tools([again]).unlock_screen.execute({ line: again.id })).toContain("Unlocked");
  // Once: the question is gone.
  expect(s.openQuestionsFor(felipe.id)).toEqual([]);
});

test("screens are found by id or whole name, or the one name a word starts; a stale id never lands on a lookalike, and two matches ask", async () => {
  const { hub, s } = room();
  const info = { width: 1920, height: 1080, dpr: 1, screenY: 0, at: Date.now() };
  s.reportScreen("main", { ...info, screenX: 0 });
  s.reportScreen("screen-2", { ...info, screenX: 1920 });
  s.reportScreen("screen-3", { ...info, screenX: 3840 });
  s.store.setSetting("screenNames", { "screen-2": { name: "Left TV" }, "screen-3": { name: "Left monitor" } });
  expect(s.screens().map((sc) => sc.name)).toEqual(["Main screen", "Left TV", "Left monitor"]);
  expect(s.screenRef("screen-2")).toBe("screen-2");
  expect(s.screenRef("the left tv")).toBe("screen-2");
  expect(s.screenRef("Left TV!")).toBe("screen-2");
  // A stale id, part of a name, or a name inside another word: nothing.
  expect(s.screenRef("screen-20")).toBeNull();
  expect(s.screenRef("screen")).toBeNull();
  expect(s.screenRef("TV")).toBeNull();
  expect(s.screenRef("lef")).toBeNull();
  // "left" starts two names: ask which.
  expect(s.screenOf("left")).toEqual({ error: "Which screen: Left TV or Left monitor?", choices: ["Left TV", "Left monitor"] });
  // Over HTTP a stale id is 404, an ambiguous name 409 with the choices; the brain asks.
  const brainSays = String(await (hub.brain as any).tools([], { effects: 0 }).show_on_screen.execute({ mode: "agents", screen: "left" }));
  expect(brainSays).toContain('"left" could be Left TV or Left monitor. Ask the room which one.');
  const server = (await import("../src/http")).startHttp(hub, 0);
  try {
    const post = (body: any) => fetch(`http://127.0.0.1:${server.port}/api/stage`, { method: "POST", headers: { "content-type": "application/json", cookie: `jam_window=${hub.auth.windows.take(hub.auth.windows.mint())}` }, body: JSON.stringify(body) });
    expect((await post({ mode: "agents", screen: "screen-20" })).status).toBe(404);
    const which = await post({ mode: "agents", screen: "left" });
    expect(which.status).toBe(409);
    expect(((await which.json()) as any).error).toBe("Which screen: Left TV or Left monitor?");
    expect(s.stage("screen-2").mode).not.toBe("agents");
  } finally {
    server.stop(true);
  }
});

// ---------- round 8: every kind of question counts; names only when unique ----------

test("a host build and a show request open together: a bare yes settles neither; naming the build answers only it", async () => {
  const { hub, s, chey, reg, said } = room();
  s.onShowRequest = () => {};
  hub.host.onRequest = () => {};
  const agent = reg("Felipe");
  const mine = artifact(s, "Pricing");
  s.setStage({ mode: "spotlight", items: [mine.id] }, "Chey", "main", { person: { id: chey.id, name: "Chey" } });
  age(s, 6 * 60_000);
  const show = s.askOwner(s.queueReady({ screen: "main", agentId: agent.id, agentName: agent.name, label: "Checkout", stage: { mode: "agents" } }))!;
  const build = hub.host.request({ agentId: agent.id, agentName: "Felipe's Claude", ownerName: "Felipe", repo: "https://github.com/acme/app.git", branch: "main", command: "true" });
  if (typeof build === "string") throw new Error(build);
  expect(s.openQuestionsFor(chey.id).map((q) => q.kind)).toEqual(["build", "show"]);
  const brain = hub.brain as any;
  brain.decideByVoice([said(chey, "yes")]);
  expect(hub.host.pendingRequests().map((r) => r.id)).toEqual([build.id]);
  expect(s.showRequests().find((r) => r.id === show.id)?.status).toBe("pending");
  expect(s.stage().items).toEqual([mine.id]);
  expect(s.store.recentEvents({ limit: 10 }).some((e) => e.kind === "brain" && /which one\?/.test(e.text) && e.text.includes("Felipe's Claude's build"))).toBe(true);
  // "Deny the build" says which: only the build is settled, and that line answers nothing else.
  const deny = said(chey, "deny the build");
  brain.decideByVoice([deny]);
  expect(hub.host.pendingRequests()).toEqual([]);
  expect(s.showRequests().find((r) => r.id === show.id)?.status).toBe("pending");
  // Now one question is open: her plain yes answers it.
  brain.decideByVoice([said(chey, "yes, show it")]);
  expect(s.showRequests().find((r) => r.id === show.id)?.status).toBe("approved");
});

test("ids match ids only, and a name two screens share is asked about", () => {
  const { s } = room();
  const info = { width: 1920, height: 1080, dpr: 1, screenY: 0, at: Date.now() };
  s.reportScreen("main", { ...info, screenX: 0 });
  s.reportScreen("screen-2", { ...info, screenX: 1920 });
  s.reportScreen("screen-3", { ...info, screenX: 3840 });
  // Someone named a screen like an id, and two screens the same.
  s.store.setSetting("screenNames", { "screen-2": { name: "screen-20" }, "screen-3": { name: "Left TV" }, main: { name: "Left TV" } });
  expect(s.screenRef("screen-20")).toBeNull();
  expect(s.screenRef("screen-2")).toBe("screen-2");
  const two = s.screenOf("left tv");
  expect("choices" in two && two.choices).toEqual(["Left TV (main)", "Left TV (screen-3)"]);
  expect(s.screenRef("left")).toBeNull();
});

test("a direct request from the lock's owner that fails keeps their lock and what it holds; one that lands replaces both", async () => {
  const { s, chey, tools, said } = room();
  const a = artifact(s, "Checkout");
  const mine = artifact(s, "Mine");
  s.setStage({ mode: "spotlight", items: [mine.id] }, "Chey", "main", { person: { id: chey.id, name: "Chey" } });
  const direct = (text: string) => ({ ...said(chey, text), data: { direct: true } }) as JamEvent;
  // A share that has ended: a layout of only it is refused by the stage.
  const sh = s.startShare("chey-mac", "screen");
  s.endShare(sh.id);
  const lockBefore = s.stage().lock;
  const r = String(await tools([direct("JamSesh, show my screen")]).set_layout.execute({ tiles: [{ kind: "screen", ref: sh.id }] }));
  expect(r).not.toContain("On screen");
  expect(s.stage().items).toEqual([mine.id]);
  expect(s.stage().lock).toEqual(lockBefore);
  // A custom view and a restore go through the same gate: a write that lands replaces the lock with the owner's new one.
  expect(await tools([direct("JamSesh, show the checkout")]).show_on_screen.execute({ mode: "spotlight", artifactIds: [a.id] })).toBe("On screen.");
  expect(s.stage().items).toEqual([a.id]);
  expect(s.stage().lock?.personId).toBe(chey.id);
});

test("every path where a person asks JamSesh directly replaces their own lock with their own, in the same write", async () => {
  const { hub, s, chey, felipe, tools, said } = room();
  const a = artifact(s, "Checkout");
  const b = artifact(s, "Pricing");
  const direct = (text: string) => ({ ...said(chey, text), data: { direct: true } }) as JamEvent;
  const cast = (who: { id: string; name: string }, items: string[]) => s.setStage({ mode: "spotlight", items, title: who.name }, who.name, "main", { person: who });
  const mine = () => cast(chey, [a.id]);
  const owner = () => s.stage().lock?.personId;
  cast(chey, [b.id]);
  s.saveLayout("review");
  const paths: Record<string, () => Promise<void> | void> = {
    show_on_screen: async () => void (await tools([direct("JamSesh, show pricing")]).show_on_screen.execute({ mode: "spotlight", artifactIds: [b.id] })),
    set_layout: async () => void (await tools([direct("JamSesh, show pricing")]).set_layout.execute({ tiles: [{ kind: "artifact", ref: b.id }] })),
    build_custom_view: async () => void (await tools([direct("JamSesh, show a view of pricing")]).build_custom_view.execute({ title: "x", html: "<p>x</p>" })),
    show_saved_layout: async () => void (await tools([direct("JamSesh, bring back the review layout")]).show_saved_layout.execute({ name: "review" })),
    restore_screen: async () => {
      cast(chey, [b.id]);
      await tools([direct("JamSesh, put the last thing back")]).restore_screen.execute({});
    },
    show_ready: async () => {
      const r = s.queueReady({ screen: "main", agentId: "ag", agentName: "Agent", label: "Pricing build", stage: { mode: "spotlight", items: [b.id] } });
      await tools([direct("JamSesh, show the pricing build")]).show_ready.execute({ id: r.id });
    },
  };
  for (const [name, run] of Object.entries(paths)) {
    mine();
    const before = s.stage().since;
    await run();
    expect([name, s.stage().since > before || s.stage().items?.[0] !== a.id || s.stage().mode !== "spotlight" ? "changed" : "same"]).toEqual([name, "changed"]);
    expect([name, owner()]).toEqual([name, chey.id]);
  }
  // The rule-based path (no gateway) does the same.
  mine();
  const ev = direct("JamSesh, show pricing");
  hub.brain.ruleRoute([ev], { lines: [{ id: ev.id, relevance: "work", intent: "present" }] } as any);
  expect(s.stage().items).toEqual([b.id]);
  expect(owner()).toBe(chey.id);
  // Someone else's lock is never replaced by these paths.
  cast(felipe, [a.id]);
  await tools([direct("JamSesh, show pricing")]).show_on_screen.execute({ mode: "spotlight", artifactIds: [b.id] });
  expect(owner()).toBe(felipe.id);
});
