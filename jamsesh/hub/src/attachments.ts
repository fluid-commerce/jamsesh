// Attachments (SPEC 12.6): images, screenshots and files people add to a message. The bytes are
// stored once (by hash) under <data>/attachments/blobs; every upload also gets a small record
// (<id>.json) with its name and who added it. Types are decided by looking at the bytes, never by
// the name or the type the browser claims, and the stored file's name is made here, so nothing a
// caller sends reaches a path.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AttachmentKind, AttachmentRef } from "./types";

export type { AttachmentKind, AttachmentRef };

export interface AttachmentRecord extends AttachmentRef {
  blob: string;
  by: string;
  ts: number;
}

export class AttachmentError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export const MAX_PER_MESSAGE = 6;
/** All the files on one message together: six big PDFs are each fine, but not one request. */
export const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;
/** The most image and PDF bytes one model request carries; files past it are named as not shown. */
const MODEL_BYTES = 15 * 1024 * 1024;
const LIMITS: Record<AttachmentKind, number> = { image: 12 * 1024 * 1024, pdf: 20 * 1024 * 1024, text: 1024 * 1024 };
/** The largest request the upload route reads at all (the biggest file plus form overhead). */
export const MAX_UPLOAD_BYTES = LIMITS.pdf + 64 * 1024;
const ID = /^att_[0-9a-f]{16}$/;
const BLOB = /^[0-9a-f]{40}\.[a-z]{2,4}$/;
export const isAttachmentId = (s: unknown): s is string => typeof s === "string" && ID.test(s);

/** Text formats worth reading; anything else that isn't an image or a PDF is refused. SVG and HTML aren't here: they can run script. */
const TEXT_EXT = new Set(["txt", "md", "markdown", "json", "csv", "tsv", "log", "yml", "yaml", "toml", "ini", "css", "js", "ts", "tsx", "jsx", "py", "rs", "go", "swift", "kt", "sql", "sh", "rb", "java", "c", "h", "cpp"]);
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "application/pdf": "pdf", "text/plain": "txt" };

/** What these bytes are, by their first bytes; null for a type that isn't allowed. */
export function sniff(bytes: Uint8Array, fileName: string): { type: string; kind: AttachmentKind } | null {
  const at = (i: number) => bytes[i] ?? 0;
  const ascii = (from: number, s: string) => [...s].every((c, i) => at(from + i) === c.charCodeAt(0));
  if (at(0) === 0x89 && ascii(1, "PNG\r\n")) return { type: "image/png", kind: "image" };
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return { type: "image/jpeg", kind: "image" };
  if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return { type: "image/gif", kind: "image" };
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return { type: "image/webp", kind: "image" };
  if (ascii(0, "%PDF-")) return { type: "application/pdf", kind: "pdf" };
  // Text: no NUL bytes, valid UTF-8, and a name that says it's a text format (or has no extension).
  const head = bytes.subarray(0, 8192);
  if (head.includes(0)) return null;
  const ext = /\.([A-Za-z0-9]{1,8})$/.exec(fileName)?.[1]?.toLowerCase();
  if (ext && !TEXT_EXT.has(ext)) return null;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  return { type: "text/plain", kind: "text" };
}

/** A name that is safe to show and to put in a header: no path, no control characters, at most 100 long. */
export function cleanFileName(raw: unknown): string {
  const base = String(raw ?? "").split(/[\\/]/).pop() ?? "";
  const s = base.replace(/[\u0000-\u001f\u007f"<>|:*?]/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "").slice(-100).trim();
  return s || "file";
}

export class Attachments {
  constructor(private dir: string) {
    mkdirSync(join(dir, "blobs"), { recursive: true });
  }

  /** Checks and keeps one upload. */
  save(bytes: Uint8Array, rawName: unknown, by: string): AttachmentRecord {
    const name = cleanFileName(rawName);
    if (!bytes.length) throw new AttachmentError("That file is empty.");
    const found = sniff(bytes, name);
    if (!found) throw new AttachmentError("JamSesh takes images (PNG, JPEG, GIF, WebP), PDFs and text files.", 415);
    if (bytes.length > LIMITS[found.kind]) throw new AttachmentError(`${found.kind === "image" ? "Images" : found.kind === "pdf" ? "PDFs" : "Text files"} must be under ${Math.round(LIMITS[found.kind] / 1024 / 1024) || 1} MB.`, 413);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const blob = `${sha.slice(0, 40)}.${EXT[found.type]}`;
    const blobPath = join(this.dir, "blobs", blob);
    if (!existsSync(blobPath)) writeFileSync(blobPath, bytes);
    const rec: AttachmentRecord = { id: `att_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`, name, type: found.type, kind: found.kind, size: bytes.length, blob, by, ts: Date.now() };
    writeFileSync(join(this.dir, `${rec.id}.json`), JSON.stringify(rec));
    return rec;
  }

  /** The record for an id; null for anything that isn't one of ours (the id is checked before it touches a path). */
  record(id: unknown): AttachmentRecord | null {
    if (!isAttachmentId(id)) return null;
    try {
      const rec = JSON.parse(readFileSync(join(this.dir, `${id}.json`), "utf8")) as AttachmentRecord;
      return rec.id === id && BLOB.test(rec.blob) && existsSync(join(this.dir, "blobs", rec.blob)) ? rec : null;
    } catch {
      return null;
    }
  }

  ref(id: unknown): AttachmentRef | null {
    const r = this.record(id);
    return r ? { id: r.id, name: r.name, type: r.type, kind: r.kind, size: r.size } : null;
  }

  /** The refs for a list of ids from a request: at most six, each one that exists, none twice. */
  refs(ids: unknown): AttachmentRef[] {
    if (!Array.isArray(ids)) return [];
    if (ids.length > MAX_PER_MESSAGE) throw new AttachmentError(`Attach at most ${MAX_PER_MESSAGE} files to a message.`);
    const out: AttachmentRef[] = [];
    let total = 0;
    for (const id of ids) {
      const ref = this.ref(id);
      if (!ref) throw new AttachmentError("One of the attached files isn't here. Add it again.", 404);
      if (out.some((o) => o.id === ref.id)) continue;
      total += ref.size;
      if (total > MAX_MESSAGE_BYTES) throw new AttachmentError(`The files on one message can be ${MAX_MESSAGE_BYTES / 1024 / 1024} MB together. Send some in another message.`, 413);
      out.push(ref);
    }
    return out;
  }

  /** The stored file, ready to send: its bytes' path and headers. */
  file(id: unknown): { path: string; rec: AttachmentRecord } | null {
    const rec = this.record(id);
    return rec ? { path: join(this.dir, "blobs", rec.blob), rec } : null;
  }

  bytes(id: string): Uint8Array | null {
    const f = this.file(id);
    try {
      return f ? new Uint8Array(readFileSync(f.path)) : null;
    } catch {
      return null;
    }
  }

  /**
   * What the room brain gets for these attachments: images and PDFs as message parts, text files
   * as text. Reads at most a few hundred KB of text in all so a big file can't swamp the prompt.
   */
  brainInput(refs: AttachmentRef[]): { text: string; parts: { type: "file"; data: Uint8Array; mediaType: string }[] } {
    const parts: ReturnType<Attachments["brainInput"]>["parts"] = [];
    const texts: string[] = [];
    let budget = 60_000;
    let room = MODEL_BYTES;
    for (const r of refs) {
      const bytes = this.bytes(r.id);
      if (!bytes) continue;
      if (r.kind === "image" || r.kind === "pdf") {
        if (bytes.length > room) texts.push(`### ${r.name}\n(not shown: too much attached to this message for one look)`);
        else {
          room -= bytes.length;
          parts.push({ type: "file", data: bytes, mediaType: r.type });
        }
      } else {
        const body = new TextDecoder().decode(bytes).slice(0, Math.min(budget, 30_000));
        budget -= body.length;
        texts.push(`### ${r.name}\n${body}${body.length < bytes.length ? "\n(cut off)" : ""}`);
      }
    }
    return { text: texts.join("\n\n"), parts };
  }
}

/** Where poppler's pdftotext may be: the PATH, or Homebrew's folders (an app started from the Dock has a short PATH). */
const PDFTOTEXT = [Bun.which("pdftotext"), "/opt/homebrew/bin/pdftotext", "/usr/local/bin/pdftotext"].filter((p): p is string => !!p);

/**
 * The words in a PDF, for a card a person reviews: poppler's pdftotext when the machine has it (first 20 pages,
 * 5 s at most), otherwise the plain text runs JamSesh can read itself. At most `max` characters; "" when there's
 * no text to read (a scan, or fonts that only map glyphs). The built-in reader runs in a worker (pdfworker.ts).
 */
export async function pdfText(path: string, max = 4000, poppler = true): Promise<string> {
  const tidy = (t: string) => t.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*/g, "\n\n").trim().slice(0, max);
  const tool = poppler ? PDFTOTEXT.find((p) => existsSync(p)) : undefined;
  if (tool) {
    try {
      const run = Bun.spawn([tool, "-l", "20", "-enc", "UTF-8", "-q", path, "-"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
      const timer = setTimeout(() => run.kill(), 5000);
      const out = await new Response(run.stdout).text();
      clearTimeout(timer);
      if ((await run.exited) === 0 && tidy(out)) return tidy(out);
    } catch {
      // Fall through to the built-in reader.
    }
  }
  try {
    return tidy(await inWorker(new Uint8Array(readFileSync(path))));
  } catch {
    return "";
  }
}

/** JamSesh's own reader (pdfworker.ts) in a worker with a time limit, so a big or hostile file can't hold up the hub. */
function inWorker(bytes: Uint8Array, ms = 5000): Promise<string> {
  return new Promise((resolve) => {
    let w: Worker;
    try {
      // From source, the file beside this one; in the compiled hub (bundle-hub.sh builds pdfworker.ts in as an
      // entrypoint) it's addressed by its bundled name.
      const beside = new URL("./pdfworker.ts", import.meta.url);
      w = new Worker(beside.protocol === "file:" && existsSync(Bun.fileURLToPath(beside)) ? beside.href : "./pdfworker.ts");
    } catch {
      return resolve("");
    }
    const done = (text: string) => (clearTimeout(timer), w.terminate(), resolve(text));
    const timer = setTimeout(() => done(""), ms);
    w.onmessage = (e: MessageEvent<string>) => done(typeof e.data === "string" ? e.data : "");
    w.onerror = () => done("");
    w.postMessage(bytes);
  });
}

/** A short "name (size)" line for lists and logs. */
export function sizeLabel(n: number) {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}
