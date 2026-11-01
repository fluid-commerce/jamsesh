// What agents get from the wiki: a compact join section and the text of the jam_wiki_* tools.
import { CATEGORIES, backlinksOf, listPages, readPage, searchPages, slugifyTitle } from "./files";

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1)).trimEnd()}…`);

/**
 * The index and the pages for one workstream, within `budget` characters (jam_join stays under about 1,500 tokens).
 * What doesn't fit is named so the agent can fetch it with jam_wiki_read. Null when the wiki has no pages.
 */
export function wikiBriefing(dir: string, workstream: string | undefined, budget: number): string | null {
  const pages = listPages(dir);
  if (!pages.length) return null;
  const lines: string[] = ["## Project wiki (this project's memory across sessions; jam_wiki_read <page>, jam_wiki_search, jam_wiki_query)"];
  const room = Math.max(400, budget);
  const mineSlug = workstream ? slugifyTitle(workstream) : "";
  const mine = pages.filter((p) => workstream && (p.slug === mineSlug || readPage(dir, p.slug)?.frontMatter.workstreams.some((w) => w.toLowerCase() === workstream.toLowerCase()))).slice(0, 6);
  const indexBudget = Math.floor(room * (mine.length ? 0.5 : 0.9));
  let index = "";
  let shown = 0;
  for (const c of CATEGORIES) {
    const here = pages.filter((p) => p.category === c);
    if (!here.length) continue;
    const row = `- ${c}: ${here.map((p) => p.slug).join(", ")}\n`;
    const fit = index.length + row.length <= indexBudget ? row : `- ${c}: ${here.map((p) => p.slug).join(", ").slice(0, Math.max(0, indexBudget - index.length - 40))}…\n`;
    index += fit;
    shown += 1;
    if (index.length >= indexBudget) break;
  }
  lines.push(index.trimEnd());
  if (shown < new Set(pages.map((p) => p.category)).size || index.includes("…")) lines.push(`(${pages.length} pages in all; jam_wiki_search finds the rest.)`);
  if (mine.length) {
    let left = room - lines.join("\n").length - 80;
    lines.push(`## Wiki pages for ${workstream}`);
    for (const p of mine) {
      const page = readPage(dir, p.slug);
      if (!page || left < 150) {
        lines.push(`- ${p.slug}: jam_wiki_read it`);
        continue;
      }
      const body = clip(page.markdown.replace(/\n{2,}/g, "\n").trim(), Math.min(700, left));
      left -= body.length;
      lines.push(body.length < page.markdown.trim().length ? `${body}\n(cut; jam_wiki_read ${p.slug} for the rest)` : body);
    }
  }
  return lines.join("\n");
}

/** jam_wiki_read: a page by name (slug or title), with where it links and what links to it. */
export function wikiReadText(dir: string, name: string): string {
  const slug = slugifyTitle(name);
  const p = readPage(dir, slug);
  if (!p) {
    const near = searchPages(dir, name, 5);
    return `No page "${name}".${near.length ? ` Closest: ${near.map((n) => n.slug).join(", ")}.` : ""}`;
  }
  const back = backlinksOf(dir, slug);
  return [`${p.slug} (${p.frontMatter.type}, updated ${p.frontMatter.updated})`, clip(p.markdown.trim(), 12_000), back.length ? `Linked from: ${back.map((b) => b.slug).join(", ")}` : "", p.frontMatter.sources.length ? `Sources: ${p.frontMatter.sources.join(", ")}` : ""].filter(Boolean).join("\n\n");
}

export function wikiSearchText(dir: string, query: string): string {
  const hits = searchPages(dir, query, 10);
  return hits.length ? hits.map((h) => `- ${h.slug} (${h.category}): ${h.title}. ${h.snippet}`).join("\n") : "Nothing in the wiki matches that.";
}
