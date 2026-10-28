// An effect written as `useEffect(() => expr, deps)` returns expr's value as its cleanup. When that
// value isn't a function (Chromium's scrollIntoView now returns a Promise), React throws on the next
// update and the whole window goes blank. Effects take a block body.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []));

test("no effect returns an expression as its cleanup", () => {
  const src = join(import.meta.dir, "../src");
  const offenders = files(src).flatMap((f) =>
    readFileSync(f, "utf8")
      .split("\n")
      .flatMap((line, i) => (/\buse(Layout)?Effect\(\s*(async\s*)?\(\)\s*=>\s*[^{\s]/.test(line) ? [`${f.slice(src.length + 1)}:${i + 1}`] : [])),
  );
  expect(offenders).toEqual([]);
});
