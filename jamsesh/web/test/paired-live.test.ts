// Letting a laptop in as someone, and disconnecting one, only make sense live: with the network down they fail at
// once and leave nothing in the outbox to replay later. Through the real api() and outbox; fetch stubbed.
import "fake-indexeddb/auto";
import { afterEach, expect, test } from "bun:test";
import { api, OfflineError } from "../src/shared/hub";
import { idbTable, outbox } from "../src/shared/offline";

const realFetch = globalThis.fetch;
afterEach(async () => {
  globalThis.fetch = realFetch;
  // Nothing this test queued is left to leak into later tests: no retry timer, no stored or in-memory entry.
  outbox.stop();
  await idbTable("outbox").clear();
  (outbox as any).entries = [];
  (outbox as any).publish();
});

test("with the network down, approving and disconnecting throw and queue nothing; an ordinary edit is queued", async () => {
  await outbox.load();
  const before = outbox.get().pending;
  globalThis.fetch = (async () => {
    throw new TypeError("network down");
  }) as any;
  await expect(api("/paired/dev_1/allow", { personId: "p_1" }, "POST", { queue: false })).rejects.toBeInstanceOf(OfflineError);
  // Even if a caller forgets queue:false.
  await expect(api("/paired/dev_1/allow", { personId: "p_1" }, "POST")).rejects.toBeInstanceOf(OfflineError);
  await expect(api("/paired/dev_1", undefined, "DELETE")).rejects.toBeInstanceOf(OfflineError);
  expect(outbox.get().pending).toBe(before);
  expect(outbox.get().items.some((e: any) => String(e.path).startsWith("/paired"))).toBe(false);
  // The control: a name change is saved for later.
  expect(await api("/people/p_1", { name: "Ana" }, "PATCH")).toMatchObject({ queued: true });
  expect(outbox.get().pending).toBe(before + 1);
});
