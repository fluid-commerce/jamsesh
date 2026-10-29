import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "../src/session";
import { Store } from "../src/store";

const dir = mkdtempSync(join(tmpdir(), "jam-screens-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("a closed big screen stops being routable at once; main too, until its window reports again", () => {
  const s = new Session(new Store(dir));
  const info = { width: 1920, height: 1080, dpr: 2, screenX: 0, screenY: 0, at: Date.now() };
  s.reportScreen("main", info);
  s.reportScreen("screen-2", { ...info, screenX: 1920 });
  expect(s.screens().map((sc) => sc.id)).toEqual(["main", "screen-2"]);
  s.setStage({ mode: "compare", title: "Nav", items: ["a", "b"] }, "x");
  s.removeScreen("screen-2");
  s.removeScreen("screen-9");
  expect(s.screens().map((sc) => sc.id)).toEqual(["main"]);
  s.removeScreen("main");
  expect(s.screens()).toEqual([]);
  // Its stage is kept for when the window opens again.
  expect(s.stage().title).toBe("Nav");
  s.reportScreen("main", info);
  s.reportScreen("screen-2", { ...info, screenX: 1920 });
  expect(s.screens().map((sc) => sc.id)).toEqual(["main", "screen-2"]);
});

test("after a restart, an extra display's brought-up view still returns to the board on its own deadline", async () => {
  const d2 = mkdtempSync(join(tmpdir(), "jam-screens-restart-"));
  const was = Session.STAGE_REVERT_MS;
  Session.STAGE_REVERT_MS = 300;
  try {
    const before = new Session(new Store(d2));
    before.setStage({ mode: "compare", title: "Nav", items: ["a", "b"] }, "Room brain", "screen-2");
    before.setStage({ mode: "compare", title: "Pinned", items: ["a"], pinned: true }, "Felipe", "screen-3");
    // The hub restarts: the old process's timers are gone, and a new session opens the same store before the deadline.
    for (const t of (before as any).screenReverts.values()) clearTimeout(t);
    const after = new Session(new Store(d2));
    expect(after.stage("screen-2").mode).toBe("compare");
    await Bun.sleep(1400); // the remaining time, with the 1-second floor
    expect(after.stage("screen-2").mode).toBe("board");
    expect(after.stage("screen-3").title).toBe("Pinned"); // a person pinned it: it stays
  } finally {
    Session.STAGE_REVERT_MS = was;
    rmSync(d2, { recursive: true, force: true });
  }
});

test("a room's saved model choices keep only the roles that exist (an older room's presenter is dropped)", () => {
  const d3 = mkdtempSync(join(tmpdir(), "jam-models-"));
  try {
    const store = new Store(d3);
    store.setSetting("models", { presenter: "x/old", router: "x/router" });
    const models = new Session(store).settings().models as Record<string, string>;
    expect("presenter" in models).toBe(false);
    expect(models.router).toBe("x/router");
  } finally {
    rmSync(d3, { recursive: true, force: true });
  }
});
