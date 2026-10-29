// JamSesh's own PDF reader, run in a worker (attachments.ts `pdfText`) so a large or hostile file can't hold up
// the hub: it is given a time limit and stopped. It reads only what a page draws as text: the strings shown by
// Tj, TJ, ' and " inside BT…ET blocks, in the plain or Flate-compressed content streams a page's /Contents names.
// Pages kept in compressed object streams aren't read: those files get nothing, and the card asks a person. Text in hex strings or
// with custom font encodings comes back empty, never invented.
import { inflateSync } from "node:zlib";

declare const self: Worker;

const latin = (b: Uint8Array) => {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return s;
};

function unescapePdf(s: string) {
  const map: Record<string, string> = { n: "\n", r: "", t: " ", b: "", f: "", "(": "(", ")": ")", "\\": "\\" };
  return s.replace(/\\([0-7]{1,3}|[\s\S])/g, (_, c: string) => (/^[0-7]+$/.test(c) ? String.fromCharCode(parseInt(c, 8)) : map[c] ?? c));
}

const STR = String.raw`\((?:\\[\s\S]|[^\\)])*\)`;
/** A shown string (`(…) Tj`, `(…) '`, `a b (…) "`), an array of them (`[(…) -20 (…)] TJ`), or a line move. */
const SHOW = new RegExp(String.raw`(${STR})\s*(?:Tj|')|(${STR})\s*"|\[((?:${STR}|[^\]()])*)\]\s*TJ|\b(T\*|Td|TD|Tm)\b`, "g");
/** The same, and a text render mode setting (`3 Tr`). */
const SHOW_OR_MODE = new RegExp(`${SHOW.source}|\\b(\\d)\\s+Tr\\b`, "g");

/** The objects of a PDF by number: each one's text from "N G obj" to its "endobj". */
function objects(src: string): Map<number, { at: number; body: string }> {
  const out = new Map<number, { at: number; body: string }>();
  for (const m of src.matchAll(/(?:^|[\s>])(\d+)\s+\d+\s+obj\b/g)) {
    const at = (m.index ?? 0) + m[0].length;
    const end = src.indexOf("endobj", at);
    if (end < 0) continue;
    out.set(Number(m[1]), { at, body: src.slice(at, end) });
  }
  return out;
}

export function drawnText(bytes: Uint8Array, limit = 200_000): string {
  const src = latin(bytes.subarray(0, 25 * 1024 * 1024));
  const objs = objects(src);
  // Only the content streams pages point at (/Contents, one or an array): a stream no page draws isn't wording.
  const pages: number[][] = [];
  for (const o of objs.values()) {
    if (!/\/Type\s*\/Page(?![s\w])/.test(o.body)) continue;
    const c = /\/Contents\s*(?:(\d+)\s+\d+\s+R|\[([^\]]*)\])/.exec(o.body);
    if (c?.[1]) pages.push([Number(c[1])]);
    else if (c?.[2]) pages.push([...c[2].matchAll(/(\d+)\s+\d+\s+R/g)].map((r) => Number(r[1])));
  }
  const out: string[] = [];
  let size = 0;
  // The text render mode belongs to a page's graphics state: its content streams share it in order, and the next page starts fresh.
  let hidden = false;
  for (const n of pages.flatMap((ids) => ids.map((id, i) => ({ id, first: i === 0 })))) {
    if (n.first) hidden = false;
    const o = objs.get(n.id);
    const m = o && /^\s*<<([\s\S]{0,400}?)>>\s*stream\r?\n/.exec(o.body);
    if (!o || !m || size > limit) continue;
    const start = o.at + m[0].length;
    const end = src.indexOf("endstream", start);
    if (end < 0) continue;
    let body = bytes.subarray(start, end);
    if (/\/FlateDecode/.test(m[1])) {
      try {
        body = new Uint8Array(inflateSync(body, { maxOutputLength: 4 * 1024 * 1024 }));
      } catch {
        continue;
      }
    } else if (/\/Filter/.test(m[1])) continue;
    const ops = latin(body);
    for (const block of ops.match(/\bBT\b[\s\S]*?\bET\b/g) ?? []) {
      let line = "";
      for (const t of block.matchAll(SHOW_OR_MODE)) {
        // Render mode 3 (invisible) and 7 (clip only) draw nothing a reader sees; the mode stays until another is set.
        if (t[5] !== undefined) hidden = t[5] === "3" || t[5] === "7";
        else if (hidden) continue;
        else if (t[4]) line += " ";
        else if (t[3] !== undefined) line += [...t[3].matchAll(new RegExp(STR, "g"))].map((x) => unescapePdf(x[0].slice(1, -1))).join("");
        else line += unescapePdf((t[1] ?? t[2]).slice(1, -1));
      }
      line = line.replace(/\s+/g, " ").trim();
      if (line) (out.push(line), (size += line.length));
    }
  }
  return out.join("\n");
}

if (typeof self !== "undefined" && typeof (self as any).postMessage === "function" && !(globalThis as any).Bun?.isMainThread) {
  self.onmessage = (e: MessageEvent<Uint8Array>) => {
    let text = "";
    try {
      text = drawnText(e.data);
    } catch {}
    self.postMessage(text);
  };
}
