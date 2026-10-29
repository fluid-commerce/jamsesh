import { expect, test } from "bun:test";
import { BARGE_MARGIN_DB, holdMic, isEchoSegment, Mic } from "../src/shared/mic";

test("the brain's echo is dropped, a close voice over it is not", () => {
  expect(isEchoSegment(-40, -60, true)).toBe(true);
  expect(isEchoSegment(-60 + BARGE_MARGIN_DB + 3, -60, true)).toBe(false);
  expect(isEchoSegment(-50, -60, false)).toBe(false);
});

test("holdMic can be released once", () => {
  const release = holdMic();
  release();
  release();
});

test("a mic switched off while its permission prompt is open is let go when the answer comes, not kept on", async () => {
  let release!: (s: unknown) => void;
  let stopped = 0;
  const track = { stop: () => stopped++ };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: { getUserMedia: () => new Promise((r) => (release = r)) } } });
  const mic = new Mic("dev");
  const on = mic.ensureOn();
  mic.stop();
  release({ getTracks: () => [track], getAudioTracks: () => [track] });
  expect(await on).toBe(false);
  expect(stopped).toBe(1);
  expect(mic.status.on).toBe(false);
});
