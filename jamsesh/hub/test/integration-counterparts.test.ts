// Where phase 4's task cards meet phases 1 and 2: a comparison card names who it compares with, and a reassigned task
// carries exactly the files it was approved with.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "../src/session";
import { Store } from "../src/store";

const dir = mkdtempSync(join(tmpdir(), "jam-int-cp-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function room() {
  const s = new Session(new Store(mkdtempSync(join(dir, "s-"))));
  const reg = (owner: string) => s.registerAgent({ ownerName: owner, harness: "claude-code", repo: `acme/${owner}`, cwd: `/${owner}`, machine: "m1", platform: "desktop" }).agent;
  return { s, a: reg("Ana"), b: reg("Ben"), c: reg("Cy") };
}

test("the same comparison with a different partner is another card, and editing the targets drops the old partners", () => {
  const { s, a, b, c } = room();
  const one = s.proposeTask({ text: "Compare the navigation", mode: "coordinate", targets: [a.id], counterparts: [b.id], by: "Chey" })!;
  const two = s.proposeTask({ text: "Compare the navigation", mode: "coordinate", targets: [a.id], counterparts: [c.id], by: "Chey" })!;
  expect(two.id).not.toBe(one.id);
  expect(two.counterparts).toEqual([c.id]);
  const edited = s.board.edit(one.id, { targets: [b.id] }, "Chey");
  expect(edited.ok && edited.card.counterparts).toBeUndefined();
});

test("a reassigned task carries exactly its approved files, none when it had none", () => {
  const { s, a, b } = room();
  const d = s.createDirective({ text: "Build it", mode: "implement", targets: [a.id], requestedBy: "Chey", attachments: [] });
  s.store.patch("directives", d.id, { reassignOfferedAt: { [a.id]: Date.now() } });
  const moved = s.reassignDirective(d.id, "Chey", b.id)!;
  expect(moved.attachments ?? []).toEqual([]);
});

test("a comparison card sent with no partner left says what to do (409), and partners can be edited", () => {
  const { s, a, b, c } = room();
  const card = s.proposeTask({ text: "Compare checkout", mode: "coordinate", targets: [a.id], counterparts: [b.id], by: "Chey" })!;
  s.removeAgent(b.id);
  const sent = s.board.send(card.id, "Chey");
  expect(sent).toMatchObject({ ok: false, status: 409 });
  expect(s.directives()).toHaveLength(0);
  expect(s.board.edit(card.id, { counterparts: [c.id] }, "Chey")).toMatchObject({ ok: true });
  const ok = s.board.send(card.id, "Chey");
  expect(ok.ok).toBe(true);
  expect(s.directives()[0]).toMatchObject({ targets: [a.id] });
  expect(s.directives()[0].counterparts).toEqual(expect.arrayContaining([c.id]));
});

test("the same comparison asked of the brain with a different partner is not a duplicate", async () => {
  const { s, a, b, c } = room();
  const first = s.createDirective({ text: "Compare the navigation", mode: "coordinate", targets: [a.id], counterparts: [b.id], requestedBy: "Chey" });
  const { Brain } = await import("../src/brain/brain");
  const brain = new Brain(s, {} as any);
  clearInterval((brain as any).digestTimer);
  const tools = (brain as any).tools([], { effects: 0 });
  const out = String(await tools.create_directive.execute({ targets: [a.id], mode: "coordinate", text: "Compare the navigation", rationale: "x", counterparts: [c.id] }, { toolCallId: "t", messages: [] }));
  expect(out).not.toContain("Already sent");
  expect(s.directives().filter((d) => d.id !== first.id)).toHaveLength(1);
});

test("the same pairing written as [partner] or [target, partner] is one comparison to the brain's duplicate check", async () => {
  const { s, a, b } = room();
  s.createDirective({ text: "Compare the settings screen", mode: "coordinate", targets: [a.id], counterparts: [b.id], requestedBy: "Chey" });
  const { Brain } = await import("../src/brain/brain");
  const brain = new Brain(s, {} as any);
  clearInterval((brain as any).digestTimer);
  const tools = (brain as any).tools([], { effects: 0 });
  const out = String(await tools.create_directive.execute({ targets: [a.id], mode: "coordinate", text: "Compare the settings screen", rationale: "x", counterparts: [a.id, b.id] }, { toolCallId: "t", messages: [] }));
  expect(out).toContain("Already sent");
});

test("over HTTP a comparison card whose partner left is recovered by naming a new one, in the edit or in the send", async () => {
  const { Hub } = await import("../src/hub");
  const { startHttp } = await import("../src/http");
  const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, "http") });
  const server = startHttp(hub, 0);
  try {
    const s = hub.session;
    const reg = (owner: string) => s.registerAgent({ ownerName: owner, harness: "claude-code", repo: `acme/${owner}`, cwd: `/${owner}`, machine: "m1", platform: "desktop" }).agent;
    const a = reg("Ana");
    const b = reg("Ben");
    const c = reg("Cy");
    const chey = s.upsertPerson({ name: "Chey" });
    const win = { cookie: `jam_window=${hub.auth.windows.take(hub.auth.windows.mint())}` };
    const call = (method: string, path: string, body: object) => fetch(`http://127.0.0.1:${server.port}/api${path}`, { method, headers: { "content-type": "application/json", ...win }, body: JSON.stringify({ personId: chey.id, ...body }) });
    const card = s.proposeTask({ text: "Compare checkout", mode: "coordinate", targets: [a.id], counterparts: [b.id], by: "Chey" })!;
    s.removeAgent(b.id);
    expect((await call("POST", `/triage/${card.id}/send`, {})).status).toBe(409);
    expect((await call("PATCH", `/triage/${card.id}`, { counterparts: [c.id] })).status).toBe(200);
    expect(s.board.get(card.id)!.counterparts).toEqual([c.id]);
    expect((await call("POST", `/triage/${card.id}/send`, {})).status).toBe(200);
    // Named in the send itself.
    const two = s.proposeTask({ text: "Compare the footer", mode: "coordinate", targets: [a.id], counterparts: [], by: "Chey" })!;
    expect((await call("POST", `/triage/${two.id}/send`, {})).status).toBe(409);
    expect((await call("POST", `/triage/${two.id}/send`, { counterparts: [c.id] })).status).toBe(200);
  } finally {
    server.stop(true);
    hub.devproxy.stop();
    hub.stop();
  }
});

test("a comparison is sent among exactly the approved agents: if one partner left, nothing is sent and the card says so", () => {
  const { s, a, b, c } = room();
  const card = s.proposeTask({ text: "Compare the header", mode: "coordinate", targets: [a.id], counterparts: [b.id, c.id], by: "Chey" })!;
  s.removeAgent(b.id);
  const sent = s.board.send(card.id, "Chey");
  expect(sent).toMatchObject({ ok: false, status: 409 });
  expect((sent as any).error).toContain("Ben");
  expect(s.directives()).toHaveLength(0);
  expect(s.board.get(card.id)).toMatchObject({ status: "open" });
});

test("the brain refuses a comparison whose only partner is an observer", async () => {
  const { s, a } = room();
  const watcher = s.registerAgent({ ownerName: "Rae", harness: "claude-code", repo: "acme/Rae", cwd: "/Rae", machine: "m1", platform: "mobile", role: "observer" }).agent;
  const { Brain } = await import("../src/brain/brain");
  const brain = new Brain(s, {} as any);
  clearInterval((brain as any).digestTimer);
  const tools = (brain as any).tools([], { effects: 0 });
  const out = String(await tools.create_directive.execute({ targets: [a.id], mode: "coordinate", text: "Compare the nav", rationale: "x", counterparts: [watcher.id] }, { toolCallId: "t", messages: [] }));
  expect(out).toContain("another agent to compare with");
  expect(s.directives()).toHaveLength(0);
});

test("a partner chosen by Edit is still named when they leave before Send", () => {
  const { s, a, b, c } = room();
  const card = s.proposeTask({ text: "Compare the footer", mode: "coordinate", targets: [a.id], counterparts: [b.id], by: "Chey" })!;
  expect(s.board.edit(card.id, { counterparts: [c.id] }, "Chey")).toMatchObject({ ok: true });
  s.removeAgent(c.id);
  const sent = s.board.send(card.id, "Chey");
  expect(sent).toMatchObject({ ok: false, status: 409 });
  expect((sent as any).error).toContain("Cy");
});

test("a card keeps only the partners outside its targets, and a target change with the visible partners sends exactly them", () => {
  const { s, a, b, c } = room();
  const card = s.proposeTask({ text: "Compare the tabs", mode: "coordinate", targets: [a.id], counterparts: [a.id, b.id], by: "Chey" })!;
  expect(card.counterparts).toEqual([b.id]);
  // The form, changing the target to Cy, submits the partners it shows (Ben) with it.
  expect(s.board.edit(card.id, { targets: [c.id], counterparts: [b.id] }, "Chey")).toMatchObject({ ok: true });
  expect(s.board.send(card.id, "Chey").ok).toBe(true);
  expect(s.directives()[0].targets).toEqual([c.id]);
  expect([...s.directives()[0].counterparts!].sort()).toEqual([b.id, c.id].sort());
});

test("a comparison among several partners can be repaired when one leaves", () => {
  const { s, a, b, c } = room();
  const card = s.proposeTask({ text: "Compare the list", mode: "coordinate", targets: [a.id], counterparts: [b.id, c.id], by: "Chey" })!;
  s.removeAgent(b.id);
  expect(s.board.send(card.id, "Chey")).toMatchObject({ ok: false, status: 409 });
  expect(s.board.edit(card.id, { counterparts: [c.id] }, "Chey")).toMatchObject({ ok: true });
  expect(s.board.send(card.id, "Chey").ok).toBe(true);
});

test("an older comparison that names nobody is no duplicate of a new one", async () => {
  const { s, a, b } = room();
  const old = s.createDirective({ text: "Compare the sidebar", mode: "coordinate", targets: [a.id], counterparts: [b.id], requestedBy: "Chey" });
  s.store.put("directives", { ...old, counterparts: undefined }); // a record from before comparisons named their partners
  const { Brain } = await import("../src/brain/brain");
  const brain = new Brain(s, {} as any);
  clearInterval((brain as any).digestTimer);
  const tools = (brain as any).tools([], { effects: 0 });
  const out = String(await tools.create_directive.execute({ targets: [a.id], mode: "coordinate", text: "Compare the sidebar", rationale: "x", counterparts: [b.id] }, { toolCallId: "t", messages: [] }));
  expect(out).not.toContain("Already sent");
});

test("Reassign is live only: a click for an agent whose offer is gone cancels nothing", () => {
  const { s, a, b } = room();
  const d = s.createDirective({ text: "Build the page", mode: "implement", targets: [a.id], requestedBy: "Chey" });
  expect(s.reassignDirective(d.id, "Chey", b.id, a.id)).toBeUndefined();
  expect(s.store.get("directives", d.id)!.progress?.[a.id]).not.toBe("cancelled");
});

test("a directive with a mode that doesn't exist is refused, in the session and over HTTP", async () => {
  const { s, a } = room();
  expect(() => s.createDirective({ text: "x", mode: "bogus" as any, targets: [a.id], requestedBy: "Chey" })).toThrow(/mode is one of/);
  const { Hub } = await import("../src/hub");
  const { startHttp } = await import("../src/http");
  const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, "mode") });
  const server = startHttp(hub, 0);
  try {
    const agent = hub.session.registerAgent({ ownerName: "Ana", harness: "claude-code", repo: "acme/a", cwd: "/a", machine: "m1", platform: "desktop" }).agent;
    const win = { cookie: `jam_window=${hub.auth.windows.take(hub.auth.windows.mint())}` };
    const r = await fetch(`http://127.0.0.1:${server.port}/api/directives`, { method: "POST", headers: { "content-type": "application/json", ...win }, body: JSON.stringify({ text: "x", mode: "bogus", targets: [agent.id] }) });
    expect(r.status).toBe(400);
  } finally {
    server.stop(true);
    hub.devproxy.stop();
    hub.stop();
  }
});

test("a live-app utility command is in the helper list while it runs, and a stuck one gives no output to read", async () => {
  const { LiveApps } = await import("../src/liveapps");
  const { HelperRegistry } = await import("../src/children");
  const reg = new HelperRegistry();
  const live = new LiveApps({} as any, reg);
  const running = (live as any).run(["/bin/sh", "-c", "sleep 30"], 20_000) as Promise<{ code: number; out: string }>;
  await Bun.sleep(300);
  expect(reg.size).toBe(1);
  expect(await reg.stopAll(500)).toBe(true);
  expect((await running).code).not.toBe(0);
});

test("the Mac's voice fallback takes its words on stdin, never in the arguments, and stops with the hub", async () => {
  const { speak, resetSpeechState, stopSpeaking } = await import("../src/brain/speech");
  const { Hub } = await import("../src/hub");
  const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, "say") });
  const calls: { cmd: unknown; wrote: string[]; killed: boolean }[] = [];
  const realSpawn = Bun.spawn;
  const was = { silent: process.env.JAMSESH_SILENT, env: process.env.NODE_ENV };
  process.env.JAMSESH_SILENT = "0";
  process.env.NODE_ENV = "production";
  (Bun as any).spawn = (cmd: unknown) => {
    const c = { cmd, wrote: [] as string[], killed: false };
    calls.push(c);
    return { exited: new Promise(() => {}), kill: () => void (c.killed = true), stdin: { write: (x: string) => void c.wrote.push(x), end() {} } };
  };
  try {
    resetSpeechState();
    hub.session.updateSettings({ voiceReplies: true });
    await speak(hub.session, "The password is hunter2.", { source: "voice", kind: "answer" });
    const say = calls.find((c) => Array.isArray(c.cmd) && c.cmd[0] === "say");
    if (process.platform === "darwin") {
      expect(say?.cmd).toEqual(["say"]);
      expect(say?.wrote.join("")).toContain("hunter2");
      stopSpeaking();
      expect(say?.killed).toBe(true);
    }
  } finally {
    (Bun as any).spawn = realSpawn;
    if (was.silent === undefined) delete process.env.JAMSESH_SILENT;
    else process.env.JAMSESH_SILENT = was.silent;
    if (was.env === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = was.env;
    hub.stop();
  }
});

test("a task for an agent that has left is refused, not left open for nobody", () => {
  const { s, a } = room();
  s.removeAgent(a.id);
  expect(() => s.createDirective({ text: "Build it", mode: "implement", targets: [a.id], requestedBy: "Chey" })).toThrow(/no longer in the session/);
  expect(s.directives()).toHaveLength(0);
});

test("once the hub is stopping, a PDF read and an idb companion start nothing", async () => {
  const { HelperRegistry } = await import("../src/children");
  const { pdfText } = await import("../src/attachments");
  const { Companion } = await import("../src/idb");
  const reg = new HelperRegistry();
  void reg.stopAll(50);
  const was = process.env.JAMSESH_PDFTEXT;
  process.env.JAMSESH_PDFTEXT = "/usr/bin/true";
  const realSpawn = Bun.spawn;
  let spawned = 0;
  (Bun as any).spawn = (...a: unknown[]) => (spawned++, (realSpawn as any)(...a));
  try {
    expect(await pdfText("/nonexistent.pdf", 100, reg)).toBe("");
    expect(spawned).toBe(0);
  } finally {
    (Bun as any).spawn = realSpawn;
    if (was === undefined) delete process.env.JAMSESH_PDFTEXT;
    else process.env.JAMSESH_PDFTEXT = was;
  }
  expect(await new Companion("udid", join(dir, "c.sock"), reg).start("/usr/bin/true")).toBe("The hub is stopping.");
});

test("stopping remote access while the router is being asked leaves no mapping, and a retry while it is off is refused", async () => {
  const { Network } = await import("../src/net");
  const n = new Network(join(dir, "net-life"), (async () => new Response("1.2.3.4")) as any);
  (n as any).cfg = { domain: "x.duckdns.org", token: "t", externalPort: 443, internalPort: 4443, enabled: true, staging: false };
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const calls: string[] = [];
  (n as any).mapper = {
    map: async () => (calls.push("map"), await held, { method: "upnp", externalPort: 443 }),
    unmap: async () => void calls.push("unmap"),
  };
  const opening = n.openRouter();
  await Bun.sleep(30);
  const stopping = n.stop();
  release();
  await opening;
  await stopping;
  expect(calls.filter((c) => c === "unmap").length).toBeGreaterThanOrEqual(1);
  expect(calls[calls.length - 1]).toBe("unmap");
  expect((n.status() as any).router.state).toBe("idle");
  (n as any).cfg = { ...(n as any).cfg, enabled: false };
  calls.length = 0;
  await n.openRouter();
  expect(calls).toEqual([]);
});

test("a router lookup that ignores TERM and keeps its output open still ends at its deadline", async () => {
  const { runShort } = await import("../src/hostctl");
  const t0 = Date.now();
  const r = await runShort(["/bin/sh", "-c", "trap '' TERM; (trap '' TERM; sleep 30) & sleep 30"], 600);
  expect(Date.now() - t0).toBeLessThan(15_000);
  expect(r.code).not.toBe(0);
});

test("a retry that arrives while remote access is being turned off maps nothing", async () => {
  const { Network } = await import("../src/net");
  const n = new Network(join(dir, "net-retry"), (async () => new Response("1.2.3.4")) as any);
  (n as any).cfg = { domain: "x.duckdns.org", token: "t", externalPort: 443, internalPort: 4443, enabled: true, staging: false };
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const calls: string[] = [];
  (n as any).mapper = {
    map: async () => (calls.push("map"), await held, { method: "upnp", externalPort: 443 }),
    unmap: async () => void calls.push("unmap"),
  };
  const first = n.openRouter();
  await Bun.sleep(30);
  const stopping = n.stop();
  const retry = n.openRouter(); // arrives while the stop is waiting for the first
  release();
  await Promise.all([first, stopping, retry]);
  expect(calls.filter((c) => c === "map")).toHaveLength(1);
  expect(calls[calls.length - 1]).toBe("unmap");
});

test("a task naming a live agent and one that has left is refused whole, in the session and over HTTP", async () => {
  const { s, a, b } = room();
  s.removeAgent(b.id);
  expect(() => s.createDirective({ text: "Build it", mode: "implement", targets: [a.id, b.id], requestedBy: "Chey" })).toThrow(/no longer in the session/);
  expect(s.directives()).toHaveLength(0);
  const { Hub } = await import("../src/hub");
  const { startHttp } = await import("../src/http");
  const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, "mixed") });
  const server = startHttp(hub, 0);
  try {
    const reg = (o: string) => hub.session.registerAgent({ ownerName: o, harness: "claude-code", repo: `acme/${o}`, cwd: `/${o}`, machine: "m1", platform: "desktop" }).agent;
    const live = reg("Ana");
    const gone = reg("Ben");
    hub.session.removeAgent(gone.id);
    const win = { cookie: `jam_window=${hub.auth.windows.take(hub.auth.windows.mint())}` };
    const r = await fetch(`http://127.0.0.1:${server.port}/api/directives`, { method: "POST", headers: { "content-type": "application/json", ...win }, body: JSON.stringify({ text: "x", mode: "implement", targets: [live.id, gone.id] }) });
    expect(r.status).toBe(409);
    expect(hub.session.directives()).toHaveLength(0);
  } finally {
    server.stop(true);
    hub.devproxy.stop();
    hub.stop();
  }
});
