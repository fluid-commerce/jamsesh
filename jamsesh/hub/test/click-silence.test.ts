// The rule: JamSesh talks out loud only in answer to something said out loud. A click (a relabel) is answered on screen.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bus } from "../src/bus";
import { resetSpeechState, speak, speechDecision } from "../src/brain/speech";
import { Hub } from "../src/hub";
import { startHttp } from "../src/http";
import type { BusMessage } from "../src/types";

const dir = mkdtempSync(join(tmpdir(), "jam-clicksilence-"));
const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, "d") });
const server = startHttp(hub, 0);
const sent: BusMessage[] = [];
const off = bus.on((m) => sent.push(m));
afterAll(() => {
  off();
  server.stop(true);
  hub.stop();
  rmSync(dir, { recursive: true, force: true });
});

const asHostWindow = (method: string, path: string, body?: unknown) =>
  fetch(`http://127.0.0.1:${server.port}/api${path}`, { method, headers: { "content-type": "application/json", cookie: `jam_window=${hub.auth.windows.take(hub.auth.windows.mint())}` }, body: body === undefined ? undefined : JSON.stringify(body) });

test("a relabel by click (POST /utterances/:id/assign) never speaks, even with voice replies on", async () => {
  resetSpeechState();
  hub.session.updateSettings({ voiceReplies: true });
  const a = hub.session.upsertPerson({ name: "Ana Click" });
  const b = hub.session.upsertPerson({ name: "Bob Click" });
  hub.session.store.put("utterances", { id: "u_click", t0: 1, t1: 2000, text: "hello", personId: a.id, speakerName: a.name, confidence: 0.8, method: "device", deviceId: "d", devices: [], location: "room", eventId: null, engine: "stub" } as any);
  sent.length = 0;
  const r = await asHostWindow("POST", "/utterances/u_click/assign", { personId: b.id });
  expect(r.status).toBe(200);
  await Bun.sleep(30);
  expect(sent.filter((m) => m.type === "speak")).toEqual([]);
  expect(hub.session.store.recentEvents({ kinds: ["brain"], limit: 10 }).every((e) => e.data?.spoken !== true)).toBe(true);
});

test("a spoken request to the brain is still answered out loud", async () => {
  resetSpeechState();
  hub.session.updateSettings({ voiceReplies: true });
  sent.length = 0;
  await speak(hub.session, "Sure, putting it up.", { source: "voice", kind: "answer" });
  expect(sent.filter((m) => m.type === "speak").length).toBe(1);
  expect(speechDecision({ voiceReplies: true, source: "voice", kind: "answer", quietRoom: false, sinceLastMs: 60_000 })).toBe("speak");
});

test("anything that wasn't said out loud is text: typed, overheard, timers", () => {
  const base = { voiceReplies: true, kind: "answer" as const, quietRoom: false, sinceLastMs: 60_000 };
  expect(speechDecision({ ...base, source: "typed" })).toBe("text");
  expect(speechDecision({ ...base, source: "ambient" })).toBe("text");
  expect(speechDecision({ ...base, source: "ambient", kind: "problem" })).toBe("text");
});
