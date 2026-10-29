// Record (6.2): talk and point, and it becomes notes. Alignment of words against the pointer
// (timing edges, pauses, several drivers), then the whole path through the real HTTP routes:
// stop lists the notes, tidy, send routes them to the agents that own each item.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../src/hub";
import { startHttp } from "../src/http";
import { AFTER_MS, alignNotes, BEFORE_MS, describeNote, LEAD_MS } from "../src/record";
import type { RecordMark, RecordNote, Utterance } from "../src/types";

process.env.JAMSESH_SILENT = "1";
const dir = mkdtempSync(join(tmpdir(), "jam-record-"));
const hubs: Hub[] = [];
const servers: ReturnType<typeof startHttp>[] = [];
afterAll(() => {
  for (const sv of servers) sv.stop(true);
  for (const h of hubs) (h.devproxy.stop(), h.stop());
  rmSync(dir, { recursive: true, force: true });
});

// ---------- alignment ----------

const T = 100_000;
const target = (ref = "a1", over: object = {}) => ({ kind: "artifact" as const, ref, label: "Login", ...over });
const mark = (t: number, kind: RecordMark["kind"], x: number, y: number, over: Partial<RecordMark> = {}): RecordMark => ({ t, kind, x, y, target: target(), ...over });
const say = (id: string, text: string, t0: number, t1: number, personId: string | null = "maya") => ({ id, text, t0, t1, personId });

test("words said while holding on a spot are pinned to it", () => {
  const [n] = alignNotes([say("u1", "make this button bigger", T, T + 2000)], [mark(T - 200, "dwell", 0.3, 0.7, { dur: 3000 })]);
  expect(n.text).toBe("make this button bigger");
  expect(n.pin).toMatchObject({ x: 0.3, y: 0.7, kind: "dwell" });
});

test("pointing a moment before speaking still counts; too long before, or after, does not", () => {
  const pointed = (gap: number) => alignNotes([say("u", "this is too dark", T, T + 1500)], [mark(T - gap, "dwell", 0.5, 0.5, { dur: 0 })])[0].pin;
  expect(pointed(LEAD_MS)).not.toBeNull();
  expect(pointed(BEFORE_MS)).not.toBeNull();
  expect(pointed(BEFORE_MS + 1)).toBeNull();
  const after = (gap: number) => alignNotes([say("u", "this is too dark", T, T + 1500)], [mark(T + 1500 + gap, "click", 0.5, 0.5)])[0].pin;
  expect(after(AFTER_MS)).not.toBeNull();
  expect(after(AFTER_MS + 1)).toBeNull();
});

test("the edges of 'while saying it': a click right at either end is in, one far past is out", () => {
  const line = say("u", "round the corners here", T, T + 1000);
  expect(alignNotes([line], [mark(T - LEAD_MS, "click", 0.1, 0.1)])[0].pin).not.toBeNull();
  expect(alignNotes([line], [mark(T + 1000 + 300, "click", 0.1, 0.1)])[0].pin).not.toBeNull();
  expect(alignNotes([line], [mark(T + 20_000, "click", 0.1, 0.1)])[0].pin).toBeNull();
  // A zero-length line is still a line.
  expect(alignNotes([say("z", "ok", T, T)], [mark(T, "click", 0.2, 0.2)])[0].pin).not.toBeNull();
});

test("a line across two spots splits there, with its words and its pins in order", () => {
  const notes = alignNotes(
    [say("u", "the heading is too small and then this button should be green", T, T + 6000)],
    [mark(T, "dwell", 0.2, 0.1, { dur: 2800 }), mark(T + 3000, "click", 0.8, 0.8)],
  );
  expect(notes.length).toBe(2);
  expect(notes.map((n) => n.text).join(" ")).toBe("the heading is too small and then this button should be green");
  expect(notes[0].pin).toMatchObject({ x: 0.2, y: 0.1 });
  expect(notes[1].pin).toMatchObject({ x: 0.8, y: 0.8, kind: "click" });
  expect(notes[0].t1).toBeLessThanOrEqual(notes[1].t0);
  expect(notes[0].id).not.toBe(notes[1].id);
});

test("a one-word sliver doesn't become its own note", () => {
  const notes = alignNotes([say("u", "wait here is the thing to fix", T, T + 4000)], [mark(T - 300, "dwell", 0.2, 0.2, { dur: 100 }), mark(T + 500, "click", 0.9, 0.9)]);
  for (const n of notes) expect(n.text.split(" ").length).toBeGreaterThanOrEqual(2);
});

test("several marks on one spot are one spot, and a long pause with no mark leaves a note unpinned", () => {
  const same = alignNotes([say("u", "this whole card needs more air", T, T + 3000)], [mark(T, "dwell", 0.5, 0.5, { dur: 500 }), mark(T + 1000, "dwell", 0.52, 0.51, { dur: 500 })]);
  expect(same.length).toBe(1);
  const far = alignNotes([say("u1", "first thing", T, T + 1000), say("u2", "second thing much later", T + 30_000, T + 31_000)], [mark(T, "click", 0.5, 0.5)]);
  expect(far[0].pin).not.toBeNull();
  expect(far[1].pin).toBeNull();
});

test("two drivers keep their own pointers: a line never takes the other driver's mark", () => {
  const marks = [mark(T, "click", 0.1, 0.1, { driverId: "maya" }), mark(T + 100, "click", 0.9, 0.9, { driverId: "ben" })];
  const lines = [say("m", "maya says fix this", T, T + 1500, "maya"), say("b", "ben says move that", T + 50, T + 1500, "ben")];
  const [m, b] = alignNotes(lines, marks);
  expect(m.pin).toMatchObject({ x: 0.1 });
  expect(b.pin).toMatchObject({ x: 0.9 });
  // Ben pointed at nothing: he gets no pin, not Maya's.
  const [only] = alignNotes([say("b", "ben says move that", T, T + 1500, "ben")], [mark(T, "click", 0.1, 0.1, { driverId: "maya" })]);
  expect(only.pin).toBeNull();
  // An unknown voice may use whoever is pointing.
  expect(alignNotes([say("x", "someone said this", T, T + 1000, null)], [mark(T, "click", 0.3, 0.3, { driverId: "maya" })])[0].pin).not.toBeNull();
});

test("junk is ignored: empty lines, move samples, non-finite marks; ids are stable and the big screen is carried", () => {
  const notes = alignNotes(
    [say("e", "   ", T, T + 100), say("u", "keep this one", T, T + 1000)],
    [mark(T, "move", 0.5, 0.5), mark(T, "click", NaN, 0.5), { ...mark(T, "click", 0.5, 0.5), target: undefined as any }],
    { screenId: "main" },
  );
  expect(notes.length).toBe(1);
  expect(notes[0]).toMatchObject({ id: "u.0", pin: null, screenId: "main" });
  expect(alignNotes([], [mark(T, "click", 0.5, 0.5)])).toEqual([]);
});

test("a note reads as a line an agent can act on: where, on which page, scrolled how far, with the picture", () => {
  const line = describeNote({ text: "tighten this", pin: { target: target("a1", { nodeId: "12", page: "Home", canvasX: 410.4, canvasY: 90 }), x: 0.2, y: 0.1, kind: "click", scroll: { x: 0, y: 320 } }, screenId: "main", crop: "/renders/uploads/crop-x.png" }, 0);
  for (const bit of ['1. on artifact "Login" (node 12)', 'page "Home"', "top left (20%, 10%)", "canvas point 410, 90", "scrolled to 0, 320", 'big screen "main"', "“tighten this”", "crop-x.png"]) expect(line).toContain(bit);
});

// ---------- the whole path ----------

function room() {
  const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, String(Math.random())) });
  hubs.push(hub);
  const server = startHttp(hub, 0);
  servers.push(server);
  const s = hub.session;
  const maya = s.upsertPerson({ name: "Maya" });
  const ben = s.upsertPerson({ name: "Ben" });
  s.touchDevice("mayaLaptop", { personId: maya.id, location: "room", micOn: true });
  s.touchDevice("benLaptop", { personId: ben.id, location: "room", micOn: true });
  const reg = (owner: string, repo: string) => s.registerAgent({ ownerName: owner, harness: "claude-code", repo, cwd: `/${owner}/${repo}`, machine: "m1", platform: "desktop" }).agent;
  const win = () => ({ cookie: `jam_window=${hub.auth.windows.take(hub.auth.windows.mint())}` });
  const post = (path: string, body: unknown, h: Record<string, string> = win()) => fetch(`http://127.0.0.1:${server.port}/api${path}`, { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(body) });
  return { hub, s, maya, ben, reg, post, server };
}

let n = 0;
function line(hub: Hub, text: string, personId: string, device: string, t0: number, t1 = t0 + 1500): Utterance {
  const u: Utterance = {
    id: `ru${++n}`,
    t0,
    t1,
    text,
    personId,
    speakerName: personId,
    confidence: 0.9,
    method: "device",
    deviceId: device,
    devices: [
      { deviceId: "mayaLaptop", level: device === "mayaLaptop" ? -20 : -40, snr: 20 },
      { deviceId: "benLaptop", level: device === "benLaptop" ? -20 : -40, snr: 20 },
    ],
    location: "room",
    eventId: null,
    engine: "test",
  };
  hub.session.store.put("utterances", u);
  (hub as any).roomLine(u, true);
  return u;
}

type StopOk = { ok: true; recordingId: string; notes: RecordNote[] };
async function record(r: ReturnType<typeof room>, speak: (t0: number) => void, pointer: (t0: number) => RecordMark[], extra: Record<string, unknown> = {}) {
  const t0 = Date.now() - 8000;
  const start = await r.post("/record/start", { deviceId: "mayaLaptop", personId: r.maya.id, t0, ...extra });
  expect(start.status).toBe(200);
  speak(t0);
  const stop = await r.post("/record/stop", { deviceId: "mayaLaptop", personId: r.maya.id, t0, t1: t0 + 10_000, pointer: pointer(t0), ...extra });
  return { t0, res: stop, body: (await stop.clone().json()) as StopOk };
}

test("stop lists notes pinned where she pointed, each with the agent that owns that item; send tidies, routes, and pins them", async () => {
  const r = room();
  const atlas = r.reg("Ben", "acme/web");
  const juno = r.reg("Ben", "acme/api");
  const login = r.s.upsertArtifact({ kind: "screenshot", stage: "built", title: "Login", agentId: atlas.id, image: "/renders/login.png" });
  const dash = r.s.upsertArtifact({ kind: "screenshot", stage: "built", title: "Dashboard", agentId: juno.id, image: "/renders/dash.png" });
  const orphan = r.s.upsertArtifact({ kind: "screenshot", stage: "built", title: "Sketch", agentId: null, image: "/renders/sketch.png" });
  const t = (a: { id: string; title: string }, extra: object = {}) => ({ kind: "artifact", ref: a.id, label: a.title, ...extra });
  const { t0, body } = await record(
    r,
    (t0) => {
      line(r.hub, "the sign in button is too small", r.maya.id, "mayaLaptop", t0 + 500);
      line(r.hub, "this chart needs a legend", r.maya.id, "mayaLaptop", t0 + 3000);
      line(r.hub, "and this sketch is off", r.maya.id, "mayaLaptop", t0 + 5000);
      line(r.hub, "general thought about spacing", r.maya.id, "mayaLaptop", t0 + 9000, t0 + 9100);
    },
    (t0) =>
      [
        { t: t0 + 700, kind: "dwell", x: 0.4, y: 0.8, dur: 1500, target: t(login, { page: "/login" }), scroll: { x: 0, y: 40 } },
        { t: t0 + 3200, kind: "click", x: 0.6, y: 0.2, target: t(dash) },
        { t: t0 + 5200, kind: "dwell", x: 0.5, y: 0.5, dur: 1000, target: t(orphan) },
      ] as RecordMark[],
  );
  expect(body.notes.map((x) => x.text)).toEqual(["the sign in button is too small", "this chart needs a legend", "and this sketch is off", "general thought about spacing"]);
  expect(body.notes.map((x) => x.ownerName)).toEqual([atlas.name, juno.name, null, null]);
  expect(body.notes[0].pin).toMatchObject({ x: 0.4, y: 0.8, scroll: { x: 0, y: 40 }, target: { page: "/login" } });
  expect(body.notes[3].pin).toBeNull();
  // Nothing has been sent yet: stop only lists.
  expect(r.s.directives().length).toBe(0);
  expect(r.s.annotations().length).toBe(0);

  // Tidy: edit one, merge two, delete one; then send through the real route.
  const tidy = [{ ...body.notes[0], text: "make the sign in button larger" }, { ...body.notes[1], text: body.notes[1].text }, body.notes[2]];
  const send = () => r.post("/record/send", { recordingId: body.recordingId, personId: r.maya.id, notes: tidy });
  const res = await send();
  expect(res.status).toBe(200);
  const out = (await res.json()) as any;
  expect(out.sent.map((x: any) => [x.agentName, x.notes])).toEqual([[atlas.name, 1], [juno.name, 1]]);
  expect(out.brain).toBe(1);
  const ds = r.s.directives();
  expect(ds.length).toBe(2);
  const forAtlas = ds.find((d) => d.targets[0] === atlas.id)!;
  expect(forAtlas.text).toContain("make the sign in button larger");
  expect(forAtlas.text).toContain('page "/login"');
  expect(forAtlas.text).toContain("scrolled to 0, 40");
  expect(forAtlas.text).toContain("bottom center");
  expect(forAtlas.requestedBy).toBe("Maya");
  expect(forAtlas.text).not.toContain("legend");
  // The pins are on the items, kept, and not offered to be sent twice.
  const pins = r.s.annotations();
  expect(pins.length).toBe(3);
  expect(pins.every((p) => p.source === "pin" && p.status === "sent" && p.recordingId === body.recordingId)).toBe(true);
  expect(pins.find((p) => p.target.ref === login.id)?.text).toBe("make the sign in button larger");
  // The note on nothing an agent owns went to the room brain, not into a directive.
  const toBrain = r.s.store.recentEvents({ kinds: ["speech"], limit: 20 }).find((e) => e.data.recordingId === body.recordingId);
  expect(toBrain?.text).toContain("and this sketch is off");

  // A lost reply and a second click: same answer, nothing doubled.
  const again = await send();
  expect(again.status).toBe(200);
  expect(((await again.json()) as any).sent.length).toBe(2);
  expect(r.s.directives().length).toBe(2);
  expect(r.s.annotations().length).toBe(3);
  expect(t0).toBeGreaterThan(0);
});

test("a note on an item no agent owns still goes somewhere: to the room brain, and the sender is told", async () => {
  const r = room();
  const orphan = r.s.upsertArtifact({ kind: "screenshot", stage: "built", title: "Sketch", agentId: null, image: "/renders/sketch.png" });
  const res = await r.post("/record/send", { recordingId: "rec-x", personId: r.maya.id, notes: [{ id: "n1", text: "swap these two", t0: 1, t1: 2, pin: { target: { kind: "artifact", ref: orphan.id, label: "Sketch" }, x: 0.5, y: 0.5, kind: "click" } }] });
  const out = (await res.json()) as any;
  expect(out).toMatchObject({ ok: true, sent: [], brain: 1 });
  expect(r.s.directives().length).toBe(0);
  expect(r.s.annotations().length).toBe(1);
});

test("an observer agent owns nothing: its item's notes go to the brain", async () => {
  const r = room();
  const obs = r.s.registerAgent({ ownerName: "Ben", harness: "claude-code", repo: "acme/x", cwd: "/x", machine: "m1", platform: "desktop", role: "observer" }).agent;
  const a = r.s.upsertArtifact({ kind: "screenshot", stage: "built", title: "Seen", agentId: obs.id, image: "/renders/s.png" });
  const out = (await (await r.post("/record/send", { recordingId: "rec-o", personId: r.maya.id, notes: [{ id: "n", text: "fix the title", pin: { target: { kind: "artifact", ref: a.id, label: "Seen" }, x: 0.1, y: 0.1, kind: "click" } }] })).json()) as any;
  expect(out.sent).toEqual([]);
  expect(out.brain).toBe(1);
});

test("a canvas frame's note finds the frame's agent by node id; a build's by its dev server url", async () => {
  const r = room();
  const atlas = r.reg("Ben", "acme/web");
  const juno = r.reg("Ben", "acme/api");
  r.s.upsertArtifact({ kind: "frame", stage: "mockup", title: "Home", nodeId: "42", agentId: atlas.id, image: "/renders/42.png" });
  r.s.upsertArtifact({ kind: "devserver", stage: "built", title: "App", url: "http://localhost:5173/", agentId: juno.id });
  const notes = [
    { id: "a", text: "round these corners", pin: { target: { kind: "canvas", ref: "canvas", label: "Canvas", nodeId: "42", canvasX: 10, canvasY: 20 }, x: 0.3, y: 0.3, kind: "click" } },
    { id: "b", text: "this loads slowly", pin: { target: { kind: "web", ref: "http://localhost:5173/", label: "App" }, x: 0.3, y: 0.3, kind: "click" } },
  ];
  const out = (await (await r.post("/record/send", { recordingId: "rec-c", personId: r.maya.id, notes })).json()) as any;
  expect(out.sent.map((x: any) => x.agentId).sort()).toEqual([atlas.id, juno.id].sort());
  expect(out.brain).toBe(0);
});

test("unhappy sends: nothing to send, garbage notes, someone else's recording, an agent, a stranger", async () => {
  const r = room();
  const a = r.reg("Ben", "acme/web");
  const art = r.s.upsertArtifact({ kind: "screenshot", stage: "built", title: "Login", agentId: a.id, image: "/renders/l.png" });
  expect((await r.post("/record/send", { recordingId: "r1", personId: r.maya.id, notes: [] })).status).toBe(200);
  expect(((await (await r.post("/record/send", { recordingId: "r1b", personId: r.maya.id, notes: [{ text: "  " }, { id: 4 }] })).json()) as any).ok).toBe(false);
  expect((await r.post("/record/send", { personId: r.maya.id, notes: [{ text: "x" }] })).status).toBe(400);
  // Out-of-range and non-finite positions are clamped, a huge text is cut, a huge list is capped.
  const wild = [{ id: "w", text: "x".repeat(5000), pin: { target: { kind: "artifact", ref: art.id, label: "Login" }, x: 9, y: -3, kind: "click" } }, ...Array.from({ length: 200 }, (_, i) => ({ id: `m${i}`, text: `note ${i}` }))];
  const out = (await (await r.post("/record/send", { recordingId: "r2", personId: r.maya.id, notes: wild })).json()) as any;
  expect(out.ok).toBe(true);
  const pin = r.s.annotations()[0];
  expect(pin.x).toBe(1);
  expect(pin.y).toBe(0);
  expect(pin.text.length).toBe(2000);
  expect(r.s.store.recentEvents({ kinds: ["speech"], limit: 5 }).find((e) => e.data.recordingId === "r2")!.text.split("\n").length).toBeLessThanOrEqual(82);
  // Someone else's recording can't be sent by another person.
  const mine = (await (await r.post("/record/stop", { deviceId: "mayaLaptop", personId: r.maya.id, t0: Date.now() - 5000, t1: Date.now(), pointer: [], text: "typed note" })).json()) as StopOk;
  expect(mine.ok).toBe(true);
  expect(mine.notes[0]).toMatchObject({ id: "typed", text: "typed note", pin: null });
  const stolen = await r.post("/record/send", { recordingId: mine.recordingId, personId: r.ben.id, notes: mine.notes });
  expect(stolen.status).toBe(403);
  // An agent's credential, and a stranger with none, can neither record nor send.
  const agent = r.hub.auth.issue({ kind: "agent", label: "Agents on Mac", ip: "10.0.0.5", ownerDeviceId: "dev_mac0" });
  const asAgent = { "x-forwarded-for": "9.9.9.9", authorization: `Bearer ${agent.token}` };
  for (const [p, b] of [["/record/start", { deviceId: "x", t0: 1 }], ["/record/stop", { deviceId: "x", t0: 1, t1: 2 }], ["/record/send", { recordingId: "z", notes: [{ text: "hi" }] }]] as const) {
    expect((await r.post(p, b, asAgent)).status).toBe(403);
    expect((await r.post(p, b, { "x-forwarded-for": "9.9.9.9" })).status).toBe(401);
  }
  expect(r.s.recordings().length).toBe(0);
});

test("stop with nothing said says so, ends the recording, and a second Stop is harmless", async () => {
  const r = room();
  const t0 = Date.now() - 4000;
  await r.post("/record/start", { deviceId: "mayaLaptop", personId: r.maya.id, t0 });
  expect(r.s.recordings().map((x) => x.personName)).toEqual(["Maya"]);
  const stop = () => r.post("/record/stop", { deviceId: "mayaLaptop", personId: r.maya.id, t0, t1: t0 + 3000, pointer: [{ t: t0 + 100, kind: "click", x: 0.5, y: 0.5, target: { kind: "artifact", ref: "a", label: "A" } }] });
  const first = (await (await stop()).json()) as any;
  expect(first).toMatchObject({ ok: false, reason: "Nothing was heard in that recording." });
  expect(r.s.recordings()).toEqual([]);
  expect(((await (await stop()).json()) as any).ok).toBe(false);
}, 30_000);

test("another person's window can't stop my recording", async () => {
  const r = room();
  const t0 = Date.now() - 4000;
  await r.post("/record/start", { deviceId: "mayaLaptop", personId: r.maya.id, t0 });
  const res = await r.post("/record/stop", { deviceId: "mayaLaptop", personId: r.ben.id, t0, t1: t0 + 3000, pointer: [] });
  expect(res.status).toBe(403);
  expect(r.s.recordings().length).toBe(1);
  await r.hub.recordStop({ deviceId: "mayaLaptop", personId: r.maya.id, t0, t1: t0 + 1 , pointer: [] });
}, 30_000);

// ---------- the big screen ----------

test("on the big screen: Record takes a free screen's lock and gives it back; a screen someone else drives refuses", async () => {
  const r = room();
  const t0 = Date.now() - 5000;
  expect(r.s.lockOf("main")).toBeNull();
  const ok = await r.post("/record/start", { deviceId: "mayaLaptop", personId: r.maya.id, t0, screen: "main" });
  expect(ok.status).toBe(200);
  expect(r.s.lockOf("main")?.personId).toBe(r.maya.id);
  expect(r.s.recordings()[0]).toMatchObject({ screenId: "main", personName: "Maya" });
  // Ben isn't driving: refused, and the lock stays Maya's.
  const no = await r.post("/record/start", { deviceId: "benLaptop", personId: r.ben.id, t0, screen: "main" });
  expect(no.status).toBe(409);
  expect(((await no.json()) as any).error ?? "").toContain("Maya is driving");
  expect(r.s.lockOf("main")?.personId).toBe(r.maya.id);
  expect(r.s.recordings().length).toBe(1);
  // Stopping lists the notes (marked with the screen) and releases the lock it took.
  line(r.hub, "move the logo to the left", r.maya.id, "mayaLaptop", t0 + 500);
  const stop = (await (await r.post("/record/stop", { deviceId: "mayaLaptop", personId: r.maya.id, t0, t1: t0 + 4000, pointer: [{ t: t0 + 600, kind: "click", x: 0.1, y: 0.1, target: { kind: "artifact", ref: "x", label: "Logo" } }], screen: "main" })).json()) as StopOk;
  expect(stop.notes[0]).toMatchObject({ screenId: "main", pin: { x: 0.1 } });
  expect(r.s.lockOf("main")).toBeNull();
  expect(r.s.recordings()).toEqual([]);
}, 30_000);

test("a screen the person already holds stays held after Record; an unknown screen, or no identity, is refused", async () => {
  const r = room();
  const t0 = Date.now() - 3000;
  r.s.setStage({ mode: "spotlight", items: ["a"] }, "Maya", "main", { person: { id: r.maya.id, name: "Maya" } });
  expect((await r.post("/record/start", { deviceId: "mayaLaptop", personId: r.maya.id, t0, screen: "main" })).status).toBe(200);
  await r.hub.recordStop({ deviceId: "mayaLaptop", personId: r.maya.id, t0, t1: t0 + 100, pointer: [] });
  expect(r.s.lockOf("main")?.personId).toBe(r.maya.id);
  expect((await r.post("/record/start", { deviceId: "mayaLaptop", personId: r.maya.id, t0, screen: "screen-9" })).status).toBe(404);
  expect(r.hub.recordStart("x", null, t0, "main")).toMatchObject({ ok: false, status: 403 });
}, 30_000);

test("driving together: each driver is recorded, and the lock is let go only after the last one stops", async () => {
  const r = room();
  const t0 = Date.now() - 6000;
  expect(r.hub.recordStart("mayaLaptop", r.maya.id, t0, "main").ok).toBe(true);
  // 6.1 widens who may drive; until it lands the hook says Ben is a driver.
  r.s.screenDrivers = () => [r.maya.id, r.ben.id];
  expect(r.hub.recordStart("benLaptop", r.ben.id, t0, "main").ok).toBe(true);
  expect(r.s.recordings().length).toBe(2);
  line(r.hub, "maya wants the header taller", r.maya.id, "mayaLaptop", t0 + 500);
  line(r.hub, "ben wants the footer shorter", r.ben.id, "benLaptop", t0 + 600);
  const mt = { kind: "artifact" as const, ref: "h", label: "Header" };
  const bt = { kind: "artifact" as const, ref: "f", label: "Footer" };
  const m = await r.hub.recordStop({ deviceId: "mayaLaptop", personId: r.maya.id, t0, t1: t0 + 4000, pointer: [{ t: t0 + 550, kind: "click", x: 0.5, y: 0.1, target: mt }] });
  // Ben is still recording: the screen stays locked.
  expect(r.s.lockOf("main")).not.toBeNull();
  const b = await r.hub.recordStop({ deviceId: "benLaptop", personId: r.ben.id, t0, t1: t0 + 4000, pointer: [{ t: t0 + 650, kind: "click", x: 0.5, y: 0.9, target: bt }] });
  expect(m.ok && b.ok).toBe(true);
  if (m.ok && b.ok) {
    expect(m.notes.map((x) => x.text)).toEqual(["maya wants the header taller"]);
    expect(b.notes.map((x) => x.text)).toEqual(["ben wants the footer shorter"]);
    expect(m.notes[0].pin?.target.ref).toBe("h");
    expect(b.notes[0].pin?.target.ref).toBe("f");
  }
  expect(r.s.lockOf("main")).toBeNull();
}, 30_000);

test("a new Record on the same device replaces a recording whose Stop never came", async () => {
  const r = room();
  const t0 = Date.now();
  r.hub.recordStart("mayaLaptop", r.maya.id, t0, "main");
  r.hub.recordStart("mayaLaptop", r.maya.id, t0 + 10, "main");
  expect(r.s.recordings().length).toBe(1);
  await r.hub.recordStop({ deviceId: "mayaLaptop", personId: r.maya.id, t0, t1: t0 + 10, pointer: [] });
  expect(r.s.lockOf("main")).toBeNull();
}, 30_000);

test("a recording whose window vanished ends on its own, and gives back the screen it locked; one still connected is left alone", async () => {
  const r = room();
  const t0 = Date.now();
  expect(r.hub.recordStart("mayaLaptop", r.maya.id, t0, "main").ok).toBe(true);
  expect(r.hub.recordStart("benLaptop", r.ben.id, t0).ok).toBe(true);
  // Maya's window is gone; Ben's is still connected.
  r.s.deviceOnline = (id) => id === "benLaptop";
  r.hub.sweepRecordings();
  expect(r.s.recordings().length).toBe(2);
  r.hub.sweepRecordings();
  expect(r.s.recordings().map((x) => x.personName)).toEqual(["Ben"]);
  expect(r.s.lockOf("main")).toBeNull();
  // A blip that recovers resets the count.
  r.s.deviceOnline = () => false;
  r.hub.sweepRecordings();
  r.s.deviceOnline = () => true;
  r.hub.sweepRecordings();
  r.s.deviceOnline = () => false;
  r.hub.sweepRecordings();
  expect(r.s.recordings().length).toBe(1);
});
