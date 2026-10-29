// The Tasks view's client side (4.1): the same api() helper the buttons call, against a real host; and the
// helpers that decide which column a task sits in and what it produced.
import "fake-indexeddb/auto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../../hub/src/hub";
import { startHttp } from "../../hub/src/http";
import { api } from "../src/shared/hub";
import { columnOf, producedBy, span } from "../src/shared/Tasks";

process.env.JAMSESH_SILENT = "1";
const dir = mkdtempSync(join(tmpdir(), "jam-web-board-"));
const hub = new Hub({ canvas: false, whisper: false, dataDir: dir });
const server = startHttp(hub, 0);
const s = hub.session;
const chey = s.upsertPerson({ name: "Chey" });
const agent = s.registerAgent({ ownerName: "Felipe", harness: "claude-code", repo: "acme/desktop", cwd: "/f", machine: "m", platform: "desktop" }).agent;

// api() calls fetch("/api/...") from a page; here it goes to the test host, as its own window (the cookie the app has).
const realFetch = globalThis.fetch;
let window = "";
beforeAll(() => {
  window = `jam_window=${hub.auth.windows.take(hub.auth.windows.mint())}`;
  (globalThis as any).navigator = { onLine: true };
  // (Other test files in this run may have left a host key behind: this window is the host's own.)
  (globalThis as any).fetch = (url: string, init: RequestInit = {}) => {
    const { "x-jam-host": _other, ...headers } = (init.headers ?? {}) as Record<string, string>;
    return realFetch(`http://127.0.0.1:${server.port}${url}`, { ...init, headers: { ...headers, cookie: window } });
  };
});
afterAll(() => {
  globalThis.fetch = realFetch;
  server.stop(true);
  hub.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("the buttons' api() calls: edit, send, a second send says who got there first, and the card leaves Triage for Waiting", async () => {
  const card = s.proposeTask({ text: "Make three onboarding variants", mode: "explore", targets: [], by: "Chey" })!;
  await expect(api(`/triage/${card.id}/send`, { personId: chey.id })).rejects.toMatchObject({ status: 400, message: expect.stringContaining("Pick an agent") });
  await api(`/triage/${card.id}`, { personId: chey.id, targets: [agent.id], mode: "implement" }, "PATCH");
  const sent = await api<{ directiveId: string }>(`/triage/${card.id}/send`, { personId: chey.id });
  expect(columnOf(s.store.get("directives", sent.directiveId)!)).toBe("waiting");
  await expect(api(`/triage/${card.id}/send`, { personId: chey.id })).rejects.toMatchObject({ status: 409, message: expect.stringContaining("already sent") });
  expect(s.board.get(card.id)).toMatchObject({ status: "sent", mode: "implement", targets: [agent.id] });
  expect(s.directives()).toHaveLength(1);
  // A triage call is never saved for later: offline, it fails where the person can see it.
  (globalThis as any).navigator = { onLine: false };
  await expect(api("/triage/tri_x/dismiss", { personId: chey.id })).rejects.toThrow();
  (globalThis as any).navigator = { onLine: true };
});

test("context cards through api(): add, merge and replace change the saved facts", async () => {
  const fact = s.board.rememberNow({ text: "Header uses option A", kind: "decision", by: "Chey" })!;
  const c = s.proposeContext({ text: "Header uses option B", kind: "decision", by: "Felipe" })!;
  const merge = s.proposeContext({ text: "Greeting says hello first", kind: "requirement", by: "Chey" })!;
  await api(`/triage/${merge.id}/merge`, { personId: chey.id, factId: fact.id, text: "Header uses option A. Greeting says hello first" });
  expect(s.store.get("facts", fact.id)!.text).toContain("Greeting says hello first");
  await api(`/triage/${c.id}/replace`, { personId: chey.id });
  expect(s.store.get("facts", fact.id)!.status).toBe("superseded");
  expect(s.facts().some((f) => f.status === "active" && f.text === "Header uses option B")).toBe(true);
});

test("columns follow directive status, and a done task lists what its agent put up since", () => {
  const d = s.createDirective({ text: "Try variants", mode: "explore", targets: [agent.id], requestedBy: "Chey" });
  expect(columnOf(d)).toBe("waiting");
  s.setDirectiveFor(d.id, agent.id, "acked");
  expect(columnOf(s.store.get("directives", d.id)!)).toBe("working");
  const art = s.upsertArtifact({ kind: "screenshot", stage: "mockup", title: "Variant A", agentId: agent.id, image: "/renders/a.png" });
  s.setDirectiveFor(d.id, agent.id, "done", "Done. Preview at http://10.0.0.5:5100/x");
  const done = s.store.get("directives", d.id)!;
  expect(columnOf(done)).toBe("done");
  const made = producedBy(done, s.state());
  expect(made.artifacts.map((a) => a.id)).toEqual([art.id]);
  expect(made.links).toEqual(["http://10.0.0.5:5100/x"]);
  s.setDirective(d.id, { status: "cancelled" });
  expect(columnOf(s.store.get("directives", d.id)!)).toBeNull();
});

test("waiting is said in minutes and hours", () => {
  expect([span(5_000), span(40 * 60_000), span(65 * 60_000), span(2 * 3600_000)]).toEqual(["just now", "40 min", "1 h 5 min", "2 h"]);
});
