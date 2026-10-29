// Record (6.2): talk and point, and it becomes notes. Alignment of words against the pointer
// (timing edges, pauses, several drivers), then the whole path through the real HTTP routes:
// stop lists the notes, tidy, send routes them to the agents that own each item.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import { bus } from "../src/bus";
import type { Hub as HubType } from "../src/hub";
import { AFTER_MS, alignNotes, BEFORE_MS, describeNote, LEAD_MS } from "../src/record";
import type { RecordMark, RecordNote, Utterance } from "../src/types";

process.env.JAMSESH_SILENT = "1";
const dir = mkdtempSync(join(tmpdir(), "jam-record-"));
// The hub reads its home folder when it loads: a throwaway one, so renders, uploads and links the tests make never touch a real session.
process.env.JAMSESH_HOME = join(dir, "home");
const { Hub, NOTE_RECS_MAX } = await import("../src/hub");
const { startHttp } = await import("../src/http");
type Hub = HubType;
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
  // Both laptops' windows are the host's own here (the window key); a recording is on the caller's own device.
  s.touchDevice("mayaLaptop", { personId: maya.id, location: "room", micOn: true, pairedId: "host" });
  s.touchDevice("benLaptop", { personId: ben.id, location: "room", micOn: true, pairedId: "host" });
  const reg = (owner: string, repo: string) => s.registerAgent({ ownerName: owner, harness: "claude-code", repo, cwd: `/${owner}/${repo}`, machine: "m1", platform: "desktop" }).agent;
  const win = () => ({ cookie: `jam_window=${hub.auth.windows.take(hub.auth.windows.mint())}` });
  const post = (path: string, body: unknown, h: Record<string, string> = win()) => fetch(`http://127.0.0.1:${server.port}/api${path}`, { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(body) });
  /** A recording id the hub handed out (Stop on Maya's laptop with a typed note), for the sends below. */
  const stopped = async (personId = maya.id) => {
    const t0 = Date.now() - 1000;
    const started = hub.recordStart("mayaLaptop", personId, t0);
    if (!started.ok) throw new Error(started.reason);
    const r = await hub.recordStop({ deviceId: "mayaLaptop", recordingId: started.id, caller: "host", personId, pointer: [], typed: "a note" });
    if (!r.ok) throw new Error(r.reason);
    return r.recordingId;
  };
  // The hub's clock can be set, so a recording's window can sit around speech that was injected at known times.
  const tick: { t: number | null } = { t: null };
  hub.clock = () => tick.t ?? Date.now();
  const at = (t: number | null) => void (tick.t = t);
  return { hub, s, maya, ben, reg, post, server, stopped, at };
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

/** The id of the recording running on a laptop (what Start handed back). */
const rid = (r: ReturnType<typeof room>, device: string): string => (r.hub as any).recs.get(device)?.id;

type StopOk = { ok: true; recordingId: string; notes: RecordNote[] };
async function record(r: ReturnType<typeof room>, speak: (t0: number) => void, pointer: (t0: number) => RecordMark[], extra: Record<string, unknown> = {}) {
  const t0 = Date.now() - 8000;
  r.at(t0);
  const start = await r.post("/record/start", { deviceId: "mayaLaptop", personId: r.maya.id, ...extra });
  expect(start.status).toBe(200);
  const recordingId = ((await start.json()) as { id: string }).id;
  speak(t0);
  r.at(t0 + 10_000);
  const stop = await r.post("/record/stop", { deviceId: "mayaLaptop", recordingId, personId: r.maya.id, t1: t0 + 10_000, pointer: pointer(t0), ...extra });
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
  const res = await r.post("/record/send", { recordingId: await r.stopped(), personId: r.maya.id, notes: [{ id: "n1", text: "swap these two", t0: 1, t1: 2, pin: { target: { kind: "artifact", ref: orphan.id, label: "Sketch" }, x: 0.5, y: 0.5, kind: "click" } }] });
  const out = (await res.json()) as any;
  expect(out).toMatchObject({ ok: true, sent: [], brain: 1 });
  expect(r.s.directives().length).toBe(0);
  expect(r.s.annotations().length).toBe(1);
});

test("an observer agent owns nothing: its item's notes go to the brain", async () => {
  const r = room();
  const obs = r.s.registerAgent({ ownerName: "Ben", harness: "claude-code", repo: "acme/x", cwd: "/x", machine: "m1", platform: "desktop", role: "observer" }).agent;
  const a = r.s.upsertArtifact({ kind: "screenshot", stage: "built", title: "Seen", agentId: obs.id, image: "/renders/s.png" });
  const out = (await (await r.post("/record/send", { recordingId: await r.stopped(), personId: r.maya.id, notes: [{ id: "n", text: "fix the title", pin: { target: { kind: "artifact", ref: a.id, label: "Seen" }, x: 0.1, y: 0.1, kind: "click" } }] })).json()) as any;
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
  const out = (await (await r.post("/record/send", { recordingId: await r.stopped(), personId: r.maya.id, notes })).json()) as any;
  expect(out.sent.map((x: any) => x.agentId).sort()).toEqual([atlas.id, juno.id].sort());
  expect(out.brain).toBe(0);
});

test("unhappy sends: nothing to send, garbage notes, someone else's recording, an agent, a stranger", async () => {
  const r = room();
  const a = r.reg("Ben", "acme/web");
  const art = r.s.upsertArtifact({ kind: "screenshot", stage: "built", title: "Login", agentId: a.id, image: "/renders/l.png" });
  const r1 = await r.stopped();
  expect((await r.post("/record/send", { recordingId: r1, personId: r.maya.id, notes: [] })).status).toBe(200);
  expect(((await (await r.post("/record/send", { recordingId: r1, personId: r.maya.id, notes: [{ text: "  " }, { id: 4 }] })).json()) as any).ok).toBe(false);
  expect((await r.post("/record/send", { personId: r.maya.id, notes: [{ text: "x" }] })).status).toBe(400);
  // Out-of-range and non-finite positions are clamped, a huge text is cut, a huge list is capped.
  const wild = [{ id: "w", text: "x".repeat(5000), pin: { target: { kind: "artifact", ref: art.id, label: "Login" }, x: 9, y: -3, kind: "click" } }, ...Array.from({ length: 200 }, (_, i) => ({ id: `m${i}`, text: `note ${i}` }))];
  const sent2 = await r.stopped();
  const out = (await (await r.post("/record/send", { recordingId: sent2, personId: r.maya.id, notes: wild })).json()) as any;
  expect(out.ok).toBe(true);
  const pin = r.s.annotations()[0];
  expect(pin.x).toBe(1);
  expect(pin.y).toBe(0);
  expect(pin.text.length).toBe(2000);
  expect(r.s.store.recentEvents({ kinds: ["speech"], limit: 5 }).find((e) => e.data.recordingId === sent2)!.text.split("\n").length).toBeLessThanOrEqual(82);
  // Someone else's recording can't be sent by another person.
  const mineStart = (await (await r.post("/record/start", { deviceId: "mayaLaptop", personId: r.maya.id, t0: Date.now() - 5000 })).json()) as { id: string };
  const mine = (await (await r.post("/record/stop", { deviceId: "mayaLaptop", recordingId: mineStart.id, personId: r.maya.id, t1: Date.now(), pointer: [], text: "typed note" })).json()) as StopOk;
  expect(mine.ok).toBe(true);
  expect(mine.notes[0]).toMatchObject({ id: "typed", text: "typed note", pin: null });
  const stolen = await r.post("/record/send", { recordingId: mine.recordingId, personId: r.ben.id, notes: mine.notes });
  expect(stolen.status).toBe(403);
  // An agent's credential, and a stranger with none, can neither record nor send.
  const agent = r.hub.auth.issue({ kind: "agent", label: "Agents on Mac", ip: "10.0.0.5", ownerDeviceId: "dev_mac0" });
  const asAgent = { "x-forwarded-for": "9.9.9.9", authorization: `Bearer ${agent.token}` };
  for (const [p, b] of [["/record/start", { deviceId: "x", t0: 1 }], ["/record/stop", { deviceId: "x", recordingId: "rec_x", t1: 2 }], ["/record/send", { recordingId: "z", notes: [{ text: "hi" }] }]] as const) {
    expect((await r.post(p, b, asAgent)).status).toBe(403);
    expect((await r.post(p, b, { "x-forwarded-for": "9.9.9.9" })).status).toBe(401);
  }
  expect(r.s.recordings().length).toBe(0);
}, 30_000);

test("stop with nothing said says so, ends the recording, and a second Stop is harmless", async () => {
  const r = room();
  const t0 = Date.now() - 4000;
  await r.post("/record/start", { deviceId: "mayaLaptop", personId: r.maya.id, t0 });
  expect(r.s.recordings().map((x) => x.personName)).toEqual(["Maya"]);
  const recordingId = rid(r, "mayaLaptop");
  const stop = () => r.post("/record/stop", { deviceId: "mayaLaptop", recordingId, personId: r.maya.id, t1: t0 + 3000, pointer: [{ t: t0 + 100, kind: "click", x: 0.5, y: 0.5, target: { kind: "artifact", ref: "a", label: "A" } }] });
  const first = (await (await stop()).json()) as any;
  expect(first).toMatchObject({ ok: false, reason: "Nothing was heard in that recording." });
  expect(r.s.recordings()).toEqual([]);
  // The recording has ended, so a repeat Stop ends nothing and gets the first answer.
  expect(await (await stop()).json()).toEqual(first);
}, 30_000);

test("another person's window can't stop my recording", async () => {
  const r = room();
  const t0 = Date.now() - 4000;
  await r.post("/record/start", { deviceId: "mayaLaptop", personId: r.maya.id, t0 });
  const res = await r.post("/record/stop", { deviceId: "mayaLaptop", recordingId: rid(r, "mayaLaptop"), personId: r.ben.id, t1: t0 + 3000, pointer: [] });
  expect(res.status).toBe(403);
  expect(r.s.recordings().length).toBe(1);
  await r.hub.recordStop({ recordingId: rid(r, "mayaLaptop"), caller: "host", deviceId: "mayaLaptop", personId: r.maya.id, pointer: [] });
}, 30_000);

// ---------- the big screen ----------

test("on the big screen: Record takes a free screen's lock and gives it back; a screen someone else drives refuses", async () => {
  const r = room();
  const t0 = Date.now() - 5000;
  expect(r.s.lockOf("main")).toBeNull();
  r.at(t0);
  const ok = await r.post("/record/start", { deviceId: "mayaLaptop", personId: r.maya.id, screen: "main" });
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
  r.at(t0 + 4000);
  const stop = (await (await r.post("/record/stop", { deviceId: "mayaLaptop", recordingId: rid(r, "mayaLaptop"), personId: r.maya.id, pointer: [{ t: t0 + 600, kind: "click", x: 0.1, y: 0.1, target: { kind: "artifact", ref: "x", label: "Logo" } }], screen: "main" })).json()) as StopOk;
  expect(stop.notes[0]).toMatchObject({ screenId: "main", pin: { x: 0.1 } });
  expect(r.s.lockOf("main")).toBeNull();
  expect(r.s.recordings()).toEqual([]);
}, 30_000);

test("a screen the person already holds stays held after Record; an unknown screen, or no identity, is refused", async () => {
  const r = room();
  const t0 = Date.now() - 3000;
  r.s.setStage({ mode: "spotlight", items: ["a"] }, "Maya", "main", { person: { id: r.maya.id, name: "Maya" } });
  expect((await r.post("/record/start", { deviceId: "mayaLaptop", personId: r.maya.id, t0, screen: "main" })).status).toBe(200);
  await r.hub.recordStop({ recordingId: rid(r, "mayaLaptop"), caller: "host", deviceId: "mayaLaptop", personId: r.maya.id, pointer: [] });
  expect(r.s.lockOf("main")?.personId).toBe(r.maya.id);
  expect((await r.post("/record/start", { deviceId: "mayaLaptop", personId: r.maya.id, t0, screen: "screen-9" })).status).toBe(404);
  expect(r.hub.recordStart("x", null, t0, "main")).toMatchObject({ ok: false, status: 403 });
}, 30_000);

test("driving together: each driver is recorded, and the lock is let go only after the last one stops", async () => {
  const r = room();
  const t0 = Date.now() - 6000;
  expect(r.hub.recordStart("mayaLaptop", r.maya.id, t0, "main").ok).toBe(true);
  // Maya, who holds the screen, lets Ben drive alongside her (6.1's Drive together).
  r.s.deviceOnline = () => true;
  expect(r.s.drive("together", "main", r.maya.id, r.ben.id)).toMatchObject({ ok: true, drivers: [r.maya.id, r.ben.id] });
  expect(r.hub.recordStart("benLaptop", r.ben.id, t0, "main").ok).toBe(true);
  expect(r.s.recordings().length).toBe(2);
  line(r.hub, "maya wants the header taller", r.maya.id, "mayaLaptop", t0 + 500);
  line(r.hub, "ben wants the footer shorter", r.ben.id, "benLaptop", t0 + 600);
  const mt = { kind: "artifact" as const, ref: "h", label: "Header" };
  const bt = { kind: "artifact" as const, ref: "f", label: "Footer" };
  const m = await r.hub.recordStop({ recordingId: rid(r, "mayaLaptop"), caller: "host", deviceId: "mayaLaptop", personId: r.maya.id, pointer: [{ t: t0 + 550, kind: "click", x: 0.5, y: 0.1, target: mt }] });
  // Ben is still recording: the screen stays locked.
  expect(r.s.lockOf("main")).not.toBeNull();
  const b = await r.hub.recordStop({ recordingId: rid(r, "benLaptop"), caller: "host", deviceId: "benLaptop", personId: r.ben.id, pointer: [{ t: t0 + 650, kind: "click", x: 0.5, y: 0.9, target: bt }] });
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
  await r.hub.recordStop({ recordingId: rid(r, "mayaLaptop"), caller: "host", deviceId: "mayaLaptop", personId: r.maya.id, pointer: [] });
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

test("a lock refresh while recording never cuts off drivers, and Record taking the lock makes its taker a driver", async () => {
  const r = room();
  const t0 = Date.now();
  r.s.deviceOnline = () => true;
  expect(r.hub.recordStart("mayaLaptop", r.maya.id, t0, "main").ok).toBe(true);
  expect(r.s.driversOf("main")).toEqual([r.maya.id]);
  r.s.drive("together", "main", r.maya.id, r.ben.id);
  // The keep-alive the recording runs, and a show-request refresh: both leave the drivers alone.
  r.s.touchLock("main");
  r.s.touchLock("main");
  expect(r.s.driversOf("main")).toEqual([r.maya.id, r.ben.id]);
  expect(r.hub.recordStart("benLaptop", r.ben.id, t0, "main").ok).toBe(true);
  await r.hub.recordStop({ recordingId: rid(r, "mayaLaptop"), caller: "host", deviceId: "mayaLaptop", personId: r.maya.id, pointer: [] });
  // Ben is still recording and still driving.
  expect(r.s.driversOf("main")).toEqual([r.maya.id, r.ben.id]);
  await r.hub.recordStop({ recordingId: rid(r, "benLaptop"), caller: "host", deviceId: "benLaptop", personId: r.ben.id, pointer: [] });
  expect(r.s.lockOf("main")).toBeNull();
}, 30_000);

test("an owner who passed control can record: it starts them driving again; someone who was never given control can't", async () => {
  const r = room();
  const t0 = Date.now();
  r.s.deviceOnline = () => true;
  r.s.setStage({ mode: "spotlight", items: ["a"] }, "Maya", "main", { person: { id: r.maya.id, name: "Maya" } });
  r.s.drive("start", "main", r.maya.id);
  r.s.drive("pass", "main", r.maya.id, r.ben.id);
  expect(r.s.driversOf("main")).toEqual([r.ben.id]);
  expect(r.hub.recordStart("mayaLaptop", r.maya.id, t0, "main").ok).toBe(true);
  expect(r.s.driversOf("main").sort()).toEqual([r.maya.id, r.ben.id].sort());
  const cara = r.s.upsertPerson({ name: "Cara" });
  expect(r.hub.recordStart("caraLaptop", cara.id, t0, "main")).toMatchObject({ ok: false, status: 409 });
});

// ---------- review fixes: ids the hub issued, devices the caller owns, locks it took, one send at a time ----------

/** A plain grey PNG of the given size (stored, not compressed), for the crop picture. */
function png(width: number, height: number) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Uint8Array) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    Buffer.from(data).copy(out, 8);
    out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 0, 0, 0, 0], 8); // 8-bit greyscale
  const raw = Buffer.alloc((width + 1) * height, 0x80);
  for (let y = 0; y < height; y++) raw[y * (width + 1)] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array(0))]);
}

const pinOn = (a: { id: string; title: string }, id = "n1") => ({ id, text: "make this bigger", pin: { target: { kind: "artifact", ref: a.id, label: a.title }, x: 0.5, y: 0.5, kind: "click" } });

test("a send names a recording this hub stopped: made-up ids and path tricks are refused, and a crop's file name is the hub's own", async () => {
  const r = room();
  const orphan = r.s.upsertArtifact({ kind: "screenshot", stage: "built", title: "Sketch", agentId: null, image: "/renders/sketch.png" });
  writeFileSync(join(r.hub.canvas.rendersDir, "sketch.png"), png(400, 300));
  for (const id of ["rec-x", "crop-../../../target", "../../etc/passwd", "rec_0000000000"]) {
    const res = await r.post("/record/send", { recordingId: id, personId: r.maya.id, notes: [pinOn(orphan)] });
    expect([id, res.status]).toEqual([id, 404]);
  }
  expect(r.s.annotations()).toEqual([]);
  const before = new Set(readdirSync(dirname(r.hub.canvas.rendersDir)));
  const id = await r.stopped();
  const out = (await (await r.post("/record/send", { recordingId: id, personId: r.maya.id, notes: [pinOn(orphan)] })).json()) as any;
  expect(out.ok).toBe(true);
  if (process.platform === "darwin") {
    const crop = r.s.annotations()[0].crop!;
    expect(crop).toMatch(/^\/renders\/uploads\/crop_[0-9a-f]{10}\.png$/);
    expect(existsSync(join(r.hub.uploadsDir, basename(crop)))).toBe(true);
  }
  // Nothing was written beside the renders folder.
  expect(new Set(readdirSync(dirname(r.hub.canvas.rendersDir)))).toEqual(before);
}, 30_000);

test("a picture whose path leads out of the renders folder (a link) gets no crop", async () => {
  const r = room();
  const outside = join(dir, `outside-${Math.random()}.png`);
  writeFileSync(outside, png(400, 300));
  symlinkSync(outside, join(r.hub.canvas.rendersDir, "linked.png"));
  const linked = r.s.upsertArtifact({ kind: "screenshot", stage: "built", title: "Linked", agentId: null, image: "/renders/linked.png" });
  const out = (await (await r.post("/record/send", { recordingId: await r.stopped(), personId: r.maya.id, notes: [pinOn(linked)] })).json()) as any;
  expect(out.ok).toBe(true);
  expect(r.s.annotations()[0].crop).toBeNull();
}, 30_000);

test("nobody records, stops or sends on another window's device, even knowing its id", async () => {
  const r = room();
  const t0 = Date.now() - 3000;
  expect((await r.post("/record/start", { deviceId: "mayaLaptop", personId: r.maya.id, t0, screen: "main" })).status).toBe(200);
  const lock = r.s.lockOf("main");
  // Ben's own laptop is paired to him; the room's ids are in the state, so he knows Maya's.
  const bens = r.hub.auth.issue({ kind: "browser", label: "Ben's laptop", ip: "10.0.0.7", personId: r.ben.id });
  r.s.touchDevice("benOwn", { personId: r.ben.id, pairedId: bens.device.id });
  const asBen = { "x-forwarded-for": "10.0.0.7", authorization: `Bearer ${bens.token}` };
  expect((await r.post("/record/start", { deviceId: "mayaLaptop", t0 }, asBen)).status).toBe(403);
  expect((await r.post("/record/stop", { deviceId: "mayaLaptop", recordingId: "rec_x", t1: t0 + 10 }, asBen)).status).toBe(403);
  expect((await r.post("/record/start", { deviceId: "nobody-has-this", t0 }, asBen)).status).toBe(403);
  // Maya's recording and her lock are untouched.
  expect(r.s.recordings().map((x) => x.personName)).toEqual(["Maya"]);
  expect(r.s.lockOf("main")).toEqual(lock);
  // Notes stopped in the host's window can't be sent from Ben's, even naming Maya.
  const id = await r.stopped();
  const notes = [{ id: "n", text: "hello" }];
  expect((await r.post("/record/send", { recordingId: id, personId: r.maya.id, notes }, asBen)).status).toBe(403);
  // His own device works for him.
  expect((await r.post("/record/start", { deviceId: "benOwn", t0 }, asBen)).status).toBe(200);
  // The same window, with someone else at it, doesn't replace a recording either.
  r.s.touchDevice("mayaLaptop", { personId: r.maya.id, pairedId: "host" });
  r.hub.recordStart("mayaLaptop", r.maya.id, t0);
  expect(r.hub.recordStart("mayaLaptop", r.ben.id, t0)).toMatchObject({ ok: false, status: 409 });
  expect(r.s.recordings().filter((x) => x.deviceId === "mayaLaptop").map((x) => x.personName)).toEqual(["Maya"]);
}, 30_000);

test("a recording replacing its own keeps the screen locked; one that ends gives back only the lock it took", async () => {
  const r = room();
  const t0 = Date.now();
  expect(r.hub.recordStart("mayaLaptop", r.maya.id, t0, "main").ok).toBe(true);
  expect(r.hub.recordStart("mayaLaptop", r.maya.id, t0 + 10, "main").ok).toBe(true);
  // The replacement is recording a locked screen, still Maya's.
  expect(r.s.lockOf("main")?.personId).toBe(r.maya.id);
  expect(r.s.recordings().length).toBe(1);
  await r.hub.recordStop({ recordingId: rid(r, "mayaLaptop"), caller: "host", deviceId: "mayaLaptop", personId: r.maya.id, pointer: [] });
  expect(r.s.lockOf("main")).toBeNull();

  // Maya records the free screen; it is unlocked while she records, and Ben puts something up.
  expect(r.hub.recordStart("mayaLaptop", r.maya.id, t0, "main").ok).toBe(true);
  r.s.unlockStage("main");
  r.s.setStage({ mode: "spotlight", items: ["b"] }, "Ben", "main", { person: { id: r.ben.id, name: "Ben" } });
  const bens = r.s.lockOf("main");
  expect(bens?.personId).toBe(r.ben.id);
  // Her recording ending (stopped, abandoned or swept) leaves Ben's lock alone.
  await r.hub.recordStop({ recordingId: rid(r, "mayaLaptop"), caller: "host", deviceId: "mayaLaptop", personId: r.maya.id, pointer: [] });
  expect(r.s.lockOf("main")).toEqual(bens);
  r.s.unlockStage("main");
  expect(r.hub.recordStart("mayaLaptop", r.maya.id, t0, "main").ok).toBe(true);
  r.s.unlockStage("main");
  r.s.setStage({ mode: "spotlight", items: ["c"] }, "Ben", "main", { person: { id: r.ben.id, name: "Ben" } });
  r.s.deviceOnline = () => false;
  r.hub.sweepRecordings();
  r.hub.sweepRecordings();
  expect(r.s.recordings()).toEqual([]);
  expect(r.s.lockOf("main")?.personId).toBe(r.ben.id);
}, 30_000);

test("two sends of one recording at once (a double click, a retry racing the first) send it once", async () => {
  const r = room();
  const atlas = r.reg("Ben", "acme/web");
  const login = r.s.upsertArtifact({ kind: "screenshot", stage: "built", title: "Login", agentId: atlas.id, image: "/renders/login.png" });
  writeFileSync(join(r.hub.canvas.rendersDir, "login.png"), png(400, 300));
  const id = await r.stopped();
  const send = () => r.post("/record/send", { recordingId: id, personId: r.maya.id, notes: [pinOn(login)] }).then((x) => x.json() as Promise<any>);
  const [a, b, c] = await Promise.all([send(), send(), send()]);
  expect(a.ok && b.ok && c.ok).toBe(true);
  expect(b).toEqual(a);
  expect(c).toEqual(a);
  expect(r.s.directives().length).toBe(1);
  expect(r.s.annotations().length).toBe(1);
  // A send that went nowhere (nothing in it) doesn't stand in for a real one after it.
  const empty = await r.stopped();
  expect(((await (await r.post("/record/send", { recordingId: empty, personId: r.maya.id, notes: [] })).json()) as any).ok).toBe(false);
  expect(((await (await r.post("/record/send", { recordingId: empty, personId: r.maya.id, notes: [pinOn(login, "n2")] })).json()) as any).ok).toBe(true);
  expect(r.s.directives().length).toBe(2);
}, 30_000);

test("the older prompt routes need the caller's own device too: another person can't replace or end a recording through them", async () => {
  const r = room();
  const t0 = Date.now() - 3000;
  expect(r.hub.recordStart("mayaLaptop", r.maya.id, t0, "main").ok).toBe(true);
  const lock = r.s.lockOf("main");
  const bens = r.hub.auth.issue({ kind: "browser", label: "Ben's laptop", ip: "10.0.0.7", personId: r.ben.id });
  const asBen = { "x-forwarded-for": "10.0.0.7", authorization: `Bearer ${bens.token}` };
  expect((await r.post("/prompt-window/start", { deviceId: "mayaLaptop", t0 }, asBen)).status).toBe(403);
  expect((await r.post("/prompt-window", { deviceId: "mayaLaptop", t0, t1: t0 + 10 }, asBen)).status).toBe(403);
  expect((await r.post("/prompt-window", { deviceId: "nobody-has-this", t0, t1: t0 + 10 }, asBen)).status).toBe(403);
  // Maya's recording and her lock are untouched; her own window still works.
  expect(r.s.recordings().map((x) => x.personName)).toEqual(["Maya"]);
  expect(r.s.lockOf("main")).toEqual(lock);
  expect((await r.post("/prompt-window/start", { deviceId: "mayaLaptop", t0 })).status).toBe(409);
  expect(r.s.recordings().map((x) => x.personName)).toEqual(["Maya"]);
}, 30_000);

test("a Stop still gathering words doesn't end the recording that started after it", async () => {
  const r = room();
  const t0 = Date.now() - 3000;
  const first = r.hub.recordStart("mayaLaptop", r.maya.id, t0);
  expect(first.ok).toBe(true);
  const stopping = r.hub.recordStop({ recordingId: (first as any).id, deviceId: "mayaLaptop", caller: "host", personId: r.maya.id, pointer: [], typed: "first" });
  const second = r.hub.recordStart("mayaLaptop", r.maya.id, t0 + 20);
  expect(second.ok).toBe(true);
  await stopping;
  expect(r.s.recordings().map((x) => x.id)).toEqual([(second as any).id]);
  // The same for the older prompt window.
  const prompting = r.hub.promptWindow({ deviceId: "mayaLaptop", personId: r.maya.id, pointer: [], typed: "x" });
  const third = r.hub.recordStart("mayaLaptop", r.maya.id, t0 + 30);
  await prompting;
  expect(r.s.recordings().map((x) => x.id)).toEqual([(third as any).id]);
}, 30_000);

test("a Start that is refused leaves the recording already running", async () => {
  const r = room();
  const t0 = Date.now();
  expect(r.hub.recordStart("mayaLaptop", r.maya.id, t0, "main").ok).toBe(true);
  const lock = r.s.lockOf("main");
  // A screen that isn't there, and a screen someone else drives.
  expect(r.hub.recordStart("mayaLaptop", r.maya.id, t0 + 5, "no-such-screen")).toMatchObject({ ok: false, status: 404 });
  expect(r.s.recordings().length).toBe(1);
  expect(r.s.lockOf("main")).toEqual(lock);
  r.s.unlockStage("main");
  r.s.setStage({ mode: "spotlight", items: ["b"] }, "Ben", "main", { person: { id: r.ben.id, name: "Ben" } });
  expect(r.hub.recordStart("mayaLaptop", r.maya.id, t0 + 6, "main")).toMatchObject({ ok: false, status: 409 });
  expect(r.s.recordings().map((x) => x.personName)).toEqual(["Maya"]);
}, 30_000);

test("a delayed Stop for recording A that arrives after B started ends nothing, and B keeps running", async () => {
  const r = room();
  const t0 = Date.now() - 3000;
  const a = (await (await r.post("/record/start", { deviceId: "mayaLaptop", personId: r.maya.id, t0 })).json()) as { id: string };
  // A is replaced by B (a second Start from the same window) before A's Stop reaches the hub.
  const b = (await (await r.post("/record/start", { deviceId: "mayaLaptop", personId: r.maya.id, t0: t0 + 50 })).json()) as { id: string };
  expect(b.id).not.toBe(a.id);
  const late = await r.post("/record/stop", { deviceId: "mayaLaptop", recordingId: a.id, personId: r.maya.id, t1: t0 + 100, pointer: [], text: "from A" });
  expect(late.status).toBe(409);
  expect(r.s.recordings().map((x) => x.id)).toEqual([b.id]);
  expect((r.hub as any).promptMode.has("mayaLaptop")).toBe(true);
  // B's own Stop still works.
  const ok = await r.post("/record/stop", { deviceId: "mayaLaptop", recordingId: b.id, personId: r.maya.id, t1: t0 + 200, pointer: [], text: "from B" });
  expect(ok.status).toBe(200);
  expect(r.s.recordings()).toEqual([]);
}, 30_000);

test("Stop with no recording, or with an id nobody was given, issues no notes", async () => {
  const r = room();
  const noRec = await r.post("/record/stop", { deviceId: "mayaLaptop", recordingId: "rec_none", personId: r.maya.id, t1: Date.now(), pointer: [], text: "typed" });
  expect(noRec.status).toBe(409);
  expect(await r.post("/record/stop", { deviceId: "mayaLaptop", personId: r.maya.id, t1: Date.now(), pointer: [], text: "typed" }).then((x) => x.status)).toBe(400);
  const t0 = Date.now() - 1000;
  await r.post("/record/start", { deviceId: "mayaLaptop", personId: r.maya.id, t0 });
  const wrong = await r.post("/record/stop", { deviceId: "mayaLaptop", recordingId: "rec_guess", personId: r.maya.id, t1: Date.now(), pointer: [], text: "typed" });
  expect(wrong.status).toBe(409);
  expect(r.s.recordings().length).toBe(1);
}, 30_000);

test("the notes' window is the hub's own record of Start: a Stop can't widen it, and two Stops race to one answer", async () => {
  const r = room();
  const t0 = Date.now() - 2000;
  const start = r.hub.recordStart("mayaLaptop", r.maya.id, t0);
  if (!start.ok) throw new Error("start");
  const base = { deviceId: "mayaLaptop", recordingId: start.id, caller: "host", personId: r.maya.id, t1: t0 + 10, pointer: [], typed: "x" };
  const [one, two] = await Promise.all([r.hub.recordStop(base), r.hub.recordStop(base)]);
  // A repeated Stop gets the first one's answer and does nothing twice.
  expect(one.ok && two.ok).toBe(true);
  expect(one).toEqual(two);
  expect((r.hub as any).noteRecs.size).toBe(1);
}, 30_000);

test("an old prompt window naming a replaced recording ends nothing", async () => {
  const r = room();
  const t0 = Date.now() - 2000;
  const a = r.hub.recordStart("mayaLaptop", r.maya.id, t0);
  const b = r.hub.recordStart("mayaLaptop", r.maya.id, t0 + 10);
  if (!a.ok || !b.ok) throw new Error("start");
  await r.hub.promptWindow({ deviceId: "mayaLaptop", recordingId: a.id, personId: r.maya.id, pointer: [], typed: "x" });
  expect(r.s.recordings().map((x) => x.id)).toEqual([b.id]);
}, 30_000);

test("a stale prompt-window for recording A closes nothing of B: not B's recording, not B's speech window", async () => {
  const r = room();
  const a = r.hub.recordStart("mayaLaptop", r.maya.id);
  const b = r.hub.recordStart("mayaLaptop", r.maya.id);
  if (!a.ok || !b.ok) throw new Error("start");
  const stale = await r.post("/prompt-window", { deviceId: "mayaLaptop", recordingId: a.id, personId: r.maya.id, text: "late" });
  expect(stale.status).toBe(409);
  expect(r.s.recordings().map((x) => x.id)).toEqual([b.id]);
  const win = (r.hub as any).promptMode.get("mayaLaptop");
  expect(win).toBeTruthy();
  expect(win.t1).toBeUndefined();
  expect(win.rec).toBe(b.id);
  // An id-less close can't take a recording's window either; only the older start call's own window.
  expect((await r.post("/prompt-window", { deviceId: "mayaLaptop", personId: r.maya.id, text: "x" })).status).toBe(409);
  expect((r.hub as any).promptMode.get("mayaLaptop")).toBe(win);
  // B's own id closes it.
  expect((await r.post("/prompt-window", { deviceId: "mayaLaptop", recordingId: b.id, personId: r.maya.id, text: "ok" })).status).toBe(200);
  expect(r.s.recordings()).toEqual([]);
}, 30_000);

test("the recording window is the hub's clock: a caller's start or stop time changes nothing, and adjacent recordings don't share speech", async () => {
  const r = room();
  const base = Date.now() - 60_000;
  // Speech from before Start, and from after Stop, belongs to neither recording.
  r.at(base);
  line(r.hub, "before the recording", r.maya.id, "mayaLaptop", base - 3000);
  const a = (await (await r.post("/record/start", { deviceId: "mayaLaptop", personId: r.maya.id, t0: base - 3_600_000 })).json()) as { id: string };
  line(r.hub, "inside A", r.maya.id, "mayaLaptop", base + 1000);
  r.at(base + 5000);
  line(r.hub, "after A stopped", r.maya.id, "mayaLaptop", base + 9000);
  const stopA = (await (await r.post("/record/stop", { deviceId: "mayaLaptop", recordingId: a.id, personId: r.maya.id, t0: 1, t1: base + 3_600_000, pointer: [] })).json()) as StopOk;
  expect(stopA.notes.map((n) => n.text)).toEqual(["inside A"]);
  // B starts later; a Stop that claims a far-future end doesn't pull in anything after the hub's own now.
  r.at(base + 8000);
  const b = (await (await r.post("/record/start", { deviceId: "mayaLaptop", personId: r.maya.id })).json()) as { id: string };
  line(r.hub, "later than now", r.maya.id, "mayaLaptop", base + 40_000);
  r.at(base + 12_000);
  const stopB = (await (await r.post("/record/stop", { deviceId: "mayaLaptop", recordingId: b.id, personId: r.maya.id, t1: base + 3_600_000, pointer: [{ t: base + 1_000_000, kind: "click", x: 0.5, y: 0.5, target: { kind: "artifact", ref: "a", label: "A" } }] })).json()) as StopOk;
  expect(stopB.notes.map((n) => n.text)).toEqual(["after A stopped"]);
  expect(stopB.notes.every((n) => !n.pin)).toBe(true);
}, 60_000);

test("speech belongs to one recording: the stopping one's 300 ms never reaches into the recording that started right after it", async () => {
  const r = room();
  const base = Date.now() - 60_000;
  r.at(base);
  const a = r.hub.recordStart("mayaLaptop", r.maya.id);
  if (!a.ok) throw new Error("start");
  line(r.hub, "said in A", r.maya.id, "mayaLaptop", base + 1000);
  // A stops at base+5000; while it waits for its last words, B starts at base+5100 and its first words come at base+5200: inside A's
  // 300 ms of slack, but B's.
  r.at(base + 5000);
  const stoppingA = r.hub.recordStop({ deviceId: "mayaLaptop", recordingId: a.id, caller: "host", personId: r.maya.id, pointer: [] });
  r.at(base + 5100);
  const b = r.hub.recordStart("mayaLaptop", r.maya.id);
  if (!b.ok) throw new Error("start");
  line(r.hub, "said in B", r.maya.id, "mayaLaptop", base + 5200);
  const gotA = await stoppingA;
  expect(gotA.ok && gotA.notes.map((n) => n.text)).toEqual(["said in A"]);
  r.at(base + 9000);
  const gotB = await r.hub.recordStop({ deviceId: "mayaLaptop", recordingId: b.id, caller: "host", personId: r.maya.id, pointer: [] });
  expect(gotB.ok && gotB.notes.map((n) => n.text)).toEqual(["said in B"]);
  // A line that began before a recording started is not that recording's.
  r.at(base + 20_000);
  line(r.hub, "before C", r.maya.id, "mayaLaptop", base + 19_800);
  const c = r.hub.recordStart("mayaLaptop", r.maya.id);
  if (!c.ok) throw new Error("start");
  line(r.hub, "inside C", r.maya.id, "mayaLaptop", base + 20_500);
  r.at(base + 24_000);
  const gotC = await r.hub.recordStop({ deviceId: "mayaLaptop", recordingId: c.id, caller: "host", personId: r.maya.id, pointer: [] });
  expect(gotC.ok && gotC.notes.map((n) => n.text)).toEqual(["inside C"]);
}, 60_000);

test("a recording's speech stops at the next start even after that next recording is replaced or ended during the wait", async () => {
  const r = room();
  const base = Date.now() - 60_000;
  r.at(base);
  const a = r.hub.recordStart("mayaLaptop", r.maya.id);
  if (!a.ok) throw new Error("start");
  line(r.hub, "said in A", r.maya.id, "mayaLaptop", base + 1000);
  r.at(base + 5000);
  const stoppingA = r.hub.recordStop({ deviceId: "mayaLaptop", recordingId: a.id, caller: "host", personId: r.maya.id, pointer: [] });
  // B starts inside A's slack, a line of B's lands, then B is replaced by C and C is stopped before A's wait is over.
  r.at(base + 5100);
  const b = r.hub.recordStart("mayaLaptop", r.maya.id);
  if (!b.ok) throw new Error("start");
  line(r.hub, "said in B", r.maya.id, "mayaLaptop", base + 5200);
  r.at(base + 5400);
  const c = r.hub.recordStart("mayaLaptop", r.maya.id);
  if (!c.ok) throw new Error("start");
  r.at(base + 5600);
  await r.hub.recordStop({ deviceId: "mayaLaptop", recordingId: c.id, caller: "host", personId: r.maya.id, pointer: [], typed: "c" });
  const gotA = await stoppingA;
  expect(gotA.ok && gotA.notes.map((n) => n.text)).toEqual(["said in A"]);
}, 60_000);

test("a send that fails after a directive went out repeats nothing when it is tried again", async () => {
  const r = room();
  const atlas = r.reg("Ben", "acme/web");
  const juno = r.reg("Ana", "acme/api");
  const a = r.s.upsertArtifact({ kind: "screenshot", stage: "built", title: "A", agentId: atlas.id, image: "/renders/a.png" });
  const b = r.s.upsertArtifact({ kind: "screenshot", stage: "built", title: "B", agentId: juno.id, image: "/renders/b.png" });
  const recordingId = await r.stopped();
  const notes = [a, b].map((x, i) => ({ id: `n${i}`, text: `fix ${x.title}`, t0: 1, t1: 2, pin: { target: { kind: "artifact", ref: x.id, label: x.title }, x: 0.5, y: 0.5, kind: "click" } }));
  // The second directive's write fails once.
  const real = r.s.createDirective.bind(r.s);
  let calls = 0;
  (r.s as any).createDirective = (...args: any[]) => {
    if (++calls === 2) throw new Error("database is locked");
    return (real as any)(...args);
  };
  expect((await r.post("/record/send", { recordingId, personId: r.maya.id, notes })).status).toBeGreaterThanOrEqual(500);
  expect(r.s.directives().length).toBe(1);
  const retry = await r.post("/record/send", { recordingId, personId: r.maya.id, notes });
  expect(retry.status).toBe(200);
  expect(((await retry.json()) as any).sent.length).toBe(2);
  expect(r.s.directives().length).toBe(2);
  expect(r.s.annotations().length).toBe(2);
}, 60_000);

test("the directive and its event are one write: a failure between them leaves no directive, and the retry makes exactly one", async () => {
  const r = room();
  const atlas = r.reg("Ben", "acme/web");
  const a = r.s.upsertArtifact({ kind: "screenshot", stage: "built", title: "A", agentId: atlas.id, image: "/renders/a.png" });
  const recordingId = await r.stopped();
  const notes = [{ id: "n0", text: "fix A", t0: 1, t1: 2, pin: { target: { kind: "artifact", ref: a.id, label: "A" }, x: 0.5, y: 0.5, kind: "click" } }];
  const real = r.s.store.addEvent.bind(r.s.store);
  let failed = false;
  (r.s.store as any).addEvent = (e: any) => {
    if (e.kind === "directive" && !failed) (failed = true, (() => { throw new Error("database is locked"); })());
    return real(e);
  };
  expect((await r.post("/record/send", { recordingId, personId: r.maya.id, notes })).status).toBeGreaterThanOrEqual(500);
  expect(r.s.directives().length).toBe(0);
  expect((await r.post("/record/send", { recordingId, personId: r.maya.id, notes })).status).toBe(200);
  expect(r.s.directives().length).toBe(1);
  expect(r.s.store.recentEvents({ kinds: ["directive"], limit: 20 }).length).toBe(1);
  // The same key asked for again finds the directive.
  const again = r.s.createDirective({ text: "x", mode: "implement", targets: [atlas.id], requestedBy: "Maya", key: r.s.directives()[0].key });
  expect(again.id).toBe(r.s.directives()[0].id);
  expect(r.s.directives().length).toBe(1);
}, 60_000);

test("a send is frozen once made: the same notes answer the same, different notes are refused and change nothing", async () => {
  const r = room();
  const atlas = r.reg("Ben", "acme/web");
  const a = r.s.upsertArtifact({ kind: "screenshot", stage: "built", title: "A", agentId: atlas.id, image: "/renders/a.png" });
  const recordingId = await r.stopped();
  const mk = (text: string) => [{ id: "n0", text, t0: 1, t1: 2, pin: { target: { kind: "artifact", ref: a.id, label: "A" }, x: 0.5, y: 0.5, kind: "click" } }];
  const first = (await (await r.post("/record/send", { recordingId, personId: r.maya.id, notes: mk("fix A") })).json()) as any;
  const same = (await (await r.post("/record/send", { recordingId, personId: r.maya.id, notes: mk("fix A") })).json()) as any;
  expect(same.sent).toEqual(first.sent);
  const changed = await r.post("/record/send", { recordingId, personId: r.maya.id, notes: mk("fix A, and bigger") });
  expect(changed.status).toBe(409);
  expect(((await changed.json()) as any).error ?? "").toContain("Record again");
  expect(r.s.directives().length).toBe(1);
  expect(r.s.directives()[0].text).toContain("fix A");
  expect(r.s.directives()[0].text).not.toContain("bigger");
}, 60_000);

test("a window closing while its Start is in flight: the token cancels whichever side wins", async () => {
  const r = room();
  const tok = "rt_aaaaaaaaaaaaaaaa";
  const tok2 = "rt_bbbbbbbbbbbbbbbb";
  // Start first, cancel after: the recording ends and its screen/speech window go.
  const a = r.hub.recordStart("mayaLaptop", r.maya.id, undefined, null, tok);
  if (!a.ok) throw new Error("start");
  expect((await r.post("/record/cancel", { deviceId: "mayaLaptop", token: tok })).status).toBe(200);
  expect(r.hub.recordingOn("mayaLaptop")).toBe(false);
  expect(r.s.recordings().length).toBe(0);
  // Cancel first, Start after: the Start is refused and nothing runs.
  expect((await r.post("/record/cancel", { deviceId: "mayaLaptop", token: tok2 })).status).toBe(200);
  const late = await r.post("/record/start", { deviceId: "mayaLaptop", personId: r.maya.id, token: tok2 });
  expect(late.status).toBe(409);
  expect(r.hub.recordingOn("mayaLaptop")).toBe(false);
  // A cancel names its own token: another recording is untouched, and a malformed or foreign-device cancel is refused.
  const b = r.hub.recordStart("mayaLaptop", r.maya.id, undefined, null, "rt_cccccccccccccccc");
  if (!b.ok) throw new Error("start");
  await r.post("/record/cancel", { deviceId: "mayaLaptop", token: "rt_dddddddddddddddd" });
  expect(r.hub.recordingOn("mayaLaptop")).toBe(true);
  expect((await r.post("/record/cancel", { deviceId: "mayaLaptop", token: "x" })).status).toBe(400);
  expect((await r.post("/record/cancel", { deviceId: "nobodyLaptop", token: tok })).status).toBe(403);
}, 60_000);

test("a recording's speech bound is kept on the recording itself: twenty-five replacements during its wait pull nothing in", async () => {
  const r = room();
  const base = Date.now() - 60_000;
  r.at(base);
  const a = r.hub.recordStart("mayaLaptop", r.maya.id);
  if (!a.ok) throw new Error("start");
  line(r.hub, "said in A", r.maya.id, "mayaLaptop", base + 1000);
  r.at(base + 5000);
  const stoppingA = r.hub.recordStop({ deviceId: "mayaLaptop", recordingId: a.id, caller: "host", personId: r.maya.id, pointer: [] });
  r.at(base + 5100);
  for (let i = 0; i < 25; i++) {
    const x = r.hub.recordStart("mayaLaptop", r.maya.id);
    if (!x.ok) throw new Error("start");
    if (i === 0) line(r.hub, "said in B", r.maya.id, "mayaLaptop", base + 5200);
    r.at(base + 5300 + i);
  }
  const gotA = await stoppingA;
  expect(gotA.ok && gotA.notes.map((n) => n.text)).toEqual(["said in A"]);
}, 60_000);

test("a Stop sent again after its reply was lost gets the first answer and ends nothing twice; a Stop that fails outright can be tried again", async () => {
  const r = room();
  const a = r.hub.recordStart("mayaLaptop", r.maya.id);
  if (!a.ok) throw new Error("start");
  const body = { deviceId: "mayaLaptop", recordingId: a.id, personId: r.maya.id, pointer: [], text: "make it bigger" };
  const first = await r.post("/record/stop", body);
  const again = await r.post("/record/stop", body);
  expect(first.status).toBe(200);
  expect(await again.json()).toEqual(await first.json());
  expect((r.hub as any).noteRecs.size).toBe(1);
  // Another window's Stop for the same id is not given that answer.
  expect((await r.post("/record/stop", { ...body, deviceId: "benLaptop" })).status).toBeGreaterThanOrEqual(400);
  // An outright failure leaves the recording stoppable.
  const b = r.hub.recordStart("mayaLaptop", r.maya.id);
  if (!b.ok) throw new Error("start");
  const real = (r.hub as any).stopRecording.bind(r.hub);
  let failed = false;
  (r.hub as any).stopRecording = (...args: any[]) => (failed ? real(...args) : ((failed = true), Promise.reject(new Error("database is locked"))));
  expect((await r.post("/record/stop", { ...body, recordingId: b.id })).status).toBeGreaterThanOrEqual(500);
  expect((await r.post("/record/stop", { ...body, recordingId: b.id })).status).toBe(200);
}, 60_000);

test("a window's cancelled tokens are kept per device and never pushed out by other windows' cancels", async () => {
  const r = room();
  const tok = "rt_eeeeeeeeeeeeeeee";
  r.hub.recordCancel("mayaLaptop", tok);
  for (let i = 0; i < 600; i++) r.hub.recordCancel("benLaptop", `rt_ben${String(i).padStart(12, "0")}`);
  const late = await r.post("/record/start", { deviceId: "mayaLaptop", personId: r.maya.id, token: tok });
  expect(late.status).toBe(409);
  // One window's own cancels are capped, so it can't grow without limit.
  const n = (r.s.store.db.query("SELECT COUNT(*) AS n FROM cancels WHERE device = 'benLaptop'").get() as { n: number }).n;
  expect(n).toBe(200);
  // Past the hour a token no longer counts.
  expect(r.s.store.tokenCancelled("mayaLaptop", tok, Date.now() + 61 * 60_000)).toBe(false);
});

test("a write's announcement waits for the commit: a rolled-back transaction announces nothing", () => {
  const r = room();
  const heard: string[] = [];
  const off = bus.on((m: any) => m.type === "event" && heard.push(m.event.text));
  const ev = (text: string) => r.s.store.addEvent({ kind: "speech", authorType: "person", authorName: "x", text });
  expect(() => r.s.store.atomic(() => (ev("rolled back"), (() => { throw new Error("commit failed"); })()))).toThrow();
  expect(heard).toEqual([]);
  r.s.store.atomic(() => (ev("kept"), expect(heard).toEqual([])));
  expect(heard).toEqual(["kept"]);
  off?.();
});

test("a cancel while a Stop is in flight ends the recording at once, and it stays ended when that Stop then fails", async () => {
  const r = room();
  const tok = "rt_ffffffffffffffff";
  const a = r.hub.recordStart("mayaLaptop", r.maya.id, undefined, null, tok);
  if (!a.ok) throw new Error("start");
  (r.hub as any).stopRecording = async () => (await Bun.sleep(100), Promise.reject(new Error("database is locked")));
  const stopping = r.hub.recordStop({ deviceId: "mayaLaptop", recordingId: a.id, caller: "host", personId: r.maya.id, pointer: [], typed: "x" });
  const failed = stopping.then(() => "ok", (e) => String(e));
  expect((r.hub as any).recs.get("mayaLaptop").state).toBe("ending");
  r.hub.recordCancel("mayaLaptop", tok);
  expect(r.hub.recordingOn("mayaLaptop")).toBe(false);
  expect(await failed).toContain("database is locked");
  expect(r.hub.recordingOn("mayaLaptop")).toBe(false);
  expect(r.s.recordings().length).toBe(0);
});

test("a Stop that fails with nothing else happening puts the recording back to live with the error kept, and the retry runs it again", async () => {
  const r = room();
  const a = r.hub.recordStart("mayaLaptop", r.maya.id);
  if (!a.ok) throw new Error("start");
  const rec = (r.hub as any).recs.get("mayaLaptop");
  const real = (r.hub as any).stopRecording.bind(r.hub);
  let n = 0;
  (r.hub as any).stopRecording = (...args: any[]) => (++n === 1 ? Promise.reject(new Error("database is locked")) : real(...args));
  const stop = () => r.hub.recordStop({ deviceId: "mayaLaptop", recordingId: a.id, caller: "host", personId: r.maya.id, pointer: [], typed: "x" });
  await expect(stop()).rejects.toThrow("locked");
  expect(rec.state).toBe("live");
  expect(rec.error).toContain("locked");
  expect((await stop()).ok).toBe(true);
  expect(rec.state).toBe("ended");
});

test("a prompt-window close and a Stop racing for one recording: one closes it, the other is refused, in either order", async () => {
  for (const first of ["stop", "window"] as const) {
    const r = room();
    const a = r.hub.recordStart("mayaLaptop", r.maya.id);
    if (!a.ok) throw new Error("start");
    const stop = () => r.hub.recordStop({ deviceId: "mayaLaptop", recordingId: a.id, caller: "host", personId: r.maya.id, pointer: [], typed: "make it bigger" });
    const win = () => r.hub.promptWindow({ deviceId: "mayaLaptop", recordingId: a.id, personId: r.maya.id, pointer: [], typed: "make it bigger" });
    const [one, two]: any[] = await Promise.all(first === "stop" ? [stop(), win()] : [win(), stop()]);
    expect([one.ok, two.ok]).toEqual([true, false]);
    expect(two.status).toBe(409);
    expect(r.hub.recordingOn("mayaLaptop")).toBe(false);
    // Only one close made anything: a repeated Stop shares or repeats it, never adds a second prompt.
    const prompts = r.s.store.recentEvents({ kinds: ["speech"], limit: 20 }).filter((e) => e.data.recorded).length;
    expect(prompts).toBe(first === "stop" ? 0 : 1);
  }
}, 60_000);

test("a Stop whose pointer can't be read still ends the recording: junk marks are dropped, not fatal", async () => {
  const r = room();
  for (const pointer of ["garbage", [null, 5, { t: "x" }, { t: 1, kind: "click" }]] as any[]) {
    const a = r.hub.recordStart("mayaLaptop", r.maya.id);
    if (!a.ok) throw new Error("start");
    const res = await r.hub.recordStop({ deviceId: "mayaLaptop", recordingId: a.id, caller: "host", personId: r.maya.id, pointer, typed: "words" });
    expect(res.ok).toBe(true);
    expect(r.hub.recordingOn("mayaLaptop")).toBe(false);
  }
}, 30_000);

test("the right to send and the receipt of the send are one record: past the cap both go together, and a retry after that sends nothing twice", async () => {
  const r = room();
  const stopOne = async (text: string) => {
    const started = r.hub.recordStart("mayaLaptop", r.maya.id);
    if (!started.ok) throw new Error("start");
    const res = await r.hub.recordStop({ deviceId: "mayaLaptop", recordingId: started.id, caller: "host", personId: r.maya.id, pointer: [], typed: text });
    if (!res.ok) throw new Error(res.reason);
    return res;
  };
  const first = await stopOne("first");
  const notes = first.notes;
  const send = () => r.post("/record/send", { recordingId: first.recordingId, personId: r.maya.id, notes });
  expect((await send()).status).toBe(200);
  const sentOnce = r.s.store.recentEvents({ kinds: ["speech"], limit: 50 }).filter((e) => e.data.recordingId === first.recordingId).length;
  expect(sentOnce).toBeGreaterThan(0);
  // More stopped recordings than the hub keeps: the first one's record is evicted, authorization and receipt together.
  for (let i = 0; i < NOTE_RECS_MAX; i++) (r.hub as any).noteRecs.set(`filler${i}`, { caller: "host", personId: r.maya.id });
  r.hub.recordStart("mayaLaptop", r.maya.id);
  await stopOne("evictor").catch(() => {});
  expect((r.hub as any).noteRecs.has(first.recordingId)).toBe(false);
  // A retry now is refused outright, not run a second time.
  const retry = await send();
  expect(retry.status).toBe(404);
  expect(r.s.store.recentEvents({ kinds: ["speech"], limit: 50 }).filter((e) => e.data.recordingId === first.recordingId).length).toBe(sentOnce);
  expect(r.s.directives().length).toBe(0);
}, 60_000);

test("the older prompt-window start is refused while a recording runs, and the recording and its window are untouched", async () => {
  const r = room();
  const a = r.hub.recordStart("mayaLaptop", r.maya.id);
  if (!a.ok) throw new Error("start");
  const win = (r.hub as any).promptMode.get("mayaLaptop");
  const res = await r.post("/prompt-window/start", { deviceId: "mayaLaptop" });
  expect(res.status).toBe(409);
  expect((r.hub as any).promptMode.get("mayaLaptop")).toBe(win);
  expect(r.s.recordings().map((x) => x.id)).toEqual([a.id]);
  // Its own Stop still closes the window.
  expect((await r.post("/record/stop", { deviceId: "mayaLaptop", recordingId: a.id, personId: r.maya.id, text: "ok" })).status).toBe(200);
  // With no recording running the older call works as before.
  expect((await r.post("/prompt-window/start", { deviceId: "mayaLaptop" })).status).toBe(200);
}, 30_000);
