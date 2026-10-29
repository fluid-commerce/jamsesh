// Regression tests for the brain/session bug hunt (R1-R12, rename follow-through).
//   cd jamsesh/hub && JAMSESH_OFFLINE=1 bun test test/bughunt.brain.test.ts
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ruleTriage } from "../src/brain/brain";
import { Session } from "../src/session";
import { Store } from "../src/store";
import type { JamEvent } from "../src/types";
import { makeRoom } from "./bench";

const fresh = () => new Session(new Store(mkdtempSync(join(tmpdir(), "jam-bh-"))));
const two = (s: Session) => ({
  a: s.registerAgent({ ownerName: "Maya", harness: "claude-code", repo: "acme/app", cwd: "/w/app", machine: "m1" }).agent,
  b: s.registerAgent({ ownerName: "Ben", harness: "codex", repo: "acme/web", cwd: "/w/web", machine: "m2" }).agent,
});
const line = (s: Session, text: string, over: Partial<Parameters<Store["addEvent"]>[0]> = {}): JamEvent =>
  s.store.addEvent({ kind: "speech", authorType: "person", authorId: null, authorName: "Chey", text, ...over } as any);

test("R1: prompts and system notices never become directives on the rules path", () => {
  const r = makeRoom();
  const s = r.hub.session;
  const before = s.directives().length;
  const prompt = line(s, "can you refactor the login form validation", { kind: "prompt" });
  const notice = line(s, "Preview build failed: ios@main. exit 65 build the thing", { kind: "system", authorType: "system" });
  const triage = ruleTriage([prompt, notice]);
  expect(triage.lines.every((l) => l.intent === "none")).toBe(true);
  r.hub.brain.ruleRoute([prompt, notice], { lines: [{ id: prompt.id, relevance: "work", intent: "directive", confidence: 1 }, { id: notice.id, relevance: "work", intent: "directive", confidence: 1 }], actionable: true, introductions: [] });
  expect(s.directives().length).toBe(before);
  r.stop();
});

test("R2: clear requests route, questions, negations and chit-chat do not", () => {
  const r = makeRoom();
  const s = r.hub.session;
  const route = (text: string) => {
    const before = s.directives().length;
    const ev = line(s, text);
    r.hub.brain.ruleRoute([ev], ruleTriage([ev]), true);
    return s.directives().length - before;
  };
  expect(route("can you hear me")).toBe(0);
  expect(route("I don't think we should build that")).toBe(0);
  expect(route("Felipe can you grab lunch")).toBe(0);
  expect(route("we are going with a simpler header on the settings page")).toBe(0);
  expect(s.directives().some((d) => d.mode === "implement" && /Nav \/ A/.test(d.text))).toBe(false);
  expect(route("make three variants of the profile screen")).toBe(1);
  expect(route("let's try some onboarding illustrations for the mobile app")).toBe(1);
  r.stop();
});

test("R2: 'let's go with B' still builds variant B", () => {
  const r = makeRoom();
  const s = r.hub.session;
  s.setStage({ mode: "compare", title: "Nav", items: s.artifacts().filter((a) => a.group === "Nav").map((a) => a.id) }, "t");
  const ev = line(s, "ok let's go with B");
  r.hub.brain.ruleRoute([ev], ruleTriage([ev]), true);
  expect(s.directives().some((d) => d.mode === "implement" && /Nav \/ B/.test(d.text))).toBe(true);
  r.stop();
});

test("R3: an ack or done after a cancel doesn't reopen the directive", () => {
  const s = fresh();
  const { a } = two(s);
  const d = s.createDirective({ text: "x", mode: "explore", targets: [a.id], requestedBy: "Chey" });
  s.setDirective(d.id, { status: "cancelled", progress: { [a.id]: "cancelled" } });
  s.setDirectiveFor(d.id, a.id, "acked");
  s.setDirectiveFor(d.id, a.id, "done", "late");
  expect(s.store.get("directives", d.id)!.status).toBe("cancelled");
  expect(s.openFor(a.id)).toHaveLength(0);
});

test("R4: a spoken first name doesn't shorten or merge people", () => {
  const s = fresh();
  s.upsertPerson({ name: "Sam Lee", role: "engineer" });
  s.upsertPerson({ name: "Sam", role: "designer" });
  expect(s.people().map((p) => p.name)).toEqual(["Sam Lee"]);
  expect(s.people()[0].role).toBe("designer");
  s.upsertPerson({ name: "Sam Cho" });
  expect(s.people().map((p) => p.name).sort()).toEqual(["Sam Cho", "Sam Lee"]);
  // A rename by id still renames.
  s.upsertPerson({ id: s.people()[0].id, name: "Samuel Lee" });
  expect(s.people().some((p) => p.name === "Samuel Lee")).toBe(true);
});

test("R5: hooks pick the deepest folder, then the harness", () => {
  const s = fresh();
  const mono = s.registerAgent({ ownerName: "Maya", harness: "claude-code", repo: "acme/mono", cwd: "/mono", machine: "m1" }).agent;
  const ios = s.registerAgent({ ownerName: "Maya", harness: "claude-code", repo: "acme/ios", cwd: "/mono/ios", machine: "m1" }).agent;
  expect(s.findAgentByCwd("/mono/ios/App", "m1")?.id).toBe(ios.id);
  expect(s.findAgentByCwd("/mono/other", "m1")?.id).toBe(mono.id);
  const cl = s.registerAgent({ ownerName: "Ben", harness: "claude-code", repo: "acme/x", cwd: "/x", machine: "m1" }).agent;
  const cx = s.registerAgent({ ownerName: "Ben", harness: "codex", repo: "acme/x", cwd: "/x", machine: "m1" }).agent;
  expect(s.findAgentByCwd("/x", "m1", "claude-code")?.id).toBe(cl.id);
  expect(s.findAgentByCwd("/x", "m1", "codex")?.id).toBe(cx.id);
});

test("R6: an offline owner's workstream can be claimed; a conflict doesn't tag the update", () => {
  const s = fresh();
  const { a, b } = two(s);
  s.claim(a.id, "Nav");
  const ws = s.claim(b.id, "Nav");
  expect(ws.conflict?.id).toBe(a.id);
  const ev = s.postUpdate(b.id, "progress", "working", { workstream: "Nav" });
  expect(ev.workstreamId).toBeNull();
  s.store.patch("agents", a.id, { lastSeen: Date.now() - 3 * 3600_000 });
  const taken = s.claim(b.id, "Nav");
  expect(taken.conflict).toBeNull();
  expect(taken.workstream.ownerAgentId).toBe(b.id);
});

test("R8: a restart ends live shares and re-arms the stage", () => {
  const dir = mkdtempSync(join(tmpdir(), "jam-bh-"));
  const s1 = new Session(new Store(dir));
  s1.touchDevice("d1", { label: "Mac", personId: s1.upsertPerson({ name: "Chey" }).id });
  const sh = s1.startShare("d1", "screen");
  s1.setStage({ mode: "layout", layout: { tiles: [{ kind: "screen", shareId: sh.id, label: "x" }] } } as any, "t");
  const s2 = new Session(new Store(dir));
  expect(s2.shares()).toHaveLength(0);
  expect(s2.stage().mode).toBe("board");
});

test("R12/G7: an answer the asker waited for isn't repeated in its inbox", async () => {
  const s = fresh();
  const { a, b } = two(s);
  const { askId, answer } = s.ask(a.id, b.id, "what radius?", 5000);
  s.answer(b.id, askId, "8px");
  expect(await answer).toBe("8px");
  expect(s.inbox(a.id).messages).toHaveLength(0);
  // Asked, stopped waiting, then answered: the inbox still delivers it.
  const late = s.ask(a.id, b.id, "and the color?", 1);
  await late.answer;
  s.answer(b.id, late.askId, "red");
  expect(s.inbox(a.id).messages.map((m) => m.text)).toEqual(["red"]);
});

test("renaming a person renames their default-named agents and owner name", () => {
  const s = fresh();
  const renamed: string[] = [];
  s.onAgentRenamed = (ag, old) => renamed.push(`${old}>${ag.name}`);
  const p = s.upsertPerson({ name: "Maya" });
  const cl = s.registerAgent({ ownerName: "Maya", harness: "claude-code", repo: "acme/app", cwd: "/w/app", machine: "m1" }).agent;
  const cx = s.registerAgent({ ownerName: "Maya", harness: "codex", repo: "acme/web", cwd: "/w/web", machine: "m1" }).agent;
  const custom = s.registerAgent({ ownerName: "Maya", harness: "codex", repo: "acme/z", cwd: "/w/z", machine: "m1", name: "Scout" }).agent;
  s.store.patch("agents", cx.id, { name: "MAYA's codex (web)" });
  s.upsertPerson({ id: p.id, name: "Mia" });
  expect(s.agent(cl.id)).toMatchObject({ name: "Mia's Claude", ownerName: "Mia" });
  expect(s.agent(cx.id)).toMatchObject({ name: "Mia's codex (web)", ownerName: "Mia" });
  expect(s.agent(custom.id)).toMatchObject({ name: "Scout", ownerName: "Mia" });
  expect(renamed).toHaveLength(2);
});

test("R9: with the brain off, direct requests do nothing", async () => {
  const r = makeRoom();
  const s = r.hub.session;
  s.updateSettings({ brainEnabled: false });
  const before = s.directives().length;
  const ev = line(s, "JamSesh, make some variants of the nav", { data: { typed: true } } as any);
  await r.hub.brain.direct(ev);
  expect(s.directives().length).toBe(before);
  r.stop();
});
