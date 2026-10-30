import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../src/hub";
import { startHttp } from "../src/http";

// A long session: more of everything than the live state carries.
const dir = mkdtempSync(join(tmpdir(), "jam-history-"));
const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, "d") });
const server = startHttp(hub, 0);
const base = `http://127.0.0.1:${server.port}`;
afterAll(() => {
  server.stop(true);
  hub.devproxy.stop();
  rmSync(dir, { recursive: true, force: true });
});
const s = hub.session;
const agent = hub.auth.issue({ kind: "agent", label: "Agents", ip: "10.0.0.5", ownerDeviceId: "host" });
const auth = { authorization: `Bearer ${agent.token}`, "x-forwarded-for": "9.9.9.9" };
const get = (path: string) => fetch(`${base}/api${path}`, { headers: auth }).then((r) => r.json() as Promise<any>);

const a = s.registerAgent({ ownerName: "Jonathan", harness: "claude-code", repo: "acme/desktop", cwd: "/d", machine: "m1", platform: "desktop" }).agent;
for (let i = 0; i < 90; i++) s.createDirective({ text: `directive ${i}`, mode: "explore", targets: [a.id], requestedBy: "Felipe" });
// Open directives always stay in the state (phase 2), so the 30 oldest are finished.
for (const d of s.directives().slice(60)) s.endDirective(d.id, "done");
for (let i = 0; i < 150; i++) s.upsertArtifact({ kind: "screenshot", title: `shot ${i}`, agentId: a.id, updatedAt: 1_000 + i } as any, { announce: false });
for (let i = 0; i < 300; i++) s.store.addEvent({ kind: "speech", authorType: "person", authorName: "Sam", text: `line ${i}` });

test("the state stays light but says how much more the session holds", () => {
  const st = s.state();
  expect(st.directives).toHaveLength(60);
  expect(st.artifacts).toHaveLength(120);
  expect(st.totals.directives).toBe(90);
  expect(st.totals.artifacts).toBe(150);
  expect(st.totals.events).toBeGreaterThanOrEqual(300);
});

test("older events page back by id, oldest first, with how many are left", async () => {
  const st = s.state();
  const first = st.events[0].id;
  const page = await get(`/history/events?before=${first}&limit=100&kinds=speech`);
  const before = 300 - st.events.filter((e) => e.kind === "speech").length;
  expect(page.items).toHaveLength(Math.min(100, before));
  expect(page.items[page.items.length - 1].id).toBeLessThan(first);
  expect(page.items[0].id).toBeLessThan(page.items[1].id);
  expect(page.more).toBe(before - page.items.length);
  const next = await get(`/history/events?before=${page.items[0].id}&limit=500&kinds=speech`);
  expect(next.items.length).toBe(page.more);
});

test("directives and artifacts page newest first until they run out", async () => {
  const st = s.state();
  const oldest = st.directives[st.directives.length - 1];
  const d = await get(`/history/directives?before=${oldest.ts}|${oldest.id}`);
  expect(d.total).toBe(90);
  expect(d.items.length + st.directives.length).toBe(90);
  expect(d.more).toBe(0);
  const last = st.artifacts[st.artifacts.length - 1];
  const art = await get(`/history/artifacts?before=${last.updatedAt}|${last.id}&limit=10`);
  expect(art.items).toHaveLength(10);
  expect(art.more).toBe(150 - 120 - 10);
});

test("an unknown list is a 404, junk cursors don't crash", async () => {
  expect((await fetch(`${base}/api/history/secrets`, { headers: auth })).status).toBe(404);
  const r = await get(`/history/events?before=abc&limit=-5`);
  expect(r.items.length).toBeLessThanOrEqual(1);
  // A limit that isn't a number gets the default page, not a broken query.
  for (const what of ["events", "utterances", "directives", "artifacts"]) {
    const junk = await get(`/history/${what}?limit=abc`);
    expect(Array.isArray(junk.items)).toBe(true);
    if (what !== "utterances") expect(junk.items.length).toBeGreaterThan(0);
  }
  expect((await get(`/history/events?limit=Infinity`)).items.length).toBeGreaterThan(0);
});

test("jam_artifacts and jam_directives page and say how many more there are", async () => {
  const ctx = { agentId: null as string | null, ip: "relayed", device: agent.device.id, origin: "http://127.0.0.1:1" };
  await hub.mcp.call(ctx, "jam_join", { owner: "Rae", harness: "claude", cwd: "/tmp/x" });
  const first = (await hub.mcp.call(ctx, "jam_artifacts", { limit: 80 })).content[0] as any;
  expect(first.text).toContain("150 in all; 70 more: call again with offset 80");
  const last = (await hub.mcp.call(ctx, "jam_artifacts", { limit: 80, offset: 80 })).content[0] as any;
  expect(last.text.split("\n").filter((l: string) => l.includes("shot")).length).toBe(70);
  expect(last.text).toContain("last page");
  const dirs = (await hub.mcp.call(ctx, "jam_directives", { limit: 50 })).content[0] as any;
  expect(dirs.text).toContain("90 in all; 40 more");
  const search = (await hub.mcp.call(ctx, "jam_search", { query: "line", limit: 20 })).content[0] as any;
  expect(search.text).toContain("offset 20");
});

test("a state window with nothing the feed shows still pages back to older speech", async () => {
  // The newest 250 events are canvas noise; the speech is all older.
  for (let i = 0; i < 260; i++) s.store.addEvent({ kind: "canvas", authorType: "system", authorName: "Canvas", text: `edit ${i}` });
  const st = s.state();
  const feed = new Set(["speech", "prompt", "directive", "decision", "brain", "update", "message", "artifact"]);
  expect(st.events.some((e) => feed.has(e.kind))).toBe(false);
  // The window's own oldest event is the cursor (what the web feed now uses).
  const cursor = Math.min(...st.events.map((e) => e.id));
  const page = await get(`/history/events?before=${cursor}&limit=60&kinds=${[...feed].join(",")}`);
  expect(page.items.length).toBe(60);
  expect(page.items.every((e: any) => feed.has(e.kind))).toBe(true);
  expect(page.items.at(-1).text).toBe("line 299");
  expect(page.more).toBeGreaterThan(0);
});
