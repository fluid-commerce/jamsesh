import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bus } from "../src/bus";
import { Hub } from "../src/hub";
import { startHttp } from "../src/http";
import type { BusMessage } from "../src/types";
import { chime, quietRoom, resetSpeechState, speak, speechDecision, trimForSpeech } from "../src/brain/speech";
import { speechSource } from "../src/brain/brain";

const d = (o: Partial<Parameters<typeof speechDecision>[0]>) => speechDecision({ voiceReplies: true, source: "voice", kind: "answer", quietRoom: false, sinceLastMs: 60_000, ...o });

test("spoken questions get spoken answers", () => expect(d({})).toBe("speak"));
test("problems are spoken when asked by voice", () => expect(d({ kind: "problem" })).toBe("speak"));
test("a spoken request is confirmed out loud in a few words", () => {
  expect(d({ kind: "confirm" })).toBe("speak");
  expect(d({ kind: "confirm", source: "recorded" })).toBe("speak");
});
test("typed and overheard confirmations stay text", () => {
  expect(d({ kind: "confirm", source: "typed" })).toBe("text");
  expect(d({ kind: "confirm", source: "ambient" })).toBe("text");
});
test("a quiet room doesn't get confirmations out loud", () => expect(d({ kind: "confirm", quietRoom: true })).toBe("text"));
test("typed requests get text", () => expect(d({ source: "typed" })).toBe("text"));
test("overheard work never makes the brain talk", () => expect(d({ source: "ambient", kind: "problem" })).toBe("text"));
test("a quiet room still gets answers, but not problems", () => {
  expect(d({ quietRoom: true })).toBe("speak");
  expect(d({ quietRoom: true, kind: "problem" })).toBe("text");
});
test("no back-to-back talking", () => expect(d({ sinceLastMs: 1500 })).toBe("text"));
test("voice replies off means text", () => expect(d({ voiceReplies: false })).toBe("text"));
test("quiet notes are recognized", () => {
  expect(quietRoom(["Don't speak out loud unless someone asks a question directly."])).toBe(true);
  expect(quietRoom(["Keep replies short."])).toBe(false);
});
test("spoken replies are two sentences at most", () => expect(trimForSpeech("One. Two! Three? Four.")).toBe("One. Two!"));
test("sources", () => {
  const ev = (data: any) => ({ id: 1, ts: 0, kind: "speech", authorType: "person", authorId: null, authorName: "A", text: "x", relevance: null, workstreamId: null, data }) as any;
  expect(speechSource([ev({ typed: true, direct: true })])).toBe("typed");
  expect(speechSource([ev({ typed: true })])).toBe("ambient");
  expect(speechSource([ev({ recorded: true, direct: true })])).toBe("recorded");
  expect(speechSource([ev({ direct: true })])).toBe("voice");
  expect(speechSource([ev({})])).toBe("ambient");
  expect(speechSource([])).toBe("ambient");
});

import { sameSpecifics } from "../src/brain/brain";
test("decisions that differ in specifics are not duplicates", () => {
  expect(sameSpecifics("Settings header uses option A on both apps", "Settings header uses option B on desktop")).toBe(false);
  expect(sameSpecifics("Mobile nav uses direction A (bottom tabs)", "The mobile navigation will use Option A, bottom tabs")).toBe(true);
  expect(sameSpecifics("Card radius is 16px", "Card radius is 24px")).toBe(false);
  expect(sameSpecifics("Accent is #FF6B4A", "Accent color is #FF6B4A")).toBe(true);
});

describe("silent mode reaches the page", () => {
  const dir = mkdtempSync(join(tmpdir(), "jam-silent-"));
  const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, "hub") });
  const server = startHttp(hub, 0);
  const sent: BusMessage[] = [];
  const off = bus.on((m) => sent.push(m));
  const was = process.env.JAMSESH_SILENT;
  afterAll(() => {
    off();
    if (was === undefined) delete process.env.JAMSESH_SILENT;
    else process.env.JAMSESH_SILENT = was;
    server.stop(true);
    hub.devproxy.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("speak sends text with no audio, chime sends nothing, and the state says silent", async () => {
    process.env.JAMSESH_SILENT = "1";
    resetSpeechState();
    hub.session.updateSettings({ voiceReplies: true });
    sent.length = 0;
    expect(await speak(hub.session, "Two agents are working.", { source: "voice", kind: "answer" })).toBe("spoken");
    chime(hub.session, "dev1");
    expect(sent.filter((m) => m.type === "chime")).toEqual([]);
    expect(sent.filter((m) => m.type === "speak")).toEqual([{ type: "speak", audio: null, mime: "", text: "Two agents are working." }]);
    expect(hub.session.state().session.silent).toBe(true);
    const laptop = hub.auth.issue({ kind: "browser", label: "Laptop", ip: "10.0.0.10" });
    const r = await fetch(`http://127.0.0.1:${server.port}/api/voice-preview`, { method: "POST", headers: { "x-forwarded-for": "9.9.9.9", "content-type": "application/json", authorization: `Bearer ${laptop.token}` }, body: "{}" });
    expect(r.status).toBe(409);
  });

  test("a silent hub never falls back to the Mac's own voice, even outside tests and with no good voice", async () => {
    process.env.JAMSESH_SILENT = "1";
    resetSpeechState();
    hub.session.updateSettings({ voiceReplies: true });
    const spawned: unknown[] = [];
    const realSpawn = Bun.spawn;
    const wasEnv = process.env.NODE_ENV;
    // `say` is guarded by NODE_ENV=test in other runs; here that guard is off, so only the silent flag stands in the way.
    (Bun as any).spawn = (cmd: unknown) => (spawned.push(cmd), { exited: Promise.resolve(0), kill() {} });
    process.env.NODE_ENV = "production";
    sent.length = 0;
    try {
      expect(await speak(hub.session, "Nothing should be said.", { source: "voice", kind: "answer" })).toBe("spoken");
    } finally {
      (Bun as any).spawn = realSpawn;
      if (wasEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = wasEnv;
    }
    expect(spawned).toEqual([]);
    expect(sent.filter((m) => m.type === "speak")).toEqual([{ type: "speak", audio: null, mime: "", text: "Nothing should be said." }]);
  });

  test("without the flag chime still goes out and the state says not silent", () => {
    delete process.env.JAMSESH_SILENT;
    sent.length = 0;
    chime(hub.session, null as any);
    expect(sent.filter((m) => m.type === "chime").length).toBe(1);
    expect(hub.session.state().session.silent).toBe(false);
  });
});
