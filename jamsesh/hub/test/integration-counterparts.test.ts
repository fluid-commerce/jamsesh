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

test("the same pairing written as [partner] or [target, partner] is one comparison to the brain's duplicate check", async () => {
  const { s, a, b } = room();
  s.createDirective({ text: "Compare the settings screen", mode: "coordinate", targets: [a.id], counterparts: [b.id], requestedBy: "Chey" });
  const { Brain } = await import("../src/brain/brain");
  const brain = new Brain(s, {} as any);
  clearInterval((brain as any).digestTimer);
  const tools = (brain as any).tools([], { effects: 0 });
  const out = String(await tools.create_directive.execute({ targets: [a.id], mode: "coordinate", text: "Compare the settings screen", rationale: "x", counterparts: [a.id, b.id] }, { toolCallId: "t", messages: [] }));
  expect(out).toContain("Already sent");
});

test("over HTTP a comparison card whose partner left is recovered by naming a new one, in the edit or in the send", async () => {
  const { Hub } = await import("../src/hub");
  const { startHttp } = await import("../src/http");
  const hub = new Hub({ canvas: false, whisper: false, dataDir: join(dir, "http") });
  const server = startHttp(hub, 0);
  try {
    const s = hub.session;
    const reg = (owner: string) => s.registerAgent({ ownerName: owner, harness: "claude-code", repo: `acme/${owner}`, cwd: `/${owner}`, machine: "m1", platform: "desktop" }).agent;
    const a = reg("Ana");
    const b = reg("Ben");
    const c = reg("Cy");
    const chey = s.upsertPerson({ name: "Chey" });
    const win = { cookie: `jam_window=${hub.auth.windows.take(hub.auth.windows.mint())}` };
    const call = (method: string, path: string, body: object) => fetch(`http://127.0.0.1:${server.port}/api${path}`, { method, headers: { "content-type": "application/json", ...win }, body: JSON.stringify({ personId: chey.id, ...body }) });
    const card = s.proposeTask({ text: "Compare checkout", mode: "coordinate", targets: [a.id], counterparts: [b.id], by: "Chey" })!;
    s.removeAgent(b.id);
    expect((await call("POST", `/triage/${card.id}/send`, {})).status).toBe(409);
    expect((await call("PATCH", `/triage/${card.id}`, { counterparts: [c.id] })).status).toBe(200);
    expect(s.board.get(card.id)!.counterparts).toEqual([c.id]);
    expect((await call("POST", `/triage/${card.id}/send`, {})).status).toBe(200);
    // Named in the send itself.
    const two = s.proposeTask({ text: "Compare the footer", mode: "coordinate", targets: [a.id], counterparts: [], by: "Chey" })!;
    expect((await call("POST", `/triage/${two.id}/send`, {})).status).toBe(409);
    expect((await call("POST", `/triage/${two.id}/send`, { counterparts: [c.id] })).status).toBe(200);
  } finally {
    server.stop(true);
    hub.devproxy.stop();
    hub.stop();
  }
});

test("a comparison is sent among exactly the approved agents: if one partner left, nothing is sent and the card says so", () => {
  const { s, a, b, c } = room();
  const card = s.proposeTask({ text: "Compare the header", mode: "coordinate", targets: [a.id], counterparts: [b.id, c.id], by: "Chey" })!;
  s.removeAgent(b.id);
  const sent = s.board.send(card.id, "Chey");
  expect(sent).toMatchObject({ ok: false, status: 409 });
  expect((sent as any).error).toContain("Ben");
  expect(s.directives()).toHaveLength(0);
  expect(s.board.get(card.id)).toMatchObject({ status: "open" });
});

test("the brain refuses a comparison whose only partner is an observer", async () => {
  const { s, a } = room();
  const watcher = s.registerAgent({ ownerName: "Rae", harness: "claude-code", repo: "acme/Rae", cwd: "/Rae", machine: "m1", platform: "mobile", role: "observer" }).agent;
  const { Brain } = await import("../src/brain/brain");
  const brain = new Brain(s, {} as any);
  clearInterval((brain as any).digestTimer);
  const tools = (brain as any).tools([], { effects: 0 });
  const out = String(await tools.create_directive.execute({ targets: [a.id], mode: "coordinate", text: "Compare the nav", rationale: "x", counterparts: [watcher.id] }, { toolCallId: "t", messages: [] }));
  expect(out).toContain("another agent to compare with");
  expect(s.directives()).toHaveLength(0);
});

test("a partner chosen by Edit is still named when they leave before Send", () => {
  const { s, a, b, c } = room();
  const card = s.proposeTask({ text: "Compare the footer", mode: "coordinate", targets: [a.id], counterparts: [b.id], by: "Chey" })!;
  expect(s.board.edit(card.id, { counterparts: [c.id] }, "Chey")).toMatchObject({ ok: true });
  s.removeAgent(c.id);
  const sent = s.board.send(card.id, "Chey");
  expect(sent).toMatchObject({ ok: false, status: 409 });
  expect((sent as any).error).toContain("Cy");
});

test("a card keeps only the partners outside its targets, and a target change with the visible partners sends exactly them", () => {
  const { s, a, b, c } = room();
  const card = s.proposeTask({ text: "Compare the tabs", mode: "coordinate", targets: [a.id], counterparts: [a.id, b.id], by: "Chey" })!;
  expect(card.counterparts).toEqual([b.id]);
  // The form, changing the target to Cy, submits the partners it shows (Ben) with it.
  expect(s.board.edit(card.id, { targets: [c.id], counterparts: [b.id] }, "Chey")).toMatchObject({ ok: true });
  expect(s.board.send(card.id, "Chey").ok).toBe(true);
  expect(s.directives()[0].targets).toEqual([c.id]);
  expect([...s.directives()[0].counterparts!].sort()).toEqual([b.id, c.id].sort());
});

test("a comparison among several partners can be repaired when one leaves", () => {
  const { s, a, b, c } = room();
  const card = s.proposeTask({ text: "Compare the list", mode: "coordinate", targets: [a.id], counterparts: [b.id, c.id], by: "Chey" })!;
  s.removeAgent(b.id);
  expect(s.board.send(card.id, "Chey")).toMatchObject({ ok: false, status: 409 });
  expect(s.board.edit(card.id, { counterparts: [c.id] }, "Chey")).toMatchObject({ ok: true });
  expect(s.board.send(card.id, "Chey").ok).toBe(true);
});
