// A small line diff for the wiki cards: unified-style hunks with two lines of context, cut to a readable size. Removed
// lines are never hidden: past the cut the rest of them follow, and the counts cover the whole page.
const MAX_LINES = 700;
const CONTEXT = 2;

type Op = { k: " " | "+" | "-"; s: string };

/**
 * The line-by-line edit from `before` to `after`. The lines both pages start and end with are matched first. If what is
 * left between is still too long to line up, it is shown whole (every line removed, then every line added), in order:
 * a reordered page is never reported as unchanged.
 */
function ops(before: string, after: string): { ops: Op[]; aligned: boolean } {
  const full = (before ? before.split("\n") : []) as string[];
  const fullB = (after ? after.split("\n") : []) as string[];
  let lo = 0;
  while (lo < full.length && lo < fullB.length && full[lo] === fullB[lo]) lo++;
  let hiA = full.length;
  let hiB = fullB.length;
  while (hiA > lo && hiB > lo && full[hiA - 1] === fullB[hiB - 1]) hiA--, hiB--;
  const a = full.slice(lo, hiA);
  const b = fullB.slice(lo, hiB);
  const head: Op[] = full.slice(0, lo).map((s) => ({ k: " ", s }));
  const tail: Op[] = full.slice(hiA).map((s) => ({ k: " ", s }));
  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return { ops: [...head, ...a.map((s): Op => ({ k: "-", s })), ...b.map((s): Op => ({ k: "+", s })), ...tail], aligned: false };
  }
  const n = a.length;
  const m = b.length;
  const t: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const out: Op[] = [...head];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) out.push({ k: " ", s: a[i++] }), j++;
    else if (t[i + 1][j] >= t[i][j + 1]) out.push({ k: "-", s: a[i++] });
    else out.push({ k: "+", s: b[j++] });
  }
  while (i < n) out.push({ k: "-", s: a[i++] });
  while (j < m) out.push({ k: "+", s: b[j++] });
  return { ops: [...out, ...tail], aligned: true };
}

export function lineDiff(before: string, after: string, maxChars = 6000): string {
  const { ops: all, aligned } = ops(before, after);
  const keep = new Array(all.length).fill(false);
  all.forEach((o, x) => {
    if (o.k !== " ") for (let y = Math.max(0, x - CONTEXT); y <= Math.min(all.length - 1, x + CONTEXT); y++) keep[y] = true;
  });
  const out: string[] = aligned ? [] : ["(too long to line up: the lines that changed are shown whole, removed then added)"];
  let gap = false;
  all.forEach((o, x) => {
    if (!keep[x]) return void (gap = out.length > 0);
    if (gap) out.push("@@");
    gap = false;
    out.push(`${o.k}${o.s}`);
  });
  const text = out.join("\n");
  if (text.length <= maxChars) return text;
  // Cut at a line, but the removed lines past the cut still follow: what a change takes away is what most needs a look.
  const head = text.slice(0, Math.max(0, text.lastIndexOf("\n", maxChars)));
  const shown = head.split("\n").filter((l) => l.startsWith("-")).length;
  const rest = all.filter((o) => o.k === "-").slice(shown).map((o) => `-${o.s}`);
  if (!rest.length) return `${head}\n(cut here)`;
  const tail: string[] = [];
  let room = maxChars;
  for (const l of rest) {
    if (l.length + 1 > room) break;
    tail.push(l);
    room -= l.length + 1;
  }
  const more = rest.length - tail.length;
  return `${head}\n(cut here; the rest of the lines it removes:)\n${tail.join("\n")}${more ? `\n(and ${more} more line${more === 1 ? "" : "s"} removed)` : ""}`;
}

/** Lines added and removed over the whole page, and whether the change takes out a large part of it (the page shrinks by a third or more). */
export function diffStats(before: string, after: string): { added: number; removed: number; largeDeletion: boolean } {
  const { ops: all } = ops(before, after);
  const removed = all.filter((o) => o.k === "-").length;
  const added = all.filter((o) => o.k === "+").length;
  return { added, removed, largeDeletion: removed >= 3 && after.length < before.length * 0.67 };
}
