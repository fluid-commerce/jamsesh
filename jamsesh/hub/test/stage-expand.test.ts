import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "../src/session";
import { Store } from "../src/store";

const dir = mkdtempSync(join(tmpdir(), "jam-expand-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("expanding a tile marks it on the stage in place; collapsing and a new stage clear it", async () => {
  const s = new Session(new Store(dir));
  const first = s.setStage({ mode: "compare", items: ["a", "b"], title: "Login" }, "Chey");
  await Bun.sleep(5);
  const open = s.expandTile("b");
  expect(open.expanded).toBe("b");
  expect(s.stage().expanded).toBe("b");
  // Same stage, not a new one: it keeps its age, who put it up and what's on it.
  expect(open.since).toBe(first.since);
  expect(open.by).toBe("Chey");
  expect(open.items).toEqual(["a", "b"]);
  // Another tile replaces it; asking again changes nothing.
  expect(s.expandTile("a").expanded).toBe("a");
  expect(s.expandTile("a").expanded).toBe("a");
  expect(s.expandTile(null).expanded).toBeUndefined();
  expect(s.stage().expanded).toBeUndefined();
  s.expandTile("a");
  s.setStage({ mode: "spotlight", items: ["a"] }, "Chey");
  expect(s.stage().expanded).toBeUndefined();
});

test("the join screen has nothing to expand; an extra screen keeps its own expanded tile", () => {
  const s = new Session(new Store(mkdtempSync(join(tmpdir(), "jam-expand2-"))));
  s.setStage({ mode: "join" }, "Chey");
  expect(s.expandTile("a").expanded).toBeUndefined();
  const info = { width: 1920, height: 1080, dpr: 2, screenX: 0, screenY: 0, at: Date.now() };
  s.reportScreen("main", info);
  s.reportScreen("screen-2", { ...info, screenX: 1920 });
  s.setStage({ mode: "compare", items: ["a", "b"] }, "Chey", "screen-2");
  expect(s.expandTile("b", "screen-2").expanded).toBe("b");
  expect(s.stage("screen-2").expanded).toBe("b");
  expect(s.stage().expanded).toBeUndefined();
  expect(s.expandTile("x".repeat(200), "screen-2").expanded?.length).toBe(80);
});

test("a locked screen can still be expanded: the lock, its owner and its history stay, and each screen keeps its own", () => {
  const s = new Session(new Store(mkdtempSync(join(tmpdir(), "jam-expand3-"))));
  const chey = s.upsertPerson({ name: "Chey" });
  const info = { width: 1920, height: 1080, dpr: 2, screenX: 0, screenY: 0, at: Date.now() };
  s.reportScreen("main", info);
  s.reportScreen("screen-2", { ...info, screenX: 1920 });
  const put = s.setStage({ mode: "compare", items: ["a", "b"] }, "Chey", "screen-2", { person: chey });
  expect(s.lockOf("screen-2")?.personId).toBe(chey.id);
  const history = s.stageHistory("screen-2").length;
  const open = s.expandTile("b", "screen-2");
  expect(open.expanded).toBe("b");
  expect(open.lock?.personId).toBe(chey.id);
  expect(open.since).toBe(put.since);
  expect(s.lockOf("screen-2")?.personId).toBe(chey.id);
  expect(s.stageHistory("screen-2").length).toBe(history);
  // Another person can look closer at a locked screen, but still can't replace it.
  s.setStage({ mode: "board" }, "Agent", "screen-2");
  expect(s.stage("screen-2").mode).toBe("compare");
  expect(s.stage("screen-2").expanded).toBe("b");
  // The main screen is its own stage.
  expect(s.stage("main").expanded).toBeUndefined();
});
