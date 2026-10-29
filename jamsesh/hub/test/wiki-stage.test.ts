// "JamSesh, show the wiki graph": the brain's show_on_screen takes a wiki mode, which needs no artifacts and stays up.
//   cd jamsesh/hub && JAMSESH_OFFLINE=1 bun test test/wiki-stage.test.ts
import { expect, test } from "bun:test";
import { stageLabel } from "../src/session";
import { makeRoom } from "./bench";

const call = (tools: any, name: string, input: object) => tools[name].execute(input, { toolCallId: "t", messages: [] }) as Promise<string>;

test("the wiki graph goes on the big screen, pinned so it doesn't fall back to the board", async () => {
  const r = makeRoom();
  const pass = { effects: 0 };
  const tools = r.hub.brain.tools([], pass);
  await call(tools, "show_on_screen", { mode: "wiki" });
  expect(r.hub.session.stage("main")).toMatchObject({ mode: "wiki", pinned: true });
  expect(pass.effects).toBe(1);
  r.stop();
});

test("the room can ask for it unpinned, and the next show replaces it", async () => {
  const r = makeRoom();
  const tools = r.hub.brain.tools([], { effects: 0 });
  await call(tools, "show_on_screen", { mode: "wiki", pin: false });
  expect(r.hub.session.stage("main")).toMatchObject({ mode: "wiki", pinned: false });
  await call(tools, "show_on_screen", { mode: "board" });
  expect(r.hub.session.stage("main").mode).toBe("board");
  r.stop();
});

test("the history strip and the ready queue call it by name", () => {
  expect(stageLabel({ mode: "wiki" })).toBe("The wiki");
});
