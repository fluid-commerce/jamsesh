// Regression tests for Astra's second review: A1 (approvals and the host shell), A3 (speaker
// correction target), A5 (what counts as a pass's effect), A8 (host-only brain switch), A10 (dev
// port revocation), A14 (stop cancels queued passes), and the x-jam-host check on mutations.
//   cd jamsesh/hub && JAMSESH_OFFLINE=1 bun test test/astra2-fixes.test.ts
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verdictFor } from "../src/brain/brain";
import { Hub } from "../src/hub";
import { startHttp } from "../src/http";
import type { JamEvent } from "../src/types";
import { makeRoom } from "./bench";

const call = (tools: any, name: string, input: object) => tools[name].execute(input, { toolCallId: "t", messages: [] }) as Promise<string>;
const said = (text: string, ts = Date.now(), over: Partial<JamEvent> = {}) =>
  ({ id: 1, kind: "speech", authorType: "person", authorId: "p1", authorName: "Maya", text, ts, relevance: "work", data: {}, ...over }) as unknown as JamEvent;

/** A room with host control on and one agent's build waiting. */
function roomWithRequest() {
  const r = makeRoom();
  r.hub.session.updateSettings({ hostControl: true });
  const req = r.hub.host.request({ agentId: r.agents.desktop.id, agentName: "Jonathan's Claude", ownerName: "Jonathan", repo: "https://github.com/acme/desktop.git", branch: "main", command: "true" });
  if (typeof req === "string") throw new Error(req);
  // Keep the build itself from running in tests.
  let built = 0;
  (r.hub.host as any).preview = () => ((built += 1), "Building");
  return { r, req, built: () => built };
}

test("A1: unrelated speech doesn't let the model approve a waiting build", async () => {
  const { r, req, built } = roomWithRequest();
  const tools = r.hub.brain.tools([said("what is the join code")], { effects: 0 });
  const out = await call(tools, "decide_host_build", { id: req.id, approve: true });
  expect(out).toContain("keeps waiting");
  expect(r.hub.host.pendingRequests()).toHaveLength(1);
  expect(built()).toBe(0);
  r.stop();
});

test("A1: the person's own words decide, not the model's flag", async () => {
  const { r, req, built } = roomWithRequest();
  const tools = r.hub.brain.tools([said("deny", Date.now() + 10)], { effects: 0 });
  expect(await call(tools, "decide_host_build", { id: req.id, approve: true })).toContain("Denied");
  expect(built()).toBe(0);
  r.stop();
});

test("A1: a broad request with 'open' can't run a shell command or start a build", async () => {
  const { r } = roomWithRequest();
  const host = r.hub.host;
  const ran: string[] = [];
  (host as any).runShell = (c: string) => (ran.push(c), "ran");
  const asked = r.say("chey", "JamSesh, open the nav mockup");
  r.hub.session.store.updateEvent(asked.id, { data: { direct: true, intent: "directive" } });
  const tools = r.hub.brain.tools([asked], { effects: 0 });
  const shell = await call(tools, "host_action", { action: "shell", command: "echo hi" });
  expect(shell).toContain("approve");
  expect(ran).toEqual([]);
  // It waits like a build, and only a person's answer to it runs it.
  const shellReq = host.pendingRequests().find((p) => p.command === "echo hi")!;
  expect(shellReq).toBeTruthy();
  expect(await host.act({ action: "shell", command: "echo hi" })).toContain("only after a person");
  const build = await call(tools, "build_preview", { repo: "https://github.com/acme/web.git", command: "make" });
  // The brain already has a request waiting; either way nothing builds.
  expect(build).not.toContain("Building");
  host.decide(shellReq.id, true, "Chey", Date.now() + 5);
  expect(ran).toEqual(["echo hi"]);
  r.stop();
});

test("A1: with several waiting, an answer has to name the one it means", () => {
  const now = Date.now();
  const a = { id: "build-a", createdAt: now - 1000, agentName: "Sam's Claude", ownerName: "Sam", repo: "https://github.com/acme/ios.git", branch: "main" };
  const b = { id: "build-b", createdAt: now - 1000, agentName: "Ben's Codex", ownerName: "Ben", repo: "https://github.com/acme/web.git", branch: "main" };
  const both = [a, b];
  expect(verdictFor([said("approve")], a, both)).toBeNull();
  expect(verdictFor([said("approve Sam's build")], a, both)?.approve).toBe(true);
  expect(verdictFor([said("approve Sam's build")], b, both)).toBeNull();
  expect(verdictFor([said("deny the web one")], b, both)?.approve).toBe(false);
  expect(verdictFor([said("approve Sam and Ben")], a, both)).toBeNull();
  expect(verdictFor([said("approve Sam's build", now - 5000)], a, both)).toBeNull();
  expect(verdictFor([said("approve Sam's build", now, { kind: "prompt" } as any)], a, both)).toBeNull();
});

test("A5: no_action and refused tools aren't effects of the pass", async () => {
  const r = makeRoom();
  const pass = { effects: 0 };
  const tools = r.hub.brain.tools([said("hm")], pass);
  await call(tools, "no_action", { reason: "banter" });
  await call(tools, "create_directive", { targets: ["nope"], mode: "explore", text: "x", rationale: "y" });
  await call(tools, "show_on_screen", { mode: "spotlight", artifactIds: ["missing"] });
  expect(pass.effects).toBe(0);
  await call(tools, "show_on_screen", { mode: "board" });
  expect(pass.effects).toBe(1);
  r.stop();
});

test("A14: stop() cancels queued passes and tool effects", async () => {
  const r = makeRoom();
  const brain = r.hub.brain as any;
  let release!: () => void;
  const ran: string[] = [];
  void brain.exclusive(() => new Promise<void>((res) => (release = () => (ran.push("first"), res()))));
  const queued = brain.exclusive(async () => ran.push("second"));
  const tools = brain.tools([said("hm")], { effects: 0 });
  while (!release) await new Promise((res) => setTimeout(res, 1));
  r.stop();
  release();
  await queued;
  expect(ran).toEqual(["first"]);
  expect(await call(tools, "show_on_screen", { mode: "board" })).toContain("stopped");
});

// ---- HTTP ----

const dir = mkdtempSync(join(tmpdir(), "jam-astra2-"));
const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, "d") });
const server = startHttp(hub, 0);
const base = `http://127.0.0.1:${server.port}`;
afterAll(() => {
  server.stop(true);
  hub.devproxy.stop();
  hub.brain.stop();
  rmSync(dir, { recursive: true, force: true });
});
const remote = { "x-forwarded-for": "9.9.9.9", "content-type": "application/json" };

test("A3: a speaker correction keeps the person it was corrected to", async () => {
  const maya = hub.session.upsertPerson({ name: "Maya" });
  const felipe = hub.session.upsertPerson({ name: "Felipe" });
  const laptop = hub.auth.issue({ kind: "browser", label: "Maya's laptop", ip: "10.0.0.6", personId: maya.id });
  let target = "";
  (hub.audio as any).assign = (_u: string, pid: string) => ((target = pid), { utterance: { id: _u }, learning: { learned: true } });
  const r = await fetch(`${base}/api/utterances/u1/assign`, { method: "POST", headers: { ...remote, authorization: `Bearer ${laptop.token}` }, body: JSON.stringify({ personId: felipe.id }) });
  expect(r.status).toBe(200);
  expect(target).toBe(felipe.id);
  // Speaking still acts as the window's own person, whatever the request says.
  const say = await fetch(`${base}/api/say`, { method: "POST", headers: { ...remote, authorization: `Bearer ${laptop.token}` }, body: JSON.stringify({ text: "hi there", personId: felipe.id }) });
  expect(((await say.json()) as JamEvent).authorName).toBe("Maya");
});

test("A8: only the host turns the brain off", async () => {
  const laptop = hub.auth.issue({ kind: "browser", label: "Laptop", ip: "10.0.0.7" });
  const r = await fetch(`${base}/api/settings`, { method: "POST", headers: { ...remote, authorization: `Bearer ${laptop.token}` }, body: JSON.stringify({ brainEnabled: false }) });
  expect(r.status).toBe(403);
  expect(hub.session.settings().brainEnabled).toBe(true);
});

test("a change made for another host is refused before it runs; without the header nothing changes", async () => {
  const info = (await (await fetch(`${base}/api/pair/info`)).json()) as { hostId: string };
  const post = (h: Record<string, string>) => fetch(`${base}/api/clock`, { method: "POST", headers: { "content-type": "application/json", ...h }, body: "{}" });
  expect((await post({ "x-jam-host": "someone-else" })).status).toBe(409);
  expect((await post({ "x-jam-host": info.hostId })).status).not.toBe(409);
  expect((await post({})).status).not.toBe(409);
  expect((await fetch(`${base}/api/clock`, { headers: { "x-jam-host": "someone-else" } })).status).toBe(200);
});

test("A10: revoking a device closes its dev sockets and its token stops at once", () => {
  const laptop = hub.auth.issue({ kind: "browser", label: "Laptop", ip: "10.0.0.8" });
  const proxy = hub.devproxy as any;
  const req = () => new Request("http://x/", { headers: { authorization: `Bearer ${laptop.token}` } });
  expect(proxy.who(req(), "10.0.0.8")).toBe(laptop.device.id);
  const closed: number[] = [];
  const mine = { data: { deviceId: laptop.device.id }, close: (c: number) => closed.push(c) };
  const other = { data: { deviceId: "dev_other" }, close: (c: number) => closed.push(-c) };
  proxy.sockets.add(mine);
  proxy.sockets.add(other);
  hub.auth.revoke(laptop.device.id);
  expect(closed).toEqual([4401]);
  expect(proxy.who(req(), "10.0.0.8")).toBeNull();
  proxy.sockets.delete(mine);
  proxy.sockets.delete(other);
});

test("a closed big-screen window stops being a screen at once; main stays, and only the host can say so", async () => {
  // The host's own big-screen windows carry the window key; any other process on the host doesn't.
  const win = () => ({ cookie: `jam_window=${hub.auth.windows.take(hub.auth.windows.mint())}` });
  const json = { "content-type": "application/json" };
  const report = (screen: string, h: Record<string, string> = win()) => fetch(`${base}/api/display`, { method: "POST", headers: { ...json, ...h }, body: JSON.stringify({ screen, width: 1920, height: 1080 }) });
  const ids = () => hub.session.screens().map((x) => x.id);
  expect((await report("screen-3", {})).status).toBe(403);
  expect(ids()).not.toContain("screen-3");
  await report("main");
  await report("screen-2");
  expect(ids()).toContain("screen-2");
  const del = (screen: string, h: Record<string, string> = win()) => fetch(`${base}/api/display`, { method: "DELETE", headers: { ...json, ...h }, body: JSON.stringify({ screen }) });
  await del("screen-2", { "x-forwarded-for": "9.9.9.9" });
  expect((await del("screen-2", {})).status).toBe(403);
  expect(ids()).toContain("screen-2");
  expect((await del("screen-2")).status).toBe(200);
  expect(ids()).not.toContain("screen-2");
  await del("main");
  expect(ids()).toContain("main");
});
