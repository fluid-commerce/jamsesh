// The Wiki tab's client side: the same api() helper the buttons call, against a real hub with a seeded wiki folder.
import "fake-indexeddb/auto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../../hub/src/hub";
import { startHttp } from "../../hub/src/http";
import { api } from "../src/shared/hub";
import { wikiApi } from "../src/wiki/wikiApi";
import { shapeGraph } from "../src/wiki/graph";
import { seedWiki } from "./wiki-fixture";
import type { Decider } from "../../hub/src/wiki/service";

process.env.JAMSESH_SILENT = "1";
const dir = mkdtempSync(join(tmpdir(), "jam-web-wiki-"));
const wikiDir = join(dir, "wiki-folder");
const hub = new Hub({ canvas: false, whisper: false, dataDir: dir, wikiDir });
const server = startHttp(hub, 0);
const seeded = seedWiki(wikiDir, 40);
const agent = hub.auth.issue({ kind: "agent", label: "Agents on Mac", ip: "10.0.0.5", ownerDeviceId: "host" });

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
