// The Work tab's "what the session has settled": short links to the wiki's decisions, requirements and open questions pages.
import { useEffect, useState } from "react";
import { onWikiOpen, openWiki } from "./nav";
import { wikiApi } from "./wikiApi";
import { hub } from "../shared/hub";

const PAGES = [
  { slug: "decisions", label: "Decisions", unit: "decision" },
  { slug: "requirements", label: "Requirements", unit: "requirement" },
  { slug: "open-questions", label: "Open questions", unit: "question" },
] as const;

/** Items on a page: its bullet lines (the maintainer keeps one item to a bullet). */
export const countItems = (markdown: string) => (markdown.match(/^\s*(?:[-*+]|\d+\.)\s+\S/gm) ?? []).length;

export function SettledLinks() {
  const [counts, setCounts] = useState<Record<string, number | null>>({});
  useEffect(() => {
    let live = true;
    const load = () =>
      Promise.all(PAGES.map((p) => wikiApi.page(p.slug).then((x) => [p.slug, countItems(x.markdown)] as const, () => [p.slug, null] as const))).then((r) => live && setCounts(Object.fromEntries(r)));
    void load();
    const off = hub.onMessage((m) => m?.type === "wiki" && void load());
    return () => {
      live = false;
      off();
    };
  }, []);
  const here = PAGES.filter((p) => counts[p.slug] !== null && counts[p.slug] !== undefined);
  return (
    <section className="settled">
      <h2 style={{ margin: "0 0 12px", fontSize: 20, fontWeight: 650 }}>What the project has settled</h2>
      {here.length ? (
        <div className="settled-row">
          {here.map((p) => (
            <button key={p.slug} className="settled-card" onClick={() => openWiki(p.slug)}>
              <b>{p.label}</b>
              <span>{counts[p.slug]} {counts[p.slug] === 1 ? p.unit : p.unit === "question" ? "questions" : `${p.unit}s`}</span>
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
