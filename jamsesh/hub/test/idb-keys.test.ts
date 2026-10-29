// Typing through idb: US keyboard text as HID usage codes, shift around capitals and symbols.
import { expect, test } from "bun:test";
import { hidKey, hidSteps, KEY_SHIFT } from "../src/idb";

test("letters, digits and space map to HID usage codes", () => {
  expect(hidKey("a")).toEqual({ code: 4, shift: false });
  expect(hidKey("z")).toEqual({ code: 29, shift: false });
  expect(hidKey("A")).toEqual({ code: 4, shift: true });
  expect(hidKey("1")).toEqual({ code: 30, shift: false });
  expect(hidKey("0")).toEqual({ code: 39, shift: false });
  expect(hidKey(" ")).toEqual({ code: 44, shift: false });
  expect(hidKey("\n")).toEqual({ code: 40, shift: false });
  expect(hidKey("\t")).toEqual({ code: 43, shift: false });
});

test("symbols use shift where a US keyboard does", () => {
  expect(hidKey("!")).toEqual({ code: 30, shift: true });
  expect(hidKey(")")).toEqual({ code: 39, shift: true });
  expect(hidKey("@")).toEqual({ code: 31, shift: true });
  for (const [plain, shifted, code] of [["-", "_", 45], ["=", "+", 46], ["[", "{", 47], ["]", "}", 48], ["\\", "|", 49], [";", ":", 51], ["'", '"', 52], ["`", "~", 53], [",", "<", 54], [".", ">", 55], ["/", "?", 56]] as const) {
    expect(hidKey(plain)).toEqual({ code, shift: false });
    expect(hidKey(shifted)).toEqual({ code, shift: true });
  }
});

test("every printable ASCII character maps, and nothing else does", () => {
  for (let c = 32; c < 127; c++) expect(hidKey(String.fromCharCode(c))).not.toBeNull();
  for (const bad of ["é", "日", "😀", "", "ab", "\u0000", "\r"]) expect(hidKey(bad)).toBeNull();
});

test("a string becomes down/up steps with shift pressed around capitals, and is refused whole if any character can't be typed", () => {
  expect(hidSteps("hI")).toEqual([
    { code: 11, down: true },
    { code: 11, down: false },
    { code: KEY_SHIFT, down: true },
    { code: 12, down: true },
    { code: 12, down: false },
    { code: KEY_SHIFT, down: false },
  ]);
  expect(hidSteps("ok é")).toBeNull();
  expect(hidSteps("")).toEqual([]);
});
