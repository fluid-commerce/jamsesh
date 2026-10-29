// The link graph as data: shaped from the hub's nodes and edges, with the lookups the canvas needs.
import { asCategory, type Category, type RawGraph } from "./types";

export const MAX_NODES = 400;
const arr = <T>(v: T[] | undefined | null): T[] => (Array.isArray(v) ? v : []);

export interface GNode {
  id: string;
  title: string;
  category: Category;
  backlinks: number;
  /** Links in and out; what keeps a hub of the map near its middle. */
  degree: number;
  r: number;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
}
export interface GEdge {
  source: string;
  target: string;
}
export interface Graph {
  nodes: GNode[];
  edges: GEdge[];
  /** Who each page is linked with, either direction. */
  near: Map<string, Set<string>>;
}

/** A node's radius from how many pages link to it; the square root keeps one popular page from swallowing the map. */
export const radiusFor = (backlinks: number, scale = 1) => (4.5 + Math.sqrt(Number.isFinite(backlinks) ? Math.max(0, backlinks) : 0) * 3.2) * scale;

/** Whatever the hub sent, made safe to draw: no repeats, no dangling or self links, bounded, finite numbers. */
export function shapeGraph(raw: Partial<RawGraph> | null | undefined, scale = 1): Graph {
  const seen = new Map<string, GNode>();
  for (const n of arr(raw?.nodes)) {
    const id = n && typeof n.id === "string" ? n.id : "";
    if (!id || seen.has(id)) continue;
    const backlinks = Number.isFinite(n.backlinks) && n.backlinks > 0 ? Math.floor(n.backlinks) : 0;
    seen.set(id, { id, title: String(n.title || id).slice(0, 120), category: asCategory(n.category), backlinks, degree: 0, r: radiusFor(backlinks, scale) });
  }
  const edges: GEdge[] = [];
  const have = new Set<string>();
  for (const e of arr(raw?.edges)) {
    if (!e || e.from === e.to || !seen.has(e.from) || !seen.has(e.to)) continue;
    const key = `${e.from}\u0000${e.to}`;
    if (have.has(key)) continue;
    have.add(key);
    edges.push({ source: e.from, target: e.to });
  }
  const degree = new Map<string, number>();
  for (const e of edges) for (const id of [e.source, e.target]) degree.set(id, (degree.get(id) ?? 0) + 1);
  let nodes = [...seen.values()];
  for (const n of nodes) n.degree = degree.get(n.id) ?? 0;
  if (nodes.length > MAX_NODES) {
    nodes = nodes.sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id)).slice(0, MAX_NODES);
    const keep = new Set(nodes.map((n) => n.id));
    for (let i = edges.length - 1; i >= 0; i--) if (!keep.has(edges[i].source) || !keep.has(edges[i].target)) edges.splice(i, 1);
  }
  const near = new Map<string, Set<string>>(nodes.map((n) => [n.id, new Set<string>()]));
  for (const e of edges) (near.get(e.source)!.add(e.target), near.get(e.target)!.add(e.source));
  return { nodes, edges, near };
}

/** One page and the pages it links with, for the small map beside a page. */
export function localGraph(g: Graph, slug: string): Graph {
  const around = g.near.get(slug);
  if (!around) return { nodes: [], edges: [], near: new Map() };
  const keep = new Set([slug, ...around]);
  const nodes = g.nodes.filter((n) => keep.has(n.id)).map((n) => ({ ...n }));
  const edges = g.edges.filter((e) => keep.has(e.source) && keep.has(e.target) && (e.source === slug || e.target === slug)).map((e) => ({ ...e }));
  const near = new Map<string, Set<string>>(nodes.map((n) => [n.id, new Set<string>()]));
  for (const e of edges) (near.get(e.source)!.add(e.target), near.get(e.target)!.add(e.source));
  return { nodes, edges, near };
}

/** The order the keyboard walks the map in: by category, then title. */
export const walkOrder = (g: Graph) => [...g.nodes].sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title)).map((n) => n.id);

/** Which nodes get a name drawn beside them without hovering: the biggest few, scaled to how much room there is. */
export function labelled(g: Graph, max: number): Set<string> {
  return new Set([...g.nodes].sort((a, b) => b.backlinks - a.backlinks || b.degree - a.degree || a.id.localeCompare(b.id)).slice(0, Math.max(0, max)).map((n) => n.id));
}

/** The nearest node under a point, if the point is within its radius plus a little slack. */
export function nodeAt(nodes: GNode[], x: number, y: number, slack = 5): GNode | null {
  let best: GNode | null = null;
  let bestD = Infinity;
  for (const n of nodes) {
    if (n.x === undefined || n.y === undefined) continue;
    const d = Math.hypot(n.x - x, n.y - y);
    if (d <= n.r + slack && d < bestD) (best = n, (bestD = d));
  }
  return best;
}
