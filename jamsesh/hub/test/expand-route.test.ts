// Expanding a tile over HTTP and by voice, and the on-demand full-size frame render.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../src/hub";
import { FULL_SIZES, startHttp } from "../src/http";
import { Session } from "../src/session";
import { Store } from "../src/store";

const dir = mkdtempSync(join(tmpdir(), "jam-expand-http-"));
const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, "d") });
const server = startHttp(hub, 0);
const base = `http://127.0.0.1:${server.port}`;
afterAll(() => {
  server.stop(true);
  hub.devproxy.stop();
  rmSync(dir, { recursive: true, force: true });
});

const json = { "content-type": "application/json" };
const remote = { "x-forwarded-for": "9.9.9.9" };
const s = hub.session;
const window = () => ({ cookie: `jam_window=${hub.auth.windows.take(hub.auth.windows.mint())}` });
const expand = (body: unknown, h: Record<string, string> = window()) => fetch(`${base}/api/stage/expand`, { method: "POST", headers: { ...json, ...h }, body: JSON.stringify(body) });

const a = s.upsertArtifact({ kind: "screenshot", title: "Checkout / A" });
const b = s.upsertArtifact({ kind: "screenshot", title: "Checkout / B" });
const frame = s.upsertArtifact({ kind: "frame", title: "Dashboard", nodeId: "12", image: "/renders/12-abcdef.png", width: 1440, height: 900 });

test("the expand route: a person's window expands and collapses; strangers, agents and malformed calls don't", async () => {
  s.setStage({ mode: "compare", items: [a.id, b.id] }, "Chey", "main", { claim: s.stageClaim() });
  expect((await expand({ tile: b.id })).status).toBe(200);
  expect(s.stage().expanded).toBe(b.id);
  // Repeated: same answer, same state.
  expect((await expand({ tile: b.id })).status).toBe(200);
  expect(s.stage().expanded).toBe(b.id);
  // Not paired at all, or an agent's credential.
  expect((await expand({ tile: a.id }, remote)).status).toBe(401);
  const agent = hub.auth.issue({ kind: "agent", label: "Agents on Mac", ip: "10.0.0.5", ownerDeviceId: "dev_mac0" });
  expect((await expand({ tile: a.id }, { ...remote, authorization: `Bearer ${agent.token}` })).status).toBe(403);
  expect(s.stage().expanded).toBe(b.id);
  // Malformed tiles never collapse by accident.
  for (const bad of [{}, { tile: 5 }, { tile: {} }, { tile: "" }, { tile: ["a"] }]) expect((await expand(bad)).status).toBe(400);
  expect(s.stage().expanded).toBe(b.id);
  // Another process on the host (loopback with no window key) can't steer the screen.
  expect((await expand({ tile: a.id }, {})).status).toBe(403);
  expect(s.stage().expanded).toBe(b.id);
  // A tile that isn't on this stage is refused, and a tile key padded with spaces is the tile.
  expect((await expand({ tile: "art_not_here" })).status).toBe(404);
  expect((await expand({ tile: frame.id })).status).toBe(404);
  expect(s.stage().expanded).toBe(b.id);
  expect((await expand({ tile: ` ${a.id} ` })).status).toBe(200);
  expect(s.stage().expanded).toBe(a.id);
  // An unknown screen is refused; null collapses.
  expect((await expand({ tile: a.id, screen: "screen-9" })).status).toBe(404);
  expect((await expand({ tile: null })).status).toBe(200);
  expect(s.stage().expanded).toBeUndefined();
});

test("expanding restarts the wait before a brought-up stage returns to the board", async () => {
  const prev = Session.STAGE_REVERT_MS;
  Session.STAGE_REVERT_MS = 120;
  try {
    const s2 = new Session(new Store(mkdtempSync(join(tmpdir(), "jam-expand-timer-"))));
    const art = s2.upsertArtifact({ kind: "screenshot", stage: "built", title: "A", image: "/renders/a.png" });
    s2.setStage({ mode: "spotlight", items: [art.id] }, "Room brain", "main", { claim: s2.stageClaim() });
    await Bun.sleep(80);
    s2.expandTile(art.id);
    await Bun.sleep(80);
    expect(s2.stage().mode).toBe("spotlight");
    await Bun.sleep(100);
    expect(s2.stage().mode).toBe("board");
    // A pinned stage never reverts, expanded or not.
    s2.setStage({ mode: "spotlight", items: [art.id], pinned: true }, "Chey", "main", { claim: s2.stageClaim() });
    s2.expandTile(art.id);
    await Bun.sleep(200);
    expect(s2.stage().mode).toBe("spotlight");
  } finally {
    Session.STAGE_REVERT_MS = prev;
  }
});

test("by voice: the second tile, a named artifact, a count that's too big, and collapse", () => {
  s.setStage({ mode: "compare", items: [b.id, a.id] }, "Room brain", "main", { claim: s.stageClaim() });
  // Drawn as A then B, so "the second one" is B.
  expect(s.stageTileKeys().map((t) => t.key)).toEqual([a.id, b.id]);
  expect(s.expandWhich({ position: 2 })).toMatchObject({ ok: true });
  expect(s.stage().expanded).toBe(b.id);
  expect(s.expandWhich({ artifactId: a.id })).toMatchObject({ ok: true });
  expect(s.stage().expanded).toBe(a.id);
  expect(s.expandWhich({ position: 3 })).toMatchObject({ ok: false });
  expect(s.expandWhich({ position: 0 })).toMatchObject({ ok: false });
  expect(s.expandWhich({ artifactId: "art_nope" })).toMatchObject({ ok: false });
  expect(s.stage().expanded).toBe(a.id);
  expect(s.expandWhich({})).toMatchObject({ ok: true });
  expect(s.stage().expanded).toBeUndefined();
  // A layout is counted by tile, and a tile can be found by its artifact.
  s.setStage({ mode: "layout", layout: { tiles: [{ kind: "web", url: "http://x.test" }, { kind: "artifact", artifactId: b.id }] } }, "Room brain", "main", { claim: s.stageClaim() });
  expect(s.expandWhich({ artifactId: b.id })).toMatchObject({ ok: true });
  expect(s.stage().expanded).toBe("t1");
  s.setStage({ mode: "agents" }, "Room brain", "main", { claim: s.stageClaim() });
  expect(s.expandWhich({ position: 1 })).toMatchObject({ ok: false });
  // Another screen is its own stage.
  expect(s.expandWhich({ position: 1 }, "main")).toMatchObject({ ok: false });
});

// ---- the full-size render ----

const full = (id: string, size: string | number, h: Record<string, string> = window()) => fetch(`${base}/renders/full/${id}.png?size=${size}`, { headers: h });
const asked: number[] = [];
const scales: (number | undefined)[] = [];
const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
(hub.canvas as any).renderNode = async (_id: string, size: number, scale?: number) => (asked.push(size), scales.push(scale), { content: [{ type: "image", data: png }] });

test("full-size render: only the allowed sizes, only frames, nothing for strangers, and each size is drawn once", async () => {
  expect(FULL_SIZES).toEqual([1600, 2400, 3200, 4096]);
  for (const bad of ["", "abc", "0", "-1", "2401", "99999", "1e3", "2400.5"]) expect((await full(frame.id, bad)).status).toBe(400);
  expect((await full(frame.id, 2400, remote)).status).toBe(401);
  expect((await full("art_nope", 2400)).status).toBe(404);
  expect((await full(a.id, 2400)).status).toBe(404); // a screenshot isn't a frame
  expect(asked).toEqual([]);
  const ok = await full(frame.id, 2400);
  expect(ok.status).toBe(200);
  expect(asked).toEqual([2400]);
  // The canvas draws at 1x unless given a scale: 1440 wide to 2400 is x1.67.
  expect(scales[0]).toBeCloseTo(2400 / 1440, 5);
  // Asked again, and twice at once: served from what's kept.
  await Promise.all([full(frame.id, 2400), full(frame.id, 2400)]);
  expect(asked).toEqual([2400]);
  expect((await full(frame.id, 4096)).status).toBe(200);
  expect(asked).toEqual([2400, 4096]);
});

test("full-size render: path tricks never leave the renders folder, a failed draw is a 404 not a crash, and the cache is capped", async () => {
  for (const id of ["..", "..%2f..%2fetc%2fpasswd", "%2e%2e", "a/b", "art_x%00"]) {
    const r = await fetch(`${base}/renders/full/${id}.png?size=2400`, { headers: window() });
    expect([400, 404]).toContain(r.status);
  }
  // A canvas that fails or says nothing.
  (hub.canvas as any).renderNode = async () => ({ isError: true, content: [{ type: "text", text: "no" }] });
  expect((await full(frame.id, 3200)).status).toBe(404);
  (hub.canvas as any).renderNode = async () => {
    throw new Error("canvas isn't running");
  };
  expect((await full(frame.id, 3200)).status).toBe(404);
  // Many frames: the folder keeps only the newest 60.
  (hub.canvas as any).renderNode = async () => ({ content: [{ type: "image", data: png }] });
  for (let i = 0; i < 70; i++) {
    const f = s.upsertArtifact({ kind: "frame", title: `Bulk ${i}`, nodeId: String(100 + i), image: `/renders/${100 + i}-hash${i}.png` });
    expect((await full(f.id, 1600)).status).toBe(200);
  }
  expect(readdirSync(join(hub.canvas.rendersDir, "full")).length).toBeLessThanOrEqual(60);
  expect(existsSync(join(hub.canvas.rendersDir, "..", "etc"))).toBe(false);
});

test("windows get each screen's tile keys from the hub: in the state, and again whenever the stage or the artifacts change", async () => {
  const { bus } = await import("../src/bus");
  // The tests above made other sessions; this hub's session answers the patches again.
  bus.resolver = (k) => (s as any).resolve(k);
  const patches: any[] = [];
  const off = bus.on((m: any) => m.type === "patch" && m.key === "stageTiles" && patches.push(m.value));
  try {
    s.setStage({ mode: "layout", layout: { tiles: [{ kind: "artifact", artifactId: a.id }, { kind: "feed" }] } }, "Chey", "main", { claim: s.stageClaim() });
    expect(s.state().stageTiles.main).toEqual([{ key: "t0", layoutIndex: 0, artifactId: a.id }, { key: "t1", layoutIndex: 1 }]);
    await Bun.sleep(80);
    expect(patches.at(-1).main.map((t: any) => t.key)).toEqual(["t0", "t1"]);
    // An extra screen's stage has its own list.
    s.setStage({ mode: "compare", items: [b.id, a.id] }, "Chey", "screen-2", { claim: s.stageClaim() });
    await Bun.sleep(80);
    expect(patches.at(-1)["screen-2"].map((t: any) => t.key)).toEqual([a.id, b.id]);
    // The board shows the newest artifacts: a new one changes its tiles without any stage change.
    s.setStage({ mode: "board" }, "JamSesh", "main", { override: true });
    await Bun.sleep(80);
    const n = patches.length;
    const c = s.upsertArtifact({ kind: "screenshot", title: "Pricing" });
    await Bun.sleep(80);
    expect(patches.length).toBeGreaterThan(n);
    expect(patches.at(-1).main[0].key).toBe(c.id);
  } finally {
    off?.();
  }
});
