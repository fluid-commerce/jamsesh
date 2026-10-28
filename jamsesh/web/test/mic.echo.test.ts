import { expect, test } from "bun:test";
import { BARGE_MARGIN_DB, holdMic, isEchoSegment } from "../src/shared/mic";

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
