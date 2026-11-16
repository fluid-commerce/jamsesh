// What the hub puts in its Bonjour record about the project.
import { expect, test } from "bun:test";
import { txtName } from "../src/bonjour";

test("the project name is one short tidy line, or nothing", () => {
  expect(txtName("Passport Refine")).toBe("Passport Refine");
  expect(txtName("  two\nlines\t here ")).toBe("two lines here");
  expect(txtName("x".repeat(100))?.length).toBe(40);
  expect(txtName("   ")).toBeUndefined();
  expect(txtName(null)).toBeUndefined();
});
