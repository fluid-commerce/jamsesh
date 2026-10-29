// JamSesh's own PDF reader, run in a worker (attachments.ts `pdfText`) so a large or hostile file can't hold up
// the hub: it is given a time limit and stopped. It reads only what a page draws as text: the strings shown by
// Tj, TJ, ' and " inside BT…ET blocks, from plain and Flate-compressed content streams. Text in hex strings or
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

export function drawnText(bytes: Uint8Array, limit = 200_000): string {
  const src = latin(bytes.subarray(0, 25 * 1024 * 1024));
  const out: string[] = [];
  let size = 0;
  for (const m of src.matchAll(/<<(.{0,400}?)>>\s*stream\r?\n/gs)) {
    const start = (m.index ?? 0) + m[0].length;
    const end = src.indexOf("endstream", start);
    if (end < 0 || size > limit) break;
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
      for (const t of block.matchAll(SHOW)) {
        if (t[4]) line += " ";
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
