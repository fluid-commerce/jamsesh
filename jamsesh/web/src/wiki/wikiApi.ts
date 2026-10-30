// The wiki's routes, through the same api() helper every button uses. People only: an agent's credential gets 403.
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, hub, type WikiMeta } from "../shared/hub";
import { asCategory, type LogEntry, type PageMeta, type RawGraph, type SearchHit, type SourceText, type WikiPage } from "./types";
import { pulses } from "./pulse";
import { shapeGraph, type Graph } from "./graph";

const enc = encodeURIComponent;
const NOW = { queue: false } as const;

const tidy = (p: any): PageMeta => ({ ...p, category: asCategory(p?.category), title: String(p?.title ?? p?.slug ?? ""), summary: String(p?.summary ?? ""), links: Array.isArray(p?.links) ? p.links : [], backlinks: Number(p?.backlinks) || 0 });
const tidyPage = (p: any): WikiPage => ({ ...p, category: asCategory(p?.category), title: String(p?.title ?? p?.slug ?? ""), backlinks: p?.backlinks ?? [], links: p?.links ?? [], sources: p?.sources ?? [], frontMatter: p?.frontMatter ?? {} });

/** Whether the wiki keeps a version history, as the hub says (anything unexpected reads as no news, not as off). */
export const historyOf = (h: { state?: string; why?: string } | undefined): { off: boolean; why: string } => ({ off: h?.state === "off", why: typeof h?.why === "string" ? h.why.slice(0, 200) : "" });

export const wikiApi = {
  pages: async () => {
    const r = await api<{ ready: boolean; project: string; history?: { state?: string; why?: string }; pages: any[] }>("/wiki/pages", undefined, undefined, NOW);
    return { ready: !!r.ready, project: r.project ?? "", pages: (r.pages ?? []).map(tidy), history: historyOf(r.history) };
  },
  graph: (): Promise<RawGraph> => api("/wiki/graph", undefined, undefined, NOW),
  page: async (slug: string) => tidyPage(await api(`/wiki/page/${enc(slug)}`, undefined, undefined, NOW)),
  /** Saves an edit. A stale `rev` comes back as { conflict: the page as it is now }. */
  save: async (slug: string, body: { markdown: string; rev?: string; title?: string; category?: string }): Promise<{ page: WikiPage } | { conflict: WikiPage }> => {
    try {
      const r = await api<{ page: any }>(`/wiki/page/${enc(slug)}`, body, "PUT", NOW);
      return { page: tidyPage(r.page) };
    } catch (e: any) {
      if (e?.status === 409 && e?.body?.current) return { conflict: tidyPage(e.body.current) };
      throw e;
    }
  },
  search: async (q: string): Promise<SearchHit[]> => (await api<{ results: SearchHit[] }>(`/wiki/search?q=${enc(q)}`, undefined, undefined, NOW)).results ?? [],
  log: async (): Promise<LogEntry[]> => (await api<{ entries: LogEntry[] }>("/wiki/log", undefined, undefined, NOW)).entries ?? [],
  source: (id: string): Promise<SourceText> => api(`/wiki/source/${enc(id)}`, undefined, undefined, NOW),
  /** The whole of a change a wiki card shows part of. */
  fullChange: (cardId: string, slug: string): Promise<{ diff: string; added: number; removed: number; meta?: WikiMeta }> => api(`/wiki/proposal/${enc(cardId)}/${enc(slug)}`, undefined, undefined, NOW),
  addSource: (body: { title?: string; text?: string; url?: string; attachment?: string }) => api<{ ok: boolean; source: { id: string } }>("/wiki/sources", body, "POST", NOW),
};

export interface WikiData {
  pages: PageMeta[];
  graph: Graph;
  ready: boolean;
  project: string;
  /** Version history is off (and why): the wiki still works, it just keeps none. */
  history: { off: boolean; why: string };
  loading: boolean;
  error: string | null;
  /** Bumps whenever the wiki changed, so an open page knows to look again. */
  version: number;
  reload: () => void;
}

const EMPTY: Graph = { nodes: [], edges: [], near: new Map() };

/** The index and the graph, kept fresh: refetched when the hub says the wiki changed and when the connection comes back. */
export function useWiki(scale = 1): WikiData {
  const [data, setData] = useState<{ pages: PageMeta[]; raw: RawGraph | null; ready: boolean; project: string; history: { off: boolean; why: string } }>({ pages: [], raw: null, ready: true, project: "", history: { off: false, why: "" } });
  const [state, setState] = useState<{ loading: boolean; error: string | null; version: number }>({ loading: true, error: null, version: 0 });

  const load = useCallback(async () => {
    try {
      const [p, g] = await Promise.all([wikiApi.pages(), wikiApi.graph().catch(() => null)]);
      setData({ pages: p.pages, raw: g, ready: p.ready, project: p.project, history: p.history });
      setState((s) => ({ loading: false, error: null, version: s.version + 1 }));
    } catch (e: any) {
      setState((s) => ({ ...s, loading: false, error: e?.message ?? "Couldn't load the wiki." }));
    }
  }, []);

  useEffect(() => {
    void load();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = hub.onMessage((m) => {
      if (m?.type !== "wiki") return;
      if (Array.isArray(m.touched)) pulses.add(m.touched.filter((s: unknown) => typeof s === "string"));
      clearTimeout(timer);
      timer = setTimeout(() => void load(), 400);
    });
    const back = hub.onReconnect(() => void load());
    return () => (off(), back(), clearTimeout(timer));
  }, [load]);

  // Pages and links come from the same fetch; if the graph route is unavailable, it is built from the pages' links.
  // Rebuilt only when the data or the scale changes: a new graph object restarts the layout.
  const graph = useMemo(() => {
    const raw = data.raw ?? {
      nodes: data.pages.map((p) => ({ id: p.slug, title: p.title, category: p.category, backlinks: p.backlinks })),
      edges: data.pages.flatMap((p) => p.links.map((to) => ({ from: p.slug, to }))),
    };
    return data.pages.length || raw.nodes.length ? shapeGraph(raw, scale) : EMPTY;
  }, [data, scale]);
  return { ...data, ...state, graph, reload: () => void load() };
}
