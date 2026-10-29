import { expect, test } from "bun:test";
import { neverQueued } from "../src/shared/hub";

test("letting a laptop in as someone, and disconnecting one, are never saved to replay later", () => {
  for (const p of ["/paired/dev_1/allow", "/paired/dev_1", "/paired"]) expect(neverQueued(p)).toBe(true);
  expect(neverQueued("/people/p_1")).toBe(false);
});
