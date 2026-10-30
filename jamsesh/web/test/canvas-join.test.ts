// A person's canvas joins inside its iframe; the page reads how that's going and rejoins when it
// fails, instead of leaving a blank document up.
import { expect, test } from "bun:test";
import { canvasSrc, friendlyReason, JoinWatch, RejoinTimer, joinLabel, joinStateOf, rejoinDelay } from "../src/shared/canvasJoin";

test("the join state comes from the canvas's own session", () => {
  expect(joinStateOf({ status: "live" })).toEqual({ state: "live" });
  expect(joinStateOf({ status: "connecting" })).toEqual({ state: "connecting" });
  expect(joinStateOf({ status: "reconnecting", reason: "connection lost" })).toEqual({ state: "reconnecting", reason: "connection lost" });
  expect(joinStateOf({ status: "failed", reason: "This device isn't paired" })).toEqual({ state: "failed", reason: "This device isn't paired" });
  // The blank document the canvas starts on isn't in a session; the join shows in `sessions`.
  expect(joinStateOf({ status: "off", sessions: [{ status: "connecting" }] })).toEqual({ state: "connecting" });
  expect(joinStateOf({ status: "off", sessions: [{ status: "failed", reason: "401" }] })).toEqual({ state: "failed", reason: "401" });
  expect(joinStateOf({ status: "off", sessions: [{ status: "failed" }, { status: "live" }] })).toEqual({ state: "live" });
  // A join that never started (a bad link) is a failure too, never a silent blank page.
  expect(joinStateOf({ status: "off", sessions: [] }).state).toBe("failed");
  expect(joinStateOf(null).state).toBe("failed");
});

test("a failed join is retried by itself, backing off to every 30 s", () => {
  expect([0, 1, 2, 3, 4, 10].map(rejoinDelay)).toEqual([3000, 6000, 12000, 24000, 30000, 30000]);
});

test("the page bar says something whenever the canvas isn't live", () => {
  expect(joinLabel({ state: "live" })).toBeNull();
  for (const j of [{ state: "loading" }, { state: "connecting" }, { state: "reconnecting", reason: null }] as const) expect(joinLabel(j)).toBeTruthy();
  // The pill stays short: the reason is on the card over the canvas, said once.
  expect(joinLabel({ state: "failed", reason: "WebSocket error: 401" })).toBe("Reconnecting…");
});

test("join errors read as a few plain reasons", () => {
  expect(friendlyReason("collab: 401 This device isn't paired")).toBe("This device isn't paired with the host.");
  expect(friendlyReason("ws://10.0.0.2:47900: Connection refused (os error 61)")).toBe("Can't reach the host on the network.");
  expect(friendlyReason("The canvas server didn't answer.")).toBe("Can't reach the host on the network.");
  expect(friendlyReason("The canvas isn't in the session.")).toBe("The host's canvas is restarting.");
  expect(friendlyReason("file not found on the server")).toBe("The host's canvas is restarting.");
  expect(friendlyReason("something odd")).toBe("The connection to the host dropped.");
  expect(friendlyReason(null)).toBe("The connection to the host dropped.");
});

test("only a person's canvas asks for the panel buttons", () => {
  const link = "ws://h:1/?k=a&b";
  expect(canvasSrc({ link, name: "Big screen" })).toBe(`/canvas/?canvas&control&name=Big%20screen#join=${encodeURIComponent(link)}`);
  expect(canvasSrc({ link, name: "Dana", panels: true, webgl: true })).toBe(`/canvas/?canvas&control&webgl&panels&name=Dana#join=${encodeURIComponent(link)}`);
  expect(canvasSrc({ link })).not.toContain("panels");
});

test("a hung or failing collab.peers becomes a failed join, one read at a time", async () => {
  let calls = 0;
  let mode: "hang" | "reject" | "live" = "hang";
  let settle: (v: any) => void = () => {};
  const fc = {
    execute: (cmd: string) => {
      expect(cmd).toBe("collab.peers");
      calls++;
      if (mode === "hang") return new Promise<any>((r) => (settle = r));
      if (mode === "reject") return Promise.reject(new Error("canvas gone"));
      return Promise.resolve({ status: "live" });
    },
  };
  const watch = new JoinWatch(20);
  // Polls while one is still running don't start another.
  const first = watch.poll(fc);
  expect(await watch.poll(fc)).toBeNull();
  expect(calls).toBe(1);
  expect(await first).toBeNull(); // timed out: one miss is a blip
  // The timed-out read is still out: no new read goes on top of it, and the canvas counts as not answering.
  expect(await watch.poll(fc)).toEqual({ state: "failed", reason: "The canvas stopped answering." });
  expect(calls).toBe(1);
  // Its late answer is ignored; once it is back, reads start again.
  mode = "live";
  settle({ status: "live" });
  await Bun.sleep(5);
  expect(await watch.poll(fc)).toEqual({ state: "live" });
  expect(calls).toBe(2);
  // A rejection counts as a miss; an answer resets the count.
  mode = "reject";
  expect(await watch.poll(fc)).toBeNull();
  expect((await watch.poll(fc))?.state).toBe("failed");
  expect(calls).toBe(4);
});

test("a canvas bridge that throws instead of rejecting counts as failed reads, so the join fails and rejoins", async () => {
  const fc = {
    execute: (): Promise<any> => {
      throw new Error("bridge gone");
    },
  };
  const watch = new JoinWatch(20);
  expect(await watch.poll(fc)).toBeNull();
  expect(await watch.poll(fc)).toEqual({ state: "failed", reason: "The canvas stopped answering." });
});

test("a canvas that comes back live before its scheduled rejoin isn't reloaded", async () => {
  const failures = { current: 1 };
  let fired = 0;
  const timer = new RejoinTimer(failures, () => void fired++);
  const at = timer.update({ state: "failed", reason: "gone" });
  expect(at! - Date.now()).toBeGreaterThan(5_000); // 6 s after the second failure in a row
  // Another failed reading doesn't schedule a second one.
  expect(timer.update({ state: "failed", reason: "gone" })).toBe(at);
  expect(timer.update({ state: "live" })).toBeNull();
  expect(failures.current).toBe(0);
  // Recovered after a first failure (a 3 s rejoin) and failing elsewhere: only the one still due fires.
  const recovered = new RejoinTimer({ current: 0 }, () => void fired++);
  recovered.update({ state: "failed", reason: "gone" });
  recovered.update({ state: "live" });
  const failing = new RejoinTimer({ current: 0 }, () => void (fired += 10));
  failing.update({ state: "failed", reason: "gone" });
  await Bun.sleep(3100);
  expect(fired).toBe(10);
}, 10_000);
