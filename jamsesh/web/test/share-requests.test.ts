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

test("a request the state lists for this person is asked again after a reload, once; one already answered is not", async () => {
  const { missedRequests } = await import("../src/shared/share");
  const shares: any[] = [
    { id: "sh1", personId: "p1", kind: "screen", status: "requested", reason: "the build", deviceId: "d", personName: "A", label: "", startedAt: 1 },
    { id: "sh2", personId: "p2", kind: "camera", status: "requested", reason: "", deviceId: "d", personName: "B", label: "", startedAt: 1 },
    { id: "sh3", personId: "p1", kind: "camera", status: "live", reason: "", deviceId: "d", personName: "A", label: "", startedAt: 1 },
  ];
  const got = missedRequests([], shares, "p1");
  expect(got.map((r) => r.shareId)).toEqual(["sh1"]); // only a request for this person, only one still waiting
  expect(missedRequests(got, shares, "p1")).toEqual([]); // already in the queue
  expect(missedRequests([], shares, "")).toEqual([]);
});
