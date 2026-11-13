// Lines that show at once (the first copy of speech, before the room's other laptops have had their time) and the
// "<Name> is talking" indicator. Both are display only: what acts on speech acts once, on the settled line.
import "./dedupe.env";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "bun:test";
import { AudioPipeline } from "../src/audio/pipeline";
import { encodeWav } from "../src/audio/wav";
import { bus } from "../src/bus";
import { Hub } from "../src/hub";
import { startHttp } from "../src/http";
import { Session } from "../src/session";
import { Speaking } from "../src/speaking";
import { Store } from "../src/store";
import type { BusMessage, Utterance } from "../src/types";

const dir = mkdtempSync(join(tmpdir(), "jam-livelines-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Something that sounds like speech to the gate; `gain` is how close the laptop is. */
function speech(seconds: number, seed: number, gain = 1) {
  const n = Math.round(16000 * seconds);
  const out = new Float32Array(n);
  let r = seed;
  const rand = () => ((r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) - 0.5;
  for (let i = 0; i < n; i++) {
    const t = i / 16000;
    const syllable = Math.max(0, Math.sin(2 * Math.PI * 3.5 * t)) ** 2;
    out[i] = gain * 0.3 * syllable * (Math.sin(2 * Math.PI * 140 * t) + 0.5 * Math.sin(2 * Math.PI * 280 * t)) + 0.002 * rand();
  }
  return out;
}

function room(remote: string[] = []) {
  const session = new Session(new Store(mkdtempSync(join(dir, "s-"))));
  const ana = session.upsertPerson({ name: "Ana" });
  const bob = session.upsertPerson({ name: "Bob" });
  for (const id of ["lap-a", "lap-b", "lap-c"]) session.touchDevice(id, { label: id, micOn: true, location: "room", kind: "client" });
  for (const id of remote) session.touchDevice(id, { label: id, micOn: true, location: "remote", kind: "client" });
  session.touchDevice("lap-a", { personId: ana.id });
  session.touchDevice("lap-b", { personId: bob.id });
  const said = new Map<string, string>();
  const transcriber = { transcribe: async (wav: Uint8Array) => ({ text: said.get(String(Bun.hash(wav))) ?? "", engine: "stub" }) } as any;
  const pipeline = new AudioPipeline(session, transcriber);
  const lines: { u: Utterance; isNew: boolean }[] = [];
  pipeline.onLine = (u, isNew) => lines.push({ u, isNew });
  const sent: BusMessage[] = [];
  const off = bus.on((m) => sent.push(m));
  const hear = async (deviceId: string, t0: number, seconds: number, text: string, seed: number, gain = 1) => {
    const wav = encodeWav({ sampleRate: 16000, samples: speech(seconds, seed, gain) });
    said.set(String(Bun.hash(wav)), text);
    await pipeline.ingest({ deviceId, t0, t1: t0 + seconds * 1000, wav });
  };
  const utterances = () => sent.filter((m): m is Extract<BusMessage, { type: "utterance" }> => m.type === "utterance").map((m) => m.utterance);
  return { session, pipeline, hear, lines, sent, utterances, ana, bob, off };
}
const base = () => Date.now() - 120_000;

test("the first copy is shown before the settle window ends, and a better copy updates the same line in place", async () => {
  const r = room();
  const t = base();
  // Three laptops are listening, so the line waits at least 0.7 s for the others' copies.
  expect(r.pipeline.settleMs()).toBeGreaterThanOrEqual(700);
  await r.hear("lap-a", t, 2, "put the pricing page up", 1, 0.2);
  await Bun.sleep(40);
  const early = [...r.session.previews.values()];
  expect(early).toHaveLength(1);
  expect(early[0]).toMatchObject({ text: "put the pricing page up", settled: false, eventId: null });
  // Display only: nothing was stored, and nothing that acts on speech was told.
  expect(r.session.store.all("utterances")).toHaveLength(0);
  expect(r.lines).toHaveLength(0);
  expect(r.pipeline.pending).toBe(1);
  // Bob's laptop hears it far more clearly.
  await r.hear("lap-b", t, 2, "Put the pricing page up.", 2, 1);
  await r.pipeline.flush();
  const stored = r.session.store.all("utterances");
  expect(stored).toHaveLength(1);
  expect(stored[0].id).toBe(early[0].id);
  expect(stored[0].text).toBe("Put the pricing page up.");
  expect(stored[0].speakerName).toBe("Bob");
  expect(stored[0].settled).toBeUndefined();
  expect(stored[0].devices.map((d) => d.deviceId).sort()).toEqual(["lap-a", "lap-b"]);
  expect(r.session.previews.size).toBe(0);
  // Windows saw the same id twice: the early copy, then the settled line.
  const shown = r.utterances().filter((u) => u.id === early[0].id);
  // The early copy (and its labels following the second laptop's copy), then the settled line, all under one id.
  expect(shown.slice(0, -1).every((u) => u.settled === false && u.text === "put the pricing page up")).toBe(true);
  expect(shown.at(-1)).toMatchObject({ text: "Put the pricing page up.", speakerName: "Bob" });
  expect(shown.at(-1)!.settled).toBeUndefined();
  r.off();
});

test("what acts on speech runs once, on the settled line only", async () => {
  const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, "hub") });
  try {
    const s = hub.session;
    for (const id of ["lap-a", "lap-b", "lap-c"]) s.touchDevice(id, { label: id, micOn: true, location: "room", kind: "client" });
    const heard: { text: string; id: number }[] = [];
    (hub.brain as any).hear = (ev: any) => heard.push({ text: ev.text, id: ev.id });
    const said = new Map<string, string>();
    (hub.audio as any).transcriber = { transcribe: async (wav: Uint8Array) => ({ text: said.get(String(Bun.hash(wav))) ?? "", engine: "stub" }) };
    const hear = async (deviceId: string, t0: number, text: string, seed: number, gain: number) => {
      const wav = encodeWav({ sampleRate: 16000, samples: speech(2, seed, gain) });
      said.set(String(Bun.hash(wav)), text);
      await hub.audio.ingest({ deviceId, t0, t1: t0 + 2000, wav });
    };
    const t = base();
    await hear("lap-a", t, "make it blue", 3, 0.2);
    await Bun.sleep(40);
    // The early copy is showing; the brain, the events and the store know nothing of it.
    expect(s.previews.size).toBe(1);
    expect(heard).toHaveLength(0);
    expect(s.store.recentEvents({ limit: 50 }).filter((e) => e.kind === "speech")).toHaveLength(0);
    await hear("lap-b", t, "Make it blue.", 4, 1);
    await hub.audio.flush();
    expect(heard.map((h) => h.text)).toEqual(["Make it blue."]);
    const speechEvents = s.store.recentEvents({ limit: 50 }).filter((e) => e.kind === "speech");
    expect(speechEvents.map((e) => e.text)).toEqual(["Make it blue."]);
    expect(s.previews.size).toBe(0);
    // A late, clearer copy changes the line in place and does not act again.
    await hear("lap-c", t, "Make it blue.", 5, 2);
    await hub.audio.flush();
    expect(heard).toHaveLength(1);
    expect(s.store.all("utterances")).toHaveLength(1);
  } finally {
    hub.devproxy.stop();
  }
});

test("a line the room's rules would drop is never shown early, and one that was shown goes away", async () => {
  const r = room();
  const t = base();
  // The same words from another laptop 1.5 s later: a twin, not a second line. Its early copy isn't shown.
  await r.hear("lap-a", t, 1.5, "Looks good.", 6);
  await r.pipeline.flush();
  await r.hear("lap-b", t + 1500, 1.5, "looks good", 7);
  await Bun.sleep(40);
  expect(r.session.previews.size).toBe(0);
  await r.pipeline.flush();
  expect(r.session.store.all("utterances").map((u) => u.text)).toEqual(["Looks good."]);
  expect(r.lines.filter((l) => l.isNew)).toHaveLength(1);

  // Two such copies while both are still early: one shows, and the line is settled once.
  const q = room();
  const t2 = base() + 30_000;
  await q.hear("lap-a", t2, 1.5, "Ship it today.", 8);
  await q.hear("lap-b", t2 + 1500, 1.5, "ship it today", 9);
  await Bun.sleep(40);
  expect(q.session.previews.size).toBe(1);
  await q.pipeline.flush();
  expect(q.session.store.all("utterances").map((u) => u.text)).toEqual(["Ship it today."]);
  expect(q.lines.filter((l) => l.isNew)).toHaveLength(1);
  expect(q.session.previews.size).toBe(0);
  r.off();
  q.off();
});

test("an echo in the other place is dropped, early copy included", async () => {
  const r = room(["far"]);
  const t = base();
  await r.hear("lap-a", t, 2, "Can everyone see this?", 10, 1);
  await r.pipeline.flush();
  await r.hear("far", t + 200, 2, "can everyone see this", 11, 0.5);
  await Bun.sleep(40);
  expect(r.session.previews.size).toBe(0);
  await r.pipeline.flush();
  expect(r.session.store.all("utterances").map((u) => u.text)).toEqual(["Can everyone see this?"]);
  r.off();
});

test("an early line whose words were nothing at settle time is taken back", async () => {
  const r = room();
  const t = base();
  await r.hear("lap-a", t, 2, "thank you for watching", 12, 0.2);
  await Bun.sleep(40);
  expect(r.session.previews.size).toBe(1);
  // The cleanest copy says nothing at all: no line stands.
  await r.hear("lap-b", t, 2, "", 13, 1);
  await r.pipeline.flush();
  expect(r.session.previews.size).toBe(0);
  expect(r.session.store.all("utterances")).toHaveLength(0);
  expect(r.lines).toHaveLength(0);
  const last = r.utterances().at(-1)!;
  expect(last).toMatchObject({ text: "", settled: true });
  r.off();
});

// ---- who is talking ----

function talk() {
  const session = new Session(new Store(mkdtempSync(join(dir, "t-"))));
  const ana = session.upsertPerson({ name: "Ana" });
  const bob = session.upsertPerson({ name: "Bob" });
  session.touchDevice("a", { label: "a", personId: ana.id, micOn: true, location: "room", kind: "client" });
  session.touchDevice("b", { label: "b", personId: bob.id, micOn: true, location: "room", kind: "client" });
  session.touchDevice("muted", { label: "muted", personId: bob.id, micOn: false, location: "room", kind: "client" });
  session.touchDevice("nobody", { label: "nobody", micOn: true, location: "remote", kind: "client" });
  const speaking = new Speaking(session);
  const msgs: Extract<BusMessage, { type: "talking" }>[] = [];
  const off = bus.on((m) => m.type === "talking" && msgs.push(m));
  return { session, speaking, msgs, ana, bob, done: () => (off(), speaking.stop()) };
}

test("someone talking is shown with their name and colour, and goes when their line shows", async () => {
  const r = talk();
  r.speaking.update("a", true, -30);
  expect(r.msgs.at(-1)!.talkers).toMatchObject([{ personId: r.ana.id, name: "Ana", color: r.ana.color, live: true }]);
  expect(r.msgs.at(-1)!.talkers[0].level).toBeGreaterThan(0.5);
  r.speaking.lineShown({ personId: r.ana.id, devices: [{ deviceId: "a", level: -30, snr: 20 }] } as Utterance);
  await Bun.sleep(230);
  expect(r.msgs.at(-1)!.talkers).toEqual([]);
  r.done();
});

test("with no line, the indicator stays about a second after speech ends, then goes", async () => {
  const r = talk();
  r.speaking.update("a", true, -35);
  r.speaking.update("a", false, -90);
  await Bun.sleep(300);
  expect(r.msgs.at(-1)!.talkers).toMatchObject([{ name: "Ana", live: false }]);
  await Bun.sleep(900);
  expect(r.msgs.at(-1)!.talkers).toEqual([]);
  r.done();
});

test("a muted mic, and a laptop the hub doesn't know, show nothing; an unnamed laptop is Someone", async () => {
  const r = talk();
  r.speaking.update("muted", true, -30);
  r.speaking.update("ghost", true, -30);
  expect(r.msgs).toHaveLength(0);
  r.speaking.update("nobody", true, -30);
  expect(r.msgs.at(-1)!.talkers).toMatchObject([{ name: "Someone", personId: null }]);
  // A mic muted while talking goes at once.
  r.session.touchDevice("nobody", { micOn: false });
  r.speaking.update("nobody", true, -30);
  await Bun.sleep(250);
  expect(r.msgs.at(-1)!.talkers).toEqual([]);
  r.done();
});

test("one talker for a room, the laptop that hears the voice loudest, and at most five updates a second", async () => {
  const r = talk();
  r.speaking.update("a", true, -50);
  r.speaking.update("b", true, -30);
  await Bun.sleep(250);
  expect(r.msgs.at(-1)!.talkers.map((x) => x.name)).toEqual(["Bob"]);
  const before = r.msgs.length;
  const t0 = Date.now();
  for (let i = 0; i < 50; i++) {
    r.speaking.update("b", true, -30 + (i % 7));
    await Bun.sleep(10);
  }
  const seconds = (Date.now() - t0) / 1000;
  expect(r.msgs.length - before).toBeLessThanOrEqual(Math.ceil(seconds * 5) + 1);
  r.done();
});

test("who is talking is never stored", () => {
  const r = talk();
  const before = [r.session.store.recentEvents({ limit: 50 }).length, r.session.store.all("utterances").length, r.session.store.all("devices").length];
  r.speaking.update("a", true, -30);
  r.speaking.update("a", false, -90);
  expect([r.session.store.recentEvents({ limit: 50 }).length, r.session.store.all("utterances").length, r.session.store.all("devices").length]).toEqual(before);
  r.done();
});

test("windows hear who is talking and early lines; agents hear neither", async () => {
  const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, "ws") });
  const server = startHttp(hub, 0);
  try {
    const ana = hub.session.upsertPerson({ name: "Ana" });
    hub.session.touchDevice("dev-ana", { label: "Ana", personId: ana.id, micOn: true, location: "room", kind: "client" });
    const browser = hub.auth.issue({ kind: "browser", label: "Laptop", ip: "10.0.0.6" });
    const agent = hub.auth.issue({ kind: "agent", label: "Agents", ip: "10.0.0.5", ownerDeviceId: "host" });
    const open = (token: string, device?: string) =>
      new Promise<{ ws: WebSocket; got: any[] }>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws${device ? `?device=${device}` : ""}`, { headers: { "x-forwarded-for": "9.9.9.9", authorization: `Bearer ${token}` } } as any);
        const got: any[] = [];
        ws.onmessage = (e) => got.push(JSON.parse(String(e.data)));
        ws.onopen = () => resolve({ ws, got });
        ws.onerror = reject;
      });
    const person = await open(browser.token, "dev-ana");
    const bystander = await open(browser.token);
    const bot = await open(agent.token);
    person.ws.send(JSON.stringify({ type: "speaking", on: true, level: -32 }));
    // The first copy of a line, showing early.
    const early = { id: "utt-x", t0: 1, t1: 2, text: "early words", personId: null, speakerName: "Someone", confidence: 0, method: "unknown", deviceId: "dev-ana", devices: [], location: "room", eventId: null, engine: "stub", settled: false };
    hub.session.previews.set(early.id, early as Utterance);
    bus.send({ type: "utterance", utterance: early as Utterance });
    bus.send({ type: "utterance", utterance: { ...early, id: "utt-y", text: "settled words", settled: undefined } as Utterance });
    await Bun.sleep(300);
    expect(bystander.got.filter((m) => m.type === "talking").at(-1).talkers).toMatchObject([{ name: "Ana" }]);
    expect(bystander.got.filter((m) => m.type === "utterance").map((m) => m.utterance.text)).toEqual(["early words", "settled words"]);
    expect(bot.got.filter((m) => m.type === "talking")).toEqual([]);
    expect(bot.got.filter((m) => m.type === "utterance").map((m) => m.utterance.text)).toEqual(["settled words"]);
    // An agent's state has no early lines either.
    expect(bot.got[0].state.utterances.map((u: Utterance) => u.text)).toEqual([]);
    expect(bystander.got[0].type).toBe("state");
    // Closing the window ends its indicator.
    person.ws.close();
    await Bun.sleep(300);
    expect(bystander.got.filter((m) => m.type === "talking").at(-1).talkers).toEqual([]);
    bystander.ws.close();
    bot.ws.close();
  } finally {
    server.stop(true);
    hub.devproxy.stop();
  }
});
