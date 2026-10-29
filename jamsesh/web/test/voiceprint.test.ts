import "fake-indexeddb/auto";
import { beforeEach, expect, test } from "bun:test";

const { beginRead, endRead, forgetDeviceCopies, deviceCopiesProblem } = await import("../src/shared/voiceprint");
const { VoiceRead } = await import("../src/shared/voiceRead");
let calls: { method: string; path: string; body: any }[] = [];
let reply: (method: string, path: string) => { status: number; body: unknown } = () => ({ status: 200, body: { ok: true } });

beforeEach(() => {
  calls = [];
  reply = () => ({ status: 200, body: { ok: true } });
  (globalThis as any).fetch = async (url: string, init: RequestInit = {}) => {
    const path = String(url).replace(/^\/api/, "");
    const method = init.method ?? "GET";
    calls.push({ method, path, body: typeof init.body === "string" ? JSON.parse(init.body) : init.body });
    const r = reply(method, path);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  };
});

test("starting the join read fails out loud when the host didn't take it, and is never queued for later", async () => {
  reply = () => ({ status: 403, body: { error: "A voice is only for its own person to give." } });
  await expect(beginRead("p2")).rejects.toThrow("A voice is only for its own person to give.");
  (globalThis as any).fetch = async () => {
    throw new TypeError("network down");
  };
  await expect(beginRead("p1")).rejects.toThrow();
  reply = () => ({ status: 200, body: { ok: true } });
  (globalThis as any).fetch = async (url: string, init: RequestInit = {}) => (calls.push({ method: init.method ?? "GET", path: String(url), body: null }), new Response('{"ok":true,"epoch":3}', { status: 200 }));
  // The host's reset epoch, which the recording goes back with.
  await expect(beginRead("p1")).resolves.toBe(3);
  expect(calls.at(-1)).toMatchObject({ method: "POST", path: "/api/people/p1/voice/start" });
});

test("a failed read is ended on the host, never queued, and never throws", async () => {
  await endRead("p1", false);
  expect(calls.at(-1)).toMatchObject({ method: "POST", path: "/people/p1/voice/end", body: { read: false } });
  (globalThis as any).fetch = async () => {
    throw new TypeError("network down");
  };
  await expect(endRead("p1", true)).resolves.toBeUndefined();
});

/** A Storage that behaves like the browser's, for what the module reads and writes. */
function storage(entries: Record<string, string>) {
  const m = new Map(Object.entries(entries));
  return {
    m,
    get length() {
      return m.size;
    },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  };
}

test("copies of a voice that earlier builds kept in the browser are deleted, and nothing else is", () => {
  const s = storage({
    "jamsesh.voiceprint.v1": "{}",
    "jamsesh.voiceprint.v2::p1": '{"samples":[[0.1]]}',
    "jamsesh.voiceCarry": "true",
    "jamsesh.voiceCarry.v2::p1": "true",
    "jamsesh.identity": '{"name":"Ana"}',
    "jamsesh.voiceprintsHint": "x",
    other: "1",
  });
  expect(forgetDeviceCopies(s).removed).toHaveLength(4);
  expect([...s.m.keys()].sort()).toEqual(["jamsesh.identity", "jamsesh.voiceprintsHint", "other"]);
  expect(forgetDeviceCopies(s)).toEqual({ removed: [], left: [] });
  expect(deviceCopiesProblem(() => s)).toBeNull();
});

test("a deletion that throws or does nothing is read back, shown, and tried again until it works (office review 8)", () => {
  const s = storage({ "jamsesh.voiceprint.v2::p1": "{}", "jamsesh.voiceCarry": "true", keep: "1" });
  let mode: "throws" | "ignored" | "works" = "throws";
  const real = s.removeItem;
  s.removeItem = (k: string) => {
    if (mode === "throws") throw new DOMException("denied", "SecurityError");
    if (mode === "works") real(k);
  };
  expect(forgetDeviceCopies(s).left.sort()).toEqual(["jamsesh.voiceCarry", "jamsesh.voiceprint.v2::p1"]);
  expect(deviceCopiesProblem(() => s)).toContain("couldn't be deleted (jamsesh.voiceprint.v2::p1, jamsesh.voiceCarry)");
  mode = "ignored";
  expect(deviceCopiesProblem(() => s)).toContain("couldn't be deleted");
  mode = "works";
  expect(deviceCopiesProblem(() => s)).toBeNull();
  expect([...s.m.keys()]).toEqual(["keep"]);
});

test("blocked storage isn't taken as empty: it is shown as unchecked, and checked once it opens", () => {
  let blocked = true;
  const s = storage({ "jamsesh.voiceprint.v1": "{}" });
  const get = () => {
    if (blocked) throw new DOMException("blocked", "SecurityError");
    return s;
  };
  expect(deviceCopiesProblem(get)).toContain("couldn't be checked");
  const reading = { get length(): number { throw new DOMException("blocked", "SecurityError"); }, key: () => null, removeItem: () => {} };
  expect(deviceCopiesProblem(() => reading as any)).toContain("couldn't be checked");
  blocked = false;
  expect(deviceCopiesProblem(get)).toBeNull();
  expect(s.m.size).toBe(0);
});

// ---- the join read's lifecycle (VoiceRead, what the profile's VoiceEnroll runs), with a fake microphone and recorder

function rig(opts: { begin?: Promise<number>; media?: Promise<MediaStream>; upload?: (wav: ArrayBuffer) => Promise<Response> } = {}) {
  const log: string[] = [];
  const tracks = [{ stopped: false, stop() { this.stopped = true; } }];
  const stream = { getTracks: () => tracks } as unknown as MediaStream;
  const recs: any[] = [];
  const views: string[] = [];
  const deps = {
    beginRead: async () => (log.push("begin"), opts.begin ?? 4),
    endRead: async (_p: string, read: boolean) => void log.push(`end:${read}`),
    getUserMedia: () => (log.push("mic"), opts.media ?? Promise.resolve(stream)),
    recorder: () => {
      const r: any = { state: "inactive", mimeType: "audio/webm", ondataavailable: null, onstop: null, onerror: null };
      r.start = () => ((r.state = "recording"), log.push("record"));
      r.stop = () => {
        r.state = "inactive";
        log.push("stop");
        r.ondataavailable?.({ data: new Blob([new Uint8Array(8)]) });
        r.onstop?.();
      };
      recs.push(r);
      return r;
    },
    toWav: async (b: Blob) => (log.push(`wav:${b.size}`), new ArrayBuffer(44)),
    upload: opts.upload ?? (async (_p: string, epoch: number) => (log.push(`upload:${epoch}`), new Response('{"ok":true,"samples":3}'))),
    maxMs: 45_000,
  };
  const read = new VoiceRead("p1", "Astra", deps, (v) => views.push(v.state));
  return { read, log, tracks, recs, views, stream };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

test("a whole read records, converts, uploads with its epoch, and keeps nothing about the voice on the device", async () => {
  const s = storage({});
  (globalThis as any).localStorage = s;
  try {
    const r = rig();
    await r.read.start();
    expect(r.views.at(-1)).toBe("recording");
    r.read.stop();
    await tick();
    expect(r.log).toEqual(["begin", "mic", "record", "stop", "wav:8", "upload:4"]);
    expect(r.read.view).toMatchObject({ state: "done", msg: "Astra knows your voice." });
    expect(r.tracks[0].stopped).toBe(true);
    expect(r.read.busy).toBe(false);
    expect(s.m.size).toBe(0);
    expect((await indexedDB.databases()).filter((d) => /voice/i.test(d.name ?? ""))).toEqual([]);
  } finally {
    delete (globalThis as any).localStorage;
  }
});

test("a second start while a read is under way is ignored", async () => {
  let open!: (s: MediaStream) => void;
  const r = rig({ media: new Promise((res) => (open = res)) });
  const first = r.read.start();
  void r.read.start();
  await tick();
  open(r.stream);
  await first;
  void r.read.start();
  await tick();
  expect(r.log.filter((x) => x === "begin")).toHaveLength(1);
  expect(r.recs).toHaveLength(1);
});

test("closing the profile while the browser asks for the microphone: the microphone is given back, nothing records, the host hears the end (office review 5)", async () => {
  let open!: (s: MediaStream) => void;
  const r = rig({ media: new Promise((res) => (open = res)) });
  const started = r.read.start();
  await tick();
  r.read.cancel();
  open(r.stream);
  await started;
  await tick();
  expect(r.tracks[0].stopped).toBe(true);
  expect(r.recs).toHaveLength(0);
  expect(r.log).toEqual(["begin", "mic", "end:false"]);
  expect(r.read.busy).toBe(false);
});

test("closing the profile before the host answered the start: the end goes after the start, never before it", async () => {
  let begin!: (n: number) => void;
  const r = rig({ begin: new Promise((res) => (begin = res)) });
  const started = r.read.start();
  await tick();
  r.read.cancel();
  expect(r.log).toEqual(["begin"]);
  begin(2);
  await started;
  expect(r.log).toEqual(["begin", "end:false"]);
});

test("closing the profile while recording: recorder, microphone and timers stop, nothing is uploaded (office review 5)", async () => {
  const r = rig();
  await r.read.start();
  const views = r.views.length;
  r.read.cancel();
  await Bun.sleep(300);
  expect(r.tracks[0].stopped).toBe(true);
  expect(r.recs[0].state).toBe("inactive");
  expect(r.log).toEqual(["begin", "mic", "record", "stop", "end:true"]);
  // The second-counter timer is gone: no update after the cancel.
  expect(r.views.length).toBe(views);
});

test("a refused upload ends the read on the host and says why", async () => {
  const r = rig({ upload: async () => new Response('{"error":"Your voice was reset while you read"}', { status: 409 }) });
  await r.read.start();
  r.read.stop();
  await tick();
  expect(r.log.at(-1)).toBe("end:true");
  expect(r.read.view).toMatchObject({ state: "error", msg: "Your voice was reset while you read" });
});
