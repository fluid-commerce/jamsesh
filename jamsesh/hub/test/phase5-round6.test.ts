// Phase 5, sixth review: who may change a voice by correcting a line. Synthetic embeddings only; nothing makes sound.
import "./voices.env";
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { voiceprintStatus } from "../src/audio/voiceprint";
import { Hub } from "../src/hub";
import { startHttp } from "../src/http";

const dir = mkdtempSync(join(tmpdir(), "jam-p5r6-"));
const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, "d") });
const server = startHttp(hub, 0);
const base = `http://127.0.0.1:${server.port}`;
afterAll(() => {
  server.stop(true);
  hub.devproxy.stop();
  rmSync(dir, { recursive: true, force: true });
});

const remote = { "x-forwarded-for": "9.9.9.9", "content-type": "application/json" };
const call = (token: string, method: string, path: string, body?: unknown) =>
  fetch(`${base}/api${path}`, { method, headers: { ...remote, authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
const asHostWindow = (method: string, path: string, body?: unknown) =>
  fetch(`${base}/api${path}`, { method, headers: { "content-type": "application/json", cookie: `jam_window=${hub.auth.windows.take(hub.auth.windows.mint())}` }, body: body === undefined ? undefined : JSON.stringify(body) });
const unit = (seed: number) => {
  const v = Array.from({ length: 256 }, (_, i) => Math.sin(i * 0.37 + seed));
  const n = Math.hypot(...v);
  return Float32Array.from(v.map((x) => x / n));
};

let n = 0;
/** A spoken line labelled `personId`, whose voice already taught them (as an automatic sample would have). */
function taughtLine(personId: string, seed: number) {
  const s = hub.session;
  const id = `utt_r6_${++n}`;
  const heardAt = Date.now() - 1000;
  const e = unit(seed);
  const ev = s.store.addEvent({ kind: "speech", authorType: "person", authorId: personId, authorName: s.person(personId)!.name, text: `line ${id}`, data: { utteranceId: id, embedding: [...e], heardAt } });
  s.store.put("utterances", { id, t0: heardAt, t1: heardAt + 2000, text: `line ${id}`, personId, speakerName: s.person(personId)!.name, confidence: 0.8, method: "device", deviceId: "d", devices: [], location: "room", eventId: ev.id, engine: "stub" } as any);
  hub.audio.voiceprints.add(personId, e, "auto", heardAt);
  return { id, eventId: ev.id };
}
const people = (tag: string) => ["Ana", "Bob", "Cam"].map((name) => hub.session.upsertPerson({ name: `${name} ${tag}` }));
const count = (id: string) => hub.audio.voiceprints.count(id);

const voiced = test.skipIf(!voiceprintStatus().available);

voiced("someone else's correction relabels only: the new label learns nothing and the old one keeps its sample", () => {
  const [ana, bob, cam] = people("1");
  const { id } = taughtLine(ana.id, 1);
  const before = count(ana.id);
  const r = hub.audio.assign(id, cam.id, { host: false, personId: bob.id });
  expect(r.utterance).toMatchObject({ personId: cam.id, method: "manual" });
  expect(r.learning).toMatchObject({ learned: false });
  expect((r.learning as { reason: string }).reason).toContain(`only ${cam.name} or the host`);
  expect(count(cam.id)).toBe(0);
  expect(count(ana.id)).toBe(before);
});

voiced("the person named teaches their own voice, but can't take a sample back from the one wrongly labelled", () => {
  const [ana, , cam] = people("2");
  const { id } = taughtLine(ana.id, 2);
  const before = count(ana.id);
  expect(hub.audio.assign(id, cam.id, { host: false, personId: cam.id }).learning).toMatchObject({ learned: true, cleaned: 0 });
  expect(count(cam.id)).toBeGreaterThan(0);
  expect(count(ana.id)).toBe(before);
});

voiced("the person wrongly labelled takes their sample back, without teaching the person they name", () => {
  const [ana, , cam] = people("3");
  const { id } = taughtLine(ana.id, 3);
  const r = hub.audio.assign(id, cam.id, { host: false, personId: ana.id });
  expect(r.learning).toMatchObject({ learned: false });
  expect(count(ana.id)).toBe(0);
  expect(count(cam.id)).toBe(0);
});

voiced("the host's correction does both", () => {
  const [ana, , cam] = people("4");
  const { id } = taughtLine(ana.id, 4);
  expect(hub.audio.assign(id, cam.id, { host: true, personId: null }).learning).toMatchObject({ learned: true });
  expect(count(ana.id)).toBe(0);
  expect(count(cam.id)).toBeGreaterThan(0);
});

voiced("a relabel said aloud to the brain relabels the line and changes no voice", () => {
  const [ana, , cam] = people("5");
  const { id, eventId } = taughtLine(ana.id, 5);
  const before = count(ana.id);
  expect(hub.brain.relabel!(eventId, cam.name)).toContain(`now ${cam.name}'s`);
  expect(hub.session.store.get("utterances", id)).toMatchObject({ personId: cam.id });
  expect(count(cam.id)).toBe(0);
  expect(count(ana.id)).toBe(before);
});

voiced("over HTTP: another paired browser relabels only; the named person's own browser and the host's window teach", async () => {
  const [ana, bob, cam] = people("6");
  const bobs = hub.auth.issue({ kind: "browser", label: "Bob's laptop", ip: "10.0.0.31" });
  const cams = hub.auth.issue({ kind: "browser", label: "Cam's laptop", ip: "10.0.0.32" });
  expect((await call(bobs.token, "POST", "/devices", { deviceId: "d-bob6", personId: bob.id })).status).toBe(200);
  expect((await call(cams.token, "POST", "/devices", { deviceId: "d-cam6", personId: cam.id })).status).toBe(200);
  const first = taughtLine(ana.id, 6);
  const anaBefore = count(ana.id);
  const r = await call(bobs.token, "POST", `/utterances/${first.id}/assign`, { personId: cam.id });
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({ personId: cam.id, learning: { learned: false } });
  expect([count(cam.id), count(ana.id)]).toEqual([0, anaBefore]);
  // Naming a new person by name from someone else's laptop teaches them nothing either.
  const named = await (await call(bobs.token, "POST", `/utterances/${first.id}/assign`, { name: "Dee 6" })).json();
  expect(named.learning).toMatchObject({ learned: false });
  expect(count(named.personId)).toBe(0);

  expect(await (await call(cams.token, "POST", `/utterances/${first.id}/assign`, { personId: cam.id })).json()).toMatchObject({ learning: { learned: true } });
  expect(count(cam.id)).toBeGreaterThan(0);
  const second = taughtLine(ana.id, 7);
  expect(await (await asHostWindow("POST", `/utterances/${second.id}/assign`, { personId: bob.id })).json()).toMatchObject({ personId: bob.id, learning: { learned: true } });
  expect(count(bob.id)).toBeGreaterThan(0);
});
