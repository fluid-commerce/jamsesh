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
const { Session } = await import("../src/session");
const { Store } = await import("../src/store");
/** A restart: close the database and open the same file again. */
function reopen(r: { s: any; dataDir: string }) {
  r.s.store.db.close();
  return new Session(new Store(r.dataDir));
}

const dir = mkdtempSync(join(tmpdir(), "jam-share-delay-"));
const hubs: any[] = [];
afterAll(() => {
  for (const h of hubs) h.stop();
  rmSync(dir, { recursive: true, force: true });
});

function room() {
  const dataDir = join(dir, String(Math.random()));
  const hub = new Hub({ canvas: false, whisper: false, dataDir });
  hubs.push(hub);
  const s = hub.session;
  const chey = s.upsertPerson({ name: "Chey" });
  const felipe = s.upsertPerson({ name: "Felipe" });
  s.touchDevice("chey-mac", { label: "Chey's Mac", personId: chey.id, kind: "client" });
  s.touchDevice("felipe-laptop", { label: "Felipe's laptop", personId: felipe.id, kind: "client" });
  const a = s.upsertArtifact({ kind: "screenshot", stage: "built", title: "Pricing", image: "/renders/p.png" });
  return { hub, s, chey, felipe, a, dataDir };
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
  r.s.setStage({ mode: "agents", pinned: true }, "Chey", "main", { person: { id: r.chey.id, name: "Chey" }, noLock: true });
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
  const again = reopen(r);
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
  r.s.setStage({ mode: "agents", pinned: true }, "Chey", "main", { person: { id: r.chey.id, name: "Chey" }, noLock: true });
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
  const again = reopen(r);
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

test("nobody matches nobody: an unclaimed device's share never takes a host lock or a host pin", async () => {
  mock.module("ai", () => ({ ...ai, generateText: async () => { throw new Error("presenter down"); } }));
  const r = room();
  r.s.touchDevice("stray", { label: "Unclaimed laptop", kind: "client" });
  // A host window cast before anyone picked who they are: locked, no person id.
  r.s.setStage({ mode: "spotlight", items: [r.a.id], pinned: true }, "Host", "main", { person: { id: null, name: "Host" } });
  expect(r.s.stage().lock?.personId).toBeNull();
  const sh = r.s.startShare("stray", "screen");
  expect(sh.personId).toBeNull();
  await r.hub.brain.placeShare(sh);
  expect(r.s.stage().mode).toBe("spotlight");
  // Same with a pin and no lock, by a person who has no id of their own: nobody else's share is theirs to take it with.
  r.s.setStage({ mode: "spotlight", items: [r.a.id], pinned: true }, "Host", "main", { person: { id: null, name: "Host" }, noLock: true });
  expect(r.s.stage().lock).toBeUndefined();
  await r.hub.brain.placeShare(sh);
  expect(r.s.stage().mode).toBe("spotlight");
  // A pin by an identified person is that person's to share over.
  r.s.setStage({ mode: "spotlight", items: [r.a.id], pinned: true }, "Felipe", "main", { person: { id: r.felipe.id, name: "Felipe" } });
  expect(r.s.stage().pinnedById).toBe(r.felipe.id);
});

test("a share ending that fails part way changes nothing and runs none of its effects", async () => {
  mock.module("ai", () => ({ ...ai, generateText: async () => { throw new Error("presenter down"); } }));
  const { bus } = await import("../src/bus");
  const r = room();
  const info = { width: 1920, height: 1080, dpr: 2, screenX: 0, screenY: 0, at: Date.now() };
  r.s.reportScreen("main", info);
  r.s.reportScreen("screen-2", { ...info, screenX: 1920 });
  const sh = r.s.startShare("felipe-laptop", "screen");
  const tiles = { mode: "layout" as const, layout: { tiles: [{ kind: "screen" as const, shareId: sh.id, label: "x" }, { kind: "feed" as const }] } };
  r.s.setStage({ mode: "spotlight", items: [r.a.id] }, "Chey", "main", { override: true });
  r.s.rememberStageFor(sh.id);
  r.s.setStage(tiles, "JamSesh", "main", { override: true });
  r.s.setStage(tiles, "JamSesh", "screen-2", { override: true });
  const revs = [r.s.stageRev("main"), r.s.stageRev("screen-2")];
  const real = r.s.store.setSetting.bind(r.s.store);
  const sent: unknown[] = [];
  const realSend = bus.send.bind(bus);
  (bus as any).send = (m: any) => void sent.push(m);
  (r.s.store as any).setSetting = (k: string, v: unknown) => { if (k === "screenStages") throw new Error("disk full"); real(k, v); };
  expect(() => r.s.endShare(sh.id)).toThrow("disk full");
  (r.s.store as any).setSetting = real;
  (bus as any).send = realSend;
  expect(sent).toEqual([]);
  expect(r.s.store.get("shares", sh.id)?.status).toBe("live");
  expect([r.s.stageRev("main"), r.s.stageRev("screen-2")]).toEqual(revs);
  expect(r.s.stage().layout?.tiles.length).toBe(2);
  expect(r.s.store.setting<Record<string, unknown>>("beforeShare", {})[sh.id]).toBeDefined();
  // And it works once the disk does.
  r.s.endShare(sh.id);
  expect(r.s.stage().layout?.tiles.length).toBe(1);
});

test("an ended share still on a screen with no saved snapshot loses its tile at restart (the board, if it was alone)", async () => {
  mock.module("ai", () => ({ ...ai, generateText: async () => { throw new Error("presenter down"); } }));
  const r = room();
  const sh = r.s.startShare("felipe-laptop", "screen");
  r.s.setStage({ mode: "layout", layout: { tiles: [{ kind: "screen", shareId: sh.id, label: "x" }] } }, "JamSesh", "main", { override: true });
  r.s.store.put("shares", { ...r.s.store.get("shares", sh.id)!, status: "ended" });
  const again = reopen(r);
  // The earlier screen is lost, but the dead tile comes off: the board, since it was alone.
  expect(again.stage().mode).toBe("board");
  expect(again.store.get("shares", sh.id)?.status).toBe("ended");
});

test("at restart a dead share's tile comes off and the other tiles stay", async () => {
  mock.module("ai", () => ({ ...ai, generateText: async () => { throw new Error("presenter down"); } }));
  const r = room();
  const sh = r.s.startShare("felipe-laptop", "screen");
  r.s.setStage({ mode: "layout", layout: { tiles: [{ kind: "feed" }, { kind: "screen", shareId: sh.id, label: "x" }] } }, "JamSesh", "main", { override: true });
  r.s.store.put("shares", { ...r.s.store.get("shares", sh.id)!, status: "ended" });
  const again = reopen(r);
  expect(again.stage().layout?.tiles.map((x: any) => x.kind)).toEqual(["feed"]);
});

test("after Unlock a person's direct pin is nobody's: another person's share takes the screen; before it, not", async () => {
  mock.module("ai", () => ({ ...ai, generateText: async () => { throw new Error("presenter down"); } }));
  const r = room();
  // The brain, asked directly by Chey to pin a view, writes under its own label but records Chey's id.
  const tools = (r.hub.brain as any).tools([{ id: 1, ts: Date.now(), kind: "speech", authorType: "person", authorId: r.chey.id, authorName: "Chey", text: "JamSesh, pin the pricing", data: { direct: true } }], { effects: 0 });
  await tools.show_on_screen.execute({ mode: "spotlight", artifactIds: [r.a.id], pin: true });
  expect(r.s.stage().by).toBe("Room brain");
  expect(r.s.stage().pinnedById).toBe(r.chey.id);
  const sh = r.s.startShare("felipe-laptop", "screen");
  await r.hub.brain.placeShare(sh);
  expect(r.s.stage().mode).toBe("spotlight");
  r.s.releaseLock("main", { owner: r.chey.id });
  expect(r.s.stage().pinnedById).toBeUndefined();
  await r.hub.brain.placeShare(sh);
  expect(r.s.stage().mode).toBe("layout");
});

test("a post-commit effect that throws is logged and never undoes the committed ending or skips the rest", async () => {
  mock.module("ai", () => ({ ...ai, generateText: async () => { throw new Error("presenter down"); } }));
  const { bus } = await import("../src/bus");
  const r = room();
  const sh = r.s.startShare("felipe-laptop", "screen");
  r.s.setStage({ mode: "spotlight", items: [r.a.id] }, "Chey", "main", { override: true });
  r.s.rememberStageFor(sh.id);
  r.s.setStage({ mode: "layout", layout: { tiles: [{ kind: "screen", shareId: sh.id, label: "x" }] } }, "JamSesh", "main", { override: true });
  const realChanged = bus.changed.bind(bus);
  const seen: string[] = [];
  (bus as any).changed = (k: string) => { seen.push(k); if (k === "stageTiles") throw new Error("listener blew up"); realChanged(k); };
  const err = console.error;
  console.error = () => {};
  try {
    r.s.endShare(sh.id);
  } finally {
    (bus as any).changed = realChanged;
    console.error = err;
  }
  expect(r.s.store.get("shares", sh.id)?.status).toBe("ended");
  expect(r.s.stage().mode).toBe("spotlight");
  // The failing listener was the second effect; the ones queued after it still ran.
  expect(seen.indexOf("shares")).toBeLessThan(seen.indexOf("stageTiles"));
  expect(seen.length).toBeGreaterThan(seen.indexOf("stageTiles") + 1);
});

test("a failed BEGIN leaves the store usable: the next atomic write still opens a real transaction", () => {
  const r = room();
  const st = r.s.store as any;
  const real = st.db.exec.bind(st.db);
  let boom = true;
  st.db.exec = (sql: string) => { if (boom && sql.startsWith("BEGIN")) { boom = false; throw new Error("busy"); } return real(sql); };
  expect(() => st.atomic(() => st.setSetting("probe", "x"))).toThrow("busy");
  expect(() => st.atomic(() => { st.setSetting("probe", "half"); throw new Error("boom"); })).toThrow("boom");
  expect(st.setting("probe", "none")).toBe("none");
});

test("an owner who unlocks during their own pinned share doesn't get the pin back when the share ends", async () => {
  mock.module("ai", () => ({ ...ai, generateText: async () => { throw new Error("presenter down"); } }));
  const r = room();
  r.s.setStage({ mode: "spotlight", items: [r.a.id], pinned: true }, "Felipe", "main", { person: { id: r.felipe.id, name: "Felipe" } });
  const sh = r.s.startShare("felipe-laptop", "screen");
  await r.hub.brain.placeShare(sh);
  expect(r.s.stage().lock?.by).toBe("Felipe");
  r.s.releaseLock("main", { owner: r.felipe.id });
  r.s.endShare(sh.id);
  expect(r.s.stage().mode).toBe("spotlight");
  expect(r.s.stage().pinned).toBe(false);
  expect(r.s.stage().pinnedById).toBeUndefined();
  expect((r.s as any).stageRevert).not.toBeNull();
});
