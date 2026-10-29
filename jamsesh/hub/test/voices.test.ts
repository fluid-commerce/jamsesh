// 5.3 and 5.4: speaker labels that learn, and a transcript that shows each line once.
// Rooms are four `say` voices on three laptops (voices.sim.ts); nothing here plays sound.
import "./voices.env";
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENROL_SCRIPT, scriptShare } from "../src/audio/enrol";
import { embed, learningNote } from "../src/audio/voiceprint";
import { decodeWav, encodeWav, resample } from "../src/audio/wav";
import { Hub } from "../src/hub";
import { startHttp } from "../src/http";
import { CAN_SIM, CAST, copiesOf, enrol, ENROL_TEXT, HOST, LAPTOPS, makeRoom, play, rng, say, score, script, type Key, type Spoken } from "./voices.sim";

const sim = test.skipIf(!CAN_SIM);
const T = 120_000;

/** One person saying one thing at a given moment. */
function line(who: Key, text: string, t0: number, rate = 170): Spoken {
  const samples = say(who, text, rate);
  return { speaker: who, text, t0, t1: t0 + Math.round((samples.length / 16000) * 1000), samples };
}
const base = () => Date.now() - 300_000;
const ofRoom = (room: ReturnType<typeof makeRoom>) => room.session.store.all("utterances").sort((a, b) => a.t0 - b.t0);

// ---------------------------------------------------------------- 5.4 the transcript

sim("the join read stays out of the transcript, even though every laptop heard it", async () => {
  const room = makeRoom();
  const r = rng(1);
  const t = base();
  room.pipeline.beginEnrolment(room.people.ana.id);
  // Heard at once by all three laptops, as the three sentences and as one run.
  for (const [i, sentence] of ENROL_SCRIPT.entries()) await play(room, line("ana", sentence, t + i * 6000), r);
  expect(ofRoom(room)).toHaveLength(0);
  room.pipeline.endEnrolment(room.people.ana.id);
  // Ordinary talk right after still shows up, whoever it is.
  await play(room, line("ben", "The build finished on my side, so I can push the new checkout screen now.", t + 30_000), r);
  expect(ofRoom(room).map((u) => u.speakerName)).toEqual(["Ben"]);
}, T);

sim("without a read in progress the same words are an ordinary line", async () => {
  const room = makeRoom();
  await play(room, line("ana", ENROL_SCRIPT[1], base()), rng(2));
  expect(ofRoom(room)).toHaveLength(1);
}, T);

sim("two people at once: one reads, the other keeps talking and is heard", async () => {
  const room = makeRoom();
  const r = rng(3);
  const t = base();
  room.pipeline.beginEnrolment(room.people.ben.id);
  await play(room, line("ben", ENROL_SCRIPT[0], t), r);
  await play(room, line("cam", "Remind me which of these two layouts we agreed on last week for the portal.", t + 9000), r);
  // Cold room, so Cam's line is Someone's: the point is that it is there and the read is not.
  expect(ofRoom(room).map((u) => u.text)).toEqual(["Remind me which of these two layouts we agreed on last week for the portal."]);
}, T);

sim("while one person reads, others using the script's words, or reading it at their own laptop, are still heard", async () => {
  const room = makeRoom();
  const r = rng(4);
  const t = base();
  room.pipeline.beginEnrolment(room.people.ana.id);
  const mixed = "I ask for the layout and the spacing on the big screen.";
  await play(room, line("cam", mixed, t), r);
  // Ben reads the script aloud at his own laptop while Ana is the one enrolling: that's Ben talking.
  await play(room, line("ben", ENROL_SCRIPT[2], t + 9000), r);
  expect(ofRoom(room).map((u) => u.text)).toEqual([mixed, ENROL_SCRIPT[2]]);
}, T);

test("the read is matched by the script's word order, not its vocabulary", () => {
  expect(scriptShare(ENROL_SCRIPT[0])).toBe(1);
  expect(scriptShare("this is my boys and this is how I sound while I work")).toBeGreaterThan(0.8);
  expect(scriptShare("the colors, the spacing, and what I would change next. When I ask for something")).toBeGreaterThan(0.9);
  expect(scriptShare("I ask for the layout and the spacing on the big screen")).toBeLessThan(0.6);
  expect(scriptShare("this is it")).toBe(0);
});

const SKEWS = [
  { name: "laptop clocks a second and a half off", opts: { skew: { "lap-b": 1500, "lap-c": -1300 } } },
  { name: "one laptop's copy arrives five seconds late", opts: { settleMs: 1000 } },
  { name: "far laptops mishear a word", opts: { textNoise: true } },
];
for (const c of SKEWS)
  sim(`the same line heard by three laptops shows once: ${c.name}`, async () => {
    const room = makeRoom();
    const lines = script(21, 3, base()).slice(0, 12);
    const r = rng(5);
    for (const l of lines) await play(room, l, r, c.opts);
    const s = score(room, lines);
    expect(s.dupes).toBe(0);
    expect(s.lost).toBe(0);
    expect(ofRoom(room)).toHaveLength(lines.length);
  }, T);

// Clocks too far off to group the copies by time, and a far laptop that lost a word: the words don't agree one by
// one, so JamSesh can't be sure it's one line and keeps both rather than lose what someone said.
sim("a copy with clocks off and a word lost isn't merged by guesswork: both lines are kept", async () => {
  const room = makeRoom();
  const lines = script(21, 3, base()).slice(0, 12);
  const r = rng(5);
  for (const l of lines) await play(room, l, r, { skew: { "lap-b": 1500, "lap-c": -1300 }, textNoise: true });
  const s = score(room, lines);
  expect(s.lost).toBe(0);
  expect(s.dupes).toBeGreaterThan(0);
}, T);

sim("two people saying the same words a moment apart are still two lines when far apart in time", async () => {
  const room = makeRoom();
  const r = rng(6);
  const t = base();
  const words = "Can we try the blue button on the settings page before the demo this afternoon.";
  await play(room, line("ana", words, t), r);
  await play(room, line("ben", words, t + 12_000), r);
  expect(ofRoom(room)).toHaveLength(2);
}, T);

sim("one person repeating another's sentence two seconds later is a second line, not merged into the first", async () => {
  const room = makeRoom();
  const r = rng(16);
  const t = base();
  const words = "Can we try the blue button on the settings page before the demo this afternoon.";
  const first = line("ana", words, t);
  await play(room, first, r);
  await play(room, line("ben", words, t + 2000), r);
  expect(ofRoom(room)).toHaveLength(2);
}, T);

sim("two voices saying the same words on two laptops at once are two lines", async () => {
  const room = makeRoom();
  const words = "Can we try the blue button on the settings page before the demo this afternoon.";
  const t = base();
  const a = copiesOf(line("ana", words, t), rng(18))[0];
  const b = copiesOf(line("ben", words, t + 1500), rng(19))[1];
  for (const c of [a, b]) {
    room.say.set(String(Bun.hash(c.wav)), c.text);
    await room.pipeline.ingest({ deviceId: c.laptop, t0: c.t0, t1: c.t1, wav: c.wav });
    await room.pipeline.flush();
  }
  expect(ofRoom(room).map((u) => u.devices[0].deviceId)).toEqual(["lap-a", "lap-b"]);
}, T);

sim("a late copy whose first line is too old to join is dropped only on the very same words", async () => {
  const room = makeRoom();
  const spoken = line("ana", "Let me check the spacing on the pricing cards and send a screenshot to the room.", base());
  const [a, b] = copiesOf(spoken, rng(17), { skew: { "lap-b": 1500 } });
  for (const c of [a, b]) room.say.set(String(Bun.hash(c.wav)), c.text);
  await room.pipeline.ingest({ deviceId: a.laptop, t0: a.t0, t1: a.t1, wav: a.wav });
  await room.pipeline.flush();
  (room.pipeline as any).finalized = [];
  await room.pipeline.ingest({ deviceId: b.laptop, t0: b.t0, t1: b.t1, wav: b.wav });
  await room.pipeline.flush();
  // Ana's own words from another laptop: the line already shown, not a second one.
  expect(ofRoom(room)).toHaveLength(1);
  // Ben at the same moment with other words at his own laptop: shown, though only time lines it up.
  const ben = copiesOf(line("ben", "The build finished on my side, so I can push the new checkout screen now.", spoken.t0 + 300), rng(18))[1];
  room.say.set(String(Bun.hash(ben.wav)), ben.text);
  (room.pipeline as any).finalized = [];
  await room.pipeline.ingest({ deviceId: ben.laptop, t0: ben.t0, t1: ben.t1, wav: ben.wav });
  await room.pipeline.flush();
  expect(ofRoom(room)).toHaveLength(2);
}, T);

// ---------------------------------------------------------------- 5.3 corrections

sim("a correction is worth many automatic samples, says it is learning, and the next line is right", async () => {
  const room = makeRoom();
  const r = rng(7);
  const t = base();
  const first = line("dee", "The empty state needs a friendlier message and a button to create the first item.", t);
  await play(room, first, r);
  const u = ofRoom(room)[0];
  const dee = room.people.dee;
  const done = room.pipeline.assign(u.id, dee.id, HOST);
  expect(done.learning.learned).toBe(true);
  expect(learningNote("Dee", done.learning)).toBe("Learning Dee's voice.");
  expect(room.pipeline.voiceprints.learnedFrom(dee.id).correction).toBe(1);
  expect(room.pipeline.voiceprints.count(dee.id)).toBeGreaterThanOrEqual(10);
  await play(room, line("dee", "Could we use a softer shadow under the cards, the current one looks heavy.", t + 15_000), r);
  expect(ofRoom(room)[1].speakerName).toBe("Dee");
}, T);

sim("correcting a line takes back what the wrong label taught the wrong person", async () => {
  const room = makeRoom();
  const r = rng(8);
  const t = base();
  const ana = room.people.ana;
  const dee = room.people.dee;
  // Ana has read the join sentences. Then three of Dee's lines, heard at Ana's laptop, were filed under Ana.
  enrol(room, "ana");
  const deeLines = [
    "The empty state needs a friendlier message and a button to create the first item.",
    "I tested the signup form and the error text overlaps the input on small phones.",
    "Could we use a softer shadow under the cards, the current one looks heavy.",
  ];
  for (const text of deeLines) room.pipeline.voiceprints.add(ana.id, embed({ sampleRate: 16000, samples: say("dee", text, 170) })!, "auto", Date.now());
  expect(room.pipeline.voiceprints.learnedFrom(ana.id).auto).toBe(3);
  await play(room, line("dee", "Let me write down what we decided about the navigation so nobody forgets it.", t), r);
  const u = ofRoom(room)[0];
  room.pipeline.assign(u.id, ana.id, HOST); // wrongly filed under Ana first, as the live room did
  const fixed = room.pipeline.assign(u.id, dee.id, HOST);
  expect(fixed.learning.learned).toBe(true);
  // The wrong label's samples that sound like Dee are gone; what Ana read herself stays.
  expect(room.pipeline.voiceprints.learnedFrom(ana.id).auto).toBe(0);
  expect(room.pipeline.voiceprints.learnedFrom(ana.id).enrol).toBeGreaterThan(0);
  expect(room.pipeline.voiceprints.learnedFrom(ana.id).correction).toBe(0);
}, T);

sim("a correction also names earlier lines nobody could place that sound like the same voice", async () => {
  const room = makeRoom();
  const r = rng(9);
  const t = base();
  // Cold room: Cam and Dee sit at the shared laptop, so their lines are Someone.
  const spoken = [
    line("cam", "Remind me which of these two layouts we agreed on last week for the portal.", t),
    line("cam", "The customer asked for a way to export the report as a spreadsheet file.", t + 9000),
    line("cam", "I will take the notifications task unless somebody else already has it.", t + 18_000),
  ];
  for (const l of spoken) await play(room, l, r);
  const before = ofRoom(room).filter((u) => !u.personId).length;
  expect(before).toBeGreaterThanOrEqual(2);
  const out = room.pipeline.assign(ofRoom(room)[2].id, room.people.cam.id, HOST);
  expect(out.learning.learned && out.learning.relabelled).toBeGreaterThanOrEqual(1);
  expect(ofRoom(room).filter((u) => !u.personId).length).toBeLessThan(before);
  expect(learningNote("Cam", out.learning)).toMatch(/^Learning Cam's voice\. Fixed \d+ earlier lines? too\.$/);
}, T);

sim("a line with no voice sample kept says so instead of pretending", async () => {
  const room = makeRoom();
  // An old line: its copies are long gone and its event kept no sample.
  const old = { id: "utt_old", t0: Date.now() - 3_600_000, t1: Date.now() - 3_598_000, text: "an old line", personId: null, speakerName: "Someone", confidence: 0, method: "unknown", deviceId: "lap-a", devices: [], location: "room" as const, eventId: null, engine: "t" };
  room.session.store.put("utterances", old);
  const out = room.pipeline.assign(old.id, room.people.ben.id, HOST);
  expect(out.learning.learned).toBe(false);
  expect(learningNote("Ben", out.learning)).toMatch(/^Renamed, but couldn't learn from that line \(no voice sample was kept/);
  expect(room.session.store.get("utterances", old.id)?.speakerName).toBe("Ben");
});

sim("corrections stick: three fixes in a cold room and everything after is right", async () => {
  const room = makeRoom();
  const lines = script(11, 8, base());
  const r = rng(7);
  let fixed = 0;
  let from = 0;
  for (const [i, l] of lines.entries()) {
    await play(room, l, r);
    const u = ofRoom(room).find((x) => x.t0 < l.t1 + 1500 && x.t1 > l.t0 - 1500);
    if (fixed < 3 && u && u.personId !== room.people[l.speaker].id) (room.pipeline.assign(u.id, room.people[l.speaker].id, HOST), fixed++, (from = i + 1));
  }
  const s = score(room, lines.slice(from));
  expect(s.right / s.lines).toBeGreaterThanOrEqual(0.9);
}, T);

sim("the join read gives every person a voice from the first line", async () => {
  const room = makeRoom();
  for (const c of CAST) expect(enrol(room, c.key)).toMatchObject({ ok: true });
  for (const c of CAST) expect(room.pipeline.voiceprints.learnedFrom(room.people[c.key].id).enrol).toBeGreaterThanOrEqual(2);
  const lines = script(12, 6, base());
  const r = rng(12);
  for (const l of lines) await play(room, l, r);
  const s = score(room, lines);
  expect(s.someone).toBe(0);
  expect(s.right / s.lines).toBeGreaterThanOrEqual(0.6);
}, T);

// ---------------------------------------------------------------- 5.3 a voice stays on its host

const dir = mkdtempSync(join(tmpdir(), "jam-voices-hub-"));
const hubA = new Hub({ canvas: false, whisper: false, dataDir: join(dir, "a") });
const hubB = new Hub({ canvas: false, whisper: false, dataDir: join(dir, "b") });
const server = startHttp(hubB, 0);
const url = `http://127.0.0.1:${server.port}`;
afterAll(() => {
  server.stop(true);
  for (const h of [hubA, hubB]) (h.stop(), h.devproxy.stop());
  rmSync(dir, { recursive: true, force: true });
});
const remote = { "x-forwarded-for": "9.9.9.9", "content-type": "application/json" };

function wavOf(key: Key, text: string) {
  return encodeWav({ sampleRate: 16000, samples: say(key, text, 165) });
}

sim("a voice stays on the host that learned it: another host doesn't know it until the person reads there", async () => {
  const anaA = hubA.session.upsertPerson({ name: "Ana" });
  expect(hubA.enrollVoice(anaA.id, wavOf("ana", ENROL_TEXT.ana), hubA.session.store.voiceEpoch())).toMatchObject({ ok: true });
  expect(hubA.audio.voiceprints.count(anaA.id)).toBeGreaterThan(0);
  // Host B has never heard her, and there is no way to bring it there.
  const anaB = hubB.session.upsertPerson({ name: "Ana" });
  hubB.session.upsertPerson({ name: "Ben" });
  expect(hubB.audio.voiceprints.count(anaB.id)).toBe(0);
  for (const method of ["GET", "PUT"]) expect((await fetch(`${url}/api/people/${anaB.id}/voiceprint`, { method, headers: remote })).status).not.toBe(200);
  // A line on host B at a laptop nobody owns: nothing names her yet.
  hubB.session.touchDevice("shared", { kind: "host", location: "room", micOn: true });
  const words = "I think the header should be taller so the logo has some room to breathe.";
  (hubB.audio as any).transcriber = { transcribe: async () => ({ text: words, engine: "stub" }) };
  const hear = async (t: number) => {
    await hubB.audio.ingest({ deviceId: "shared", t0: t, t1: t + 4000, wav: encodeWav({ sampleRate: 16000, samples: say("ana", words, 170) }) });
    await hubB.audio.flush();
  };
  await hear(Date.now() - 60_000);
  expect(hubB.session.store.all("utterances").at(-1)?.personId).not.toBe(anaB.id);
  // She reads on B: from then on B knows her.
  expect(hubB.enrollVoice(anaB.id, wavOf("ana", ENROL_TEXT.ana), hubB.session.store.voiceEpoch())).toMatchObject({ ok: true });
  await hear(Date.now() - 20_000);
  const heard = hubB.session.store.all("utterances").sort((a, b) => a.t0 - b.t0).at(-1)!;
  expect(heard.speakerName).toBe("Ana");
  expect(heard.method).toContain("voice");
}, T);

test("resetting a voice forgets it everywhere it could come back from: samples, the lines' embeddings, what's held", () => {
  const s = hubB.session;
  const p = s.upsertPerson({ name: "Resetter" });
  const v = Array.from({ length: 256 }, (_, i) => Math.cos(i));
  hubB.audio.voiceprints.add(p.id, Float32Array.from(v), "enrol", Date.now());
  const ev = s.store.addEvent({ kind: "speech", authorType: "person", authorId: p.id, authorName: p.name, text: "A line of theirs", data: { embedding: v } });
  const other = s.upsertPerson({ name: "Bystander" });
  const theirs = s.store.addEvent({ kind: "speech", authorType: "person", authorId: other.id, authorName: other.name, text: "Not theirs", data: { embedding: v } });
  const now = Date.now();
  s.store.put("utterances", { id: "utt_reset1", t0: now - 5000, t1: now - 3000, text: "A line of theirs", personId: p.id, speakerName: p.name, confidence: 0.5, method: "voice", deviceId: "d", devices: [], location: "room", eventId: ev.id, engine: "stub" } as any);
  expect(hubB.resetVoice(p.id)).toMatchObject({ ok: true, scrubbed: 1 });
  expect(hubB.audio.voiceprints.count(p.id)).toBe(0);
  expect(s.store.event(ev.id)?.data.embedding).toBeUndefined();
  expect(s.store.event(theirs.id)?.data.embedding).toEqual(v);
  // Correcting their old line to them teaches nothing now.
  expect(hubB.audio.assign("utt_reset1", p.id, { host: true, personId: null }).learning.learned).toBe(false);
  expect(hubB.audio.voiceprints.count(p.id)).toBe(0);
  // What it hears from them afterwards is theirs again.
  expect(hubB.audio.voiceprints.add(p.id, Float32Array.from(v), "enrol", Date.now() + 1)).toBe(true);
});

test("the join read's window closes when the read fails: a refused recording, bad audio, or no microphone", async () => {
  const p = hubB.session.upsertPerson({ name: "Reader" });
  const open = () => (hubB.audio as any).enrolling.get(p.id) as { until: number } | undefined;
  hubB.audio.beginEnrolment(p.id);
  expect(open()!.until).toBeGreaterThan(Date.now() + 60_000);
  // Too quiet: refused, and the window is down to the grace for copies on their way.
  expect(hubB.enrollVoice(p.id, encodeWav({ sampleRate: 16000, samples: new Float32Array(16000 * 4) }), hubB.session.store.voiceEpoch())).toMatchObject({ ok: false });
  expect(open()!.until).toBeLessThanOrEqual(Date.now() + 25_000);
  hubB.audio.beginEnrolment(p.id);
  expect(() => hubB.enrollVoice(p.id, new Uint8Array([1, 2, 3]), hubB.session.store.voiceEpoch())).toThrow();
  expect(open()!.until).toBeLessThanOrEqual(Date.now() + 25_000);
  // Over HTTP: no microphone, so nothing was read: closed at once. Only the person's own window may.
  hubB.audio.beginEnrolment(p.id);
  const mine = hubB.auth.issue({ kind: "browser", label: "Reader's laptop", ip: "10.0.0.9", personId: p.id });
  const someone = hubB.auth.issue({ kind: "browser", label: "Laptop", ip: "10.0.0.10" });
  const end = (token: string) => fetch(`${url}/api/people/${p.id}/voice/end`, { method: "POST", headers: { ...remote, authorization: `Bearer ${token}` }, body: JSON.stringify({ read: false }) });
  expect((await end(someone.token)).status).toBe(403);
  expect(open()).toBeDefined();
  expect((await end(mine.token)).status).toBe(200);
  expect(open()).toBeUndefined();
});

sim("only a person resets or reads for their own voice: not another person, not an agent, not a window with no person", async () => {
  const ana = hubB.session.people().find((p) => p.name === "Ana")!;
  const ben = hubB.session.people().find((p) => p.name === "Ben")!;
  const anaLaptop = hubB.auth.issue({ kind: "browser", label: "Ana's laptop", ip: "10.0.0.6", personId: ana.id });
  const benLaptop = hubB.auth.issue({ kind: "browser", label: "Ben's laptop", ip: "10.0.0.7", personId: ben.id });
  const nobody = hubB.auth.issue({ kind: "browser", label: "Laptop", ip: "10.0.0.8" });
  const agent = hubB.auth.issue({ kind: "agent", label: "Ana's agents", ip: "10.0.0.5", personId: ana.id, ownerDeviceId: anaLaptop.device.id });
  const reset = (token: string | null, id: string) => fetch(`${url}/api/people/${id}/voiceprint`, { method: "DELETE", headers: token ? { ...remote, authorization: `Bearer ${token}` } : remote });
  const before = hubB.audio.voiceprints.count(ana.id);
  expect(before).toBeGreaterThan(0);
  for (const token of [benLaptop.token, agent.token, nobody.token]) expect((await reset(token, ana.id)).status).toBe(403);
  expect((await reset(null, ana.id)).status).toBeGreaterThanOrEqual(401);
  expect(hubB.audio.voiceprints.count(ana.id)).toBe(before);
  // Nobody reads a voice out of the host, Ana included: there is no such route.
  for (const method of ["GET", "PUT"]) expect((await fetch(`${url}/api/people/${ana.id}/voiceprint`, { method, headers: { ...remote, authorization: `Bearer ${anaLaptop.token}` } })).status).toBe(404);
  // Reading aloud and starting a read follow the same rule.
  const read = (token: string, id: string, path: string) => fetch(`${url}/api/people/${id}/${path}`, { method: "POST", headers: { ...remote, authorization: `Bearer ${token}` }, body: path === "voice" ? new Uint8Array(wavOf("ana", ENROL_SCRIPT[0])) : "{}" });
  expect((await read(benLaptop.token, ana.id, "voice/start")).status).toBe(403);
  expect((await read(agent.token, ana.id, "voice/start")).status).toBe(403);
  expect((await read(benLaptop.token, ana.id, "voice")).status).toBe(403);
  expect((await read(anaLaptop.token, ana.id, "voice/start")).status).toBe(200);
});

sim("the host says what to do when voice matching is off", () => {
  const probe = (home: string) => {
    const r = Bun.spawnSync([process.execPath, "-e", `import("${join(import.meta.dir, "../src/audio/voiceprint")}").then((m) => console.log(JSON.stringify(m.voiceprintStatus())))`], {
      env: { ...process.env, JAMSESH_HOME: home, JAMSESH_DATA: join(dir, "probe"), JAMSESH_RESOURCES: "" },
    });
    return JSON.parse(r.stdout.toString().trim().split("\n").pop()!) as { available: boolean; code: string; reason: string; fix: string };
  };
  const empty = mkdtempSync(join(tmpdir(), "jam-nomodel-"));
  const off = probe(empty);
  expect(off.available).toBe(false);
  expect(off.code).toBe("missing-model");
  expect(off.fix).toContain(join(empty, "models", "wespeaker_en.onnx"));
  expect(off.fix).toMatch(/github\.com\/k2-fsa\/sherpa-onnx/);
  // A file that isn't a model: the model is there but doesn't load.
  const broken = mkdtempSync(join(tmpdir(), "jam-badmodel-"));
  Bun.spawnSync(["mkdir", "-p", join(broken, "models")]);
  Bun.write(join(broken, "models", "wespeaker_en.onnx"), "not a model");
  const bad = probe(broken);
  expect(bad.available).toBe(false);
  expect(["load-failed", "missing-library"]).toContain(bad.code);
  expect(bad.fix.length).toBeGreaterThan(20);
  rmSync(empty, { recursive: true, force: true });
  rmSync(broken, { recursive: true, force: true });
});

sim("each speech line records whether it was typed, said to JamSesh, or overheard", async () => {
  const s = hubA.session;
  const ana = s.people().find((p) => p.name === "Ana")!;
  const typed = hubA.typed(ana.id, "put the nav on the big screen", false);
  expect(typed.data.source).toBe("typed");
  const direct = hubA.typed(ana.id, "show the pricing page", true);
  expect(direct.data.source).toBe("typed");
  const u = {
    id: "u_src", t0: Date.now() - 5000, t1: Date.now() - 3000, text: "we should look at the footer", personId: ana.id, speakerName: "Ana", confidence: 0.9, method: "device", deviceId: "x",
    devices: [{ deviceId: "x", level: -20, snr: 20 }], location: "room" as const, eventId: null, engine: "t",
  };
  s.store.put("utterances", u);
  (hubA as any).roomLine(u, true);
  const heard = s.store.recentEvents({ kinds: ["speech"], limit: 5 }).find((e) => e.text === u.text)!;
  expect(heard.data.source).toBe("overheard");
});

sim("people who read the join sentences are in the room's vocabulary", () => {
  const dee = hubA.session.upsertPerson({ name: "Deedee" });
  expect(hubA.enrollVoice(dee.id, wavOf("dee", ENROL_TEXT.dee), hubA.session.store.voiceEpoch())).toMatchObject({ ok: true });
  expect(hubA.transcriber.vocabulary().map((v) => v.term)).toContain("Deedee");
});
