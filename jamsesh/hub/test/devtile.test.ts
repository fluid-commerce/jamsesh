import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.JAMSESH_DEV_PORT_START = String(47100 + Math.floor(Math.random() * 400));
const { Hub } = await import("../src/hub");

const dir = mkdtempSync(join(tmpdir(), "jam-devtile-"));
const hubs: InstanceType<typeof Hub>[] = [];
afterAll(() => {
  for (const h of hubs) h.devproxy.stop();
  rmSync(dir, { recursive: true, force: true });
});

function room() {
  const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, String(Math.random())) });
  hubs.push(hub);
  const s = hub.session;
  const agent = s.registerAgent({ ownerName: "Chey", harness: "claude-code", repo: "acme/web", cwd: "/w", machine: "m1", platform: "web", name: "Context Gatherer" }).agent;
  return { hub, s, agent };
}
const toAgent = (s: ReturnType<typeof room>["s"], id: string) => s.inbox(id, false).messages.map((m) => m.text).join("\n");

test("a tile whose build stops says what happened, tells its agent, and clears itself", async () => {
  const { hub, s, agent } = room();
  let throwaway: ReturnType<typeof Bun.serve> | null = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("hello build") });
  const port = throwaway.port;
  const d = await hub.devproxy.register({ agentId: agent.id, name: "Web build", target: `127.0.0.1:${port}` });
  expect(d.up).toBe(true);
  expect((await fetch(d.url.replace(/^http:\/\/[^:]+/, "http://127.0.0.1"))).status).toBe(200);

  throwaway.stop(true);
  throwaway = null;
  const t0 = Date.now();
  await hub.devproxy.refresh(t0);
  const down = s.devservers()[0];
  expect(down.up).toBe(false);
  expect(down.problem).toBe(`The build at port ${port} stopped responding`);
  expect(toAgent(s, agent.id)).toContain(`The build at port ${port} stopped responding`);
  // The forwarder says the same kind of thing in words, not a bare error.
  const r = await fetch(d.url.replace(/^http:\/\/[^:]+/, "http://127.0.0.1"));
  expect(r.status).toBe(502);
  expect(await r.text()).toContain("isn't answering");

  // Told once, not on every check.
  s.inbox(agent.id, true);
  await hub.devproxy.refresh(t0 + 60_000);
  expect(toAgent(s, agent.id)).toBe("");
  expect(s.devservers()).toHaveLength(1);

  // A few minutes later the tile clears itself and the agent hears it.
  await hub.devproxy.refresh(t0 + hub.devproxy.goneMs + 61_000);
  expect(s.devservers()).toHaveLength(0);
  expect(s.artifacts().filter((a) => a.kind === "devserver")).toHaveLength(0);
  expect(toAgent(s, agent.id)).toContain("off the board");
});

test("when the owning agent has gone, the tile names it", async () => {
  const { hub, s, agent } = room();
  const throwaway = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
  await hub.devproxy.register({ agentId: agent.id, name: "Web build", target: `127.0.0.1:${throwaway.port}` });
  throwaway.stop(true);
  s.store.patch("agents", agent.id, { lastSeen: Date.now() - 3600_000 });
  await hub.devproxy.refresh();
  expect(s.devservers()[0].problem).toBe("Chey's Context Gatherer stopped this build");
});

test("a build that comes back clears its problem", async () => {
  const { hub, s, agent } = room();
  let srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
  const port = srv.port;
  await hub.devproxy.register({ agentId: agent.id, name: "Web build", target: `127.0.0.1:${port}` });
  srv.stop(true);
  await hub.devproxy.refresh();
  expect(s.devservers()[0].problem).toBeTruthy();
  srv = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("x") });
  await hub.devproxy.refresh();
  expect(s.devservers()[0].up).toBe(true);
  expect(s.devservers()[0].problem).toBeUndefined();
  srv.stop(true);
});

test("mentioning a localhost address that isn't shared gets the step to share it, once", async () => {
  const { hub, s, agent } = room();
  const ctx = { agentId: agent.id, ip: "127.0.0.1", device: null };
  const first = await hub.mcp.call(ctx, "jam_update", { kind: "progress", text: "Dev server is up at http://localhost:5173/ if you want to look" });
  const out = first.content[0].type === "text" ? first.content[0].text : "";
  expect(out).toContain('jam_devserver with url "http://localhost:5173"');
  expect(out).toContain("0.0.0.0");
  const again = await hub.mcp.call(ctx, "jam_message", { to: "all", text: "still http://localhost:5173 here" });
  expect(again.content[0].type === "text" && again.content[0].text).toBe("Sent.");
  // A different port is a different URL; a shared one is left alone.
  const other = await hub.mcp.call(ctx, "jam_message", { to: "all", text: "api on http://127.0.0.1:8080/health" });
  expect(other.content[0].type === "text" && other.content[0].text).toContain('"http://localhost:8080"');
  const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
  await hub.devproxy.register({ agentId: agent.id, name: "Web build", target: `127.0.0.1:${srv.port}` });
  expect(s.shareNudge(agent.id, `now at http://localhost:${srv.port}`)).toBe("");
  srv.stop(true);
});

test("a check that was running when the build was registered again doesn't touch the new registration", async () => {
  const { hub, s, agent } = room();
  const old = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("old") });
  const fresh = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("new") });
  try {
    const d = await hub.devproxy.register({ agentId: agent.id, name: "Web build", target: `127.0.0.1:${old.port}` });
    // The check of the old registration is slow and finds it down; meanwhile the agent registers it again.
    const real = hub.devproxy.check.bind(hub.devproxy);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    hub.devproxy.check = async (x) => (x.target.endsWith(`:${old.port}`) ? (await held, false) : real(x));
    const t0 = Date.now();
    const refreshing = hub.devproxy.refresh(t0 + hub.devproxy.goneMs + 60_000);
    await Bun.sleep(20);
    hub.devproxy.check = real;
    const again = await hub.devproxy.register({ agentId: agent.id, name: "Web build", target: `127.0.0.1:${fresh.port}` });
    expect(again.id).toBe(d.id);
    release();
    await refreshing;
    const now = s.devservers().find((x) => x.id === d.id);
    expect(now).toMatchObject({ up: true, target: `127.0.0.1:${fresh.port}` });
    expect(now?.problem).toBeUndefined();
  } finally {
    old.stop(true);
    fresh.stop(true);
  }
});

test("a stale refresh finishing while the build is being registered again never closes the new listener", async () => {
  const { hub, s, agent } = room();
  const old = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("old") });
  const fresh = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("new") });
  try {
    const d = await hub.devproxy.register({ agentId: agent.id, name: "Web build", target: `127.0.0.1:${old.port}` });
    // The old build has been down long enough to be taken off the board.
    s.store.patch("devservers", d.id, { up: false, downSince: Date.now() - hub.devproxy.goneMs - 60_000, problem: "down" });
    const real = hub.devproxy.check.bind(hub.devproxy);
    let releaseOld!: () => void;
    let releaseNew!: () => void;
    const oldHeld = new Promise<void>((r) => (releaseOld = r));
    const newHeld = new Promise<void>((r) => (releaseNew = r));
    hub.devproxy.check = async (x) => {
      if (x.target.endsWith(`:${old.port}`)) return await oldHeld, false;
      await newHeld; // the registration's own check waits too, so the stale refresh ends in the gap
      return real(x);
    };
    const refreshing = hub.devproxy.refresh();
    await Bun.sleep(20);
    const registering = hub.devproxy.register({ agentId: agent.id, name: "Web build", target: `127.0.0.1:${fresh.port}` });
    await Bun.sleep(50); // registration is now waiting on its check, its new listener open
    releaseOld();
    await refreshing; // the stale refresh finishes here, mid-registration
    releaseNew();
    const again = await registering;
    hub.devproxy.check = real;
    expect(again.id).toBe(d.id);
    expect(s.devservers().find((x) => x.id === d.id)).toMatchObject({ up: true, target: `127.0.0.1:${fresh.port}` });
    // Its forwarding port still answers.
    expect(await (await fetch(again.url.replace(/^http:\/\/[^:]+/, "http://127.0.0.1"))).text()).toBe("new");
  } finally {
    old.stop(true);
    fresh.stop(true);
  }
});
