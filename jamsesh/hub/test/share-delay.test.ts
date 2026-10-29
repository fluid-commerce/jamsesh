// A share's placement is decided at once but may land up to 45 s later (the presenter model). It lands only on the
// screen it was decided for: a newer cast, the share ending or the brain stopping in between all win.
import { afterAll, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.JAMSESH_SILENT = "1";
// A presenter that answers only when the test says, then fails, so the placement falls back.
let release: () => void = () => {};
const ai = await import("ai");
mock.module("ai", () => ({ ...ai, generateText: () => new Promise((_, no) => (release = () => no(new Error("presenter down")))) }));
const llm = await import("../src/brain/llm");
mock.module("../src/brain/llm", () => ({ ...llm, model: () => ({}) }));
const { Hub } = await import("../src/hub");

const dir = mkdtempSync(join(tmpdir(), "jam-share-delay-"));
const hubs: any[] = [];
afterAll(() => {
  for (const h of hubs) h.stop();
  rmSync(dir, { recursive: true, force: true });
});

function room() {
  const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, String(Math.random())) });
  hubs.push(hub);
  const s = hub.session;
  const chey = s.upsertPerson({ name: "Chey" });
  const felipe = s.upsertPerson({ name: "Felipe" });
  s.touchDevice("chey-mac", { label: "Chey's Mac", personId: chey.id, kind: "client" });
  s.touchDevice("felipe-laptop", { label: "Felipe's laptop", personId: felipe.id, kind: "client" });
  const a = s.upsertArtifact({ kind: "screenshot", stage: "built", title: "Pricing", image: "/renders/p.png" });
  return { hub, s, chey, felipe, a };
}

test("a cast made while the presenter thinks wins: the late fallback neither replaces it nor brings back the old lock", async () => {
  const { hub, s, felipe, chey, a } = room();
  s.setStage({ mode: "spotlight", items: [a.id] }, "Felipe", "main", { person: { id: felipe.id, name: "Felipe" } });
  const share = s.startShare("felipe-laptop", "screen");
  const placing = hub.brain.placeShare(share);
  // Chey casts over it before the presenter answers.
  s.setStage({ mode: "agents" }, "Chey", "main", { person: { id: chey.id, name: "Chey" } });
  release();
  await placing;
  expect(s.stage().mode).toBe("agents");
  expect(s.stage().lock?.by).toBe("Chey");
});

test("a share that ended, or a brain that stopped, while the presenter thought isn't put up", async () => {
  const ended = room();
  const sh = ended.s.startShare("felipe-laptop", "screen");
  const placing = ended.hub.brain.placeShare(sh);
  ended.s.endShare(sh.id);
  release();
  await placing;
  expect(ended.s.stage().mode).not.toBe("layout");

  const stopped = room();
  const sh2 = stopped.s.startShare("felipe-laptop", "screen");
  const placing2 = stopped.hub.brain.placeShare(sh2);
  stopped.hub.brain.stop();
  release();
  await placing2;
  expect(stopped.s.stage().mode).not.toBe("layout");
});

test("with nothing newer, the fallback does put the share up, keeping its sharer's own lock", async () => {
  const { hub, s, felipe, a } = room();
  s.setStage({ mode: "spotlight", items: [a.id] }, "Felipe", "main", { person: { id: felipe.id, name: "Felipe" } });
  const share = s.startShare("felipe-laptop", "screen");
  const placing = hub.brain.placeShare(share);
  release();
  await placing;
  expect(s.stage().mode).toBe("layout");
  expect(s.stage().lock?.by).toBe("Felipe");
});

test("the presenter's own set_layout, answering late, lands only on the screen it saw and never shows an ended share", async () => {
  // This time the presenter answers by calling its tool, after the room moved on.
  let act: () => Promise<unknown> = async () => {};
  mock.module("ai", () => ({
    ...ai,
    generateText: (o: any) =>
      new Promise((done) => {
        act = async () => {
          const said = await o.tools.set_layout.execute({ tiles: [{ kind: "screen", ref: o.prompt.match(/share id (\S+)\)/)[1] }] });
          done({});
          return said;
        };
      }),
  }));
  const late = room();
  late.s.setStage({ mode: "spotlight", items: [late.a.id] }, "Felipe", "main", { person: { id: late.felipe.id, name: "Felipe" } });
  (late.s as any).dropLock("main");
  const sh = late.s.startShare("felipe-laptop", "screen");
  const placing = late.hub.brain.placeShare(sh);
  // Something else goes up (unlocked) while the presenter thinks.
  late.s.setStage({ mode: "agents" }, "Room brain", "main", { override: true });
  const said = String(await act());
  await placing;
  expect(late.s.stage().mode).toBe("agents");
  expect(said).toContain("The screen changed while you were deciding");

  const ended = room();
  const sh2 = ended.s.startShare("felipe-laptop", "screen");
  const placing2 = ended.hub.brain.placeShare(sh2);
  ended.s.endShare(sh2.id);
  await act();
  await placing2;
  expect(ended.s.stage().mode).not.toBe("layout");
});

test("a late presenter layout of the share plus another tile is refused whole once the share ended, and one that leaves the share out is refused too", async () => {
  let act: (tiles: any[]) => Promise<unknown> = async () => {};
  mock.module("ai", () => ({
    ...ai,
    generateText: (o: any) =>
      new Promise((done) => {
        act = async (tiles: any[]) => {
          const id = o.prompt.match(/share id (\S+)\)/)[1];
          const said = await o.tools.set_layout.execute({ tiles: tiles.map((t) => (t.kind === "screen" ? { ...t, ref: id } : t)) });
          done({});
          return said;
        };
      }),
  }));
  const r = room();
  const before = r.s.stage();
  const sh = r.s.startShare("felipe-laptop", "screen");
  const placing = r.hub.brain.placeShare(sh);
  // The share ends before it was ever shown; the model then answers with the share and another tile.
  r.s.endShare(sh.id);
  await act([{ kind: "screen" }, { kind: "artifact", ref: r.a.id }]);
  await placing;
  expect(r.s.stage().mode).toBe(before.mode);
  expect(r.s.stage().layout).toBeUndefined();

  // Live share, but the layout leaves it out: refused, not committed as some other screen.
  const live = room();
  const sh2 = live.s.startShare("felipe-laptop", "screen");
  const placing2 = live.hub.brain.placeShare(sh2);
  const said = String(await act([{ kind: "artifact", ref: live.a.id }]));
  await placing2;
  expect(said).toContain("must include the share");
  expect(live.s.stage().layout?.tiles.some((t) => t.kind === "artifact")).not.toBe(true);
});

test("a share the presenter places on an extra screen gives that screen back what it showed, and main keeps its own", async () => {
  mock.module("ai", () => ({
    ...ai,
    generateText: async (o: any) => {
      const id = o.prompt.match(/share id (\S+)\)/)[1];
      await o.tools.set_layout.execute({ tiles: [{ kind: "screen", ref: id }], screen: "screen-2" });
      return {};
    },
  }));
  const r = room();
  const info = { width: 1920, height: 1080, dpr: 2, screenX: 0, screenY: 0, at: Date.now() };
  r.s.reportScreen("main", info);
  r.s.reportScreen("screen-2", { ...info, screenX: 1920 });
  r.s.setStage({ mode: "spotlight", items: [r.a.id], title: "Pricing" }, "Chey", "screen-2", { override: true });
  r.s.setStage({ mode: "agents", pinned: true }, "Chey", "main", { override: true });
  const sh = r.s.startShare("felipe-laptop", "screen");
  await r.hub.brain.placeShare(sh);
  expect(r.s.stage("screen-2").mode).toBe("layout");
  expect(r.s.stage().mode).toBe("agents");
  r.s.endShare(sh.id);
  expect(r.s.stage("screen-2").mode).toBe("spotlight");
  expect(r.s.stage("screen-2").items).toEqual([r.a.id]);
  expect(r.s.stage().mode).toBe("agents");
});

test("main locked by someone else: the share goes to a free extra screen, and gives it back at the end", async () => {
  mock.module("ai", () => ({ ...ai, generateText: async () => { throw new Error("presenter down"); } }));
  const r = room();
  const info = { width: 1920, height: 1080, dpr: 2, screenX: 0, screenY: 0, at: Date.now() };
  r.s.reportScreen("main", info);
  r.s.reportScreen("screen-2", { ...info, screenX: 1920 });
  r.s.setStage({ mode: "spotlight", items: [r.a.id] }, "Chey", "main", { person: { id: r.chey.id, name: "Chey" } });
  r.s.setStage({ mode: "agents" }, "Chey", "screen-2", { override: true });
  const sh = r.s.startShare("felipe-laptop", "screen");
  await r.hub.brain.placeShare(sh);
  expect(r.s.stage().mode).toBe("spotlight");
  expect(r.s.stage("screen-2").mode).toBe("layout");
  r.s.endShare(sh.id);
  expect(r.s.stage("screen-2").mode).toBe("agents");
});

test("a restart with a live share still gives the screens back what the share hid", async () => {
  mock.module("ai", () => ({ ...ai, generateText: async () => { throw new Error("presenter down"); } }));
  const r = room();
  r.s.setStage({ mode: "spotlight", items: [r.a.id], title: "Pricing" }, "Chey", "main", { person: { id: r.felipe.id, name: "Felipe" } });
  const sh = r.s.startShare("felipe-laptop", "screen");
  await r.hub.brain.placeShare(sh);
  expect(r.s.stage().mode).toBe("layout");
  // A new session over the same store, as after a restart.
  const { Session } = await import("../src/session");
  const again = new Session(r.s.store);
  expect(again.store.get("shares", sh.id)?.status).toBe("ended");
  expect(again.stage().mode).toBe("spotlight");
  expect(again.stage().lock?.by).toBe("Felipe");
});

test("a screen the sharer pinned and locked themself (an HTTP cast is pinned by default) takes their own share on a single display", async () => {
  mock.module("ai", () => ({ ...ai, generateText: async () => { throw new Error("presenter down"); } }));
  const r = room();
  r.s.setStage({ mode: "spotlight", items: [r.a.id], pinned: true }, "Felipe", "main", { person: { id: r.felipe.id, name: "Felipe" } });
  expect(r.s.stage().pinned).toBe(true);
  const sh = r.s.startShare("felipe-laptop", "screen");
  await r.hub.brain.placeShare(sh);
  expect(r.s.stage().mode).toBe("layout");
  expect(r.s.stage().lock?.by).toBe("Felipe");
  r.s.endShare(sh.id);
  expect(r.s.stage().mode).toBe("spotlight");
});

test("the presenter's set_layout is bound to the screen chosen for the share: another screen, or none (main), is refused", async () => {
  let said: string[] = [];
  mock.module("ai", () => ({
    ...ai,
    generateText: async (o: any) => {
      const id = o.prompt.match(/share id (\S+)\)/)[1];
      said = [];
      for (const screen of ["main", undefined, "screen-2"]) said.push(String(await o.tools.set_layout.execute({ tiles: [{ kind: "screen", ref: id }], ...(screen ? { screen } : {}) })));
      return {};
    },
  }));
  const r = room();
  const info = { width: 1920, height: 1080, dpr: 2, screenX: 0, screenY: 0, at: Date.now() };
  r.s.reportScreen("main", info);
  r.s.reportScreen("screen-2", { ...info, screenX: 1920 });
  // Main is pinned by a person (no lock), so the share is bound for screen-2.
  r.s.setStage({ mode: "agents", pinned: true }, "Chey", "main", { override: true });
  r.s.store.setSetting("stage", { ...r.s.stage(), by: "Chey", pinned: true });
  const sh = r.s.startShare("felipe-laptop", "screen");
  await r.hub.brain.placeShare(sh);
  expect(r.s.stage().mode).toBe("agents");
  expect(said[0]).toContain("not another one");
  expect(r.s.stage("screen-2").layout?.tiles.length).toBe(1);
});

test("an interrupted ending is finished at startup: an ended share whose snapshot remains gives the screen back", async () => {
  mock.module("ai", () => ({ ...ai, generateText: async () => { throw new Error("presenter down"); } }));
  const r = room();
  r.s.setStage({ mode: "spotlight", items: [r.a.id], title: "Pricing" }, "Felipe", "main", { person: { id: r.felipe.id, name: "Felipe" } });
  const sh = r.s.startShare("felipe-laptop", "screen");
  await r.hub.brain.placeShare(sh);
  // The old ending's first write landed (status) and nothing after it.
  r.s.store.put("shares", { ...r.s.store.get("shares", sh.id)!, status: "ended" });
  const { Session } = await import("../src/session");
  const again = new Session(r.s.store);
  expect(again.stage().mode).toBe("spotlight");
  expect(again.store.setting<Record<string, unknown>>("beforeShare", {})[sh.id]).toBeUndefined();
});

test("store.atomic: a throw in the middle undoes every write in it", () => {
  const r = room();
  const before = r.s.store.setting("probe", "none");
  expect(() => r.s.store.atomic(() => { r.s.store.setSetting("probe", "half"); throw new Error("boom"); })).toThrow("boom");
  expect(r.s.store.setting("probe", "none")).toBe(before);
  r.s.store.atomic(() => r.s.store.setSetting("probe", "done"));
  expect(r.s.store.setting("probe", "none")).toBe("done");
});
