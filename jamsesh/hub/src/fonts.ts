// Fonts for everyone (SPEC 12.4). A canvas draws text in the fonts its agents designed in, and a
// person's canvas (FigCraft's WebAssembly build) can't see any computer's installed fonts. So the host
// serves the fonts to every canvas:
//   - open fonts (OFL or Apache) the repositories use, fetched from Fontsource, which mirrors Google
//     Fonts, with no question asked;
//   - a font only one person has, borrowed for the session once that person confirms they may share it.
// Everything here is memory: nothing is written to disk, and ending the session drops it all.
import type { Agent, FontInfo, FontsState } from "./types";
import { bus } from "./bus";
import { config } from "./config";

/** Caps: one face, one family, what is lent in all, what is fetched in all. Over any of them, refused. */
export const MAX_FACE = 24 * 1024 * 1024;
export const MAX_FACES = 12;
export const MAX_FAMILY_BYTES = 32 * 1024 * 1024;
export const MAX_LENT_BYTES = 128 * 1024 * 1024;
export const MAX_OPEN_BYTES = 96 * 1024 * 1024;
export const MAX_FAMILIES = 48;
const MAX_OPEN_PER_SCAN = 16;
const FETCH_MS = 20_000;
/** Licences taken without asking anyone (Fontsource's SPDX ids). */
export const OPEN_LICENSES = new Set(["OFL-1.1", "Apache-2.0"]);

export const normalizeFamily = (f: string) => f.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();

// ---- reading a font file, enough to refuse what isn't one and to know whose it is ----

const u32 = (b: Uint8Array, at: number) => (at >= 0 && at + 4 <= b.length ? ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0 : null);
const u16 = (b: Uint8Array, at: number) => (at >= 0 && at + 2 <= b.length ? (b[at] << 8) | b[at + 1] : null);
const tag = (b: Uint8Array, at: number) => (at >= 0 && at + 4 <= b.length ? String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]) : "");

/** The family names (any language) of every face in a TrueType/OpenType file or collection, or null when it isn't a font. */
export function fontFamilies(b: Uint8Array): string[] | null {
  const head = tag(b, 0);
  const offsets: number[] = [];
  if (head === "ttcf") {
    const n = u32(b, 8);
    if (n === null || n < 1 || n > 64) return null;
    for (let i = 0; i < n; i++) {
      const o = u32(b, 12 + 4 * i);
      if (o === null) return null;
      offsets.push(o);
    }
  } else if (head === "\0\x01\0\0" || head === "OTTO" || head === "true") offsets.push(0);
  else return null;
  const names = new Set<string>();
  for (const base of offsets) {
    const tables = u16(b, base + 4);
    if (tables === null || tables < 4 || tables > 128) return null;
    let nameAt = -1;
    let nameLen = 0;
    let glyphs = false;
    for (let i = 0; i < tables; i++) {
      const rec = base + 12 + 16 * i;
      const off = u32(b, rec + 8);
      const len = u32(b, rec + 12);
      if (off === null || len === null || off + len > b.length) return null;
      const t = tag(b, rec);
      if (t === "name") ((nameAt = off), (nameLen = len));
      if (t === "glyf" || t === "CFF " || t === "CFF2") glyphs = true;
    }
    if (nameAt < 0 || !glyphs) return null;
    const count = u16(b, nameAt + 2);
    const strings = u16(b, nameAt + 4);
    if (count === null || strings === null || count > 4096) return null;
    for (let i = 0; i < count; i++) {
      const r = nameAt + 6 + 12 * i;
      const id = u16(b, r + 6);
      if (id !== 1 && id !== 16 && id !== 21) continue;
      const platform = u16(b, r);
      const len = u16(b, r + 8);
      const off = u16(b, r + 10);
      if (platform === null || len === null || off === null || off + len > nameLen - strings || nameAt + strings + off + len > b.length) continue;
      const raw = b.subarray(nameAt + strings + off, nameAt + strings + off + len);
      // Windows and Unicode names are UTF-16BE; Macintosh names are single-byte (ASCII covers family names).
      const text = platform === 1 ? String.fromCharCode(...raw) : new TextDecoder("utf-16be").decode(raw);
      if (text.trim()) names.add(text.trim());
    }
  }
  return names.size ? [...names] : null;
}

/** Strict base64 → bytes, or null (not base64, or more than `max` bytes). */
export function decodeBase64(s: unknown, max: number): Uint8Array | null {
  if (typeof s !== "string" || s.length > Math.ceil((max * 4) / 3) + 8 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4) return null;
  const bytes = Buffer.from(s, "base64");
  return bytes.length && bytes.length <= max ? new Uint8Array(bytes) : null;
}

// ---- which fonts a repository names ----

const CUE = /\b(fonts?|typefaces?|typography|font-?family|type ?family|families|display|headings?|body|sans|serif|mono)\b/i;

/**
 * Font family names in free text (a repo card): quoted or backticked names, CSS font stacks, and
 * names written after a cue such as "font:" or "typeface". Only candidates; the catalogue decides.
 */
export function fontCandidates(text: string): string[] {
  const out = new Set<string>();
  const add = (s: string) => {
    const t = s.replace(/^["'`\s]+|["'`\s.]+$/g, "").replace(/\s+/g, " ");
    if (t.length >= 2 && t.length <= 60 && /[a-z]/i.test(t) && !/^(sans-serif|serif|monospace|system-ui|inherit|initial|cursive|fantasy)$/i.test(t)) out.add(t);
  };
  for (const line of text.split(/\n|(?<=[.!?])\s+(?=[A-Z])/)) {
    // font-family: "Inter", sans-serif / fontFamily: 'Space Grotesk'
    for (const m of line.matchAll(/font-?family\s*[:=]\s*([^;}\n]+)/gi)) for (const p of m[1].split(",")) add(p);
    // Quoted or backticked names in a line that talks about type.
    if (CUE.test(line)) for (const m of line.matchAll(/["'`]([^"'`]{2,50})["'`]/g)) add(m[1]);
    // "font: Inter", "typeface Inter Tight", "fonts Inter and Lora", "Inter (body)".
    for (const m of line.matchAll(/\b(?:fonts?|typefaces?|typography|family|families)\b\s*[:=\-–]?\s*(?:is|are|uses?)?\s*([A-Z][\w-]*(?:\s+[A-Z0-9][\w-]*){0,3}(?:\s*(?:,|and|\+|&|\/)\s*[A-Z][\w-]*(?:\s+[A-Z0-9][\w-]*){0,3})*)/g)) {
      for (const p of m[1].split(/\s*(?:,|\band\b|\+|&|\/)\s*/)) add(p);
    }
    if (CUE.test(line)) for (const m of line.matchAll(/\b([A-Z][\w-]*(?:\s+[A-Z0-9][\w-]*){0,3})\s*\((?:[^)]*\b(?:body|headings?|display|mono|type|font|ui|text)\b[^)]*)\)/g)) add(m[1]);
  }
  // Any capitalised phrase on a line about type may be a family ("headings in Roboto Slab"): every run of up
  // to four words in it is a candidate, and the catalogue says which are real.
  for (const line of text.split("\n")) {
    if (!CUE.test(line)) continue;
    for (const run of line.matchAll(/[A-Z][\w'-]*(?:\s+[A-Z0-9][\w'-]*)*/g)) {
      const words = run[0].split(/\s+/);
      for (let i = 0; i < words.length; i++) for (let n = 1; n <= 4 && i + n <= words.length; n++) add(words.slice(i, i + n).join(" "));
    }
  }
  return [...out].slice(0, 300);
}

/** The text of an agent's repo card that can name fonts. */
export function cardText(agent: Pick<Agent, "card">): string {
  const c = agent.card;
  return c ? [c.designSystem, c.stack, c.components, c.notes].filter(Boolean).join("\n") : "";
}

// ---- the service ----

interface CatalogueEntry {
  id: string;
  family: string;
  license: string;
  type: string;
  styles: string[];
  weights: number[];
  defSubset: string;
}

interface Face {
  data: Uint8Array;
}

interface Held {
  key: string;
  family: string;
  kind: "open" | "borrowed";
  source: string;
  license: string | null;
  faces: Face[];
  lender?: { personId: string; name: string };
  at: number;
}

interface Wanted {
  key: string;
  family: string;
  askedBy: Set<string>;
  declinedBy: Set<string>;
  since: number;
}

export type LendResult = { ok: true; already?: boolean } | { ok: false; error: string; status: number };

export class FontService {
  private held = new Map<string, Held>();
  private wanted = new Map<string, Wanted>();
  private catalogue: Map<string, CatalogueEntry> | null = null;
  private catalogueTry: Promise<Map<string, CatalogueEntry>> | null = null;
  private resolving = new Map<string, Promise<boolean>>();
  private tried = new Set<string>();
  private abort = new AbortController();
  private closed = false;
  /** Called with a face the moment it is available, so the host's own canvases can load it too. */
  onFace: ((family: string, data: Uint8Array) => void) | null = null;

  private api: string;
  private cdn: string;
  private googleCss: string;
  private googleHost: string;
  private offline: boolean;

  /** `opts`: where open fonts come from and whether to skip the network (the config's, unless a test says otherwise). */
  constructor(
    private agents: () => Agent[],
    private personName: (id: string) => string | undefined,
    opts: { api?: string; cdn?: string; googleCss?: string; googleHost?: string; offline?: boolean } = {},
  ) {
    this.api = opts.api ?? config.fontApi;
    this.cdn = opts.cdn ?? config.fontCdn;
    this.googleCss = opts.googleCss ?? config.fontGoogleCss;
    this.googleHost = opts.googleHost ?? config.fontGoogleHost;
    this.offline = opts.offline ?? config.fontsOffline;
  }

  // ---- what the room sees (names and counts; never the bytes) ----

  state(): FontsState {
    const available: FontInfo[] = [...this.held.values()]
      .sort((a, b) => a.at - b.at)
      .map((h) => ({ key: h.key, family: h.family, kind: h.kind, source: h.source, license: h.license, faces: h.faces.length, bytes: h.faces.reduce((n, f) => n + f.data.length, 0), lenderId: h.lender?.personId, lender: h.lender?.name }));
    const wanted = [...this.wanted.values()].map((w) => ({ key: w.key, family: w.family, askedBy: [...w.askedBy], declinedBy: [...w.declinedBy], since: w.since }));
    return { available, wanted };
  }

  private changed() {
    bus.changed("fonts");
  }

  face(key: string, n: number): Uint8Array | null {
    return this.held.get(key)?.faces[n]?.data ?? null;
  }

  has(family: string) {
    return this.held.has(normalizeFamily(family));
  }

  /** Every face held, for a canvas that joins late. */
  all(): { family: string; data: Uint8Array }[] {
    return [...this.held.values()].flatMap((h) => h.faces.map((f) => ({ family: h.family, data: f.data })));
  }

  // ---- open fonts ----

  private async getJson(url: string): Promise<any> {
    const r = await fetch(url, { signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(FETCH_MS)]) });
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    return r.json();
  }

  /** Fontsource's list of families (once; it carries each family's licence). Null when it can't be reached. */
  private async load(): Promise<Map<string, CatalogueEntry> | null> {
    if (this.catalogue) return this.catalogue;
    this.catalogueTry ??= this.getJson(`${this.api}/fonts`).then((list: any[]) => {
      const m = new Map<string, CatalogueEntry>();
      for (const f of Array.isArray(list) ? list : []) {
        if (typeof f?.id === "string" && typeof f?.family === "string") m.set(normalizeFamily(f.family), { id: f.id, family: f.family, license: String(f.license ?? ""), type: String(f.type ?? ""), styles: f.styles ?? [], weights: f.weights ?? [], defSubset: String(f.defSubset ?? "latin") });
      }
      return m;
    });
    try {
      this.catalogue = await this.catalogueTry;
      return this.catalogue;
    } catch (e) {
      // Offline or the service is down: try again the next time something asks.
      this.catalogueTry = null;
      console.warn(`[fonts] couldn't reach the font catalogue: ${(e as Error)?.message ?? e}`);
      return null;
    }
  }

  /**
   * Fetches `family` when it is an open font (OFL or Apache) in the catalogue and not held yet.
   * True when it is held afterwards. Never throws: a font that can't be had is a font nobody has.
   */
  resolveOpen(family: string): Promise<boolean> {
    const key = normalizeFamily(family);
    if (!key || key.length > 80 || this.closed || this.offline) return Promise.resolve(this.held.has(key));
    if (this.held.has(key)) return Promise.resolve(true);
    let p = this.resolving.get(key);
    if (!p) {
      p = this.fetchOpen(key).finally(() => this.resolving.delete(key));
      this.resolving.set(key, p);
    }
    return p;
  }

  private openBytes() {
    let n = 0;
    for (const h of this.held.values()) if (h.kind === "open") for (const f of h.faces) n += f.data.length;
    return n;
  }

  /**
   * Google Fonts' own files for a family Fontsource lists as a Google font: Regular and Bold, upright
   * and italic where it has them. Their names are the family's (Fontsource's static files for a
   * variable font can carry the name of one instance, which a canvas would not match).
   */
  private async googleUrls(e: CatalogueEntry): Promise<string[]> {
    const have = e.weights.length ? e.weights : [400];
    const weights = [400, 700].filter((w) => have.includes(w));
    if (!weights.length) weights.push([...have].sort((a, b) => Math.abs(a - 400) - Math.abs(b - 400))[0]);
    const italic = e.styles.includes("italic");
    const axis = italic ? `ital,wght@${[...weights.map((w) => `0,${w}`), ...weights.map((w) => `1,${w}`)].join(";")}` : `wght@${weights.join(";")}`;
    const r = await fetch(`${this.googleCss}?family=${encodeURIComponent(e.family).replace(/%20/g, "+")}:${axis}`, { signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(FETCH_MS)]) });
    if (!r.ok) throw new Error(`stylesheet: ${r.status}`);
    const css = await r.text();
    return [...new Set([...css.matchAll(/url\((https?:\/\/[^)\s]+)\)\s*format\('truetype'\)/g)].map((m) => m[1]))].filter((u) => u.startsWith(this.googleHost));
  }

  /** The same from Fontsource's CDN: Regular and Bold, upright and italic, from the default subset. */
  private async fontsourceUrls(e: CatalogueEntry): Promise<string[]> {
    const meta = await this.getJson(`${this.api}/fonts/${encodeURIComponent(e.id)}`);
    const subset: string = meta?.defSubset ?? e.defSubset;
    const urls: string[] = [];
    for (const [w, style] of [["400", "normal"], ["700", "normal"], ["400", "italic"], ["700", "italic"]]) {
      const url: unknown = meta?.variants?.[w]?.[style]?.[subset]?.url?.ttf;
      if (typeof url === "string" && url.startsWith(this.cdn)) urls.push(url);
    }
    return urls;
  }

  /** Downloads each url: a face is kept only if it is a font of this family within the caps. */
  private async download(urls: string[], key: string): Promise<Face[]> {
    const faces: Face[] = [];
    let total = 0;
    for (const url of urls.slice(0, 8)) {
      const r = await fetch(url, { signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(FETCH_MS)]) });
      if (!r.ok) continue;
      const data = new Uint8Array(await r.arrayBuffer());
      total += data.length;
      if (data.length > MAX_FACE || total > MAX_FAMILY_BYTES || this.openBytes() + total > MAX_OPEN_BYTES) break;
      if (fontFamilies(data)?.some((n) => normalizeFamily(n) === key)) faces.push({ data });
    }
    return faces;
  }

  private async fetchOpen(key: string): Promise<boolean> {
    try {
      const cat = await this.load();
      const e = cat?.get(key);
      if (!e || !OPEN_LICENSES.has(e.license)) return false;
      let faces: Face[] = [];
      let source = "Fontsource";
      if (e.type === "google") {
        faces = await this.download(await this.googleUrls(e).catch(() => []), key).catch(() => []);
        source = "Google Fonts";
      }
      if (!faces.length) {
        faces = await this.download(await this.fontsourceUrls(e), key);
        source = e.type === "google" ? "Google Fonts via Fontsource" : "Fontsource";
      }
      if (!faces.length || this.closed) return false;
      this.held.set(key, { key, family: e.family, kind: "open", source, license: e.license, faces, at: Date.now() });
      this.wanted.delete(key);
      for (const f of faces) this.onFace?.(e.family, f.data);
      this.changed();
      return true;
    } catch (err) {
      if (!this.closed) console.warn(`[fonts] couldn't fetch ${key}: ${(err as Error)?.message ?? err}`);
      return false;
    }
  }

  /** Reads the agents' repo cards for the open fonts they name and fetches those (a few at a time). */
  async scan(): Promise<string[]> {
    if (this.closed || this.offline) return [];
    const found: string[] = [];
    const candidates = this.agents().filter((a) => a.status !== "offline").flatMap((a) => fontCandidates(cardText(a)));
    if (!candidates.length) return found;
    const cat = await this.load();
    if (!cat) return found;
    const names = new Set<string>();
    for (const c of candidates) {
      const e = cat.get(normalizeFamily(c));
      if (e && OPEN_LICENSES.has(e.license)) names.add(e.family);
    }
    const todo = [...names].filter((f) => !this.held.has(normalizeFamily(f)) && !this.tried.has(normalizeFamily(f))).slice(0, MAX_OPEN_PER_SCAN);
    for (const f of todo) this.tried.add(normalizeFamily(f));
    // Three at a time.
    for (let i = 0; i < todo.length; i += 3) {
      const got = await Promise.all(todo.slice(i, i + 3).map((f) => this.resolveOpen(f).then((ok) => ok && f)));
      for (const g of got) if (g) found.push(g);
    }
    return found;
  }

  // ---- fonts only one person has ----

  /** A canvas shows `families` in a substitute. Open ones are fetched; the rest are asked for from the room. */
  async want(personId: string | null, families: unknown): Promise<void> {
    if (this.closed || !Array.isArray(families)) return;
    const list = families.filter((f): f is string => typeof f === "string" && f.trim().length > 0 && f.length <= 100).slice(0, 24);
    for (const family of list) {
      const key = normalizeFamily(family);
      if (this.held.has(key)) continue;
      // Open fonts first: no question to ask anyone.
      if (await this.resolveOpen(family)) continue;
      if (this.closed || this.held.has(key)) continue;
      let w = this.wanted.get(key);
      if (!w) {
        if (this.wanted.size >= MAX_FAMILIES) continue;
        w = { key, family: family.trim().replace(/\s+/g, " "), askedBy: new Set(), declinedBy: new Set(), since: Date.now() };
        this.wanted.set(key, w);
      }
      if (personId) w.askedBy.add(personId);
      this.changed();
    }
  }

  decline(personId: string, family: unknown): boolean {
    const w = typeof family === "string" ? this.wanted.get(normalizeFamily(family)) : undefined;
    if (!w) return false;
    w.declinedBy.add(personId);
    this.changed();
    return true;
  }

  /** A person lends the files of a family they confirmed they may share. */
  lend(personId: string, family: unknown, files: unknown): LendResult {
    if (this.closed) return { ok: false, error: "The session has ended.", status: 410 };
    if (typeof family !== "string" || !family.trim()) return { ok: false, error: "Say which font.", status: 400 };
    const key = normalizeFamily(family);
    const w = this.wanted.get(key);
    if (this.held.has(key)) return { ok: true, already: true };
    if (!w) return { ok: false, error: "Nobody is waiting for that font.", status: 409 };
    if (!Array.isArray(files) || !files.length || files.length > MAX_FACES) return { ok: false, error: `Send between 1 and ${MAX_FACES} font files.`, status: 400 };
    const faces: Face[] = [];
    let total = 0;
    for (const f of files) {
      const data = decodeBase64(f, MAX_FACE);
      if (!data) return { ok: false, error: `A font file is empty, damaged or over ${MAX_FACE / 1024 / 1024} MB.`, status: 413 };
      total += data.length;
      if (total > MAX_FAMILY_BYTES) return { ok: false, error: `That family is over ${MAX_FAMILY_BYTES / 1024 / 1024} MB.`, status: 413 };
      const names = fontFamilies(data);
      if (!names) return { ok: false, error: "That isn't a font file JamSesh can read.", status: 422 };
      if (!names.some((n) => normalizeFamily(n) === key)) return { ok: false, error: `That file is not ${w.family}.`, status: 422 };
      faces.push({ data });
    }
    let lent = total;
    for (const h of this.held.values()) if (h.kind === "borrowed") for (const x of h.faces) lent += x.data.length;
    if (lent > MAX_LENT_BYTES) return { ok: false, error: "The session is already borrowing as many fonts as it can hold.", status: 413 };
    this.held.set(key, { key, family: w.family, kind: "borrowed", source: "lent by a person", license: null, faces, lender: { personId, name: this.personName(personId) ?? "Someone" }, at: Date.now() });
    this.wanted.delete(key);
    for (const f of faces) this.onFace?.(w.family, f.data);
    this.changed();
    return { ok: true };
  }

  /** The lender (or the host) takes a borrowed font back. Canvases that already drew with it keep it until they reload. */
  withdraw(personId: string | null, family: unknown, force = false): boolean {
    const key = typeof family === "string" ? normalizeFamily(family) : "";
    const h = this.held.get(key);
    if (!h || h.kind !== "borrowed" || (!force && h.lender?.personId !== personId)) return false;
    this.wipe(h);
    this.held.delete(key);
    this.changed();
    return true;
  }

  /** A person left the room: what they lent goes with them. */
  dropLender(personId: string) {
    for (const h of [...this.held.values()]) if (h.lender?.personId === personId) this.withdraw(personId, h.family);
    for (const w of this.wanted.values()) (w.askedBy.delete(personId), w.declinedBy.delete(personId));
  }

  private wipe(h: Held) {
    for (const f of h.faces) f.data.fill(0);
  }

  /** The session is over: every font held is dropped, and nothing more is fetched or lent. */
  clear() {
    this.closed = true;
    this.abort.abort();
    for (const h of this.held.values()) this.wipe(h);
    this.held.clear();
    this.wanted.clear();
    this.resolving.clear();
    this.changed();
  }
}
