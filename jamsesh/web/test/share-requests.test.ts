import "fake-indexeddb/auto";
import { expect, test } from "bun:test";

(globalThis as any).location ??= { origin: "http://127.0.0.1:4790", pathname: "/client", search: "" };
(globalThis as any).navigator ??= {};

const { waitingRequests } = await import("../src/shared/share");
type Share = Parameters<typeof waitingRequests>[1][number];

const share = (id: string, status: Share["status"]): Share => ({ id, deviceId: "d", personId: "p", personName: "Pat", kind: "screen", label: "", status, reason: "", startedAt: 0 });
const req = (shareId: string, at: number, listed?: boolean) => ({ shareId, kind: "screen" as const, reason: "", by: "Host", at, listed });

test("a second window drops a prompt once another window answers it, or it is declined or expires", () => {
  const now = 100_000;
  const q = [req("a", now - 50), req("b", now - 50, true), req("c", now - 50, true)];
  // Answered in another window (live), declined (gone from the list), still waiting.
  const next = waitingRequests(q, [share("a", "requested"), share("c", "live")], now);
  expect(next.map((r) => r.shareId)).toEqual(["a"]);
  expect(next[0].listed).toBe(true);
});

test("a brand-new prompt waits briefly for the state to list it, then goes", () => {
  const now = 100_000;
  expect(waitingRequests([req("a", now - 500)], [], now).map((r) => r.shareId)).toEqual(["a"]);
  expect(waitingRequests([req("a", now - 11_000)], [], now)).toEqual([]);
  // Once listed, dropping out of the list ends it at once (answered, declined or expired).
  expect(waitingRequests([req("a", now - 500, true)], [], now)).toEqual([]);
});

test("an unchanged queue is the same array, so the prompt doesn't re-render", () => {
  const q = [req("a", 0, true)];
  expect(waitingRequests(q, [share("a", "requested")], 1)).toBe(q);
});
