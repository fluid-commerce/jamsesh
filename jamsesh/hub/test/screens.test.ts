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
  s.setStage({ mode: "spotlight", title: "A" }, "Maya", "screen-2");
  expect(s.stage("screen-2").screenId).toBe("screen-2");
  expect(s.stage().screenId).toBeUndefined();
  s.setStage({ mode: "board" }, "Maya");
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
    const named = await (await post("/screens/config", { screens: [{ id: "main", name: "Left TV" }, { id: "screen-2", name: "Right TV" }] })).json();
    expect(named.screens.map((sc: any) => sc.name)).toEqual(["Left TV", "Right TV"]);
    const s = hub.session;
    await post("/stage", { mode: "spotlight", title: "to the right", by: "Maya", screen: "right tv" });
    expect(s.stage("screen-2").title).toBe("to the right");
    expect(s.stage().title).not.toBe("to the right");
    // No screen, or one that isn't there: the main screen.
    await post("/stage", { mode: "spotlight", title: "default", by: "Maya" });
    await post("/stage", { mode: "spotlight", title: "nowhere", by: "Maya", screen: "kitchen" });
    expect(s.stage().title).toBe("nowhere");
    expect(s.stage("screen-2").title).toBe("to the right");
    // The brain: "put it on the left TV".
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
