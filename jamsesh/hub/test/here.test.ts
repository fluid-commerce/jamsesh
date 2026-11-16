// A person is "here" when they are in this session: a window open now, or one used since it began, or speech heard or assigned in it.
// The team store keeps everyone the host has ever met; the rest of them are not.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../src/hub";
import type { Utterance } from "../src/types";

process.env.JAMSESH_SILENT = "1";
const dir = mkdtempSync(join(tmpdir(), "jam-here-"));
const hubs: Hub[] = [];
afterAll(() => {
  for (const h of hubs) h.stop();
  rmSync(dir, { recursive: true, force: true });
});

const DAY = 86_400_000;

/** A room whose team store already holds two people from long ago. */
function room() {
  const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, String(Math.random())) });
  hubs.push(hub);
  const s = hub.session;
  const old = (name: string) => {
    const p = s.upsertPerson({ name });
    return s.store.put("people", { ...p, createdAt: Date.now() - 30 * DAY });
  };
  const sam = old("Sam");
  const maya = old("Maya");
  const hereOf = (id: string) => s.state().people.find((p) => p.id === id)?.here;
  return { hub, s, sam, maya, hereOf };
}

test("people from earlier sessions are not here in a fresh session", () => {
  const { s, sam, maya, hereOf } = room();
  expect(hereOf(sam.id)).toBe(false);
  expect(hereOf(maya.id)).toBe(false);
  // Nothing is removed: they are still in the list.
  expect(s.people().map((p) => p.id)).toEqual(expect.arrayContaining([sam.id, maya.id]));
});

test("someone added in this session is here", () => {
  const { s, hereOf } = room();
  expect(hereOf(s.upsertPerson({ name: "Felipe" }).id)).toBe(true);
});

test("a connected window makes its person here, and a device from an earlier session does not", () => {
  const { s, sam, maya, hereOf } = room();
  s.touchDevice("sam-laptop", { label: "Sam's laptop", personId: sam.id, kind: "client" });
  s.deviceOnline = (id) => id === "sam-laptop";
  expect(hereOf(sam.id)).toBe(true);
  // Maya's device was last seen before this session began.
  s.store.put("devices", { id: "maya-phone", label: "Maya's phone", personId: maya.id, kind: "client", location: "room", micOn: false, level: 0, lastSeen: Date.now() - 20 * DAY });
  expect(hereOf(maya.id)).toBe(false);
});

test("speech in this session, or assigned to someone, makes them here", () => {
  const { s, maya, hereOf } = room();
  const u: Utterance = { id: "u1", t0: Date.now(), t1: Date.now() + 1000, text: "hello", personId: null, speakerName: "Someone", confidence: 0.9, method: "device", deviceId: "d", devices: [], location: "room", eventId: null, engine: "test" };
  s.store.put("utterances", u);
  expect(hereOf(maya.id)).toBe(false);
  s.store.put("utterances", { ...u, personId: maya.id });
  expect(hereOf(maya.id)).toBe(true);
});
