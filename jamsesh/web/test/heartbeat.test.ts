import { expect, test } from "bun:test";
import { HEARTBEAT_EVENT, startHeartbeat } from "../src/shared/heartbeat";

test("beats at once and then on a timer, naming the window", async () => {
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  const stop = startHeartbeat({ invoke: async (cmd, args) => void calls.push({ cmd, args }), metadata: { currentWindow: { label: "client" } } }, 5);
  expect(calls).toHaveLength(1);
  await new Promise((r) => setTimeout(r, 30));
  stop();
  const n = calls.length;
  expect(n).toBeGreaterThan(2);
  expect(calls[0]).toEqual({ cmd: "plugin:event|emit", args: { event: HEARTBEAT_EVENT, payload: { label: "client" } } });
  await new Promise((r) => setTimeout(r, 20));
  expect(calls).toHaveLength(n);
});

test("does nothing outside the Mac app, and survives a bridge that throws or rejects", () => {
  expect(() => startHeartbeat(undefined)()).not.toThrow();
  expect(() => startHeartbeat({ invoke: async () => void 0 })()).not.toThrow(); // no window label
  const stop = startHeartbeat(
    { invoke: () => { throw new Error("gone"); }, metadata: { currentWindow: { label: "x" } } },
    1000,
  );
  stop();
  const stop2 = startHeartbeat({ invoke: () => Promise.reject(new Error("denied")), metadata: { currentWindow: { label: "x" } } }, 1000);
  stop2();
});
