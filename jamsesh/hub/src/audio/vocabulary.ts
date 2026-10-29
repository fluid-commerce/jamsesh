// The room's vocabulary (5.2): the names and project words every engine is biased toward, and a
// conservative correction pass that fixes them in whatever an engine wrote.
//
// The pass fixes three things and nothing else:
//   - what the room said an engine writes instead ("Chey: Shay" in Settings turns "Shay" into "Chey");
//   - a name or coined word split or recased ("jam sesh", "jamsesh" -> "JamSesh");
//   - a near-miss of a name or coined word of six letters or more ("Jamsash", "Fitcraft").
// Ordinary English words are never touched, so "share" stays "share" and "password" stays
// "password" even with Chey and Passport in the room.

import { existsSync, readFileSync } from "node:fs";

export interface VocabEntry {
  /** How it is written: "Chey", "JamSesh", "left-hand nav". */
  term: string;
  /** What engines write instead when they hear it ("Shay" for Chey); replaced wherever it appears. */
  heard: string[];
  /** A name or coined word: its splits and close misspellings are fixed too. */
  proper: boolean;
}

export interface VocabSources {
  people?: string[];
  agents?: string[];
  /** The names the brain answers to. */
  brain?: string[];
  workstreams?: string[];
  /** Glossary and project terms. */
  terms?: string[];
  /** The room's own list (the `vocabulary` setting): "Term" or "Term: heard as, heard as". */
  custom?: string[];
}

export const MAX_VOCAB = 300;
const MAX_TERM = 60;

/** Lowercase letters and digits only: "Jam-Sesh's" and "jamsesh" compare equal. */
export const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

let dictionary: Set<string> | null | undefined;
/** The system word list's lowercase words (proper nouns there are capitalized), or null when there is none. */
function commonWords(): Set<string> | null {
  if (dictionary !== undefined) return dictionary;
  const file = ["/usr/share/dict/words", "/usr/dict/words"].find((f) => existsSync(f));
  try {
    dictionary = file ? new Set(readFileSync(file, "utf8").split("\n").filter((w) => /^[a-z]+$/.test(w))) : null;
  } catch {
    dictionary = null;
  }
  return dictionary;
}

/** An everyday word that must never be rewritten. Without a word list, every lowercase word counts. */
function isCommon(word: string): boolean {
  const dict = commonWords();
  if (!dict) return word === word.toLowerCase();
  // The list has few inflections: "payments" and "mixed" count through "payment" and "mix".
  const w = word.toLowerCase();
  return [w, w.replace(/'?s$/, ""), w.replace(/es$/, ""), w.replace(/e?d$/, ""), w.replace(/ing$/, ""), w.replace(/ing$/, "e")].some((x) => x.length > 1 && dict.has(x));
}

/** Coined or a name: an inner capital ("JamSesh"), a digit, or one word the dictionary doesn't know. */
function coined(term: string): boolean {
  if (/\p{Ll}\p{Lu}|\p{N}/u.test(term)) return true;
  const words = term.split(/[\s-]+/).filter(Boolean);
  return words.length === 1 && !isCommon(words[0]);
}

/** The `vocabulary` setting as stored: strings only, trimmed, no empties or repeats, at most MAX_VOCAB lines of 160 characters. */
export function cleanVocabulary(v: unknown): string[] {
  const lines = (Array.isArray(v) ? v : typeof v === "string" ? v.split("\n") : []).filter((x): x is string => typeof x === "string");
  const out: string[] = [];
  for (const line of lines.map((l) => l.replace(/\s+/g, " ").trim().slice(0, 160))) {
    if (squash(line.split(":")[0]).length >= 2 && !out.some((o) => o.toLowerCase() === line.toLowerCase())) out.push(line);
    if (out.length >= MAX_VOCAB) break;
  }
  return out;
}

const clean = (s: unknown) => (typeof s === "string" ? s.replace(/[^\p{L}\p{N}' .&-]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, MAX_TERM) : "");

/** One list from every source, merged by spelling (any case), at most MAX_VOCAB entries. */
export function buildVocabulary(src: VocabSources): VocabEntry[] {
  const out = new Map<string, VocabEntry>();
  const add = (raw: unknown, proper: boolean | null, heard: string[] = []) => {
    const term = clean(raw);
    const key = squash(term);
    if (key.length < 2 || (out.size >= MAX_VOCAB && !out.has(key))) return;
    const e = out.get(key) ?? { term, heard: [], proper: proper ?? coined(term) };
    e.proper ||= proper ?? coined(term);
    for (const h of heard.map(clean)) if (squash(h).length >= 2 && squash(h) !== key && !e.heard.some((x) => squash(x) === squash(h))) e.heard.push(h);
    out.set(key, e);
  };
  for (const n of [...(src.people ?? []), ...(src.agents ?? []), ...(src.brain ?? [])]) add(n, true);
  for (const line of src.custom ?? []) {
    if (typeof line !== "string") continue;
    const [term, rest = ""] = line.split(":");
    add(term, null, rest.split(","));
  }
  for (const t of [...(src.terms ?? []), ...(src.workstreams ?? [])]) add(t, null);
  return [...out.values()];
}

/** The vocabulary as sherpa-onnx hotwords: "Chey/chey/JamSesh/jamsesh", each phrase in both cases. */
export function hotwords(vocab: VocabEntry[], max = 120): string {
  const seen = new Set<string>();
  for (const e of vocab) for (const p of [e.term, e.term.toLowerCase()]) if (seen.size < max) seen.add(p.replace(/[/:]/g, " "));
  return [...seen].join("/");
}

/** What Whisper is primed with: the hint, then the room's words, kept short (Whisper reads about 220 tokens). */
export function promptWith(hint: string, vocab: VocabEntry[], maxChars = 500): string {
  const words: string[] = [];
  let len = hint.length;
  for (const e of vocab) {
    if (hint.toLowerCase().includes(e.term.toLowerCase())) continue;
    if (len + e.term.length + 2 > maxChars) break;
    words.push(e.term);
    len += e.term.length + 2;
  }
  return words.length ? `${hint} ${words.join(", ")}.`.trim() : hint;
}

function distance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;
/** The shortest name or coined word whose near-misses are fixed: shorter ones collide with real words. */
const FUZZY_MIN = 6;

export interface Fix {
  from: string;
  to: string;
}

/** Fixes the room's names and coined words in a transcript. Returns the text and what changed. */
export function correctTranscript(text: string, vocab: VocabEntry[]): { text: string; fixes: Fix[] } {
  if (!vocab.length || !text) return { text, fixes: [] };
  const heard = new Map<string, VocabEntry>();
  const exact = new Map<string, VocabEntry>();
  for (const e of vocab) {
    for (const h of e.heard) heard.set(squash(h), e);
    if (e.proper) exact.set(squash(e.term), e);
  }
  const known = (k: string) => heard.has(k) || vocab.some((e) => squash(e.term) === k);
  const fuzzy = vocab.filter((e) => e.proper && squash(e.term).length >= FUZZY_MIN);
  const words = [...text.matchAll(WORD)].map((m) => ({ w: m[0], start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }));
  const fixes: Fix[] = [];
  let out = "";
  let at = 0;
  for (let i = 0; i < words.length; ) {
    let done = 0;
    for (let n = Math.min(3, words.length - i); n >= 1 && !done; n--) {
      const span = words.slice(i, i + n);
      // Only words joined by spaces or hyphens make one name; punctuation between them ends it.
      if (span.slice(1).some((w, k) => !/^[\s-]+$/.test(text.slice(span[k].end, w.start)))) continue;
      const last = span[n - 1].w.match(/^(.+?)(['’]s)$/i);
      const suffix = last ? last[2] : "";
      const original = text.slice(span[0].start, span[n - 1].end - suffix.length);
      const key = squash(original);
      let to: VocabEntry | undefined = heard.get(key);
      if (!to && exact.has(key) && original !== exact.get(key)!.term && (n > 1 || !isCommon(original))) to = exact.get(key);
      // A near-miss is fixed only when it isn't a word itself (without a word list, only capitalized words qualify).
      if (!to && !known(key) && key.length >= FUZZY_MIN - 1 && !isCommon(n > 1 ? key : original)) {
        const close = (k: string, t: string) => k[0] === t[0] && distance(k, t, 2) <= (t.length >= 8 ? 2 : 1);
        // Every word must be needed: "workstream is" isn't a misspelling of "workstream".
        const trimmed = n > 1 ? [squash(span.slice(1).map((w) => w.w).join("")), squash(span.slice(0, -1).map((w) => w.w).join(""))] : [];
        const near = fuzzy.filter((e) => {
          const t = squash(e.term);
          return close(key, t) && !trimmed.some((k) => close(k, t));
        });
        if (near.length === 1) to = near[0];
      }
      if (!to || to.term === original) continue;
      out += text.slice(at, span[0].start) + to.term + suffix;
      at = span[n - 1].end;
      fixes.push({ from: original, to: to.term });
      done = n;
    }
    i += done || 1;
  }
  return { text: out + text.slice(at), fixes };
}
