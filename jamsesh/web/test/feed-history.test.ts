import "fake-indexeddb/auto";
import { expect, test } from "bun:test";

(globalThis as any).location ??= { origin: "http://127.0.0.1:4790", pathname: "/client", search: "" };
(globalThis as any).navigator ??= {};

const { historyCursor } = await import("../src/shared/ui");

test("history pages from the oldest event the window has, even when the feed shows none of them", () => {
  // The state's window: only canvas and system events, none the feed shows.
  expect(historyCursor([910, 905, 930])).toBe(905);
  expect(historyCursor(new Map([[40, {}], [12, {}]]).keys())).toBe(12);
  expect(historyCursor([])).toBeUndefined();
});
