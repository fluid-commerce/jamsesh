// The wiki's wire shapes (hub routes under /api/wiki) and the categories the UI groups and colours by.
export const CATEGORIES = ["people", "workstreams", "features", "decisions", "requirements", "questions", "repos", "topics"] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABEL: Record<Category, string> = {
  people: "People",
  workstreams: "Workstreams",
  features: "Features",
  decisions: "Decisions",
  requirements: "Requirements",
  questions: "Open questions",
  repos: "Repos",
  topics: "Topics",
};

/** One calm hue per category, close enough in lightness to sit together on a dark ground. */
export const CATEGORY_COLOR: Record<Category, string> = {
  people: "#ffb54a",
  workstreams: "#b49cff",
  features: "#45e0a0",
  decisions: "#7cc4ff",
  requirements: "#5fd4d4",
  questions: "#ff8f7a",
  repos: "#9aa3b8",
  topics: "#d6c79a",
};

export const asCategory = (c: unknown): Category => ((CATEGORIES as readonly string[]).includes(c as string) ? (c as Category) : "topics");

export interface PageMeta {
  slug: string;
  title: string;
  category: Category;
  summary: string;
  links: string[];
  backlinks: number;
  updated: string;
  mtime: number;
}

export interface SourceRef {
  id: string;
  title: string;
  kind: "transcript" | "document" | "link" | "agent" | "edit";
  ts: number;
  exists: boolean;
}

export interface WikiPage {
  slug: string;
  title: string;
  category: Category;
  frontMatter: { type?: string; workstreams?: string[]; updated?: string; sources?: string[] };
  markdown: string;
  rev: string;
  backlinks: { slug: string; title: string }[];
  links: { slug: string; title: string; exists: boolean }[];
  sources: SourceRef[];
}

export interface SourceText {
  id: string;
  title: string;
  kind: SourceRef["kind"];
  ts: number;
  text: string;
}

export interface RawGraph {
  nodes: { id: string; title: string; category: string; backlinks: number }[];
  edges: { from: string; to: string }[];
}

export interface SearchHit {
  slug: string;
  title: string;
  category: Category;
  snippet: string;
  score: number;
}

export interface LogEntry {
  ts: number;
  text: string;
  pages: string[];
}
