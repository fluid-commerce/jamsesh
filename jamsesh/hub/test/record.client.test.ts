// The tidy-then-send flow as the app runs it: the web client's own api() helper (not a
// shortcut to the hub's methods) against a real hub over HTTP.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../src/hub";
import { startHttp } from "../src/http";
import type { RecordNote, Utterance } from "../src/types";

process.env.JAMSESH_SILENT = "1";
const dir = mkdtempSync(join(tmpdir(), "jam-record-client-"));
const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, "d") });
const server = startHttp(hub, 0);
afterAll(() => {
  server.stop(true);
  hub.devproxy.stop();
  hub.stop();
  rmSync(dir, { recursive: true, force: true });
});

// api() calls relative /api paths with the page's cookie; here the host's own window cookie stands in.
const cookie = `jam_window=${hub.auth.windows.take(hub.auth.windows.mint())}`;
const realFetch = globalThis.fetch;
let calls: { path: string; body: any }[] = [];
let drop = 0;
(globalThis as any).fetch = (input: any, init: any = {}) => {
  const url = String(input);
  if (!url.startsWith("/api")) return realFetch(input, init);
  calls.push({ path: url.slice(4), body: init.body ? JSON.parse(init.body) : undefined });
  if (drop > 0 && url.includes("/record/send")) {
    // A lost reply: the hub gets it, the client never hears back.
    drop--;
    return realFetch(`http://127.0.0.1:${server.port}${url}`, { ...init, headers: { ...init.headers, cookie } }).then(() => Promise.reject(new TypeError("network lost")));
  }
  return realFetch(`http://127.0.0.1:${server.port}${url}`, { ...init, headers: { ...init.headers, cookie } });
};
const { api, hub: client } = await import("../../web/src/shared/hub");
const { mergeInto, sendSummary } = await import("../../web/src/shared/notes");
client.deviceId = "mayaLaptop";

const s = hub.session;
const maya = s.upsertPerson({ name: "Maya" });
// The window says which device it is, as the app does on load; that device is then this window's own.
await api("/devices", { deviceId: "mayaLaptop", label: "Maya's laptop", personId: maya.id, micOn: true, location: "room" });
const atlas = s.registerAgent({ ownerName: "Ben", harness: "claude-code", repo: "acme/web", cwd: "/w", machine: "m1", platform: "desktop" }).agent;
const login = s.upsertArtifact({ kind: "screenshot", stage: "built", title: "Login", agentId: atlas.id, image: "/renders/login.png" });
const sketch = s.upsertArtifact({ kind: "screenshot", stage: "built", title: "Sketch", agentId: null, image: "/renders/sketch.png" });

let n = 0;
const say = (text: string, t0: number) => {
  const u: Utterance = { id: `cu${++n}`, t0, t1: t0 + 1200, text, personId: maya.id, speakerName: "Maya", confidence: 0.9, method: "device", deviceId: "mayaLaptop", devices: [{ deviceId: "mayaLaptop", level: -20, snr: 20 }], location: "room", eventId: null, engine: "test" };
  s.store.put("utterances", u);
  (hub as any).roomLine(u, true);
};

test("record, stop, tidy (edit, join, delete), send, and a lost reply is safe to repeat", async () => {
  const t0 = Date.now() - 9000;
  let now: number | null = t0;
  hub.clock = () => now ?? Date.now();
  const started = await api<{ id: string }>("/record/start", { deviceId: "mayaLaptop", personId: maya.id, t0 }, undefined, { queue: false });
  say("the sign in button is tiny", t0 + 500);
  say("and it needs more padding", t0 + 2500);
  say("this one is scribbly", t0 + 5000);
  say("scratch that", t0 + 7000);
  const tgt = (a: { id: string; title: string }) => ({ kind: "artifact", ref: a.id, label: a.title });
  const pointer = [
    { t: t0 + 600, kind: "click", x: 0.5, y: 0.8, target: tgt(login) },
    { t: t0 + 5100, kind: "dwell", x: 0.3, y: 0.3, dur: 900, target: tgt(sketch) },
  ];
  now = t0 + 8500;
  const res = await api<{ ok: boolean; recordingId: string; notes: RecordNote[] }>("/record/stop", { deviceId: "mayaLaptop", recordingId: started.id, personId: maya.id, t1: t0 + 8500, pointer }, undefined, { queue: false, timeoutMs: 15_000 });
  expect(res.ok).toBe(true);
  expect(res.notes.map((x) => x.text)).toEqual(["the sign in button is tiny", "and it needs more padding", "this one is scribbly", "scratch that"]);
  expect(res.notes[0].ownerName).toBe(atlas.name);
  expect(res.notes[2].ownerName).toBeNull();

  // Tidy exactly as the sheet does: fix the words, join the two about the button, drop the one they didn't mean.
  let notes = res.notes.map((x, i) => (i === 0 ? { ...x, text: "the sign in button is too tiny" } : x));
  notes = mergeInto(notes, 1);
  notes = notes.filter((x) => x.text !== "scratch that");
  expect(notes.map((x) => x.text)).toEqual(["the sign in button is too tiny and it needs more padding", "this one is scribbly"]);

  // The first send reaches the hub but its reply is lost; the retry gets the same answer.
  drop = 1;
  await expect(api("/record/send", { recordingId: res.recordingId, personId: maya.id, notes }, undefined, { queue: false, timeoutMs: 5000 })).rejects.toThrow();
  expect(s.directives().length).toBe(1);
  const again = await api<any>("/record/send", { recordingId: res.recordingId, personId: maya.id, notes }, undefined, { queue: false, timeoutMs: 5000 });
  expect(again.ok).toBe(true);
  expect(s.directives().length).toBe(1);
  expect(s.annotations().length).toBe(2);
  expect(sendSummary(again, "Computah").text).toBe(`1 note to ${atlas.name}, 1 note to Computah`);
  expect(s.directives()[0].text).toContain("the sign in button is too tiny and it needs more padding");
  expect(s.directives()[0].text).not.toContain("scratch");
  // Record's calls are never parked in the outbox to replay later.
  expect(calls.filter((c) => c.path.startsWith("/record/")).length).toBeGreaterThanOrEqual(4);
});

test("the client sees the hub's refusals as errors it can show: a screen someone else drives, and an unknown one", async () => {
  s.setStage({ mode: "spotlight", items: [login.id] }, "Ben", "main", { person: { id: s.upsertPerson({ name: "Ben" }).id, name: "Ben" } });
  await expect(api("/record/start", { deviceId: "mayaLaptop", personId: maya.id, t0: Date.now(), screen: "main" }, undefined, { queue: false })).rejects.toThrow(/Ben is driving the big screen/);
  await expect(api("/record/start", { deviceId: "mayaLaptop", personId: maya.id, t0: Date.now(), screen: "nowhere" }, undefined, { queue: false })).rejects.toThrow(/isn't connected/);
  expect(s.recordings()).toEqual([]);
});
