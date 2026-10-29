// The wiki's HTTP routes (/api/wiki/…), for people's windows. Agents use the jam_wiki_* tools and can't edit pages.
// Returns the status and body, or null when the path isn't the wiki's; http.ts wraps it in a response.
import { type Category, CATEGORIES, backlinksOf, graph, isSourceId, linksOf, listPages, pageSlugs, readLog, readPage, readSource, searchPages, sourceIds} from "./files";
import type { Page } from "./files";
import type { WikiService } from "./service";

const LINKS_LISTED = 20;

export interface WikiReply {
  status: number;
  body: unknown;
}

const ok = (body: unknown, status = 200): WikiReply => ({ status, body });
const fail = (error: string, status = 400, extra: object = {}): WikiReply => ({ status, body: { error, ...extra } });

/** A page as the Wiki tab reads it. */
export function pageJson(w: WikiService, p: Page) {
  const have = new Set(pageSlugs(w.dir));
  return {
    slug: p.slug,
    title: p.title,
    category: p.category,
    frontMatter: p.frontMatter,
    markdown: p.markdown,
    rev: p.rev,
    backlinks: backlinksOf(w.dir, p.slug),
    links: linksOf(p.markdown).map((l) => ({ slug: l, title: readPage(w.dir, l)?.title ?? l, exists: have.has(l) })),
    sources: p.frontMatter.sources.map((id) => {
      const s = readSource(w.dir, id);
      return { id, title: s?.title ?? id, kind: s?.kind ?? "document", ts: s?.ts ?? 0, exists: !!s };
    }),
  };
}

export async function wikiRoute(w: WikiService, method: string, path: string, url: URL, body: any, who: { name: string }): Promise<WikiReply | null> {
  if (path !== "/wiki" && !path.startsWith("/wiki/")) return null;

  // The index lists up to LINKS_LISTED links a page (a fully linked vault would be millions); a page's own route has every one.
  if (path === "/wiki/pages" && method === "GET") return ok({ ready: w.info().ready, project: w.project, pages: listPages(w.dir).map((p) => ({ ...p, links: p.links.slice(0, LINKS_LISTED) })) });
  if (path === "/wiki/graph" && method === "GET") return ok(graph(w.dir));
  if (path === "/wiki/log" && method === "GET") return ok({ entries: readLog(w.dir, Math.min(200, Number(url.searchParams.get("limit")) || 100)) });
  if (path === "/wiki/search" && method === "GET") return ok({ results: searchPages(w.dir, url.searchParams.get("q") ?? "", 20) });

  let m = path.match(/^\/wiki\/page\/([^/]+)$/);
  if (m && method === "GET") {
    const p = readPage(w.dir, m[1]);
    return p ? ok(pageJson(w, p)) : fail("No such page.", 404);
  }
  if (m && method === "PUT") {
    if (typeof body?.markdown !== "string") return fail("markdown is required.");
    const cat = body.category === undefined ? undefined : (CATEGORIES as readonly string[]).includes(body.category) ? (body.category as Category) : null;
    if (cat === null) return fail(`category is one of ${CATEGORIES.join(", ")}.`);
    const r = w.editPage(m[1], body.markdown, { rev: typeof body.rev === "string" ? body.rev : undefined, by: who.name, title: typeof body.title === "string" ? body.title : undefined, category: cat });
    if (r.ok) return ok({ ok: true, page: pageJson(w, r.page) });
    return fail(r.error, r.status, r.current ? { current: pageJson(w, r.current) } : {});
  }

  // The whole of a change a card shows part of (people only: an unaccepted proposal is for them to read).
  m = path.match(/^\/wiki\/proposal\/([\w-]+)\/([^/]+)$/);
  if (m && method === "GET") {
    const d = w.fullDiff(m[1], m[2]);
    return d ? ok(d) : fail("That proposal is gone.", 404);
  }

  m = path.match(/^\/wiki\/source\/([^/]+)$/);
  if (m && method === "GET") {
    const s = isSourceId(m[1]) ? readSource(w.dir, m[1]) : null;
    return s ? ok({ id: s.id, title: s.title, kind: s.kind, ts: s.ts, by: s.by, text: s.text }) : fail("No such source.", 404);
  }
  if (path === "/wiki/sources" && method === "GET") {
    const all = sourceIds(w.dir).slice(-200).reverse().map((id) => readSource(w.dir, id)).filter((x): x is NonNullable<typeof x> => !!x);
    const state = w.sourceStates(all.map((x) => x.id));
    // `ingested` is true only for a source an accepted or dismissed card (or an empty ingest) has settled; `state` also says "held" for one an open card is waiting on.
    return ok({ sources: all.map((s) => ({ id: s.id, title: s.title, kind: s.kind, ts: s.ts, ingested: state[s.id] === "ingested", state: state[s.id] })) });
  }
  if (path === "/wiki/sources" && method === "POST") {
    const title = typeof body?.title === "string" ? body.title : "";
    try {
      if (typeof body?.attachment === "string") return ok({ ok: true, source: pub(await w.addAttachmentSource(body.attachment, title, who.name)) }, 201);
      if (typeof body?.url === "string" && body.url.trim()) {
        const u = body.url.trim();
        if (!/^https?:\/\/\S{1,2000}$/.test(u)) return fail("url must be an http or https link.");
        // The link is kept as it is; the hub doesn't fetch it, so a link can't make it reach into the network.
        return ok({ ok: true, source: pub(w.addSource("link", title || u, `Link: ${u}${typeof body.text === "string" ? `\n\n${body.text}` : ""}`, who.name)) }, 201);
      }
      if (typeof body?.text === "string" && body.text.trim()) return ok({ ok: true, source: pub(w.addSource("document", title || "Untitled document", body.text, who.name)) }, 201);
      return fail("Send text, a url or an attachment.");
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e), (e as { status?: number }).status ?? 400);
    }
  }
  if (path === "/wiki/ingest" && method === "POST") {
    const r = await w.tick();
    return ok({ ok: true, card: r?.card?.id ?? null, changes: r?.changes ?? 0 });
  }
  if (path === "/wiki/query" && method === "POST") {
    if (typeof body?.question !== "string" || !body.question.trim()) return fail("question is required.");
    const r = await w.query(body.question, { file: !!body.file, by: who.name });
    return ok({ answer: r.answer, pages: r.pages, card: r.card?.id ?? null });
  }
  if (path === "/wiki/lint" && method === "POST") {
    const r = await w.lint();
    return ok({ ok: true, findings: r.findings.length, cardId: r.card?.id ?? null });
  }
  return fail("Not found.", 404);
}

const pub = (s: { id: string; title: string; kind: string; ts: number }) => ({ id: s.id, title: s.title, kind: s.kind, ts: s.ts });
