// When two sentences say the same thing: the Tasks board and curation both fold repeats with these,
// so one rule decides what counts as "already said".
import { terms } from "./brain/affinity";

/** Share of the shorter text's words the other has; `both`: of the longer one's, so added detail counts as a difference. */
export function similar(a: string, b: string, both = false) {
  const x = new Set(terms(a));
  const y = new Set(terms(b));
  const inter = [...x].filter((t) => y.has(t)).length;
  return inter / Math.max(1, both ? Math.max(x.size, y.size) : Math.min(x.size, y.size));
}

/** Case, whitespace and punctuation don't make a difference between two statements; nothing else is judged here. */
export const normalized = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

const PLATFORMS = /\b(desktop|mobile|web|ios|iphone|ipad|android|tablet|phone|mac|macos|windows|linux|watch|tv)\b/gi;

/** "on desktop" and "on mobile" are two statements, not one said twice: the platforms named must agree. */
export function sameScope(a: string, b: string) {
  const p = (t: string) => [...new Set((t.match(PLATFORMS) ?? []).map((x) => x.toLowerCase()))].sort().join();
  return p(a) === p(b);
}

/**
 * The same statement said again: identical once case, spacing and punctuation are set aside. Anything else (a paraphrase,
 * an added clause, another option or number) is a different item, or a Merge card for a person: wording can't be
 * compared for meaning here, and a missed merge costs one card where a wrong one loses what was said.
 */
export function restates(a: string, b: string) {
  return normalized(a) === normalized(b);
}

/** Who a comparison is among: its targets and the agents they compare with, however it was written (the others only, or everyone). */
export const comparisonSet = (targets: string[], counterparts?: string[]) => [...new Set([...targets, ...(counterparts ?? [])])];
/** Whether two lists name the same agents, in any order. */
export const sameSet = (a: string[], b: string[]) => a.slice().sort().join() === b.slice().sort().join();
