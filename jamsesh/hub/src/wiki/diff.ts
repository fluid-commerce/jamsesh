// A small line diff for the wiki cards: unified-style hunks with two lines of context, cut to a readable size.
const MAX_LINES = 700;
const CONTEXT = 2;

export function lineDiff(before: string, after: string, maxChars = 6000): string {
  const a = before ? before.split("\n") : [];
  const b = after.split("\n");
  if (a.length > MAX_LINES || b.length > MAX_LINES) return `(${a.length} lines became ${b.length}: too long to compare here)`;
  // Longest common subsequence table, suffix form.
  const n = a.length;
  const m = b.length;
  const t: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const ops: { k: " " | "+" | "-"; s: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) ops.push({ k: " ", s: a[i++] }), j++;
    else if (t[i + 1][j] >= t[i][j + 1]) ops.push({ k: "-", s: a[i++] });
    else ops.push({ k: "+", s: b[j++] });
  }
  while (i < n) ops.push({ k: "-", s: a[i++] });
  while (j < m) ops.push({ k: "+", s: b[j++] });
  const keep = new Array(ops.length).fill(false);
  ops.forEach((o, x) => {
    if (o.k !== " ") for (let y = Math.max(0, x - CONTEXT); y <= Math.min(ops.length - 1, x + CONTEXT); y++) keep[y] = true;
  });
  const out: string[] = [];
  let gap = false;
  ops.forEach((o, x) => {
    if (!keep[x]) return void (gap = out.length > 0);
    if (gap) out.push("@@");
    gap = false;
    out.push(`${o.k}${o.s}`);
  });
  const text = out.join("\n");
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n(cut here)` : text;
}
