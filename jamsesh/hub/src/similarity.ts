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

/** Variant letters, numbers and hex colors: the details that make two similar sentences different. */
export function sameSpecifics(a: string, b: string) {
  const specifics = (t: string) =>
    new Set([...t.matchAll(/(?:\b(?:option|direction|variant|version)\s+([A-Z])\b)|\b([A-Z])\b(?=[:)\s,.])|(#[0-9a-f]{3,8})\b|\b(\d+(?:\.\d+)?)(?=px|pt|%|ms|\b)/gi)].map((m) => (m[1] ?? m[2] ?? m[3] ?? m[4]).toLowerCase()));
  const x = specifics(a);
  const y = specifics(b);
  return x.size === y.size && [...x].every((v) => y.has(v));
}

/** "three variants" and "five variants" are different asks. */
export function sameCounts(a: string, b: string) {
  const counts = (t: string) => (t.toLowerCase().match(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|couple|pair)\b/g) ?? []).join();
  return counts(a) === counts(b);
}

const NEGATION = /\b(?:not|no|never|none|nothing|without|instead|rather|neither|nor|cannot|stop|drop|remove|avoid)\b|n't\b|n’t\b/gi;

/** "must use option A" and "must not use option A" share every word but one, and mean the opposite. */
export function samePolarity(a: string, b: string) {
  const n = (t: string) => (t.match(NEGATION) ?? []).length % 2;
  return n(a) === n(b);
}

const PLATFORMS = /\b(desktop|mobile|web|ios|iphone|ipad|android|tablet|phone|mac|macos|windows|linux|watch|tv)\b/gi;

/** "on desktop" and "on mobile" are two statements, not one said twice: the platforms named must agree. */
export function sameScope(a: string, b: string) {
  const p = (t: string) => [...new Set((t.match(PLATFORMS) ?? []).map((x) => x.toLowerCase()))].sort().join();
  return p(a) === p(b);
}

/** The same statement said again: close wording, the same specifics, counts and platforms, and not negated one way only. */
export function restates(a: string, b: string, threshold: number) {
  return similar(a, b) > threshold && sameSpecifics(a, b) && sameCounts(a, b) && samePolarity(a, b) && sameScope(a, b);
}
