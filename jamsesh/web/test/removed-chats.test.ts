// Letting a removed chat back in is a permission change: offline, or behind a backlog, it fails at once
// instead of being kept to replay later while the panel looks as if it failed.
import "fake-indexeddb/auto";
import { expect, test } from "bun:test";

(globalThis as any).location ??= { origin: "http://127.0.0.1:4790", pathname: "/client", search: "" };
(globalThis as any).navigator ??= {};
Object.defineProperty(globalThis.navigator, "onLine", { value: true, configurable: true });

const { api, OfflineError } = await import("../src/shared/hub");
const { outbox } = await import("../src/shared/offline");

test("Allow again is never queued: an unreachable hub, or a backlog, throws and queues nothing", async () => {
  const realFetch = globalThis.fetch;
  await outbox.load();
  const before = outbox.get().pending;
  globalThis.fetch = (async () => {
    throw new TypeError("network down");
  }) as any;
  try {
    await expect(api("/removed-chats/rc_1/allow", {}, "POST", { queue: false })).rejects.toBeInstanceOf(OfflineError);
    // Even a caller that forgets queue:false gets the same: the route is never queueable.
    await expect(api("/removed-chats/rc_1/allow", {})).rejects.toBeInstanceOf(OfflineError);
    expect(outbox.get().pending).toBe(before);
    // With a backlog already waiting, it still goes straight to the hub.
    await outbox.enqueue("POST", "/say", { text: "waiting" }, "idem-backlog");
    const seen: string[] = [];
    globalThis.fetch = (async (url: string) => (seen.push(String(url)), Response.json({ ok: true }))) as any;
    await api("/removed-chats/rc_1/allow", {});
    expect(seen.filter((u) => u.includes("allow"))).toEqual(["/api/removed-chats/rc_1/allow"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});
