// The Wiki tab's client side: the same api() helper the buttons call, against a real hub with a seeded wiki folder.
import "fake-indexeddb/auto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../../hub/src/hub";
import { startHttp } from "../../hub/src/http";
import { api } from "../src/shared/hub";
import { freshHits, historyOf, wikiApi } from "../src/wiki/wikiApi";
import { localOf, shapeGraph } from "../src/wiki/graph";
import { seedWiki } from "./wiki-fixture";
import { drafts, onRefresh, restore, saveRev, track } from "../src/wiki/draft";
import { settled } from "../src/wiki/SettledLinks";
import { diffView, metaLine } from "../src/wiki/WikiCard";
import { sourceWindow } from "../src/wiki/WikiView";
import { cutDiff, lineDiff } from "../../hub/src/wiki/diff";
import { listPages, readPage, readState, writeState } from "../../hub/src/wiki/files";
import { bus } from "../../hub/src/bus";
import type { Decider } from "../../hub/src/wiki/service";

process.env.JAMSESH_SILENT = "1";
const dir = mkdtempSync(join(tmpdir(), "jam-web-wiki-"));
const wikiDir = join(dir, "wiki-folder");
const hub = new Hub({ canvas: false, whisper: false, dataDir: dir, wikiDir });
const server = startHttp(hub, 0);
const seeded = seedWiki(wikiDir, 40);
const agent = hub.auth.issue({ kind: "agent", label: "Agents on Mac", ip: "10.0.0.5", ownerDeviceId: "host" });
// The host's window has picked who is using it: every wiki change names a person.
hub.session.store.setSetting("hostPersonId", hub.session.upsertPerson({ name: "Chey" }).id);

const realFetch = globalThis.fetch;
let window = "";
beforeAll(() => {
  window = `jam_window=${hub.auth.windows.take(hub.auth.windows.mint())}`;
  (globalThis as any).navigator = { onLine: true };
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

test("the index and the graph come through api() and shape into a map of the seeded pages", async () => {
  const { pages, ready } = await wikiApi.pages();
  expect(ready).toBe(true);
  expect(pages).toHaveLength(40);
  const passport = pages.find((p) => p.slug === "passport")!;
  expect(passport).toMatchObject({ title: "Passport", category: "workstreams" });
  expect(pages.find((p) => p.slug === "session-length")!.backlinks).toBeGreaterThan(0);
  const g = shapeGraph(await wikiApi.graph());
  expect(g.nodes).toHaveLength(40);
  expect(g.edges.length).toBeGreaterThan(40);
  expect(g.near.get("passport")!.has("passport-login")).toBe(true);
});

test("a page carries its backlinks, links and the sources it cites", async () => {
  const p = await wikiApi.page("session-length");
  expect(p.title).toBe("Session length");
  expect(p.backlinks.map((b) => b.slug)).toContain("passport");
  expect(p.links.find((l) => l.slug === "felipe")).toMatchObject({ exists: true });
  expect(p.sources.map((s) => s.id)).toContain(seeded.transcript);
  expect(p.markdown).toContain(`(src: ${seeded.transcript}, 00:04)`);
  await expect(wikiApi.page("no-such-page")).rejects.toMatchObject({ status: 404 });
});

test("a citation opens the source text, and the cited moment is a line in it", async () => {
  const s = await wikiApi.source(seeded.transcript);
  expect(s.kind).toBe("transcript");
  expect(s.text.split("\n").some((l) => l.startsWith("[00:04]"))).toBe(true);
  await expect(wikiApi.source("2026-01-01_missing")).rejects.toMatchObject({ status: 404 });
  await expect(wikiApi.source("../../etc/passwd")).rejects.toMatchObject({ status: 404 });
});

test("search finds pages by what they say", async () => {
  const hits = await wikiApi.search("thirty days");
  expect(hits.length + (await wikiApi.search("session")).length).toBeGreaterThan(0);
  expect((await wikiApi.search("session")).map((h) => h.slug)).toContain("session-length");
  expect(await wikiApi.search("zzzzqqq")).toEqual([]);
});

test("saving an edit: it lands, it is logged, and a stale save comes back as a conflict with the current page", async () => {
  const before = await wikiApi.page("felipe");
  const saved = await wikiApi.save("felipe", { markdown: `${before.markdown}\nLikes short meetings.\n`, rev: before.rev });
  if (!("page" in saved)) throw new Error("expected a save");
  expect(saved.page.markdown).toContain("Likes short meetings.");
  expect(saved.page.rev).not.toBe(before.rev);
  expect((await wikiApi.log())[0].pages).toContain("felipe");
  // The same revision again is stale now.
  const stale = await wikiApi.save("felipe", { markdown: "Overwritten by a slow tab", rev: before.rev });
  if (!("conflict" in stale)) throw new Error("expected a conflict");
  expect(stale.conflict.markdown).toContain("Likes short meetings.");
  // Taking their rev and saving again goes through.
  const again = await wikiApi.save("felipe", { markdown: "Mine, over theirs", rev: stale.conflict.rev });
  expect("page" in again && again.page.markdown).toContain("Mine, over theirs");
});

test("a new page needs no revision; one that already exists does", async () => {
  const made = await wikiApi.save("fresh-idea", { markdown: "# Fresh idea\n\nLinks to [[passport]].\n", category: "topics" });
  expect("page" in made && made.page.title).toBe("Fresh idea");
  expect((await wikiApi.pages()).pages.map((p) => p.slug)).toContain("fresh-idea");
  const clash = await wikiApi.save("fresh-idea", { markdown: "No rev given" });
  expect("conflict" in clash || "page" in clash).toBe(true);
  expect("page" in clash).toBe(false);
});

test("a page name that could reach a file is turned away", async () => {
  for (const slug of ["..", "..%2f..%2fetc%2fpasswd", "A B", ".hidden"]) {
    await expect(wikiApi.save(slug, { markdown: "x" })).rejects.toBeTruthy();
  }
});

test("Add to wiki: text, a link and a file's text are kept as sources; junk is refused", async () => {
  const text = await wikiApi.addSource({ title: "Retro notes", text: "# Retro\n\nShip smaller." });
  expect(text.source.id).toMatch(/retro-notes/);
  expect((await wikiApi.source(text.source.id)).text).toContain("Ship smaller.");
  const link = await wikiApi.addSource({ title: "Spec", url: "https://example.com/spec" });
  expect((await wikiApi.source(link.source.id)).kind).toBe("link");
  await expect(wikiApi.addSource({ url: "javascript:alert(1)" })).rejects.toBeTruthy();
  await expect(wikiApi.addSource({ url: "ftp://x.example/a" })).rejects.toBeTruthy();
  await expect(wikiApi.addSource({})).rejects.toBeTruthy();
  await expect(wikiApi.addSource({ attachment: "att_missing" })).rejects.toBeTruthy();
});

test("a wiki call is never saved for later: offline it fails where the person can see it", async () => {
  (globalThis as any).navigator = { onLine: false };
  await expect(wikiApi.save("felipe", { markdown: "x", rev: "r" })).rejects.toThrow();
  await expect(wikiApi.addSource({ text: "x" })).rejects.toThrow();
  (globalThis as any).navigator = { onLine: true };
});

test("an agent's credential and a window with no one picked can't edit pages", async () => {
  const base = `http://127.0.0.1:${server.port}`;
  const viaAgent = await realFetch(`${base}/api/wiki/page/felipe`, { method: "PUT", headers: { "content-type": "application/json", "x-forwarded-for": "9.9.9.9", authorization: `Bearer ${agent.token}` }, body: JSON.stringify({ markdown: "x" }) });
  expect(viaAgent.status).toBe(403);
  const readViaAgent = await realFetch(`${base}/api/wiki/pages`, { headers: { "x-forwarded-for": "9.9.9.9", authorization: `Bearer ${agent.token}` } });
  expect(readViaAgent.status).toBe(403);
  const nobody = await realFetch(`${base}/api/wiki/pages`, { headers: { "x-forwarded-for": "9.9.9.9" } });
  expect(nobody.status).toBe(401);
});

test("hostile page text and titles come back as data and render as inert text", async () => {
  const evil = '<script>window.__xss=1</script><img src=x onerror="window.__xss=1">';
  const made = await wikiApi.save("evil-page", { markdown: `# ${evil}\n\n[x](javascript:alert(1)) ${evil}\n`, category: "topics" });
  if (!("page" in made)) throw new Error("expected a save");
  const { renderMarkdown } = await import("../src/wiki/markdown");
  const out = renderMarkdown(made.page.markdown);
  expect(out).not.toMatch(/<script|<img/i);
  const list = (await wikiApi.pages()).pages.find((p) => p.slug === "evil-page")!;
  expect(typeof list.title).toBe("string");
  await api("/wiki/pages");
});

test("a wiki card on the Tasks board: the checked pages are written through api(), the unchecked ones are not", async () => {
  const page = (slug: string, title: string, md: string) => ({ slug, title, type: "topic" as const, workstreams: [], markdown: `# ${title}\n\n${md}`, sources: [] });
  hub.wiki.addSource("document", "Pricing notes", "Two tiers, monthly.", "Chey");
  hub.wiki.decide = (async () => ({ summary: "Pricing", pages: [page("pricing", "Pricing", "Two tiers."), page("billing", "Billing", "Monthly.")] })) as Decider;
  const r = await hub.wiki.tick();
  const card = hub.session.board.get(r!.card!.id)!;
  expect(card.type).toBe("wiki");
  expect(card.wiki!.changes.map((c) => c.slug)).toEqual(["pricing", "billing"]);
  const person = hub.session.upsertPerson({ name: "Chey" });
  await api(`/triage/${card.id}/add`, { personId: person.id, pages: ["pricing"] });
  expect((await wikiApi.pages()).pages.map((p) => p.slug)).toContain("pricing");
  expect((await wikiApi.pages()).pages.map((p) => p.slug)).not.toContain("billing");
  // Accepting twice says so instead of writing again.
  await expect(api(`/triage/${card.id}/add`, { personId: person.id, pages: ["billing"] })).rejects.toBeTruthy();
  expect((await wikiApi.pages()).pages.map((p) => p.slug)).not.toContain("billing");
});

test("the Work tab's links count a page's items by its bullets", async () => {
  const { countItems } = await import("../src/wiki/SettledLinks");
  expect(countItems("# Decisions\n\n- Keep 30 days\n- Drop magic link\n  - sub-point\n1. Third\n\nProse, not an item.")).toBe(4);
  expect(countItems("")).toBe(0);
  const nav = await import("../src/wiki/nav");
  (globalThis as any).window = new EventTarget();
  (globalThis as any).CustomEvent = class extends Event { detail: unknown; constructor(t: string, i: { detail?: unknown } = {}) { super(t); this.detail = i.detail; } };
  let heard = 0;
  const off = nav.onWikiOpen(() => heard++);
  nav.openWiki("decisions");
  expect(heard).toBe(1);
  expect(nav.takePendingWikiPage()).toBe("decisions");
  expect(nav.takePendingWikiPage()).toBeNull();
  off();
});

test("two people editing: the update that arrives mid-draft never moves the draft's revision, so Save is a conflict with the choice, not an overwrite", async () => {
  // Client A opens the page and starts editing; its draft is pinned to that revision.
  const opened = await wikiApi.page("session-length");
  const base = opened.rev;
  let draftText = `${opened.markdown}\nA's addition.\n`;
  let theirs: Awaited<ReturnType<typeof wikiApi.page>> | null = null;
  // Client B saves through the same api() path; the hub tells every window the wiki changed.
  const heard = new Promise<void>((done) => {
    const off = bus.on((m) => m.type === "wiki" && m.kind === "edit" && (off(), done()));
  });
  const b = await wikiApi.save("session-length", { markdown: `${opened.markdown}\nB's addition.\n`, rev: opened.rev });
  expect("page" in b).toBe(true);
  await heard;
  // A's window refreshes on that notification, while A is still editing.
  const refresh = onRefresh(true, base, await wikiApi.page("session-length"));
  expect(refresh.page).toBeUndefined(); // the page under the draft stays as it was
  theirs = refresh.theirs ?? null;
  expect(theirs?.markdown).toContain("B's addition.");
  // A saves: checked against the revision the draft began from, so it's a conflict with B's page, not an overwrite.
  const save = await wikiApi.save("session-length", { markdown: draftText, rev: saveRev(base, theirs, false) });
  if (!("conflict" in save)) throw new Error("expected a conflict");
  expect(save.conflict.markdown).toContain("B's addition.");
  expect((await wikiApi.page("session-length")).markdown).not.toContain("A's addition.");
  // A chooses: save over B's on purpose.
  draftText = `${save.conflict.markdown}\nA's addition.\n`;
  const over = await wikiApi.save("session-length", { markdown: draftText, rev: saveRev(base, save.conflict, true) });
  if (!("page" in over)) throw new Error("expected a save");
  expect(over.page.markdown).toContain("B's addition.");
  expect(over.page.markdown).toContain("A's addition.");
  // Nobody editing: a refresh simply shows the newer page.
  expect(onRefresh(false, base, over.page).page?.rev).toBe(over.page.rev);
  expect(onRefresh(true, over.page.rev, over.page)).toEqual({});
});

test("a write that names a person but carries no window key or paired person is refused", async () => {
  const base = `http://127.0.0.1:${server.port}`;
  const chey = hub.session.upsertPerson({ name: "Chey" });
  const forged = await realFetch(`${base}/api/wiki/page/felipe`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ markdown: "# Felipe\n\nforged", personId: chey.id }) });
  expect(forged.status).toBe(403);
  const src = await realFetch(`${base}/api/wiki/sources`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "forged", personId: chey.id }) });
  expect(src.status).toBe(403);
  expect((await wikiApi.page("felipe")).markdown).not.toContain("forged");
});

test("the Work tab finds settled pages by category, with or without the list pages", () => {
  const meta = (slug: string, category: any, mtime: number) => ({ slug, title: slug, category, summary: "", links: [], backlinks: 0, updated: "", mtime });
  // A fresh project: a page per decision and question, no list pages.
  const fresh = settled([meta("use-passkeys", "decisions", 2), meta("drop-magic-link", "decisions", 3), meta("tv-sign-in", "questions", 1), meta("notes", "topics", 9)], {});
  expect(fresh).toEqual([
    { label: "Decisions", count: 2, unit: "decisions", open: "drop-magic-link", latest: "drop-magic-link" },
    { label: "Open questions", count: 1, unit: "question", open: "tv-sign-in", latest: "tv-sign-in" },
  ]);
  // A migrated project: the list page counts its bullets, and the pages beside it count too.
  const both = settled([meta("decisions", "decisions", 1), meta("use-passkeys", "decisions", 2)], { decisions: 3 });
  expect(both).toEqual([{ label: "Decisions", count: 4, unit: "decisions", open: "decisions", latest: "use-passkeys" }]);
  expect(settled([], {})).toEqual([]);
});

test("a card's diff never hides lines silently: past 400 it says how many more and opens them all, with the hub's own notes", () => {
  const before = Array.from({ length: 700 }, (_, i) => `r${i}`).join("\n");
  const diff = lineDiff(before, "r0");
  const folded = diffView(diff, false);
  expect(folded.lines).toHaveLength(400);
  expect(folded.hidden).toBeGreaterThan(0);
  expect(folded.lines.join("\n")).not.toContain("-r699");
  const open = diffView(diff, true);
  expect(open.hidden).toBe(0);
  expect(open.lines).toContain("-r699");
  // When the hub had to cut, its note is in what shows, folded or not.
  const big = cutDiff(Array.from({ length: 2000 }, (_, i) => `a removed line of page text ${i}`).join("\n"), "# x", 6000).text;
  const shown = diffView(big, false);
  expect([...shown.lines, ...shown.notes].join("\n")).toMatch(/\(cut here: \d+ more changed lines\)/);
  // A note past the fold is carried up into view.
  const late = [...Array.from({ length: 450 }, (_, i) => `-l${i}`), "(cut here: 9 more changed lines)"].join("\n");
  expect(diffView(late, false).notes).toEqual(["(cut here: 9 more changed lines)"]);
});

test("a card's cut change is fetched whole through the client's api(): every added line is there, and a gone proposal says so", async () => {
  const body = Array.from({ length: 701 }, (_, i) => `new-${i}`).join("\n");
  // The seeded pages were put in the folder directly; they are the wiki's own here, not hand edits to file.
  const st = readState(hub.wiki.dir);
  st.seen = Object.fromEntries(listPages(hub.wiki.dir).map((i) => [i.slug, { mtime: Math.floor(i.mtime), rev: readPage(hub.wiki.dir, i.slug)!.rev }]));
  for (const id of hub.wiki.pendingSources()) st.ingested[id] = { at: 1 }; // and what earlier tests left waiting is not this test's business
  writeState(hub.wiki.dir, st);
  await api("/wiki/page/replace-me", { markdown: `# Replace me\n\n${Array.from({ length: 701 }, (_, i) => `old-${i}`).join("\n")}` }, "PUT");
  hub.wiki.addSource("document", "Rewrite", "replace me rewrite", "Chey");
  hub.wiki.decide = (async () => ({ summary: "Rewrite", pages: [{ slug: "replace-me", title: "Replace me", type: "topic" as const, workstreams: [], markdown: `# Replace me\n\n${body}`, sources: [] }] })) as Decider;
  const card = hub.session.board.get((await hub.wiki.tick())!.card!.id)!;
  const ch = card.wiki!.changes[0];
  expect(ch.cut).toBe(true);
  expect(diffView(ch.diff, true).lines.filter((l) => l.startsWith("+new-")).length).toBeLessThan(701);
  const full = await wikiApi.fullChange(card.id, "replace-me");
  expect(diffView(full.diff, true).lines.filter((l) => l.startsWith("+new-"))).toHaveLength(701);
  expect(full).toMatchObject({ added: 701, removed: 701 });
  await expect(wikiApi.fullChange(card.id, "nope")).rejects.toBeTruthy();
});

// These drive the same functions PageView calls (track on each text change, restore on mount). Unmounting calls nothing, so
// "leaving by X" is the same store sequence for every X; they do not render the component (no DOM library in this package).
test("store level: a held draft comes back with its revision when the view is mounted again", () => {
  track("pricing", "edited text", "rev1"); // typing; the view is then unmounted (nothing is called) and mounted again:
  expect(restore("pricing")).toEqual({ editing: "edited text", base: "rev1" });
  expect(restore("other")).toEqual({ editing: null, base: "" });
  track("pricing", null, "rev1");
});

test("store level: Save or Cancel drops the draft, and only that page's", () => {
  track("a", "text a", "r1");
  track("b", "text b", "r2");
  track("a", null, "r1");
  expect(restore("a").editing).toBeNull();
  expect(restore("b").editing).toBe("text b");
  track("b", null, "r2");
});

test("store level: typing while a save is out stays as the draft, on the saved revision; an untouched edit is cleared", () => {
  track("p", "first", "r1");
  const sent = drafts.edit("p");
  track("p", "first, and more typed while saving", "r1"); // a later edit
  expect(drafts.saved("p", sent, "r2")).toBe("rebased");
  expect(restore("p")).toEqual({ editing: "first, and more typed while saving", base: "r2" });
  // The next save answers for the newer edit and clears it.
  const next = drafts.edit("p");
  expect(drafts.saved("p", next, "r3")).toBe("cleared");
  expect(restore("p").editing).toBeNull();
});

test("store level: a save answered after the view unmounted applies the same rule", () => {
  track("q", "text", "r1");
  const sent = drafts.edit("q");
  // (the view unmounts; the save is still out) ... the answer arrives with nothing mounted:
  expect(drafts.saved("q", sent, "r2")).toBe("cleared");
  expect(restore("q").editing).toBeNull();
  track("q2", "text", "r1");
  const sent2 = drafts.edit("q2");
  track("q2", "typed after leaving? no: typed before leaving", "r1");
  expect(drafts.saved("q2", sent2, "r5")).toBe("rebased");
  expect(restore("q2")).toEqual({ editing: "typed after leaving? no: typed before leaving", base: "r5" });
  track("q2", null, "r5");
});

test("store level: edit numbers never repeat, across Cancel, a save and a new draft: an old save's answer cannot clear a new draft", () => {
  track("r", "one", "r1");
  const old = drafts.edit("r");
  track("r", null, "r1"); // Cancel
  track("r", "a fresh draft", "r1");
  expect(drafts.edit("r")).not.toBe(old);
  expect(drafts.saved("r", old, "r2")).toBe("unrelated"); // the old save answers late: the fresh draft stays
  expect(restore("r")).toEqual({ editing: "a fresh draft", base: "r1" }); // and its revision is not moved by the old save
  track("r", null, "r1");
});

test("store level: starting an edit (begin) sets the held revision, and a save answered meanwhile moves it for every mounted copy", () => {
  drafts.hold("m", "from their version", "theirs-rev"); // what begin() does
  expect(restore("m").base).toBe("theirs-rev");
  const sent = drafts.edit("m");
  track("m", "typed on", drafts.get("m")?.base ?? "stale"); // a newly mounted editor tracks with the held base, not its own stale one
  expect(drafts.saved("m", sent, "r9")).toBe("rebased");
  track("m", "typed on, more", drafts.get("m")?.base ?? "stale");
  expect(restore("m").base).toBe("r9");
  track("m", null, "r9");
});

test("store level: the same text tracked again is not a new edit", () => {
  track("same", "abc", "r1");
  const n = drafts.edit("same");
  track("same", "abc", "r1");
  expect(drafts.edit("same")).toBe(n);
  track("same", null, "r1");
});

test("a long source draws a window around the cited moment and grows a window at a time", () => {
  expect(sourceWindow(100, -1)).toEqual([0, 100]);
  expect(sourceWindow(50_000, -1)).toEqual([0, 300]);
  expect(sourceWindow(50_000, 30_000)).toEqual([29_850, 30_150]);
  expect(sourceWindow(50_000, 49_999)).toEqual([49_700, 50_000]);
  expect(sourceWindow(50_000, 30_000, [29_550, 30_150])).toEqual([29_550, 30_150]);
  expect(sourceWindow(1000, 0, [-300, 1300])).toEqual([0, 1000]);
});

test("the card says how a page is filed, as far as the change alters it", () => {
  expect(metaLine(undefined)).toBe("");
  expect(metaLine({ from: { category: "topics", workstreams: [] }, to: { category: "topics", workstreams: [] } })).toBe("");
  expect(metaLine({ from: { category: "topics", workstreams: [] }, to: { category: "decisions", workstreams: ["billing"] } })).toBe("Filed under Decisions (was Topics). Workstreams: billing (was none).");
  expect(metaLine({ from: { category: "topics", workstreams: ["a"] }, to: { category: "topics", workstreams: [] } })).toBe("Workstreams: none (was a).");
  expect(metaLine({ to: { category: "people", workstreams: ["x", "y"] } })).toBe("Filed under People. Workstreams: x, y.");
});

test("store level: a save made from another view settles this view's draft too (cleared or rebased)", () => {
  const heard: string[] = [];
  const stop = drafts.listen("shared", (o) => heard.push(o));
  track("shared", "text", "r1");
  const sent = drafts.edit("shared");
  track("shared", "text and more", "r1");
  drafts.saved("shared", sent, "r2");
  const next = drafts.edit("shared");
  drafts.saved("shared", next, "r3");
  expect(heard).toEqual(["rebased", "cleared"]);
  stop();
  track("shared", "x", "r3");
  drafts.saved("shared", drafts.edit("shared"), "r4");
  expect(heard.length).toBe(2); // no longer listening
});

test("the local map shows every neighbour a page has, even when the global map was thinned", () => {
  const metas = Array.from({ length: 40 }, (_, i) => ({ slug: `p${i}`, title: `P${i}`, category: "topics", backlinks: 1 }));
  const page = { slug: "p0", title: "P0", category: "topics", links: metas.slice(1, 31).map((m) => ({ slug: m.slug, exists: true })), backlinks: metas.slice(31).map((m) => ({ slug: m.slug, title: m.title })) };
  const g = localOf(page, metas);
  expect(g.nodes.length).toBe(40);
  expect(g.edges.length).toBe(39);
  expect(g.near.get("p0")!.size).toBe(39);
  // A link to a page that doesn't exist yet is not a node.
  expect(localOf({ ...page, links: [{ slug: "nope", exists: false }], backlinks: [] }, metas).nodes.map((n) => n.id)).toEqual(["p0"]);
});

test("the wiki status shows version history off only when the hub says so", () => {
  expect(historyOf(undefined)).toEqual({ off: false, why: "" });
  expect(historyOf({ state: "on" })).toEqual({ off: false, why: "" });
  expect(historyOf({ state: "none" })).toEqual({ off: false, why: "" });
  expect(historyOf({ state: "off", why: "the repository uses SHA-256 object ids" })).toEqual({ off: true, why: "the repository uses SHA-256 object ids" });
});

test("search hits are shown only for the words they answered: a newer query, or a failed one, shows none", () => {
  const answer = { q: "pricing", hits: [{ slug: "pricing" }] };
  expect(freshHits(answer, "pricing")).toEqual([{ slug: "pricing" }]);
  expect(freshHits(answer, " pricing ")).toEqual([{ slug: "pricing" }]);
  expect(freshHits(answer, "pricing tiers")).toBeNull(); // typed on: the earlier answer is not this query's
  expect(freshHits(null, "pricing")).toBeNull(); // a failed search keeps no hits
});

test("the index's arrow keys can reach both kinds of row it shows (this reads the source: there is no DOM here)", async () => {
  const src = await Bun.file(new URL("../src/wiki/WikiView.tsx", import.meta.url)).text();
  const selector = [...src.matchAll(/querySelector(?:All)?<HTMLElement>\("([^"]+)"\)/g)].map((m) => m[1]).filter((q) => q.includes("wk-item"));
  expect(selector.length).toBeGreaterThan(0);
  for (const q of selector) {
    expect(q).toContain(".wk-item");
    expect(q).toContain(".wk-hit"); // search answers render rows of this class
  }
  expect(src).toContain('className={`wk-hit ');
  expect(src).toContain('className={`wk-item ');
});
