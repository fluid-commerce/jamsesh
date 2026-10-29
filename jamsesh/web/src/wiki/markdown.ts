// Page text to safe HTML. markdown-it never passes raw HTML through and only lets http(s), mailto and
// in-page links stand; DOMPurify then checks the result again in the browser. If DOMPurify can't run
// (no DOM), the text is shown escaped rather than trusted.
import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";

export const slugify = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** What the renderer needs to know about the wiki: which pages exist, which ids are sources. */
export interface RenderCtx {
  pages?: ReadonlySet<string>;
  sources?: ReadonlySet<string>;
}

const SAFE_LINK = /^(https?:|mailto:|#)/i;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** [[page]], [[page|alias]], [[page#heading]], and [[raw/source-id]] (a citation). */
export function parseWikilink(body: string): { target: string; label: string; slug: string; source: string | null; at: string | null } | null {
  const [rawTarget, ...aliasParts] = body.split("|");
  const [head, anchor] = rawTarget.split("#");
  const target = head.trim();
  if (!target || target.length > 200) return null;
  const alias = aliasParts.join("|").trim();
  const isRaw = /^raw\//i.test(target);
  const source = isRaw ? target.replace(/^raw\//i, "").replace(/\.md$/i, "") : null;
  return { target, label: alias || target.replace(/^raw\//i, ""), slug: slugify(target), source, at: source !== null && /^\d{1,2}:\d{2}(:\d{2})?$/.test(anchor?.trim() ?? "") ? anchor.trim() : null };
}

const md = new MarkdownIt({ html: false, linkify: true, breaks: false, typographer: true });
md.linkify.set({ fuzzyLink: false, fuzzyEmail: false });
md.validateLink = (url) => SAFE_LINK.test(url.trim().replace(/[\u0000- ]/g, ""));

// The context for the render in progress (markdown-it rules are synchronous, so this is safe).
let ctx: RenderCtx = {};

md.inline.ruler.before("link", "wikilink", (state, silent) => {
  const src = state.src;
  const start = state.pos;
  if (src.charCodeAt(start) !== 0x5b || src.charCodeAt(start + 1) !== 0x5b) return false;
  const end = src.indexOf("]]", start + 2);
  if (end < 0 || end - start > 240) return false;
  const body = src.slice(start + 2, end);
  if (body.includes("\n") || body.includes("[")) return false;
  const link = parseWikilink(body);
  if (!link) return false;
  if (!silent) {
    const t = state.push("wikilink", "", 0);
    t.meta = link;
  }
  state.pos = end + 2;
  return true;
});

md.renderer.rules.wikilink = (tokens, i) => {
  const { label, slug, source, at } = tokens[i].meta as ReturnType<typeof parseWikilink> & object;
  if (source !== null || ctx.sources?.has(slug)) {
    return `<a href="#" class="cite" data-src="${esc(source ?? slug)}"${at ? ` data-at="${esc(at)}"` : ""} title="Open the source">${esc(label)}</a>`;
  }
  const missing = ctx.pages ? !ctx.pages.has(slug) : false;
  return `<a href="#" class="wl${missing ? " missing" : ""}" data-slug="${esc(slug)}"${missing ? ' title="No page yet"' : ""}>${esc(label)}</a>`;
};
// Pictures from page text aren't fetched (that would let a page phone home); their alt text stands in.
md.renderer.rules.image = (tokens, i) => `<span class="img-alt">${esc(tokens[i].content || "image")}</span>`;

// Outside links open in a new tab without handing over the window or the referrer.
const defaultOpen = md.renderer.rules.link_open ?? ((t, i, o, _e, self) => self.renderToken(t, i, o));
md.renderer.rules.link_open = (tokens, i, opts, env, self) => {
  const href = tokens[i].attrGet("href") ?? "";
  if (/^https?:/i.test(href)) {
    tokens[i].attrSet("target", "_blank");
    tokens[i].attrSet("rel", "noopener noreferrer nofollow");
    tokens[i].attrJoin("class", "ext");
  }
  return defaultOpen(tokens, i, opts, env, self);
};

const PURIFY = {
  ALLOWED_TAGS: ["a", "p", "br", "hr", "em", "strong", "del", "s", "code", "pre", "blockquote", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6", "table", "thead", "tbody", "tr", "th", "td", "span", "sup", "sub"],
  ALLOWED_ATTR: ["href", "class", "data-slug", "data-src", "data-at", "title", "target", "rel"],
  ALLOW_DATA_ATTR: false,
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#)/i,
};
let hooked = false;
function purify(html: string): string | null {
  if (!DOMPurify.isSupported || typeof DOMPurify.sanitize !== "function") return null;
  if (!hooked) {
    hooked = true;
    DOMPurify.addHook("afterSanitizeAttributes", (node) => {
      if (node.tagName === "A" && /^https?:/i.test(node.getAttribute("href") ?? "")) {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer nofollow");
      } else if (node.tagName === "A") {
        node.removeAttribute("target");
      }
    });
  }
  return DOMPurify.sanitize(html, PURIFY) as unknown as string;
}

/** "(src: id, 14:32)" is how the maintainer cites a transcript moment; it becomes a citation link. */
const cites = (t: string) => t.replace(/\(src:\s*([\w./-]{1,120})(?:,\s*(\d{1,2}:\d{2}(?::\d{2})?))?\)/g, (_m, id: string, at?: string) => `[[raw/${id}${at ? `#${at}` : ""}|${at ?? "source"}]]`);

export function renderMarkdown(text: string, c: RenderCtx = {}): string {
  ctx = c;
  let html: string;
  try {
    html = md.render(cites(String(text ?? "").slice(0, 400_000)));
  } catch {
    return `<p>${esc(String(text ?? "").slice(0, 2000))}</p>`;
  } finally {
    ctx = {};
  }
  return purify(html) ?? `<pre class="plain">${esc(String(text ?? ""))}</pre>`;
}

/** The first few words of a page, plain, for a search result or a tooltip. */
export const plainText = (text: string, max = 160) =>
  text
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/[#>*_`~]|\(src:[^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

/** The [[links]] a body makes, as slugs, in order, without repeats (citations aren't pages). */
export function linksIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\[\[([^\]\n]{1,200})\]\]/g)) {
    const l = parseWikilink(m[1]);
    if (l && l.source === null && l.slug && !out.includes(l.slug)) out.push(l.slug);
  }
  return out;
}
