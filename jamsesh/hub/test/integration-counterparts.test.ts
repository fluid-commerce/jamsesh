// Where phase 4's task cards meet phases 1 and 2: a comparison card names who it compares with, and a reassigned task
// carries exactly the files it was approved with.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "../src/session";
import { Store } from "../src/store";

const dir = mkdtempSync(join(tmpdir(), "jam-int-cp-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function room() {
  const s = new Session(new Store(mkdtempSync(join(dir, "s-"))));
  const reg = (owner: string) => s.registerAgent({ ownerName: owner, harness: "claude-code", repo: `acme/${owner}`, cwd: `/${owner}`, machine: "m1", platform: "desktop" }).agent;
  return { s, a: reg("Ana"), b: reg("Ben"), c: reg("Cy") };
}

test("the same comparison with a different partner is another card, and editing the targets drops the old partners", () => {
  const { s, a, b, c } = room();
  const one = s.proposeTask({ text: "Compare the navigation", mode: "coordinate", targets: [a.id], counterparts: [b.id], by: "Chey" })!;
  const two = s.proposeTask({ text: "Compare the navigation", mode: "coordinate", targets: [a.id], counterparts: [c.id], by: "Chey" })!;
  expect(two.id).not.toBe(one.id);
  expect(two.counterparts).toEqual([c.id]);
  const edited = s.board.edit(one.id, { targets: [b.id] }, "Chey");
  expect(edited.ok && edited.card.counterparts).toBeUndefined();
});

test("a reassigned task carries exactly its approved files, none when it had none", () => {
  const { s, a, b } = room();
  const d = s.createDirective({ text: "Build it", mode: "implement", targets: [a.id], requestedBy: "Chey", attachments: [] });
  const moved = s.reassignDirective(d.id, "Chey", b.id)!;
  expect(moved.attachments ?? []).toEqual([]);
});

test("a comparison card sent with no partner left says what to do (409), and partners can be edited", () => {
  const { s, a, b, c } = room();
  const card = s.proposeTask({ text: "Compare checkout", mode: "coordinate", targets: [a.id], counterparts: [b.id], by: "Chey" })!;
  s.removeAgent(b.id);
  const sent = s.board.send(card.id, "Chey");
  expect(sent).toMatchObject({ ok: false, status: 409 });
  expect(s.directives()).toHaveLength(0);
  expect(s.board.edit(card.id, { counterparts: [c.id] }, "Chey")).toMatchObject({ ok: true });
  const ok = s.board.send(card.id, "Chey");
  expect(ok.ok).toBe(true);
  expect(s.directives()[0]).toMatchObject({ targets: [a.id] });
  expect(s.directives()[0].counterparts).toEqual(expect.arrayContaining([c.id]));
});

test("the same comparison asked of the brain with a different partner is not a duplicate", async () => {
  const { s, a, b, c } = room();
  const first = s.createDirective({ text: "Compare the navigation", mode: "coordinate", targets: [a.id], counterparts: [b.id], requestedBy: "Chey" });
  const { Brain } = await import("../src/brain/brain");
  const brain = new Brain(s, {} as any);
  clearInterval((brain as any).digestTimer);
  const tools = (brain as any).tools([], { effects: 0 });
  const out = String(await tools.create_directive.execute({ targets: [a.id], mode: "coordinate", text: "Compare the navigation", rationale: "x", counterparts: [c.id] }, { toolCallId: "t", messages: [] }));
  expect(out).not.toContain("Already sent");
  expect(s.directives().filter((d) => d.id !== first.id)).toHaveLength(1);
});
