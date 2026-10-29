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
