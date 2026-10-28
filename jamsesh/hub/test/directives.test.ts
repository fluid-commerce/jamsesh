import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "../src/session";
import { Store } from "../src/store";

function setup() {
  const s = new Session(new Store(mkdtempSync(join(tmpdir(), "jam-dir-"))));
  const a = s.registerAgent({ ownerName: "Jonathan", harness: "claude-code", repo: "acme/desktop", cwd: "/d", machine: "m1", platform: "desktop" }).agent;
  const b = s.registerAgent({ ownerName: "Chey", harness: "claude-code", repo: "acme/mobile", cwd: "/m", machine: "m2", platform: "mobile" }).agent;
  const d = s.createDirective({ text: "Two header variants each", mode: "explore", targets: [a.id, b.id], requestedBy: "Felipe" });
  return { s, a, b, d };
}

test("each target gets the directive once", () => {
  const { s, a, b } = setup();
  expect(s.inbox(a.id).directives).toHaveLength(1);
  expect(s.inbox(a.id).directives).toHaveLength(0);
  expect(s.inbox(b.id).directives).toHaveLength(1);
});

test("a shared directive is done only when every target is", () => {
  const { s, a, b, d } = setup();
  s.inbox(a.id);
  s.inbox(b.id);
  s.setDirectiveFor(d.id, a.id, "done", "desktop variants up");
  expect(s.store.get("directives", d.id)!.status).not.toBe("done");
  expect(s.openFor(b.id).map((x) => x.id)).toEqual([d.id]);
  s.setDirectiveFor(d.id, b.id, "done", "mobile variants up");
  const after = s.store.get("directives", d.id)!;
  expect(after.status).toBe("done");
  expect(after.result).toContain("desktop variants up");
  expect(after.result).toContain("mobile variants up");
});

test("one agent finishing doesn't hide the directive from the other", () => {
  const { s, a, b, d } = setup();
  s.inbox(a.id);
  s.setDirectiveFor(d.id, a.id, "done");
  expect(s.inbox(b.id).directives.map((x) => x.id)).toEqual([d.id]);
});
