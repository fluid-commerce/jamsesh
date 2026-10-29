// The reset epoch rides on audio from capture to upload: a segment carries the epoch its earliest frame was captured
// under, so a Reset (and the pong telling this laptop) during a segment never gives pre-reset audio the new epoch.
// Drives the real Mic frame path and the real upload (fetch stubbed); no microphone, nothing plays.
import "fake-indexeddb/auto";
import { afterEach, expect, test } from "bun:test";
import { hub } from "../src/shared/hub";
import { Mic } from "../src/shared/mic";

const realFetch = globalThis.fetch;
afterEach(() => (globalThis.fetch = realFetch));

const frame = (amp: number) => Float32Array.from({ length: 320 }, (_, i) => amp * Math.sin(i * 0.3));
const pong = (voiceEpoch: number) => (hub as any).handle({ type: "pong", t: Date.now(), now: Date.now(), voiceEpoch });

/** Feeds frames ([amplitude, count] runs, with a pong between runs where given) and returns the uploaded epochs. */
async function capture(steps: ([number, number] | { pong: number })[]) {
  const sent: string[] = [];
  globalThis.fetch = (async (url: string) => (sent.push(new URL(url, "http://hub").searchParams.get("epoch") ?? "none"), new Response("{}"))) as any;
  (hub as any).set({ status: "connected", connected: true });
  const mic = new Mic(`dev-${Math.random()}`);
  const pending: unknown[] = [];
  for (const step of steps) {
    if ("pong" in step) pong(step.pong);
    else for (let i = 0; i < step[1]; i++) pending.push((mic as any).frame(frame(step[0])));
  }
  await Bun.sleep(30);
  return sent;
}

test("speech that began before a reset's pong is uploaded with the epoch it began under", async () => {
  expect(await capture([{ pong: 3 }, [0.0001, 20], [0.3, 30], { pong: 4 }, [0.3, 20], [0.0001, 40]])).toEqual(["3"]);
});

test("the pre-roll counts: speech starting right after the pong still carries the older epoch of its first frames", async () => {
  expect(await capture([{ pong: 5 }, [0.0001, 20], { pong: 6 }, [0.3, 30], [0.0001, 40]])).toEqual(["5"]);
});

test("speech captured wholly after the pong carries the new epoch", async () => {
  expect(await capture([{ pong: 7 }, [0.0001, 20], { pong: 8 }, [0.0001, 20], [0.3, 30], [0.0001, 40]])).toEqual(["8"]);
});
