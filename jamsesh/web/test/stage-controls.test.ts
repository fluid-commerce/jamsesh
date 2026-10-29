import { expect, test } from "bun:test";
import { agoWords } from "../src/shared/StageControls";

test("badges say how long ago in words", () => {
  const now = 1_000_000_000;
  expect(agoWords(now - 5_000, now)).toBe("just now");
  expect(agoWords(now - 40_000, now)).toBe("40 s ago");
  expect(agoWords(now - 2 * 60_000, now)).toBe("2 min ago");
  expect(agoWords(now - 3 * 3_600_000, now)).toBe("3 h ago");
});
