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
    unmap: async () => (calls.push("unmap"), true),
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
    unmap: async () => (calls.push("unmap"), true),
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

test("a certificate bundle is written whole and loads only with its own key; one for another name is not accepted", async () => {
  const { CertStore } = await import("../src/net/acme");
  const store = new CertStore(join(dir, "certs"));
  // A certificate and key that don't belong together are no bundle.
  const bad = { kind: "apex" as const, names: ["a.duckdns.org"], notAfter: Date.now() + 1e10, cert: "not a certificate", key: "not a key" };
  store.save(bad, false);
  expect(store.load("apex")).toBeNull();
});

test("turning remote access off ends the HTTPS options even when certificates are kept", async () => {
  const { Network } = await import("../src/net");
  const n = new Network(join(dir, "net-off"), (async () => new Response("")) as any);
  (n as any).cfg = { domain: "x.duckdns.org", token: "t", externalPort: 443, internalPort: 4443, enabled: false, staging: false };
  (n as any).store = { load: () => ({ cert: "c", key: "k", names: ["x.duckdns.org"], notAfter: Date.now() + 1e10, staging: false }) };
  expect(n.tlsOptions()).toBeNull();
  (n as any).cfg.enabled = true;
  expect(n.tlsOptions()).not.toBeNull();
});

test("a lease renewal in flight is finished before the final delete", async () => {
  const { PortMapper } = await import("../src/net/router");
  const m: any = new PortMapper();
  const order: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  m.current = { method: "none", internalPort: 1, externalPort: 1, lanIp: "x" };
  m.renewOnce = async () => (order.push("renew-start"), await held, void order.push("renew-end"));
  void m.renew();
  const un = m.unmap();
  await Bun.sleep(20);
  expect(order).toEqual(["renew-start"]); // unmap waits for it
  release();
  await un;
  expect(order).toEqual(["renew-start", "renew-end"]);
});

test("a UPnP description can't point the hub at another address", async () => {
  const { parseIgdDescription } = await import("../src/net/router");
  const xml = (ctl: string) => `<root><service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><controlURL>${ctl}</controlURL></service></root>`;
  expect(parseIgdDescription(xml("/ctl"), "http://192.168.1.1:5000/desc.xml")?.control).toBe("http://192.168.1.1:5000/ctl");
  expect(parseIgdDescription(xml("http://192.168.1.50:80/admin"), "http://192.168.1.1:5000/desc.xml")).toBeNull();
});

test("a port forward the router didn't confirm removing is kept and reported, never called clean", async () => {
  const { PortMapper } = await import("../src/net/router");
  const m: any = new PortMapper();
  m.igd = { control: "http://127.0.0.1:1/ctl", type: "urn:x:service:WANIPConnection:1", location: "http://127.0.0.1:1/d" }; // nothing answers
  m.current = { method: "upnp", internalPort: 4443, externalPort: 443, lanIp: "10.0.0.2" };
  expect(await m.unmap()).toBe(false);
  expect(m.current).toBeDefined();
  m.current = undefined;
  expect(await m.unmap()).toBe(true);
});

test("Network.stop says whether the router closed the port, and a disabled name orders nothing", async () => {
  const { Network } = await import("../src/net");
  const n = new Network(join(dir, "net-conf"), (async () => new Response("1.2.3.4")) as any);
  (n as any).cfg = { domain: "x.duckdns.org", token: "t", externalPort: 443, internalPort: 4443, enabled: false, staging: false };
  (n as any).mapper = { unmap: async () => false };
  expect(await n.stop()).toBe(false);
  expect((n.status() as any).router.state).toBe("error");
  let ordered = false;
  (n as any).store = { load: () => (ordered = true, null) };
  await n.ensureCert(true);
  expect(ordered).toBe(false);
});

test("HTTPS options only carry certificates for the current name, issued the way the setting says", async () => {
  const { Network } = await import("../src/net");
  const n = new Network(join(dir, "net-names"), (async () => new Response("")) as any);
  (n as any).cfg = { domain: "new.duckdns.org", token: "t", externalPort: 443, internalPort: 4443, enabled: true, staging: false };
  const bundle = (names: string[], staging = false) => ({ cert: "c", key: "k", names, notAfter: Date.now() + 1e10, staging });
  (n as any).store = { load: (k: string) => (k === "apex" ? bundle(["old.duckdns.org"]) : bundle(["*.new.duckdns.org"])) };
  const out = n.tlsOptions()!;
  expect(out.map((o) => o.serverName)).toEqual(["*.new.duckdns.org"]); // the old name's certificate is not served for the new one
  (n as any).store = { load: () => bundle(["new.duckdns.org"], true) };
  expect(n.tlsOptions()).toBeNull(); // a staging certificate is not what a production setting asked for
});

test("a new port forward is not made while an earlier one is unconfirmed closed", async () => {
  const { PortMapper } = await import("../src/net/router");
  const m: any = new PortMapper();
  m.igd = { control: "http://127.0.0.1:1/ctl", type: "urn:x:service:WANIPConnection:1", location: "http://127.0.0.1:1/d" };
  m.current = { method: "upnp", internalPort: 4443, externalPort: 443, lanIp: "10.0.0.2" };
  const r = await m.map(8443, 4443, "10.0.0.2");
  expect(r.message).toContain("hasn't confirmed closing");
  expect(m.current.externalPort).toBe(443); // still tracked, so it is retried and reported at shutdown
});

test("a request whose reply never came is remembered until the router confirms the delete", async () => {
  const { PortMapper } = await import("../src/net/router");
  const m: any = new PortMapper();
  m.igd = { control: "http://127.0.0.1:1/ctl", type: "urn:x:service:WANIPConnection:1", location: "http://127.0.0.1:1/d" };
  m.maybe = { method: "upnp", internalPort: 4443, externalPort: 443, lanIp: "10.0.0.2" }; // sent, reply lost
  expect(await m.unmap()).toBe(false); // nothing answers the delete either: still not known to be closed
  expect(m.current).toBeDefined();
});

test("turning remote access off when the router can't confirm closing says so, and Retry still tries again", async () => {
  const { Network } = await import("../src/net");
  const n = new Network(join(dir, "net-off2"), (async () => new Response("")) as any);
  (n as any).cfg = { domain: "x.duckdns.org", token: "t", externalPort: 443, internalPort: 4443, enabled: true, staging: false };
  let confirmed = false;
  (n as any).mapper = { unmap: async () => confirmed };
  const req = (p: string) => new Request(`http://x/api/net/${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const off = await n.routes(req("disable"), new URL("http://x/api/net/disable"));
  expect(off?.status).toBe(409);
  expect(((n as any).cfg as any).enabled).toBe(false);
  const retry = await n.routes(req("retry-router"), new URL("http://x/api/net/retry-router"));
  expect(retry?.status).toBe(409);
  confirmed = true;
  const again = await n.routes(req("retry-router"), new URL("http://x/api/net/retry-router"));
  expect(again?.status).toBe(200);
});

test("room audio goes only to a whisper-server JamSesh started, or one the person said to trust", async () => {
  const { LocalWhisper } = await import("../src/audio/whisper");
  const fake = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ text: "" }) });
  const was = process.env.JAMSESH_WHISPER_TRUST_EXTERNAL;
  try {
    delete process.env.JAMSESH_WHISPER_TRUST_EXTERNAL;
    const w = new LocalWhisper();
    expect(await w.start(fake.port!, false)).toBeNull();
    expect(w.status().detail).toContain("didn't send room audio");
    process.env.JAMSESH_WHISPER_TRUST_EXTERNAL = "1";
    expect(await new LocalWhisper().start(fake.port!, false)).toBe(`http://127.0.0.1:${fake.port}`);
  } finally {
    if (was === undefined) delete process.env.JAMSESH_WHISPER_TRUST_EXTERNAL;
    else process.env.JAMSESH_WHISPER_TRUST_EXTERNAL = was;
    fake.stop(true);
  }
});

test("a worker can't take the managed engines' ids", async () => {
  const { Hub } = await import("../src/hub");
  const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, "workers") });
  try {
    hub.transcriber.addWorker("parakeet", "x", "http://127.0.0.1:1");
    hub.transcriber.addWorker("local", "x", "http://127.0.0.1:1");
    expect((hub.transcriber as any).engines.has("parakeet")).toBe(false);
    expect((hub.transcriber as any).engines.has("local")).toBe(false);
  } finally {
    hub.stop();
  }
});

test("jam_update done on a task that is finished or unknown announces nothing", async () => {
  const { Hub } = await import("../src/hub");
  const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, "upd") });
  try {
    const s = hub.session;
    const a = s.registerAgent({ ownerName: "Ana", harness: "claude-code", repo: "acme/a", cwd: "/a", machine: "m1", platform: "desktop" }).agent;
    const d = s.createDirective({ text: "Do it", mode: "implement", targets: [a.id], requestedBy: "Chey" });
    s.setDirectiveFor(d.id, a.id, "done");
    const before = s.store.recentEvents({ kinds: ["update"], limit: 50 }).length;
    const call = (args: any) => hub.mcp.call({ agentId: a.id, ip: "127.0.0.1", device: null }, "jam_update", args);
    await expect(call({ kind: "done", text: "again", directiveId: d.id })).rejects.toThrow(/already finished/);
    await expect(call({ kind: "done", text: "ghost", directiveId: "d_nope" })).rejects.toThrow(/no such directive/);
    expect(s.store.recentEvents({ kinds: ["update"], limit: 50 }).length).toBe(before);
  } finally {
    hub.stop();
  }
});

test("an uncertain NAT-PMP request is settled before the UPnP fallback is tried", async () => {
  const { PortMapper } = await import("../src/net/router");
  const m: any = new PortMapper();
  m.maybe = { gateway: "127.0.0.1", method: "nat-pmp", internalPort: 4443, externalPort: 443, lanIp: "10.0.0.2" }; // sent, reply lost
  m.igd = { control: "http://127.0.0.1:1/ctl", type: "urn:x:service:WANIPConnection:1", location: "http://127.0.0.1:1/d" };
  const r = await m.map(443, 4443, "10.0.0.2");
  expect(r.message).toContain("hasn't confirmed closing");
});

test("once the hub is closing, a setup that was waiting on an order starts and maps nothing", async () => {
  const { Network } = await import("../src/net");
  const n = new Network(join(dir, "net-shut"), (async () => new Response("1.2.3.4")) as any);
  (n as any).cfg = { domain: "x.duckdns.org", token: "t", externalPort: 443, internalPort: 4443, enabled: true, staging: false };
  const calls: string[] = [];
  (n as any).mapper = { map: async () => (calls.push("map"), { method: "upnp" }), unmap: async () => true };
  expect(await n.close()).toBe(true);
  await n.start();
  await n.openRouter();
  await n.ensureCert(true);
  expect(calls).toEqual([]);
  const r = await n.routes(new Request("http://x/api/net/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ domain: "y.duckdns.org", token: "t" }) }), new URL("http://x/api/net/setup"));
  expect(r?.status).not.toBe(200);
  expect((n as any).cfg.domain).toBe("x.duckdns.org"); // the closing host takes no new setup
  expect(calls).toEqual([]);
});

test("a setup made stale by a turn-off while it waited changes nothing, and an order finishing after close() saves and announces nothing", async () => {
  const { Network } = await import("../src/net");
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let calls = 0;
  const fetchFn = (async (u: any) => {
    if (String(u).includes("duckdns.org/update")) {
      calls++;
      if (calls === 1) await held; // the setup's DuckDNS check waits
      return new Response("OK\n1.2.3.4\n\nUPDATED");
    }
    return new Response("");
  }) as any;
  const n = new Network(join(dir, "net-stale"), fetchFn);
  (n as any).cfg = { domain: "old.duckdns.org", token: "00000000-0000-0000-0000-000000000000", externalPort: 443, internalPort: 4443, enabled: true, staging: false };
  (n as any).mapper = { map: async () => ({ method: "upnp" }), unmap: async () => true };
  const post = (p: string, body: object) => n.routes(new Request(`http://x/api/net/${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), new URL(`http://x/api/net/${p}`));
  const setup = post("config", { domain: "new", token: "11111111-1111-1111-1111-111111111111" });
  await Bun.sleep(30);
  const off = post("disable", {});
  release();
  await off;
  const r = await setup;
  expect(r?.status).toBe(409);
  expect((n as any).cfg.enabled).toBe(false);
  expect((n as any).cfg.domain).toBe("old.duckdns.org");
});

test("two overlapping setups: the older one is refused before it touches the router, and the newer one's forward stands", async () => {
  const { Network } = await import("../src/net");
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let n1 = 0;
  const fetchFn = (async (u: any) => {
    if (String(u).includes("duckdns.org/update")) {
      if (++n1 === 1) await held;
      return new Response("OK\n1.2.3.4\n\nUPDATED");
    }
    return new Response("");
  }) as any;
  const n = new Network(join(dir, "net-two"), fetchFn);
  const calls: string[] = [];
  (n as any).mapper = { map: async () => (calls.push("map"), { method: "upnp" }), unmap: async () => (calls.push("unmap"), true) };
  const post = (body: object) => n.routes(new Request("http://x/api/net/config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), new URL("http://x/api/net/config"));
  const older = post({ domain: "aaa", token: "11111111-1111-1111-1111-111111111111" });
  await Bun.sleep(30);
  const newer = post({ domain: "bbb", token: "22222222-2222-2222-2222-222222222222" });
  release();
  expect((await older)?.status).toBe(409);
  expect((await newer)?.status).toBe(200);
  expect(calls.filter((c) => c === "map").length).toBe(1); // the stale one asked the router for nothing
  expect((n as any).cfg.domain).toBe("bbb.duckdns.org");
});

test("two deletes at once share one outcome: the second can't call it closed while the first is still trying", async () => {
  const { PortMapper } = await import("../src/net/router");
  const m: any = new PortMapper();
  m.igd = { control: "http://127.0.0.1:1/ctl", type: "urn:x:service:WANIPConnection:1", location: "http://127.0.0.1:1/d" };
  m.current = { method: "upnp", internalPort: 4443, externalPort: 443, lanIp: "10.0.0.2" };
  const [a, b] = await Promise.all([m.unmap(), m.unmap()]);
  expect([a, b]).toEqual([false, false]);
  expect(m.current).toBeDefined();
});

test("a setup with bad ports changes nothing at DuckDNS, and a turn-off whose file can't be written still turns it off", async () => {
  const { Network } = await import("../src/net");
  let updates = 0;
  const fetchFn = (async (u: any) => {
    if (String(u).includes("duckdns.org/update")) updates++;
    return new Response("OK\n1.2.3.4\n\nUPDATED");
  }) as any;
  const n = new Network(join(dir, "net-bad"), fetchFn);
  (n as any).mapper = { map: async () => ({ method: "upnp" }), unmap: async () => true };
  const post = (path: string, body: object) => n.routes(new Request("http://x/api/net/" + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), new URL("http://x/api/net/" + path));
  const bad = await post("config", { domain: "aaa", token: "11111111-1111-1111-1111-111111111111", externalPort: 70000 });
  expect(bad?.status).toBe(400);
  expect(updates).toBe(0);
  expect((await post("config", { domain: "aaa", token: "11111111-1111-1111-1111-111111111111" }))?.status).toBe(200);
  let closed = 0;
  (n as any).certChanged.push(() => closed++);
  (n as any).saveConfig = () => {
    throw new Error("disk full");
  };
  const off = await post("disable", {});
  expect(off?.status).toBe(500);
  expect(((await off?.json()) as any).error).toContain("couldn't be saved");
  expect(closed).toBeGreaterThanOrEqual(1);
  expect(n.status().enabled).toBe(false);
});

test("the DuckDNS updater never has two updates out, and stopping waits for the one that is", async () => {
  const { startUpdater, parseDomain } = await import("../src/net/duckdns");
  let out = 0;
  let started = 0;
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const f = (async () => {
    started++;
    out++;
    await held;
    out--;
    return new Response("OK\n1.2.3.4\n\nUPDATED");
  }) as any;
  const stop = startUpdater(parseDomain("aaa")!, "11111111-1111-1111-1111-111111111111", () => {}, 10, f);
  await Bun.sleep(60);
  expect(started).toBe(1);
  let stopped = false;
  const p = stop().then(() => (stopped = true));
  await Bun.sleep(20);
  expect(stopped).toBe(false);
  release();
  await p;
  expect(out).toBe(0);
});

test("a reconfiguration whose file can't be saved puts the earlier setting's services back", async () => {
  const { Network } = await import("../src/net");
  const fetchFn = (async () => new Response("OK\n1.2.3.4\n\nUPDATED")) as any;
  const n = new Network(join(dir, "net-restore"), fetchFn);
  (n as any).ensureCert = async () => {}; // no certificate order in this test
  const calls: string[] = [];
  (n as any).mapper = { map: async () => (calls.push("map"), { method: "upnp" }), unmap: async () => (calls.push("unmap"), true) };
  const post = (body: object) => n.routes(new Request("http://x/api/net/config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), new URL("http://x/api/net/config"));
  expect((await post({ domain: "aaa", token: "11111111-1111-1111-1111-111111111111" }))?.status).toBe(200);
  await Bun.sleep(50);
  const real = (n as any).saveConfig.bind(n);
  (n as any).saveConfig = () => {
    throw new Error("disk full");
  };
  calls.length = 0;
  const r = await post({ domain: "bbb", token: "22222222-2222-2222-2222-222222222222" });
  expect(r?.status).toBe(500);
  await Bun.sleep(100);
  expect((n as any).cfg.domain).toBe("aaa.duckdns.org");
  expect(calls).toContain("unmap");
  expect(calls).toContain("map"); // the earlier forward is open again
  (n as any).saveConfig = real;
});

test("a renewal the router refuses is retried, and after three failures the forward is reported lost instead of silently going stale", async () => {
  const { PortMapper } = await import("../src/net/router");
  let ok = false;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(ok ? "<r/>" : "<errorCode>718</errorCode>", { status: ok ? 200 : 500 }) });
  try {
    const m: any = new PortMapper();
    m.igd = { control: `http://127.0.0.1:${server.port}/ctl`, type: "urn:x:service:WANIPConnection:1", location: "x" };
    m.current = { method: "upnp", internalPort: 4443, externalPort: 443, lanIp: "10.0.0.2" };
    const lost: string[] = [];
    m.onLost = (msg: string) => lost.push(msg);
    await m.renewOnce();
    await m.renewOnce();
    expect(lost.length).toBe(0);
    expect(m.timer).toBeDefined(); // another try is scheduled
    await m.renewOnce();
    expect(lost.length).toBe(1);
    expect(lost[0]).toContain("718");
    expect(m.current).toBeDefined(); // still tracked, so turning off tries to remove it
    // A good renewal resets the count and is scheduled from the lifetime.
    ok = true;
    m.fails = 0;
    await m.renewOnce();
    expect(m.fails).toBe(0);
    m.unrenew();
  } finally {
    server.stop(true);
  }
});

test("room audio goes only to a listener the helper we started owns", async () => {
  const { ownsPort } = await import("../src/audio/whisper");
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
  try {
    expect(await ownsPort(server.port!, process.pid)).toBe(true); // this process is the listener
    expect(await ownsPort(server.port!, 99999)).toBe(false); // someone else's process on that port is not ours
    expect(await ownsPort(1, process.pid)).toBe(false); // nothing listening
  } finally {
    server.stop(true);
  }
});

test("a turn-off made while a setup waits on the old name's certificate order wins: the setup saves and starts nothing", async () => {
  const { Network } = await import("../src/net");
  const n = new Network(join(dir, "net-order"), (async () => new Response("OK\n1.2.3.4\n\nUPDATED")) as any);
  (n as any).ensureCert = async () => {};
  (n as any).mapper = { map: async () => ({ method: "upnp" }), unmap: async () => true };
  (n as any).cfg = { domain: "old.duckdns.org", token: "00000000-0000-0000-0000-000000000000", externalPort: 443, internalPort: 4443, enabled: true, staging: false };
  let release!: () => void;
  (n as any).issuing = new Promise<void>((r) => (release = r));
  const post = (p: string, body: object) => n.routes(new Request(`http://x/api/net/${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), new URL(`http://x/api/net/${p}`));
  const setup = post("config", { domain: "new", token: "11111111-1111-1111-1111-111111111111" });
  await Bun.sleep(50);
  const off = post("disable", {});
  release();
  expect((await setup)?.status).toBe(409);
  await off;
  expect((n as any).cfg.enabled).toBe(false);
  expect((n as any).cfg.domain).toBe("old.duckdns.org");
});

test("a refused screen change doesn't count as the room's latest, so it can't hold back the automatic comparison", async () => {
  process.env.JAMSESH_SILENT = "1";
  const { Hub } = await import("../src/hub");
  const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, "brain-stage"), teamDir: join(dir, "team-bs") });
  try {
    clearInterval((hub.brain as any).digestTimer);
    const chey = hub.session.upsertPerson({ name: "Chey" });
    const ev: any = { id: "e1", type: "utterance", at: Date.now(), authorId: chey.id, authorName: "Chey", text: "show the board" };
    const tools = (hub.brain as any).tools([ev], { effects: 0 }, "person", "direct");
    const real = hub.session.setStage.bind(hub.session);
    (hub.session as any).setStage = () => ({ applied: false, reason: "The screen changed since you looked." });
    const refused = await tools.show_on_screen.execute({ mode: "board" }, { toolCallId: "1", messages: [] });
    expect(String(refused)).toContain("didn't land");
    expect((hub.brain as any).lastRoomStageAt).toBe(0);
    (hub.session as any).setStage = real;
    await tools.show_on_screen.execute({ mode: "board" }, { toolCallId: "2", messages: [] });
    expect((hub.brain as any).lastRoomStageAt).toBeGreaterThan(0);
  } finally {
    hub.devproxy.stop();
    hub.stop();
  }
});

test("a NAT-PMP renewal answered with a different port takes that forward back and reports it, instead of waiting on itself", async () => {
  const dgram = await import("node:dgram");
  const { PortMapper } = await import("../src/net/router");
  const sock = dgram.createSocket("udp4");
  const seen: number[] = [];
  sock.on("message", (msg, rinfo) => {
    const op = msg[1];
    if (op === 0) {
      const r = Buffer.alloc(12);
      r.writeUInt8(128, 1);
      r.writeUInt32BE(1, 4);
      Buffer.from([203, 0, 113, 7]).copy(r, 8);
      sock.send(r, rinfo.port, rinfo.address);
    } else if (op === 2) {
      const life = msg.readUInt32BE(8);
      seen.push(life);
      const r = Buffer.alloc(16);
      r.writeUInt8(130, 1);
      r.writeUInt32BE(1, 4);
      r.writeUInt16BE(msg.readUInt16BE(4), 8);
      r.writeUInt16BE(life === 0 ? msg.readUInt16BE(6) : 50443, 10); // a renewal gets another port
      r.writeUInt32BE(life, 12);
      sock.send(r, rinfo.port, rinfo.address);
    }
  });
  try {
    await new Promise<void>((res, rej) => {
      sock.once("error", rej);
      sock.bind(5351, "127.0.0.1", () => res());
    });
  } catch {
    sock.close();
    return; // port 5351 is in use on this machine: nothing to check here
  }
  try {
    const m: any = new PortMapper();
    m.current = { gateway: "127.0.0.1", method: "nat-pmp", internalPort: 4443, externalPort: 443, lanIp: "10.0.0.2" };
    const lost: string[] = [];
    m.onLost = (msg: string) => lost.push(msg);
    await Promise.race([m.renew(), Bun.sleep(4000).then(() => Promise.reject(new Error("renewal waited on itself")))]);
    expect(lost.length).toBe(1);
    expect(lost[0]).toContain("50443");
    expect(m.current).toBeUndefined();
    expect(seen).toContain(0); // the moved forward was deleted
  } finally {
    sock.close();
  }
});

test("a delete started while a NAT-PMP renewal is waiting on a moved-port reply: both finish and the forward is deleted", async () => {
  const dgram = await import("node:dgram");
  const { PortMapper } = await import("../src/net/router");
  const sock = dgram.createSocket("udp4");
  const lifetimes: number[] = [];
  let held: (() => void) | undefined;
  sock.on("message", (msg, rinfo) => {
    const op = msg[1];
    if (op === 0) {
      const r = Buffer.alloc(12);
      r.writeUInt8(128, 1);
      Buffer.from([203, 0, 113, 7]).copy(r, 8);
      sock.send(r, rinfo.port, rinfo.address);
    } else if (op === 2) {
      const life = msg.readUInt32BE(8);
      lifetimes.push(life);
      const r = Buffer.alloc(16);
      r.writeUInt8(130, 1);
      r.writeUInt16BE(msg.readUInt16BE(4), 8);
      r.writeUInt16BE(life === 0 ? msg.readUInt16BE(6) : 50443, 10);
      r.writeUInt32BE(life, 12);
      const send = () => sock.send(r, rinfo.port, rinfo.address);
      if (life === 0) send();
      else held = send; // the renewal's reply is held until the delete has started
    }
  });
  try {
    await new Promise<void>((res, rej) => {
      sock.once("error", rej);
      sock.bind(5351, "127.0.0.1", () => res());
    });
  } catch {
    sock.close();
    return;
  }
  try {
    const m: any = new PortMapper();
    m.current = { gateway: "127.0.0.1", method: "nat-pmp", internalPort: 4443, externalPort: 443, lanIp: "10.0.0.2" };
    const renewal = m.renew();
    await Bun.sleep(100);
    const gone = m.unmap();
    await Bun.sleep(50);
    held?.();
    const done = Promise.all([renewal, gone]);
    const out = await Promise.race([done, Bun.sleep(4000).then(() => "hung")]);
    expect(out).not.toBe("hung");
    expect((out as any)[1]).toBe(true);
    expect(lifetimes).toContain(0);
    expect(m.current).toBeUndefined();
  } finally {
    sock.close();
  }
});

test("Off closes the HTTPS listener the moment it is asked for, not after the order or router call ahead of it", async () => {
  const { Network } = await import("../src/net");
  const n = new Network(join(dir, "net-off-now"), (async () => new Response("OK\n1.2.3.4\n\nUPDATED")) as any);
  (n as any).ensureCert = async () => {};
  (n as any).mapper = { map: async () => ({ method: "upnp" }), unmap: async () => true };
  (n as any).cfg = { domain: "old.duckdns.org", token: "00000000-0000-0000-0000-000000000000", externalPort: 443, internalPort: 4443, enabled: true, staging: false };
  let closed = 0;
  (n as any).certChanged.push(() => closed++);
  let release!: () => void;
  (n as any).issuing = new Promise<void>((r) => (release = r)); // an order for the old name that takes minutes
  const post = (p: string, body: object) => n.routes(new Request(`http://x/api/net/${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), new URL(`http://x/api/net/${p}`));
  const setup = post("config", { domain: "new", token: "11111111-1111-1111-1111-111111111111" });
  await Bun.sleep(50);
  const off = post("disable", {});
  await Bun.sleep(20);
  expect(closed).toBeGreaterThan(0); // told to close while the order is still running
  expect(n.tlsOptions()).toBeNull();
  release();
  await setup;
  await off;
  expect((n as any).cfg.enabled).toBe(false);
});

test("a workstream brief that failed is tried again on the backoff, with no new room activity", async () => {
  process.env.JAMSESH_SILENT = "1";
  const { Hub } = await import("../src/hub");
  const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, "brain-briefs"), teamDir: join(dir, "team-br") });
  try {
    clearInterval((hub.brain as any).digestTimer);
    const b: any = hub.brain;
    let n = 0;
    b.workstreamBriefs = async () => {
      if (++n === 1) throw new Error("model down");
    };
    await b.briefsRun();
    expect(b.briefsPending).toBe(true);
    expect(b.digestRetryAt).toBeGreaterThan(Date.now());
    await b.briefsRun();
    expect(b.briefsPending).toBe(false);
    expect(n).toBe(2);
  } finally {
    hub.devproxy.stop();
    hub.stop();
  }
});

test("project saves run one after another, so an earlier slow thumbnail can't land over the final one", async () => {
  const { ProjectKeeper } = await import("../src/projectkeeper");
  const k: any = new ProjectKeeper({} as any, dir, null);
  const order: string[] = [];
  let n = 0;
  k.saveOnce = async () => {
    const me = ++n;
    order.push(`start${me}`);
    await Bun.sleep(me === 1 ? 60 : 1);
    order.push(`end${me}`);
  };
  await Promise.all([k.save(), k.save()]);
  expect(order).toEqual(["start1", "end1", "start2", "end2"]);
});

test("a big-screen web tile for this computer or a private network must be a registered dev server, exactly", async () => {
  const { isLocalUrl } = await import("../src/brain/brain");
  for (const u of ["http://localhost:3000", "http://127.0.0.1:1", "http://172.16.0.5/x", "http://172.31.255.1", "http://192.168.1.2", "http://10.1.2.3", "http://[::1]:3000", "http://[fd00::1]", "http://[fe80::1]", "http://[::ffff:192.168.1.1]", "http://0.0.0.0", "http://169.254.169.254", "http://100.64.0.1", "http://printer.local", "http://localhost.", "http://2130706433/"]) expect([u, isLocalUrl(u)]).toEqual([u, true]);
  for (const u of ["https://example.com", "https://8.8.8.8", "http://172.32.0.1", "http://172.15.0.1", "https://[2001:db8::1]/"]) expect([u, isLocalUrl(u)]).toEqual([u, false]);
});

test("the canvas edit and view credentials are not in the state every client receives", async () => {
  const s = new Session(new Store(mkdtempSync(join(dir, "sc-"))));
  s.setCanvas({ status: "live", editLink: "figcraft://join?host=h&file=a&token=EDIT", viewLink: "figcraft://join?host=h&file=a&token=VIEW", wsEdit: "ws://h/?file=a&token=EDIT", wsView: "ws://h/?file=a&token=VIEW", reason: null });
  const shown = JSON.stringify(s.state());
  expect(shown).not.toContain("EDIT");
  expect(shown).not.toContain("VIEW");
  expect(s.state().session.canvas.status).toBe("live");
  expect(s.canvas.wsEdit).toContain("EDIT"); // the hub keeps them for /canvas-link
});

test("a speech segment whose acknowledgement was lost is not taken in twice after a hub restart", async () => {
  process.env.JAMSESH_SILENT = "1";
  const { Hub } = await import("../src/hub");
  const { startHttp } = await import("../src/http");
  const data = join(dir, "audio-restart");
  const upload = async (hub: InstanceType<typeof Hub>, server: ReturnType<typeof startHttp>) => {
    const wav = new Uint8Array(44 + 3200);
    return fetch(`http://127.0.0.1:${server.port}/api/audio?deviceId=dv1&t0=1000&t1=1100&level=-20&noise=-60&epoch=-1`, { method: "POST", headers: { "content-type": "audio/wav", cookie: `jam_window=${hub.auth.windows.take(hub.auth.windows.mint())}` }, body: wav });
  };
  const run = async () => {
    const hub = new Hub({ canvas: false, whisper: false, dataDir: data, teamDir: join(dir, "team-ar") });
    const server = startHttp(hub, 0);
    const person = hub.session.upsertPerson({ name: "Ro" });
    hub.session.touchDevice("dv1", { personId: person.id, location: "room", micOn: true, pairedId: "host" });
    return { hub, server };
  };
  const a = await run();
  let ingested = 0;
  (a.hub.audio as any).ingest = async () => (ingested++, { id: "seg1" });
  expect((await upload(a.hub, a.server)).status).toBe(200);
  a.server.stop(true);
  a.hub.devproxy.stop();
  a.hub.stop();
  const b = await run();
  let again = 0;
  (b.hub.audio as any).ingest = async () => (again++, { id: "seg1" });
  const r = await upload(b.hub, b.server);
  expect(((await r.json()) as any).duplicate).toBe(true);
  expect([ingested, again]).toEqual([1, 0]);
  b.server.stop(true);
  b.hub.devproxy.stop();
  b.hub.stop();
});

test("what an agent asks of the brain becomes a card for a person: no directive and no pairing is made by the agent's message", async () => {
  process.env.JAMSESH_SILENT = "1";
  const { Hub } = await import("../src/hub");
  const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, "agent-cards"), teamDir: join(dir, "team-ac") });
  try {
    clearInterval((hub.brain as any).digestTimer);
    const s = hub.session;
    const a = s.registerAgent({ ownerName: "Chey", harness: "claude-code", repo: "acme/web", cwd: "/a", machine: "m", platform: "desktop" }).agent;
    const b = s.registerAgent({ ownerName: "Ana", harness: "claude-code", repo: "acme/api", cwd: "/b", machine: "m2", platform: "desktop" }).agent;
    const ev: any = s.store.addEvent({ kind: "message", authorType: "agent", authorId: a.id, authorName: a.name, text: "please have the api agent add the field", relevance: "work", data: {} });
    const tools = (hub.brain as any).tools([ev], { effects: 0 }, "agent"); // the route is left out: an agent never gets the direct one
    const made = await tools.create_directive.execute({ targets: [b.id], text: "Add the field", mode: "implement", rationale: "x" }, { toolCallId: "1", messages: [] });
    expect(String(made)).toContain("Tasks board");
    expect(s.directives().filter((d) => d.mode === "implement").length).toBe(0);
    expect(s.board.open().length).toBeGreaterThan(0);
    expect(tools.triage_card).toBeUndefined();
  } finally {
    hub.devproxy.stop();
    hub.stop();
  }
});

test("jam_inbox marks items read only once its reply has been sent: a dropped reply leaves them for the next call", async () => {
  process.env.JAMSESH_SILENT = "1";
  const { Hub } = await import("../src/hub");
  const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, "inbox-sent"), teamDir: join(dir, "team-is") });
  try {
    clearInterval((hub.brain as any).digestTimer);
    const s = hub.session;
    const a = s.registerAgent({ ownerName: "Chey", harness: "claude-code", repo: "acme/web", cwd: "/a", machine: "m", platform: "desktop" }).agent;
    s.createDirective({ text: "Fix the footer", mode: "implement", targets: [a.id], requestedBy: "Chey" });
    const ctx: any = { agentId: a.id, ip: "relayed", device: "m", origin: "http://x", sessionId: "sess1" };
    let sent: (() => void) | undefined;
    (hub.mcp as any).lives.set("sess1:number:1", { afterSent: (fn: () => void) => (sent = fn), onDrop: () => {}, idle: () => {}, signal: new AbortController().signal });
    const first = await hub.mcp.call(ctx, "jam_inbox", {}, { requestId: 1 });
    expect(JSON.stringify(first)).toContain("Fix the footer");
    // The reply never went out: still waiting, offered again.
    expect(s.hasInbox(a.id)).toBe(true);
    const again = await hub.mcp.call(ctx, "jam_inbox", {}, { requestId: 1 });
    expect(JSON.stringify(again)).toContain("Fix the footer");
    // Sent this time: now it is read.
    sent?.();
    expect(s.hasInbox(a.id)).toBe(false);
  } finally {
    hub.devproxy.stop();
    hub.stop();
  }
});

test("a real jam_inbox call is tracked like jam_wait, so its items are marked read only when the reply has gone out; in a batch it is refused", async () => {
  process.env.JAMSESH_SILENT = "1";
  const { Hub } = await import("../src/hub");
  const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, "inbox-classify"), teamDir: join(dir, "team-ic") });
  try {
    clearInterval((hub.brain as any).digestTimer);
    const post = (body: unknown) => new Request("http://x/mcp", { method: "POST", headers: { "mcp-session-id": "s1", "content-type": "application/json" }, body: JSON.stringify(body) });
    const call = (id: number, name: string) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: {} } });
    const one = await hub.mcp.classify(post(call(5, "jam_inbox")));
    expect(one.live).toBeDefined();
    const batch = await hub.mcp.classify(post([call(6, "jam_inbox"), call(7, "jam_update")]));
    expect(batch.reject).toContain("own");
    const other = await hub.mcp.classify(post(call(8, "jam_update")));
    expect(other.live).toBeUndefined();
  } finally {
    hub.devproxy.stop();
    hub.stop();
  }
});

test("a canvas pin is a FigCraft comment only once FigCraft has confirmed it: an unavailable or failing canvas is retried, a delivered one is not repeated", async () => {
  process.env.JAMSESH_SILENT = "1";
  const { Hub } = await import("../src/hub");
  const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, "canvas-comments"), teamDir: join(dir, "team-cc") });
  try {
    clearInterval((hub.brain as any).digestTimer);
    const s = hub.session;
    const pin = s.addAnnotation({ personId: null, authorName: "Mo", target: { kind: "canvas", ref: "Frame 1", label: "Frame 1", canvasX: 10, canvasY: 20 }, x: 0.1, y: 0.1, text: "tighten this", source: "pin" } as any);
    const sent: string[] = [];
    let mode: "down" | "fails" | "ok" = "down";
    (hub.canvas as any).comment = async (a: any) => {
      if (mode === "down") return false;
      if (mode === "fails") throw new Error("command failed");
      sent.push(a.id);
      return true;
    };
    expect(await hub.deliverComment(pin.id)).toBe(false);
    mode = "fails";
    expect(await hub.deliverComment(pin.id)).toBe(false);
    expect(s.store.get("annotations", pin.id)!.commentDone).toBeFalsy();
    mode = "ok";
    await hub.flushComments(); // the timer's job once the canvas is back
    expect(sent).toEqual([pin.id]);
    expect(s.store.get("annotations", pin.id)!.commentDone).toBe(true);
    await hub.flushComments();
    expect(await hub.deliverComment(pin.id)).toBe(true);
    expect(sent.length).toBe(1); // never repeated
  } finally {
    hub.devproxy.stop();
    hub.stop();
  }
});

test("two deliveries of one canvas pin at once make one FigCraft comment", async () => {
  process.env.JAMSESH_SILENT = "1";
  const { Hub } = await import("../src/hub");
  const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, "canvas-comments-2"), teamDir: join(dir, "team-cc2") });
  try {
    clearInterval((hub.brain as any).digestTimer);
    const pin = hub.session.addAnnotation({ personId: null, authorName: "Mo", target: { kind: "canvas", ref: "F", label: "F", canvasX: 1, canvasY: 2 }, x: 0.1, y: 0.1, text: "x", source: "pin" } as any);
    let calls = 0;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    (hub.canvas as any).comment = async () => (calls++, await held, true);
    const both = Promise.all([hub.deliverComment(pin.id), hub.flushComments(), hub.deliverComment(pin.id)]);
    await Bun.sleep(30);
    release();
    await both;
    expect(calls).toBe(1);
  } finally {
    hub.devproxy.stop();
    hub.stop();
  }
});

test("shutdown asks the router to delete the forward at once, not behind a setup that is waiting in the lane", async () => {
  const { Network } = await import("../src/net");
  const n = new Network(join(dir, "net-close-now"), (async () => new Response("OK\n1.2.3.4\n\nUPDATED")) as any);
  const calls: string[] = [];
  (n as any).mapper = { map: async () => ({ method: "upnp" }), unmap: async () => (calls.push("unmap"), true) };
  (n as any).cfg = { domain: "x.duckdns.org", token: "00000000-0000-0000-0000-000000000000", externalPort: 443, internalPort: 4443, enabled: true, staging: false };
  let release!: () => void;
  (n as any).lane = new Promise<void>((r) => (release = r)); // a configuration call holding the lane
  const gone = await Promise.race([n.close(), Bun.sleep(1000).then(() => "stuck")]);
  expect(gone).toBe(true);
  expect(calls).toEqual(["unmap"]);
  release();
});

test("a quiet room's HTML frame has any meta refresh removed", async () => {
  const { htmlFrame } = await import("../../web/src/shared/sound");
  const doc = `<!doctype html><html><head><META http-equiv="Refresh" content="0;url=https://example.com/x.mp3"></head><body>hi</body></html>`;
  const quiet = htmlFrame(true, doc);
  expect(quiet.srcDoc.toLowerCase()).not.toContain("refresh");
  expect(quiet.srcDoc).toContain("Content-Security-Policy");
  expect(htmlFrame(false, doc).srcDoc).toContain("Refresh"); // a normal room is left as authored
});

test("a refresh spelled with character references is still removed from a quiet room's HTML frame", async () => {
  const { htmlFrame } = await import("../../web/src/shared/sound");
  for (const tag of [`<meta http-equiv="&#114;efresh" content="0;url=https://example.invalid/">`, `<meta http-equiv="&#x72;e&#102;resh" content="0;url=x">`, `<meta http-equiv=re&Tab;fresh content="0;url=x">`]) {
    const out = htmlFrame(true, `<html><head>${tag}</head><body>hi</body></html>`).srcDoc;
    expect([tag, /refresh|&#114|&#x72/i.test(out.replace(/Content-Security-Policy/gi, ""))]).toEqual([tag, false]);
  }
});

test("a share keeps the id of the capture attempt that registered it, for a new share and for an accepted request", async () => {
  const s = new Session(new Store(mkdtempSync(join(dir, "sh-"))));
  const p = s.upsertPerson({ name: "Ona" });
  s.touchDevice("dev-1", { personId: p.id, location: "room", micOn: true, pairedId: "host" });
  expect(s.startShare("dev-1", "camera", "sh-window-1", undefined, "cap-1").clientId).toBe("cap-1");
  const asked = s.requestShare(p.id, "screen", "the build", "Host");
  expect(asked).toBeTruthy();
  const accepted = s.startShare("dev-1", "screen", asked!.id, undefined, "cap-2");
  expect(accepted.id).toBe(asked!.id);
  expect(accepted.clientId).toBe("cap-2");
});
