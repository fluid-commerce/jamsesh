import "fake-indexeddb/auto";
import { expect, test } from "bun:test";

(globalThis as any).location ??= { origin: "http://127.0.0.1:4790", pathname: "/client", search: "" };
(globalThis as any).navigator ??= {};

const { historyCursor, capFeed, feedAdmits, Generation } = await import("../src/shared/ui");

test("history pages from the oldest event the window has, even when the feed shows none of them", () => {
  // The state's window: only canvas and system events, none the feed shows.
  expect(historyCursor([910, 905, 930])).toBe(905);
  expect(historyCursor(new Map([[40, {}], [12, {}]]).keys())).toBe(12);
  expect(historyCursor([])).toBeUndefined();
});

test("the feed's size cap always applies and the list stays contiguous: following cuts the oldest end, scrolled away the newest", () => {
  const mk = (n: number) => new Map(Array.from({ length: n }, (_, i) => [i + 1, {}] as [number, unknown]));
  const a = mk(20);
  expect(capFeed(a, true, 10)).toBe("oldest");
  expect([...a.keys()]).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  const b = mk(20);
  expect(capFeed(b, false, 10)).toBe("newest"); // scrolled away: still capped, still an unbroken run
  expect([...b.keys()].sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  expect(capFeed(mk(10), false, 10)).toBeNull();
});

test("while the reader is away nothing newer than the line they left is added, so the list never has a gap", () => {
  expect(feedAdmits(true, 0, 500)).toBe(true);
  expect(feedAdmits(false, 100, 101)).toBe(false);
  expect(feedAdmits(false, 100, 100)).toBe(true);
  expect(feedAdmits(false, 100, 40)).toBe(true);
  // Simulated: away at 100, events 101..110 arrive and are only counted; returning rebuilds from the live state.
  const list = new Map<number, unknown>([[98, 1], [99, 1], [100, 1]]);
  for (let id = 101; id <= 110; id++) if (feedAdmits(false, 100, id)) list.set(id, 1);
  expect([...list.keys()]).toEqual([98, 99, 100]);
  list.clear();
  for (let id = 61; id <= 110; id++) if (feedAdmits(true, 100, id)) list.set(id, 1);
  const ids = [...list.keys()];
  expect(ids[ids.length - 1] - ids[0] + 1).toBe(ids.length); // contiguous, ends at the newest
});

test("a history response asked for before a reset to the latest window is dropped", async () => {
  const gen = new Generation();
  const seen = new Map<number, string>([[200, "latest"]]);
  const ask = (rows: number[], delay: number) => {
    const asked = gen.n;
    return new Promise<void>((r) =>
      setTimeout(() => {
        if (!gen.stale(asked)) for (const id of rows) seen.set(id, "history");
        r();
      }, delay),
    );
  };
  const slow = ask([10, 11], 30); // in flight...
  gen.bump(); // ...when Latest resets the feed
  const fresh = ask([150, 151], 1);
  await Promise.all([slow, fresh]);
  expect([...seen.keys()].sort((a, b) => a - b)).toEqual([150, 151, 200]);
});
