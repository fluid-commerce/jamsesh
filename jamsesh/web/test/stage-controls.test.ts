import "fake-indexeddb/auto";
import { expect, test } from "bun:test";
import type { ShowRequest } from "../src/shared/hub";

(globalThis as any).location ??= { origin: "http://127.0.0.1:4790", pathname: "/client", search: "" };
(globalThis as any).navigator ??= {};
const online = (on: boolean) => Object.defineProperty(globalThis.navigator, "onLine", { value: on, configurable: true });
online(true);
const { agoWords, showAsksFor, stageAction } = await import("../src/shared/StageControls");
const { outbox } = await import("../src/shared/offline");

test("badges say how long ago in words", () => {
  const now = 1_000_000_000;
  expect(agoWords(now - 5_000, now)).toBe("just now");
  expect(agoWords(now - 40_000, now)).toBe("40 s ago");
  expect(agoWords(now - 2 * 60_000, now)).toBe("2 min ago");
  expect(agoWords(now - 3 * 3_600_000, now)).toBe("3 h ago");
});

// Every screen control the bars, the strip, the cast picker and the owner's question send.
const controls: [string, Record<string, unknown>][] = [
  ["/stage", { mode: "spotlight", items: ["a"] }],
  ["/stage/unlock", { screen: "main" }],
  ["/stage/restore", { id: "his_1", screen: "main" }],
  ["/stage/ready/rdy_1", { action: "show" }],
  ["/stage/ready/rdy_1", { action: "dismiss" }],
  ["/show-requests/shw_1", { approve: true }],
];

test("offline, screen controls go nowhere later and the person is told; online, the hub's refusal is said", async () => {
  const sent: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    if (url === "/api/pair/info") return Response.json({ hostId: "h" });
    sent.push(url);
    return Response.json({});
  }) as typeof fetch;
  // Other files in this process may have left calls queued: count only what this test adds.
  await outbox.load();
  const before = outbox.get().pending;
  try {
    online(false);
    for (const [path, body] of controls) expect(await stageAction(path, body)).toBe("Not connected to the host. Try again when you're back.");
    expect(sent).toEqual([]);
    // Nothing waits in the outbox to replay over a later lock once the laptop is back.
    expect(outbox.get().pending).toBe(before);

    online(true);
    for (const [path, body] of controls) expect(await stageAction(path, body)).toBe("");
    expect(sent).toEqual(controls.map(([p]) => `/api${p}`));
    // The connection drops mid-call: not saved for later either.
    globalThis.fetch = (async () => {
      throw new TypeError("network down");
    }) as typeof fetch;
    expect(await stageAction("/stage/unlock", { screen: "main" })).toBe("Not connected to the host. Try again when you're back.");
    expect(outbox.get().pending).toBe(before);
    globalThis.fetch = (async () => Response.json({ error: "Felipe has this screen locked. Unlock it first to bring something else back." }, { status: 409 })) as typeof fetch;
    expect(await stageAction("/stage/restore", { id: "his_1" })).toBe("Felipe has this screen locked. Unlock it first to bring something else back.");
  } finally {
    globalThis.fetch = realFetch;
    online(true);
  }
});

const ask = (id: string, screen: string, ownerId: string | null, status: ShowRequest["status"] = "pending"): ShowRequest =>
  ({ id, at: 0, screen, ownerId, ownerName: "Chey", agentName: "Agent", agentOwner: "Felipe", label: "Build", readyId: "r", status }) as ShowRequest;

test("a question about a screen shows on that screen and in its owner's window, not on the other displays", () => {
  const all = [ask("main-q", "main", "chey"), ask("right-q", "screen-2", "chey"), ask("felipe-q", "screen-2", "felipe"), ask("old", "screen-2", "chey", "approved")];
  const ids = (v: Parameters<typeof showAsksFor>[1]) => showAsksFor(all, v).map((r) => r.id);
  expect(ids({ big: true, screen: "main" })).toEqual(["main-q"]);
  expect(ids({ big: true })).toEqual(["main-q"]);
  expect(ids({ big: true, screen: "screen-2" })).toEqual(["right-q", "felipe-q"]);
  expect(ids({ big: true, screen: "screen-3" })).toEqual([]);
  // A person's own window: every pending question to them, whichever screen; nobody's window answers for a lock with no owner.
  expect(ids({ me: "chey" })).toEqual(["main-q", "right-q"]);
  expect(ids({ me: "felipe" })).toEqual(["felipe-q"]);
  expect(showAsksFor([ask("x", "main", null)], { me: undefined })).toEqual([]);
});
