import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "../src/session";
import { Store } from "../src/store";

const dir = mkdtempSync(join(tmpdir(), "jam-screens-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("a closed big screen stops being routable at once; the main screen stays", () => {
  const s = new Session(new Store(dir));
  const info = { width: 1920, height: 1080, dpr: 2, screenX: 0, screenY: 0, at: Date.now() };
  s.reportScreen("main", info);
  s.reportScreen("screen-2", { ...info, screenX: 1920 });
  expect(s.screens().map((sc) => sc.id)).toEqual(["main", "screen-2"]);
  s.removeScreen("screen-2");
  s.removeScreen("main");
  s.removeScreen("screen-9");
  expect(s.screens().map((sc) => sc.id)).toEqual(["main"]);
  s.reportScreen("screen-2", { ...info, screenX: 1920 });
  expect(s.screens().map((sc) => sc.id)).toEqual(["main", "screen-2"]);
});

test("screens carry the names the host app gave them, and are found by name", () => {
  const s = new Session(new Store(mkdtempSync(join(dir, "n-"))));
  const info = { width: 1920, height: 1080, dpr: 1, screenX: 0, screenY: 0, at: Date.now() };
  s.reportScreen("main", info);
  s.reportScreen("screen-2", { ...info, screenX: 1920 });
  // No names yet: plain ones.
  expect(s.screens().map((sc) => [sc.id, sc.name, sc.role])).toEqual([["main", "Main screen", "main"], ["screen-2", "Screen 2", "extra"]]);
  s.configureScreens([{ id: "main", name: "Left TV" }, { id: "screen-2", name: " Right TV " }, { id: "../x", name: "bad" }]);
  expect(s.screens().map((sc) => sc.name)).toEqual(["Left TV", "Right TV"]);
  expect(s.findScreen("the left tv")?.id).toBe("main");
  expect(s.findScreen("Right")?.id).toBe("screen-2");
  expect(s.findScreen("screen-2")?.id).toBe("screen-2");
  expect(s.findScreen("kitchen")).toBeUndefined();
  expect(s.findScreen("")).toBeUndefined();
  // Each screen has its own stage, stamped with its id.
  s.setStage({ mode: "spotlight", items: ["x"], title: "A" }, "Maya", "screen-2", { claim: s.stageClaim() });
  expect(s.stage("screen-2").screenId).toBe("screen-2");
  expect(s.stage().screenId).toBeUndefined();
  s.setStage({ mode: "board" }, "Maya", "main", { claim: s.stageClaim() });
  expect(s.stage().screenId).toBe("main");
  expect(s.screens()[1].stage.title).toBe("A");
});

test("a cast goes to the chosen screen, and the brain can name one", async () => {
  const { Hub } = await import("../src/hub");
  const { startHttp } = await import("../src/http");
  const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, "hub") });
  const server = startHttp(hub, 0);
  try {
    const base = `http://127.0.0.1:${server.port}`;
    // The host's own window, as in the other http tests.
    const win = { cookie: `jam_window=${hub.auth.windows.take(hub.auth.windows.mint())}` };
    const post = (path: string, body: object, extra: Record<string, string> = {}) => fetch(`${base}/api${path}`, { method: "POST", headers: { "content-type": "application/json", ...win, ...extra }, body: JSON.stringify(body) });
    const size = { width: 1920, height: 1080, dpr: 1, screenY: 0 };
    await post("/display", { ...size, screen: "main", screenX: 1 });
    await post("/display", { ...size, screen: "screen-2", screenX: 1921 });
    // Only the host's own machine names screens; the relay marks anyone else's request.
    expect((await post("/screens/config", { screens: [{ id: "main", name: "x" }] }, { "x-forwarded-for": "9.9.9.9" })).status).toBeGreaterThanOrEqual(401);
    // Nor another process on the host without the app's window key.
    const bare = await fetch(`${base}/api/screens/config`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ screens: [{ id: "main", name: "Hijacked" }] }) });
    expect(bare.status).toBe(403);
    expect(hub.session.screens().some((sc) => sc.name === "Hijacked")).toBe(false);
    const named = await (await post("/screens/config", { screens: [{ id: "main", name: "Left TV" }, { id: "screen-2", name: "Right TV" }] })).json();
    expect(named.screens.map((sc: any) => sc.name)).toEqual(["Left TV", "Right TV"]);
    const s = hub.session;
    await post("/stage", { mode: "spotlight", items: ["x"], title: "to the right", by: "Maya", screen: "right tv" });
    expect(s.stage("screen-2").title).toBe("to the right");
    expect(s.stage().title).not.toBe("to the right");
    // No screen named: the main one. One that isn't there is refused, never put on the main screen instead.
    await post("/stage", { mode: "spotlight", items: ["x"], title: "default", by: "Maya" });
    expect((await post("/stage", { mode: "spotlight", items: ["x"], title: "nowhere", by: "Maya", screen: "kitchen" })).status).toBe(404);
    expect(s.stage().title).toBe("default");
    expect(s.stage("screen-2").title).toBe("to the right");
    // The brain: "put it on the left TV".
    (s as any).dropLock("main"); // Maya's casts above locked the screens she cast to
    (s as any).dropLock("screen-2");
    const tools = hub.brain.tools([], { effects: 0 });
    await (tools as any).show_on_screen.execute({ mode: "agents", screen: "the Left TV" }, { toolCallId: "t", messages: [] });
    expect(s.stage().mode).toBe("agents");
    await (tools as any).show_on_screen.execute({ mode: "join", screen: "Right TV" }, { toolCallId: "t", messages: [] });
    expect(s.stage("screen-2").mode).toBe("join");
    expect(s.stage().mode).toBe("agents");
  } finally {
    server.stop(true);
    hub.devproxy.stop();
  }
});

test("an extra screen nothing was put on has one stable default stage of its own, whatever the main screen shows", () => {
  const s = new Session(new Store(mkdtempSync(join(dir, "def-"))));
  const info = { width: 1920, height: 1080, dpr: 2, screenX: 0, screenY: 0, at: Date.now() };
  s.reportScreen("main", info);
  s.reportScreen("screen-2", { ...info, screenX: 1920 });
  s.setStage({ mode: "layout", layout: { tiles: [{ kind: "feed" }] } }, "Chey", "main", { override: true });
  const a = s.stage("screen-2");
  expect(a.screenId).toBe("screen-2");
  expect(s.stage("screen-2").since).toBe(a.since);
  expect(s.screens().find((x) => x.id === "screen-2")?.stage.since).toBe(a.since);
  expect(s.stage().screenId).toBe("main");
  s.removeScreen("screen-2");
});
