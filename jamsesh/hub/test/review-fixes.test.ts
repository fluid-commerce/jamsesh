// Fixes from the independent review of Phase 1: stage reverts vs live shares, the agent-input tool
// set, brain-name validation, the voice-preview cooldown, and the decisions mark.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bus } from "../src/bus";
import { AGENT_TOOLS, Brain, nameForms } from "../src/brain/brain";
import { Hub } from "../src/hub";
import { hooksOf } from "./hooks";
import { startHttp } from "../src/http";
import { cleanNames } from "../src/names";
import { Session } from "../src/session";
import { Store } from "../src/store";
import type { BusMessage } from "../src/types";

const dir = mkdtempSync(join(tmpdir(), "jam-review-"));
const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, "hub") });
const server = startHttp(hub, 0);
const base = `http://127.0.0.1:${server.port}`;
afterAll(() => {
  server.stop(true);
  hub.devproxy.stop();
  rmSync(dir, { recursive: true, force: true });
});

let sent: BusMessage[] = [];
const off = bus.on((m) => sent.push(m));
afterAll(() => void off());

function room() {
  const s = new Session(new Store(mkdtempSync(join(dir, "s-"))));
  const felipe = s.upsertPerson({ name: "Felipe" });
  s.touchDevice("felipe-laptop", { label: "Felipe's laptop", personId: felipe.id, kind: "client" });
  // The host's big screens are open and reporting.
  for (const [id, screenX] of [["main", 0], ["screen-2", 1920]] as const) s.reportScreen(id, { width: 1920, height: 1080, dpr: 1, screenX, screenY: 0, at: Date.now() });
  return { s, felipe };
}

// ---- the stage revert must not cut a live share ----

test("the revert timer leaves a live share on the screen; once the share ends, reverting resumes", async () => {
  const { s } = room();
  const was = Session.STAGE_REVERT_MS;
  Session.STAGE_REVERT_MS = 40;
  try {
    const sh = s.startShare("felipe-laptop", "screen");
    s.rememberStageFor(sh.id);
    // What the brain's placement makes: an unpinned layout with the share as its tile (main and an extra screen).
    s.setStage({ mode: "layout", layout: { tiles: [{ kind: "screen", shareId: sh.id }] } }, "JamSesh");
    s.setStage({ mode: "layout", layout: { tiles: [{ kind: "screen", shareId: sh.id }] } }, "JamSesh", "screen-2");
    await Bun.sleep(150); // the revert timers fire on their own, nothing is called by hand
    expect(s.store.get("shares", sh.id)?.status).toBe("live");
    expect(s.stage().mode).toBe("layout");
    expect(s.stage("screen-2").mode).toBe("layout");
    s.sweepShares();
    expect(s.store.get("shares", sh.id)?.status).toBe("live");

    // The share ends; the screen goes back to what it showed, and a brought-up screen reverts again.
    s.endShare(sh.id);
    s.setStage({ mode: "layout", layout: { tiles: [{ kind: "feed" }] } }, "JamSesh");
    expect(s.stage().mode).toBe("layout");
    await Bun.sleep(150);
    expect(s.stage().mode).toBe("board");
  } finally {
    Session.STAGE_REVERT_MS = was;
  }
});

test("a share that is not on the stage does not hold a revert", async () => {
  const { s } = room();
  const was = Session.STAGE_REVERT_MS;
  Session.STAGE_REVERT_MS = 40;
  try {
    s.setStage({ mode: "layout", layout: { tiles: [{ kind: "screen", shareId: "sh-gone" }] } }, "JamSesh");
    await Bun.sleep(120);
    expect(s.stage().mode).toBe("board");
  } finally {
    Session.STAGE_REVERT_MS = was;
  }
});

test("an unplaced share stops after its placement window without any stage change", async () => {
  const { s } = room();
  const was = Session.SHARE_PLACE_MS;
  Session.SHARE_PLACE_MS = 60;
  sent = [];
  try {
    const sh = s.startShare("felipe-laptop", "screen");
    await Bun.sleep(250);
    expect(s.store.get("shares", sh.id)?.status).toBe("ended");
    const note = sent.find((m) => m.type === "share-ended" && m.shareId === sh.id);
    expect(note && note.type === "share-ended" && note.text).toContain("wasn't put on the big screen");
  } finally {
    Session.SHARE_PLACE_MS = was;
  }
});

// ---- agent input gets a reduced tool set ----

test("the brain's tools for an agent's words leave out the host, the screen and itself", () => {
  const { s } = room();
  const brain = new Brain(s, {} as any);
  clearInterval((brain as any).digestTimer);
  const full = Object.keys((brain as any).tools([], { effects: 0 }));
  const forAgent = Object.keys((brain as any).tools([], { effects: 0 }, "agent"));
  for (const gone of ["host_action", "set_layout", "show_on_screen", "build_custom_view", "request_share", "set_brain_name", "remember_feedback", "forget_feedback", "decide_host_build", "build_preview"]) {
    expect(full).toContain(gone);
    expect(forAgent).not.toContain(gone);
  }
  expect(forAgent.sort()).toEqual([...AGENT_TOOLS].sort());
});

// ---- brainAliases ----

test("brain aliases are cleaned wherever they come from", () => {
  const { s } = room();
  s.updateSettings({ brainAliases: [1, null, "  Computah  ", "computah", "", "   ", { x: 1 }, "x".repeat(100), ...Array.from({ length: 20 }, (_, i) => `Name ${i}`)] as any });
  const aliases = s.settings().brainAliases;
  expect(aliases[0]).toBe("Computah");
  expect(aliases[1]).toBe("x".repeat(40));
  expect(aliases).toHaveLength(8);
  expect(aliases.every((a) => typeof a === "string" && a.length <= 40)).toBe(true);
  // Junk that was stored before validation existed can't reach the brain either.
  s.store.setSetting("brainAliases", [1, "Jammy", null] as any);
  expect(s.settings().brainAliases).toEqual(["Jammy"]);
  expect(s.isBrainName("jammy")).toBe(true);
  expect(nameForms(s.settings().brainAliases)).toContain("jammy");
  s.updateSettings({ brainAliases: "nope" as any });
  expect(s.settings().brainAliases).toEqual([]);
  s.updateSettings({ brainName: 7 as any });
  expect(s.settings().brainName).toBe("JamSesh");
  expect(cleanNames(undefined)).toEqual([]);
});

test("adding a name keeps the newest eight", () => {
  const { s } = room();
  for (let i = 0; i < 12; i++) s.addBrainName(`Nickname ${String.fromCharCode(97 + i)}${i}`);
  const a = s.settings().brainAliases;
  expect(a).toHaveLength(8);
  expect(a[7]).toBe("Nickname l11");
});

test("posting junk aliases to the API is cleaned, not stored", async () => {
  const laptop = hub.auth.issue({ kind: "browser", label: "Laptop", ip: "10.0.0.9" });
  const r = await fetch(`${base}/api/settings`, { method: "POST", headers: { "x-forwarded-for": "9.9.9.9", "content-type": "application/json", authorization: `Bearer ${laptop.token}` }, body: JSON.stringify({ brainAliases: [1, "Ok", "ok", ""] }) });
  expect(r.status).toBe(200);
  expect(hub.session.settings().brainAliases).toEqual(["Ok"]);
});

// ---- voice preview ----

test("voice previews are limited per device and the voice name has a length cap", async () => {
  const laptop = hub.auth.issue({ kind: "browser", label: "Laptop", ip: "10.0.0.10" });
  const other = hub.auth.issue({ kind: "browser", label: "Other", ip: "10.0.0.11" });
  const post = (token: string, voice: string) => fetch(`${base}/api/voice-preview`, { method: "POST", headers: { "x-forwarded-for": "9.9.9.9", "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ voice }) });
  expect((await post(laptop.token, "x".repeat(200))).status).toBe(400);
  expect((await post(laptop.token, "alloy")).status).not.toBe(429);
  expect((await post(laptop.token, "alloy")).status).toBe(429);
  expect((await post(other.token, "alloy")).status).not.toBe(429);
});

// ---- the decisions mark ----

test("an agent's decisions mark moves to the last decision it was handed", () => {
  const h = new Hub({ canvas: false, whisper: false, dataDir: join(dir, "marks") });
  const s = h.session;
  const nav = s.registerAgent({ ownerName: "Jonathan", harness: "claude-code", repo: "acme/d", cwd: "/d", machine: "m1", platform: "desktop" }).agent;
  const other = s.registerAgent({ ownerName: "Chey", harness: "claude-code", repo: "acme/m", cwd: "/m", machine: "m1", platform: "mobile" }).agent;
  const mine = s.claim(nav.id, "Navigation").workstream;
  const theirs = s.claim(other.id, "Checkout").workstream;
  const add = (text: string, workstreamId: string | null) => s.store.addEvent({ kind: "decision", authorType: "brain", authorName: "Room decision", text, workstreamId, relevance: "work", data: {} });
  const first = add("Nav goes in a sidebar", mine.id);
  add("Checkout is one page", theirs.id);
  const out = JSON.stringify(hooksOf(h).prompt(nav, { prompt: "hi" }));
  expect(out).toContain("sidebar");
  expect(out).not.toContain("Checkout");
  // Other workstreams' decisions are skipped for good, and the mark follows what was handed over
  // once the hook says it passed it on (the next call carries that).
  expect(JSON.stringify(hooksOf(h).prompt(nav, { prompt: "again" }))).not.toContain("sidebar");
  const mark = s.store.setting<number>(`decisionsSeen:${nav.id}`, 0);
  expect(mark).toBeGreaterThanOrEqual(first.id);
  h.devproxy.stop();
});
