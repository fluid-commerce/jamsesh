import { expect, test } from "bun:test";
import type { Artifact, HubState } from "../src/shared/hub";

(globalThis as any).location ??= { origin: "http://127.0.0.1:4790", pathname: "/client", search: "" };
(globalThis as any).navigator ??= {};
const { stageTiles } = await import("../src/host/Stage");

const art = (id: string, title = id) => ({ id, title, kind: "screenshot", variant: "", group: "" }) as unknown as Artifact;

test("a window's tiles are the hub's keys in the hub's order; it works out none itself", () => {
  const artifacts = [art("a", "Zeta"), art("b", "Alpha"), art("c")];
  const state = {
    artifacts,
    agents: [],
    shares: [],
    stage: { mode: "layout", screenId: "screen-2", layout: { tiles: [{ kind: "feed" }, { kind: "artifact", artifactId: "b" }] } },
    // Whatever keys and order the hub sends, including ones the web couldn't have guessed.
    stageTiles: { main: [{ key: "a", artifactId: "a" }], "screen-2": [{ key: "k-second", layoutIndex: 1, artifactId: "b" }, { key: "k-first", layoutIndex: 0 }, { key: "gone", layoutIndex: 7 }] },
  } as unknown as HubState;
  const tiles = stageTiles(state);
  // The hub's order and keys; a tile the stage doesn't have (yet) is left out rather than guessed.
  expect(tiles.map((t) => [t.key, t.label])).toEqual([["k-second", "Alpha"], ["k-first", "Room"]]);
  // The main screen's list is the main screen's; a stage with no list from the hub has nothing to expand.
  expect(stageTiles({ ...state, stage: { mode: "spotlight", items: ["a", "c"] } } as unknown as HubState).map((t) => t.key)).toEqual(["a"]);
  expect(stageTiles({ ...state, stageTiles: {} } as unknown as HubState)).toEqual([]);
});
