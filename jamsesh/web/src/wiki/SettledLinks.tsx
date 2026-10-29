// The Work tab's "what the project has settled": the wiki's decision, requirement and question pages, by category.
// A project may keep one list page per kind (decisions, requirements, open-questions), a page per item, or both; all count.
import { useEffect, useState } from "react";
import { openWiki } from "./nav";
import { wikiApi } from "./wikiApi";
import type { Category, PageMeta } from "./types";
import { hub } from "../shared/hub";

const KINDS: { cat: Category; label: string; one: string; many: string; list: string }[] = [
  { cat: "decisions", label: "Decisions", one: "decision", many: "decisions", list: "decisions" },
  { cat: "requirements", label: "Requirements", one: "requirement", many: "requirements", list: "requirements" },
  { cat: "questions", label: "Open questions", one: "question", many: "questions", list: "open-questions" },
];

/** Items on a page: its bullet lines (the maintainer keeps one item to a bullet). */
export const countItems = (markdown: string) => (markdown.match(/^\s*(?:[-*+]|\d+\.)\s+\S/gm) ?? []).length;

export interface Settled {
  label: string;
  count: number;
  unit: string;
  /** The page a click opens: the list page when there is one, or the newest. */
  open: string;
  latest: string | null;
}

/** One entry per kind that has pages: a list page counts its bullets, every other page in the category counts one. */
export function settled(pages: PageMeta[], bullets: Record<string, number>): Settled[] {
  return KINDS.flatMap((k) => {
    const here = pages.filter((p) => p.category === k.cat).sort((a, b) => b.mtime - a.mtime);
    if (!here.length) return [];
    const list = here.find((p) => p.slug === k.list);
    const count = here.reduce((n, p) => n + (p === list ? (bullets[p.slug] ?? 0) : 1), 0);
    const latest = here.find((p) => p !== list) ?? null;
    return [{ label: k.label, count, unit: count === 1 ? k.one : k.many, open: (list ?? here[0]).slug, latest: latest?.title ?? null }];
  });
}

export function SettledLinks() {
  const [rows, setRows] = useState<Settled[] | null>(null);
  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const { pages } = await wikiApi.pages();
        const lists = KINDS.map((k) => k.list).filter((s) => pages.some((p) => p.slug === s));
        const counts = await Promise.all(lists.map((s) => wikiApi.page(s).then((x) => [s, countItems(x.markdown)] as const, () => [s, 0] as const)));
        if (live) setRows(settled(pages, Object.fromEntries(counts)));
      } catch {
        if (live) setRows([]);
      }
    };
    void load();
    const off = hub.onMessage((m) => m?.type === "wiki" && void load());
    return () => {
      live = false;
      off();
    };
  }, []);
  return (
    <section className="settled">
      <h2 style={{ margin: "0 0 12px", fontSize: 20, fontWeight: 650 }}>What the project has settled</h2>
      {rows?.length ? (
        <div className="settled-row">
          {rows.map((r) => (
            <button key={r.label} className="settled-card" onClick={() => openWiki(r.open)}>
              <b>{r.label}</b>
              <span>
                {r.count} {r.unit}
              </span>
              {r.latest && <span className="ellipsis">Latest: {r.latest}</span>}
            </button>
          ))}
        </div>
      ) : (
        <div className="empty-note">
          Decisions, requirements and open questions collect in the wiki as the room works.{" "}
          <button className="btn small" onClick={() => openWiki("")}>Open the wiki</button>
        </div>
      )}
    </section>
  );
}
