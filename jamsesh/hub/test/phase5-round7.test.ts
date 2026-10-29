// Phase 5, office review: a person identity is granted only by the host's explicit confirmation of that exact
// person (or, by becomePerson's rule, someone the browser made itself or nobody has been). Every path into
// bindBrowser, the one place a browser credential is given a person. Nothing makes sound.
import "./voices.env";
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../src/hub";
import { startHttp } from "../src/http";
import { encodeWav } from "../src/audio/wav";
import { deflateSync } from "node:zlib";
import { readdirSync, existsSync as exists } from "node:fs";
import { voiceprintStatus } from "../src/audio/voiceprint";

const dir = mkdtempSync(join(tmpdir(), "jam-p5r7-"));
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
const browser = (label: string) => hub.auth.issue({ kind: "browser", label, ip: "10.0.0.20" });
/** A person someone else already holds, and a laptop asking to be them. */
async function asking(name: string) {
  const p = hub.session.upsertPerson({ name });
  const own = browser(`${name}'s laptop`);
  expect((await call(own.token, "POST", "/devices", { deviceId: `d-${name}`, personId: p.id })).status).toBe(200);
  const other = browser(`Someone wanting ${name}`);
  expect((await call(other.token, "POST", "/devices", { deviceId: `d-want-${name}`, personId: p.id })).status).toBe(403);
  return { p, own, other };
}

test("the host's approval names the person it was shown; a request changed since then isn't granted", async () => {
  const lee = await asking("Lee");
  const ray = await asking("Ray");
  // The host is shown "wants Lee"; meanwhile the laptop asks to be Ray instead.
  expect((await call(lee.other.token, "POST", "/devices", { deviceId: `d-want-Lee`, personId: ray.p.id })).status).toBe(403);
  expect(hub.auth.get(lee.other.device.id)?.wants).toBe(ray.p.id);
  const r = await asHostWindow("POST", `/paired/${lee.other.device.id}/allow`, { personId: lee.p.id });
  expect(r.status).toBe(409);
  expect((await r.json()).error).toContain("now asking to be Ray");
  expect(hub.auth.get(lee.other.device.id)?.personId).toBeNull();
  // Ray's own laptop is untouched.
  expect(hub.auth.get(ray.own.device.id)?.personId).toBe(ray.p.id);
});

test("an approval without a person, or with a junk one, grants nothing", async () => {
  const kai = await asking("Kai");
  for (const body of [{}, { personId: null }, { personId: 5 }, { personId: [kai.p.id] }, { personId: "p_nobody" }, undefined]) {
    expect((await asHostWindow("POST", `/paired/${kai.other.device.id}/allow`, body)).status).toBe(409);
    expect(hub.auth.get(kai.other.device.id)?.personId).toBeNull();
  }
  expect(hub.auth.get(kai.own.device.id)?.personId).toBe(kai.p.id);
});

test("a late replay of an approval for a laptop that was disconnected meanwhile grants nothing", async () => {
  const ivy = await asking("Ivy");
  hub.auth.revoke(ivy.other.device.id);
  expect((await asHostWindow("POST", `/paired/${ivy.other.device.id}/allow`, { personId: ivy.p.id })).status).toBe(404);
  expect(hub.auth.get(ivy.own.device.id)?.personId).toBe(ivy.p.id);
});

test("the exact approval grants that person, once; replaying it after changes nothing", async () => {
  const max = await asking("Max");
  expect((await asHostWindow("POST", `/paired/${max.other.device.id}/allow`, { personId: max.p.id })).status).toBe(200);
  expect(hub.auth.get(max.other.device.id)).toMatchObject({ personId: max.p.id, wants: null });
  expect(hub.auth.get(max.own.device.id)).toBeNull();
  // Replayed later: the laptop isn't asking anymore.
  expect((await asHostWindow("POST", `/paired/${max.other.device.id}/allow`, { personId: max.p.id })).status).toBe(404);
});

// ---- each join read has an id: its end and its recording touch only that read (office review round 2: 1, 2)

test("an earlier read's late end can't close a newer read, and a recording is taken only for the open read", async () => {
  const p = hub.session.upsertPerson({ name: "Ren" });
  const ren = browser("Ren's laptop");
  expect((await call(ren.token, "POST", "/devices", { deviceId: "d-ren", personId: p.id })).status).toBe(200);
  const window = () => (hub.audio as any).enrolling.get(p.id) as { read: string; open: boolean; until: number } | undefined;
  const start = async () => (await (await call(ren.token, "POST", `/people/${p.id}/voice/start`, { seq: Bun.nanoseconds() })).json()).read as string;
  const end = (id: unknown, read: boolean) => call(ren.token, "POST", `/people/${p.id}/voice/end`, { read, id });
  const upload = (read: string | null) =>
    fetch(`${base}/api/people/${p.id}/voice?epoch=${hub.session.store.voiceEpoch()}${read === null ? "" : `&read=${read}`}`, { method: "POST", headers: { ...remote, "content-type": "audio/wav", authorization: `Bearer ${ren.token}` }, body: encodeWav({ sampleRate: 16000, samples: new Float32Array(16000 * 4) }) as unknown as BodyInit }).then((r) => r.json());

  const older = await start();
  const newer = await start();
  expect(older).not.toBe(newer);
  // The closed profile's end arrives after the new read began: the new read stays open and held out.
  for (const read of [false, true]) expect((await end(older, read)).status).toBe(200);
  for (const junk of [undefined, 5, "", "read_nope"]) expect((await end(junk, false)).status).toBe(200);
  expect(window()).toMatchObject({ read: newer, open: true });
  expect(window()!.until).toBeGreaterThan(Date.now() + 60_000);
  // The old read's recording, or one naming no read, isn't taken.
  for (const read of [older, null, ""]) expect(await upload(read)).toMatchObject({ ok: false, reason: expect.stringContaining("read was closed") });
  expect(window()).toMatchObject({ read: newer, open: true });
  // The newer read's own recording is heard (too quiet here, so refused for that), which closes it.
  expect(await upload(newer)).toMatchObject({ ok: false, reason: expect.stringContaining("too quiet") });
  expect(window()!.open).toBe(false);
  // Closed by its end (the profile closed while the upload was on its way): the upload arriving after isn't taken.
  const third = await start();
  expect((await end(third, true)).status).toBe(200);
  expect(await upload(third)).toMatchObject({ ok: false, reason: expect.stringContaining("read was closed") });
  // Cancelled (no microphone): the window goes, but only for that read.
  const fourth = await start();
  expect((await end(third, false)).status).toBe(200);
  expect(window()?.read).toBe(fourth);
  expect((await end(fourth, false)).status).toBe(200);
  expect(window()).toBeUndefined();
});

test("an older start that reaches the host after a newer one can't replace it; its cancel and upload touch nothing", async () => {
  const p = hub.session.upsertPerson({ name: "Oda" });
  const oda = browser("Oda's laptop");
  expect((await call(oda.token, "POST", "/devices", { deviceId: "d-oda", personId: p.id })).status).toBe(200);
  const window = () => (hub.audio as any).enrolling.get(p.id) as { read: string; open: boolean; until: number } | undefined;
  // The page began read 1, then (profile reopened) read 2; read 2's start arrives first.
  const newer = await call(oda.token, "POST", `/people/${p.id}/voice/start`, { seq: 2000 });
  const newerRead = (await newer.json()).read;
  const older = await call(oda.token, "POST", `/people/${p.id}/voice/start`, { seq: 1000 });
  expect(older.status).toBe(409);
  expect(window()).toMatchObject({ read: newerRead, open: true });
  // The old controller was cancelled: it never got a read id, so its end names none, and touches nothing.
  expect((await call(oda.token, "POST", `/people/${p.id}/voice/end`, { read: false, id: "" })).status).toBe(200);
  expect(window()).toMatchObject({ read: newerRead, open: true });
  const upload = await fetch(`${base}/api/people/${p.id}/voice?epoch=${hub.session.store.voiceEpoch()}&read=`, { method: "POST", headers: { ...remote, "content-type": "audio/wav", authorization: `Bearer ${oda.token}` }, body: encodeWav({ sampleRate: 16000, samples: new Float32Array(16000 * 4) }) as unknown as BodyInit });
  expect(await upload.json()).toMatchObject({ ok: false, reason: expect.stringContaining("read was closed") });
  expect(window()).toMatchObject({ read: newerRead, open: true });
  // A later start (a newer page order) is taken as usual; so is one after the old read's window ran out.
  const later = await call(oda.token, "POST", `/people/${p.id}/voice/start`, { seq: 3000 });
  expect(later.status).toBe(200);
});

test("the start-order fence outlives the newer read: an older or equal start after it closed, was cancelled or ran out is refused", async () => {
  const p = hub.session.upsertPerson({ name: "Ude" });
  const ude = browser("Ude's laptop");
  expect((await call(ude.token, "POST", "/devices", { deviceId: "d-ude", personId: p.id })).status).toBe(200);
  const start = (seq: unknown, token = ude.token) => call(token, "POST", `/people/${p.id}/voice/start`, { seq });
  const r2000 = await start(2000);
  expect(r2000.status).toBe(200);
  const read = (await r2000.json()).read;
  // Cancelled (no microphone): the window is gone, the fence stays.
  expect((await call(ude.token, "POST", `/people/${p.id}/voice/end`, { read: false, id: read })).status).toBe(200);
  expect((hub.audio as any).enrolling.get(p.id)).toBeUndefined();
  for (const seq of [1000, 2000, undefined, "x", null]) expect([seq, (await start(seq)).status]).toEqual([seq, 409]);
  // Later in the page's order: taken. Left open until its window runs out: an older start is still refused.
  expect((await start(2001)).status).toBe(200);
  const realNow = Date.now;
  Date.now = () => realNow() + 10 * 60_000;
  try {
    expect((await start(1500)).status).toBe(409);
    expect((await start(2002)).status).toBe(200);
  } finally {
    Date.now = realNow;
  }
  // A window's first start needs a real number too: null, false, [], "5" are not 0 (a second credential of Ude's that
  // has made no start yet, so only the seq can refuse it).
  const second = hub.auth.issue({ kind: "browser", label: "Ude's other window", ip: "10.0.0.21", personId: p.id });
  for (const seq of [null, false, [], "5", {}]) expect([seq, (await start(seq, second.token)).status]).toEqual([seq, 409]);
  expect((await start(0, second.token)).status).toBe(200);
});

test("a request whose credential is disconnected while its body is on its way acts as disconnected: it can't start a read over the new laptop's", async () => {
  const p = hub.session.upsertPerson({ name: "Vic" });
  const old = browser("Vic's old laptop");
  expect((await call(old.token, "POST", "/devices", { deviceId: "d-vic-old", personId: p.id })).status).toBe(200);
  // The old laptop's start: headers sent, body held. The host has seen the request (its credential was checked).
  const h = holdBody(old.token, `/people/${p.id}/voice/start`, { "content-type": "application/json" });
  await h.reached;
  const late = h.response;
  const send = h.send;
  // Meanwhile: a new laptop asks to be Vic, the host lets it in (disconnecting the old one), and it starts reading.
  const fresh = browser("Vic's new laptop");
  expect((await call(fresh.token, "POST", "/devices", { deviceId: "d-vic-new", personId: p.id })).status).toBe(403);
  expect((await asHostWindow("POST", `/paired/${fresh.device.id}/allow`, { personId: p.id })).status).toBe(200);
  expect(hub.auth.get(old.device.id)).toBeNull();
  const started = await call(fresh.token, "POST", `/people/${p.id}/voice/start`, { seq: 10 });
  expect(started.status).toBe(200);
  const read = (await started.json()).read;
  send(JSON.stringify({ seq: 9e15 }));
  expect((await late).status).toBe(401);
  expect((hub.audio as any).enrolling.get(p.id)).toMatchObject({ read, open: true });
});


// ---- an adopted late copy is never its line's voice, through the hub's correction and Reset (review round 5)

/**
 * A request whose headers reach the host while its body is held. `reached` resolves once the host has checked its
 * credential (an observable point on the server, not a sleep); `send` delivers the body.
 */
function holdBody(token: string, path: string, headers: Record<string, string>, method = "POST") {
  let send!: (body: string | Uint8Array) => void;
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => void ((ctl = c), (send = (b) => (c.enqueue(typeof b === "string" ? new TextEncoder().encode(b) : b), c.close()))) });
  const check = hub.auth.check.bind(hub.auth);
  let seen!: () => void;
  const reached = new Promise<void>((r) => (seen = r));
  hub.auth.check = ((t: string | null | undefined, ip?: string) => {
    const d = check(t, ip);
    if (t === token) ((hub.auth.check = check), seen());
    return d;
  }) as typeof hub.auth.check;
  // Only the content type given (none when none is): `remote`'s JSON type isn't inherited.
  const sent = { "x-forwarded-for": remote["x-forwarded-for"], ...headers, authorization: `Bearer ${token}` };
  const response = fetch(`${base}/api${path}`, { method, headers: sent, body, duplex: "half" } as RequestInit);
  return { reached, response, send, sent, fail: () => ctl.error(new Error("connection dropped")) };
}

test("audio whose laptop is disconnected while its body is on its way is never heard, whatever its content type", async () => {
  for (const type of [{ "content-type": "audio/wav" }, { "content-type": "text/plain" }, {} as Record<string, string>]) {
    const p = hub.session.upsertPerson({ name: `Ari${Object.values(type).join("")}` });
    const lap = browser("Ari's laptop");
    const dev = `d-ari-${Math.random()}`;
    expect((await call(lap.token, "POST", "/devices", { deviceId: dev, personId: p.id })).status).toBe(200);
    const t0 = Date.now() - 5000;
    const before = hub.audio.pending;
    const ingest = hub.audio.ingest.bind(hub.audio);
    let heard = 0;
    hub.audio.ingest = (async (x: any) => (heard++, ingest(x))) as any;
    try {
      // The credential's second look (api() after the body): it must not come before the body is in.
      const get = hub.auth.get.bind(hub.auth);
      let rechecked = false;
      hub.auth.get = ((id: string | null | undefined) => (id === lap.device.id && (rechecked = true), get(id))) as typeof hub.auth.get;
      const h = holdBody(lap.token, `/audio?deviceId=${dev}&t0=${t0}&t1=${t0 + 3000}&epoch=0`, type);
      expect(Object.keys(h.sent).filter((k) => k.toLowerCase() === "content-type")).toEqual(Object.keys(type));
      await h.reached;
      // Let the host run everything it can without the body (a few turns of its event loop).
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
      hub.auth.get = get as typeof hub.auth.get;
      expect([type, rechecked]).toEqual([type, false]);
      hub.auth.revoke(lap.device.id);
      h.send(encodeWav({ sampleRate: 16000, samples: new Float32Array(16000 * 3).fill(0.1) }));
      expect([type, (await h.response).status]).toEqual([type, 401]);
      expect(heard).toBe(0);
      expect(hub.audio.pending).toBe(before);
    } finally {
      hub.audio.ingest = ingest as any;
    }
  }
});

const RATE = 16000;
const buzz = (pitch: number, rate: number, gain: number, seed: number) => {
  const out = new Float32Array(RATE * 3);
  let r = seed;
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE;
    out[i] = gain * 0.3 * Math.max(0, Math.sin(2 * Math.PI * rate * t)) ** 2 * (Math.sin(2 * Math.PI * pitch * t) + 0.5 * Math.sin(2 * Math.PI * 2 * pitch * t)) + 0.002 * (((r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) - 0.5);
  }
  return encodeWav({ sampleRate: RATE, samples: out });
};

test.skipIf(!voiceprintStatus().available)("a correction or Reset after a late copy was adopted uses the line's own voice sample, never the adopted copy's", async () => {
  const pipeline = hub.audio as any;
  pipeline.transcriber = { transcribe: async () => ({ text: "Ship the header change today.", engine: "stub" }) };
  const ivo = hub.session.upsertPerson({ name: "Ivo" });
  const jun = hub.session.upsertPerson({ name: "Jun" });
  for (const id of ["d-adopt-a", "d-adopt-b"]) hub.session.touchDevice(id, { label: id, micOn: true, location: "room", kind: "client" });
  hub.session.touchDevice("d-adopt-a", { personId: ivo.id });
  const taught: Float32Array[] = [];
  const add = hub.audio.voiceprints.add.bind(hub.audio.voiceprints);
  hub.audio.voiceprints.add = ((pid: string, e: Float32Array, kind: any, at: number) => (pid === jun.id && taught.push(e), add(pid, e, kind, at))) as any;
  const line = async (t0: number) => {
    await hub.audio.ingest({ deviceId: "d-adopt-a", t0, t1: t0 + 3000, wav: buzz(140, 3.5, 1, t0 % 97) });
    await hub.audio.flush();
    const u = hub.session.store.all("utterances").find((x) => x.t0 === t0)!;
    const own = [...(hub.session.store.event(u.eventId!)!.data.embedding as number[])];
    // Its group is let go; a much later copy (the same voice, so the line takes it) is adopted by the line. Its sample
    // is then made unlike the line's: whatever a correction teaches can be told apart.
    pipeline.finalized = [];
    await hub.audio.ingest({ deviceId: "d-adopt-b", t0: t0 + 200, t1: t0 + 3200, wav: buzz(140, 3.5, 0.7, t0 % 89) });
    await hub.audio.flush();
    const g = pipeline.finalized.find((x: any) => x.adopted && x.utteranceId === u.id);
    expect(g).toBeDefined();
    for (const seg of g.segments) seg.embedding = Float32Array.from(own, (x, i) => (i % 2 ? -x : x));
    return { u, own };
  };
  try {
    const t0 = Date.now() - 60_000;
    // After Ivo's Reset scrubbed his line's sample, a correction teaches nobody: the adopted copy doesn't stand in.
    const b = await line(t0);
    expect(b.u.personId).toBe(ivo.id);
    hub.resetVoice(ivo.id);
    const r = hub.audio.assign(b.u.id, jun.id, { host: true, personId: null });
    expect(r.learning.learned).toBe(false);
    expect(taught).toHaveLength(0);
    // Correction by the host: Jun is taught the line's own sample, not the adopted copy's.
    const a = await line(t0 + 10_000);
    hub.audio.assign(a.u.id, jun.id, { host: true, personId: null });
    expect(taught).toHaveLength(1);
    expect([...taught[0]]).toEqual(a.own.map((x) => Math.fround(x)));
  } finally {
    hub.audio.voiceprints.add = add as any;
  }
});

test("a form's file bytes are all read before the credential is checked again (photo and upload)", async () => {
  for (const path of ["photo", "upload"] as const) {
    const p = hub.session.upsertPerson({ name: `Pia ${path}` });
    const lap = browser("Pia's laptop");
    expect((await call(lap.token, "POST", "/devices", { deviceId: `d-pia-${path}`, personId: p.id })).status).toBe(200);
    const form = new FormData();
    const png = new Uint8Array(2048);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    form.append("file", new Blob([png], { type: "image/png" }), "a.png");
    // The order on the host: every Blob read, and the credential's second look (api() after the body).
    const order: string[] = [];
    const get = hub.auth.get.bind(hub.auth);
    const read = Blob.prototype.arrayBuffer;
    hub.auth.get = ((id: string | null | undefined) => (id === lap.device.id && order.push("recheck"), get(id))) as typeof hub.auth.get;
    Blob.prototype.arrayBuffer = function (this: Blob) {
      if (this.size === 2048) order.push("file bytes");
      return read.call(this);
    };
    try {
      const r = await fetch(`${base}/api${path === "photo" ? `/people/${p.id}/photo` : "/upload"}`, { method: "POST", headers: { "x-forwarded-for": "9.9.9.9", authorization: `Bearer ${lap.token}` }, body: form });
      expect(r.status).toBeLessThan(500);
    } finally {
      hub.auth.get = get as typeof hub.auth.get;
      Blob.prototype.arrayBuffer = read;
    }
    expect([path, order.slice(0, 2)]).toEqual([path, ["file bytes", "recheck"]]);
    expect(order.lastIndexOf("file bytes")).toBeLessThan(order.indexOf("recheck"));
  }
});

test("a request whose body doesn't arrive whole runs nothing, and the same key sent again whole runs (not a replayed failure)", async () => {
  const p = hub.session.upsertPerson({ name: "Cy" });
  const lap = browser("Cy's laptop");
  expect((await call(lap.token, "POST", "/devices", { deviceId: "d-cy", personId: p.id })).status).toBe(200);
  const before = hub.session.store.voiceResetAt(p.id);
  const idem = { "content-type": "application/octet-stream", "x-jam-idem": `idem-${Math.random()}` };
  const h = holdBody(lap.token, `/people/${p.id}/voiceprint`, idem, "DELETE");
  await h.reached;
  h.fail();
  const r = await h.response.catch(() => null);
  if (r) expect(r.status).toBe(408);
  await Bun.sleep(0);
  expect(hub.session.store.voiceResetAt(p.id)).toBe(before);
  // The outbox sends it again with the same key, whole this time: it runs.
  const again = await fetch(`${base}/api/people/${p.id}/voiceprint`, { method: "DELETE", headers: { "x-forwarded-for": "9.9.9.9", ...idem, authorization: `Bearer ${lap.token}` }, body: new Uint8Array([1]) });
  expect(again.status).toBe(200);
  expect(again.headers.get("x-jam-idem-replay")).toBeNull();
  expect(hub.session.store.voiceResetAt(p.id)).toBeGreaterThan(before);
});

// ---- images: whole before anything is written; a photo is its own person's; an agent posts from its own machine

/** A real w x h grey PNG. */
function png(w = 2, h = 2, rowsOverride?: Uint8Array) {
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const v = new DataView(out.buffer);
    v.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    v.setUint32(8 + data.length, Bun.hash.crc32(out.subarray(4, 8 + data.length)) >>> 0);
    return out;
  };
  const ihdr = new Uint8Array(13);
  const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, w);
  iv.setUint32(4, h);
  ihdr.set([8, 0, 0, 0, 0], 8);
  const rows = new Uint8Array(h * (w + 1)).fill(128);
  for (let y = 0; y < h; y++) rows[y * (w + 1)] = 0;
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array(deflateSync(rowsOverride ?? rows))), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let at = 0;
  for (const p of parts) (out.set(p, at), (at += p.length));
  return out;
}
const formOf = (bytes: Uint8Array, fields: Record<string, string> = {}) => {
  const f = new FormData();
  f.append("file", new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "image/png" }), "a.png");
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  return f;
};
const post = (token: string | null, path: string, body: BodyInit, headers: Record<string, string> = {}) =>
  fetch(`${base}/api${path}`, { method: "POST", headers: { "x-forwarded-for": "9.9.9.9", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body });
const uploads = () => (exists(hub.uploadsDir) ? readdirSync(hub.uploadsDir).length : 0);

test("a photo is its own person's: another person's laptop can't set it; a broken image is a 400 and writes nothing", async () => {
  const p = hub.session.upsertPerson({ name: "Pat" });
  const q = hub.session.upsertPerson({ name: "Quin" });
  const pat = browser("Pat's laptop");
  const quin = browser("Quin's laptop");
  expect((await call(pat.token, "POST", "/devices", { deviceId: "d-pat", personId: p.id })).status).toBe(200);
  expect((await call(quin.token, "POST", "/devices", { deviceId: "d-quin", personId: q.id })).status).toBe(200);
  const agent = hub.auth.issue({ kind: "agent", label: "Agent", ip: "10.0.0.30" });
  for (const token of [quin.token, agent.token]) expect((await post(token, `/people/${p.id}/photo`, png(), { "content-type": "image/png" })).status).toBe(403);
  const before = uploads();
  const whole = png();
  for (const broken of [whole.slice(0, 2), whole.slice(0, whole.length - 5), whole.slice(0, 40), new Uint8Array([0xff, 0xd8, 0xff, 0xe0])]) expect((await post(pat.token, `/people/${p.id}/photo`, broken, { "content-type": "image/png" })).status).toBe(400);
  // JSON posing as a raw body or form: refused as bad input.
  expect((await call(pat.token, "POST", `/people/${p.id}/photo`, { __raw: { 0: 0x89 }, __files: { file: [0x89] } })).status).toBe(400);
  expect(uploads()).toBe(before);
  expect((await post(pat.token, `/people/${p.id}/photo`, whole, { "content-type": "image/png" })).status).toBe(200);
  expect(hub.session.person(p.id)?.photo).toBeTruthy();
  expect(hub.session.person(q.id)?.photo).toBeFalsy();
});

test("over HTTP an agent posts only as one of its own machine's agents, always as a new item; versions are the host's or jam_post_image's", async () => {
  const mine = hub.auth.issue({ kind: "agent", label: "My agents", ip: "10.0.0.31" });
  const theirs = hub.auth.issue({ kind: "agent", label: "Their agents", ip: "10.0.0.32" });
  const reg = (owner: string, cwd: string, cred: { device: { id: string } }) => hub.session.registerAgent({ ownerName: owner, harness: "claude-code", repo: "r", cwd, machine: hub.auth.machineOf(cred.device.id)!, platform: "desktop" }).agent;
  const a = reg("Me", "/a", mine);
  const a2 = reg("Me", "/a2", mine);
  const b = reg("Them", "/b", theirs);
  const posted = await post(theirs.token, "/upload", formOf(png(), { agent: b.id, title: "Checkout (built)" }));
  expect(posted.status).toBe(200);
  const theirShot = (await posted.json()).id;
  const mineShot = (await (await post(mine.token, "/upload", formOf(png(), { agent: a.id, title: "Nav" }))).json()).id;
  const before = uploads();
  const items = () => hub.session.artifacts().length;
  const count = items();
  // Another machine's agent, nobody's (the room's), an unknown agent, or any replacement: refused, nothing written.
  expect((await post(mine.token, "/upload", formOf(png(), { agent: b.id }))).status).toBe(403);
  expect((await post(mine.token, "/upload", formOf(png(), {}))).status).toBe(403);
  expect((await post(mine.token, "/upload", formOf(png(), { agent: "agent_nobody" }))).status).toBe(404);
  for (const replaces of [theirShot, mineShot]) expect((await post(mine.token, "/upload", formOf(png(), { agent: a2.id, replaces }))).status).toBe(403);
  expect(uploads()).toBe(before);
  expect(items()).toBe(count);
  // The same title from another agent on the same machine is a new item, not a version of a's.
  const same = await (await post(mine.token, "/upload", formOf(png(), { agent: a2.id, title: "Nav" }))).json();
  expect(same.id).not.toBe(mineShot);
  expect(hub.session.store.get("artifacts", mineShot)?.version ?? 1).toBe(1);
  // The host's window may post for any agent and make versions; a replacement that names nothing writes nothing.
  const win = () => `jam_window=${hub.auth.windows.take(hub.auth.windows.mint())}`;
  const asHost = (form: FormData) => fetch(`${base}/api/upload`, { method: "POST", headers: { cookie: win() }, body: form });
  const filesBefore = uploads();
  expect((await asHost(formOf(png(), { agent: b.id, replaces: "art_nothing" }))).status).toBe(400);
  expect(uploads()).toBe(filesBefore);
  expect((await asHost(formOf(png(), { agent: b.id, replaces: theirShot }))).status).toBe(200);
  expect(hub.session.store.get("artifacts", theirShot)?.version).toBe(2);
});

test("an image with no picture in it (a PNG without image data, a JPEG without a scan) is a 400 for a photo and an upload", async () => {
  const p = hub.session.upsertPerson({ name: "Nel" });
  const lap = browser("Nel's laptop");
  expect((await call(lap.token, "POST", "/devices", { deviceId: "d-nel", personId: p.id })).status).toBe(200);
  const whole = png();
  // Drop the IDAT chunk: IHDR (8+25 bytes) then IEND (last 12).
  const noData = new Uint8Array([...whole.subarray(0, 33), ...whole.subarray(whole.length - 12)]);
  // Right chunks and CRCs, but image data with too few pixels for its size.
  const fewPixels = png(2, 2, new Uint8Array(3));
  const jpegNoScan = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0, 0xff, 0xd9]);
  const jpegEmptyScan = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0, 0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0, 0xff, 0xd9]);
  const before = uploads();
  for (const broken of [noData, fewPixels, jpegNoScan, jpegEmptyScan]) {
    expect((await post(lap.token, `/people/${p.id}/photo`, broken, { "content-type": "image/png" })).status).toBe(400);
  }
  const agentCred = hub.auth.issue({ kind: "agent", label: "Nel's agents", ip: "10.0.0.33" });
  const ag = hub.session.registerAgent({ ownerName: "Nel", harness: "claude-code", repo: "r", cwd: "/n", machine: hub.auth.machineOf(agentCred.device.id)!, platform: "desktop" }).agent;
  for (const broken of [noData, fewPixels, jpegNoScan, jpegEmptyScan]) expect((await post(agentCred.token, "/upload", formOf(broken, { agent: ag.id }))).status).toBe(400);
  expect(uploads()).toBe(before);
});

test("a form that arrived whole but is broken is a 400 (the sender's error), not a 408 to retry", async () => {
  const lap = browser("Form laptop");
  const r = await post(lap.token, "/upload", "--x\r\nnot a form at all", { "content-type": "multipart/form-data; boundary=zzz" });
  expect(r.status).toBe(400);
});

test("a photo or upload whose laptop is disconnected while it's on its way saves nothing", async () => {
  for (const path of ["photo", "upload"] as const) {
    const p = hub.session.upsertPerson({ name: `Rev ${path}` });
    const lap = browser("Rev's laptop");
    expect((await call(lap.token, "POST", "/devices", { deviceId: `d-rev-${path}`, personId: p.id })).status).toBe(200);
    const encoded = new Response(formOf(png()));
    const bytes = new Uint8Array(await encoded.arrayBuffer());
    const before = uploads();
    const h = holdBody(lap.token, path === "photo" ? `/people/${p.id}/photo` : "/upload", { "content-type": encoded.headers.get("content-type")! });
    await h.reached;
    hub.auth.revoke(lap.device.id);
    h.send(bytes);
    expect([path, (await h.response).status]).toEqual([path, 401]);
    expect(uploads()).toBe(before);
    expect(hub.session.person(p.id)?.photo).toBeFalsy();
  }
});
