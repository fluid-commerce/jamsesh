// The wiki graph on the big screen: drawn at TV scale, no controls, pages the wiki just learned about pulse
// and are named for a few seconds. It keeps the same data as the Wiki tab, so what you see is what's there.
import { useEffect, useMemo, useState } from "react";
import { hub } from "../shared/hub";
import { GraphCanvas } from "./GraphCanvas";
import { useWiki } from "./wikiApi";
import { CATEGORIES, CATEGORY_COLOR, CATEGORY_LABEL } from "./types";
import "./wiki.css";

const NEWS_MS = 7000;

export function WikiStage() {
  const wiki = useWiki();
  const [news, setNews] = useState<{ at: number; slugs: string[] } | null>(null);
  useEffect(() => {
    const off = hub.onMessage((m) => {
      if (m?.type === "wiki" && Array.isArray(m.touched) && m.touched.length) setNews({ at: Date.now(), slugs: m.touched.filter((s: unknown) => typeof s === "string") });
    });
    return () => void off();
  }, []);
  useEffect(() => {
    if (!news) return;
    const t = setTimeout(() => setNews(null), NEWS_MS);
    return () => clearTimeout(t);
  }, [news]);

  const titles = useMemo(() => new Map(wiki.graph.nodes.map((n) => [n.id, n.title])), [wiki.graph]);
  const counts = useMemo(() => CATEGORIES.map((c) => ({ c, n: wiki.graph.nodes.filter((x) => x.category === c).length })).filter((x) => x.n), [wiki.graph]);
  const named = news?.slugs.map((s) => titles.get(s) ?? s).slice(0, 3) ?? [];

  return (
    <div className="wk-stage">
      {wiki.graph.nodes.length ? (
        <GraphCanvas graph={wiki.graph} mode="stage" label="The project wiki as a map of linked pages" />
      ) : (
        <div className="wk-stage-empty">
          <b>{wiki.loading ? "" : "The wiki is empty so far"}</b>
          <span>{wiki.loading ? "" : "It grows as the room talks and as documents come in."}</span>
        </div>
      )}
      <div className="wk-stage-title">
        <b>What we know</b>
        <span>{wiki.graph.nodes.length ? `${wiki.graph.nodes.length} pages, ${wiki.graph.edges.length} links` : " "}</span>
      </div>
      <ul className="wk-legend" aria-hidden>
        {counts.map(({ c, n }) => (
          <li key={c}>
            <span className="wk-dot" style={{ background: CATEGORY_COLOR[c] }} />
            {CATEGORY_LABEL[c]} <span className="wk-count">{n}</span>
          </li>
        ))}
      </ul>
      {named.length > 0 && (
        <div className="wk-stage-news" role="status" key={news!.at}>
          Just updated <b>{named.join(", ")}</b>
          {news!.slugs.length > named.length ? ` and ${news!.slugs.length - named.length} more` : ""}
        </div>
      )}
    </div>
  );
}
