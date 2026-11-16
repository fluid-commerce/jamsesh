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

const wordsOf = (t: string) => normalized(t).split(" ").filter(Boolean);

/** A copy needs this many words before it can match a longer one: "Yes" over someone's sentence is its own line. */
const MIN_FUZZY_WORDS = 3;
/** Share of the shorter copy's words the longer one has, for the same sentence heard through two mics. */
const SAME_WORDS_SHARE = 0.7;
/** A run this long, taken from a reply the room just said out loud, is that reply coming back through a mic. */
const ECHO_RUN = 5;
/** Fewer words than this can't be told from someone answering ("yes", "okay, do it"). */
const ECHO_MIN_WORDS = 4;

/**
 * The same sentence heard by two mics: the words are equal, or the shorter copy (at least three words) is the start
 * or the end of the longer one, or most of its words are in the longer one (a word whisper heard differently, one cut off).
 */
export function sameWords(a: string, b: string) {
  const x = wordsOf(a);
  const y = wordsOf(b);
  if (!x.length || !y.length) return false;
  if (x.join(" ") === y.join(" ")) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length < MIN_FUZZY_WORDS) return false;
  if (short.every((w, i) => long[i] === w) || short.every((w, i) => long[long.length - short.length + i] === w)) return true;
  const have = new Set(long);
  return short.filter((w) => have.has(w)).length / short.length >= SAME_WORDS_SHARE;
}

/** Whether a transcript is the room's own spoken reply heard again: most of its words are the reply's, or it holds a run of the reply. */
export function quotesReply(heard: string, reply: string) {
  const x = wordsOf(heard);
  const y = wordsOf(reply);
  if (x.length < ECHO_MIN_WORDS || !y.length) return false;
  const have = new Set(y);
  if (x.filter((w) => have.has(w)).length / x.length >= SAME_WORDS_SHARE) return true;
  const run = ` ${y.join(" ")} `;
  for (let i = 0; i + ECHO_RUN <= x.length; i++) if (run.includes(` ${x.slice(i, i + ECHO_RUN).join(" ")} `)) return true;
  return false;
}

/** Who a comparison is among: its targets and the agents they compare with, however it was written (the others only, or everyone). */
export const comparisonSet = (targets: string[], counterparts?: string[]) => [...new Set([...targets, ...(counterparts ?? [])])];
/** Whether two lists name the same agents, in any order. */
export const sameSet = (a: string[], b: string[]) => a.slice().sort().join() === b.slice().sort().join();
