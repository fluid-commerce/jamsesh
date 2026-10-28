import { expect, test } from "bun:test";
import { stripMd } from "../src/shared/ui";

test("stripMd shows markdown as plain words", () => {
  expect(stripMd("**felipe's claude** said `ls` and *hi* [docs](http://x.y)")).toBe("felipe's claude said ls and hi docs");
  expect(stripMd("snake_case_name stays")).toBe("snake_case_name stays");
});
