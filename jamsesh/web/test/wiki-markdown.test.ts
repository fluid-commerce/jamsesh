// Page text to HTML: wikilinks and citations resolve, and nothing a page says can run or reach out.
import { expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { createElement } from "react";
import { dropTitle, linksIn, markdownToHtml, parseWikilink, plainText, renderMarkdown, slugify } from "../src/wiki/markdown";

const pages = new Set(["passport", "account-menu"]);
const md = (t: string) => markdownToHtml(t, { pages, sources: new Set(["2026-10-28_standup"]) });

test("[[page]], [[page|alias]] and [[page#heading]] become links to a page; unknown pages are marked", () => {
  const h = md("See [[Passport]], [[account-menu|the menu]], [[passport#login]] and [[Nothing Here]].");
  expect(h).toContain('<a href="#" class="wl" data-slug="passport">Passport</a>');
  expect(h).toContain('data-slug="account-menu">the menu</a>');
  expect(h).toContain('data-slug="passport">passport</a>');
  expect(h).toContain('class="wl missing" data-slug="nothing-here" title="No page yet">Nothing Here</a>');
});

// The same table is in hub/test/wiki.test.ts: the hub and the web must name a page the same way.
const SLUGS: [string, string][] = [
  ["Passport login!", "passport-login"],
  ["  Café  Menu ", "cafe-menu"],
  ["a".repeat(70), "a".repeat(60)],
  ["a".repeat(59) + " b", "a".repeat(59)],
  ["x".repeat(58) + " - yz", "x".repeat(58) + "-y"],
  ["!!!", "page"],
  ["---Lead---", "lead"],
  ["Ünïcödé — Straße", "unicode-stra-e"],
  ["Ｆｕｌｌｗｉｄｔｈ ①", "fullwidth-1"],
];

test("slugs and links are read the same way the hub writes them", () => {
  for (const [title, slug] of SLUGS) expect(slugify(title)).toBe(slug);
  expect(linksIn(`[[${"Long name ".repeat(8)}]]`)).toEqual([slugify("Long name ".repeat(8))]);
  expect(linksIn("a [[One]] b [[two|2]] c [[One]] d [[raw/2026-10-28_x]] e [[a\nb]]")).toEqual(["one", "two"]);
  expect(parseWikilink("")).toBeNull();
  expect(parseWikilink("x".repeat(300))).toBeNull();
});

test("citations: (src: id, 14:32) and [[raw/id]] become source links, with the moment kept", () => {
  const h = md("Thirty days (src: 2026-10-28_standup, 14:32). Also [[raw/2026-10-28_standup|the standup]] and (src: 2026-10-28_standup).");
  expect(h).toContain('class="cite" data-src="2026-10-28_standup" data-at="14:32"');
  expect(h).toContain('data-src="2026-10-28_standup" title="Open the source">the standup</a>');
  expect(h).toContain('title="Open the source">source</a>');
  expect(h).not.toContain("(src:");
});

test("outside links open in a new tab and keep the referrer and the window to themselves", () => {
  const h = md("[docs](https://example.com/a?b=1) and https://example.org/x and [me](mailto:a@b.co)");
  expect(h).toContain('href="https://example.com/a?b=1" target="_blank" rel="noopener noreferrer nofollow"');
  expect(h).toContain('href="https://example.org/x" target="_blank"');
  expect(h).toContain('href="mailto:a@b.co"');
});

const hostile = [
  "[x](javascript:alert(1))",
  "[x](JaVaScRiPt:alert(1))",
  "[x](  javascript:alert(1))",
  "[x](jav&#x61;script:alert(1))",
  "[x](java\tscript:alert(1))",
  "[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
  "[x](vbscript:msgbox(1))",
  "[x](file:///etc/passwd)",
  "[x](//evil.example/x)",
  "[x](/api/state)",
  "[ref]\n\n[ref]: javascript:alert(1)",
  "<javascript:alert(1)>",
  "![x](javascript:alert(1))",
  "![x](https://evil.example/pixel.gif)",
  "<script>alert(1)</script>",
  '<img src=x onerror="alert(1)">',
  '<a href="javascript:alert(1)">x</a>',
  "<iframe src=//evil.example></iframe>",
  '<svg onload="alert(1)"></svg>',
  '[[a"><script>alert(1)</script>]]',
  "[[a|<img src=x onerror=alert(1)>]]",
  '(src: a"onmouseover="alert(1), 12:00)',
  "[x](https://a.example/\"onmouseover=\"alert(1))",
  "`<script>alert(1)</script>`",
];

test("nothing hostile survives: no script, no handler, no javascript:, no data:, no picture fetched", () => {
  for (const t of hostile) {
    const h = md(t);
    expect(h).not.toMatch(/<script|<iframe|<svg|<img|<style|<form/i);
    expect(h).not.toMatch(/<[^>]*\son\w+\s*=/i);
    expect(h).not.toMatch(/href="\s*(javascript|data|vbscript|file):/i);
    expect(h).not.toMatch(/href="(\/|\.)/);
    for (const m of h.matchAll(/href="([^"]*)"/g)) expect(m[1]).toMatch(/^(https?:|mailto:|#)/);
  }
});

test("a link that isn't safe is shown as plain text, not as a dead link", () => {
  expect(md("[click](javascript:alert(1))")).toContain("[click](javascript:alert(1))");
  expect(md("![chart](https://evil.example/p.gif)")).toContain('<span class="img-alt">chart</span>');
});

test("with no DOM to run DOMPurify in, the page is shown as escaped text instead of being trusted", () => {
  const h = renderMarkdown('<script>alert(1)</script> [[passport]] <img src=x onerror=alert(1)>');
  expect(h).not.toMatch(/<script|<img/i);
  expect(h).toContain("&lt;script&gt;");
});

test("a page title is text, never markup", () => {
  const evil = '<img src=x onerror=alert(1)><script>alert(2)</script>"\'';
  const html = renderToString(createElement("h1", { className: "wk-title" }, evil));
  expect(html).not.toMatch(/<img|<script/i);
  expect(html).toContain("&lt;img");
});

test("the leading title line is dropped only when it repeats the title", () => {
  expect(dropTitle("# Passport\n\nBody", "Passport")).toBe("\nBody");
  expect(dropTitle("# Other\n\nBody", "Passport")).toBe("# Other\n\nBody");
  expect(dropTitle("Body only", "Passport")).toBe("Body only");
});

test("plain text for a hint drops the markup", () => {
  expect(plainText("## Hello [[a|big]] **world** (src: x, 1:02) [[b]]")).toBe("Hello big world b");
});

test("huge or odd input is cut and never throws", () => {
  expect(() => md("[[".repeat(50_000))).not.toThrow();
  expect(() => md("x".repeat(2_000_000))).not.toThrow();
  expect(md("")).toBe("");
});

test("mail and web links are followed by the browser; other links stay in the app", async () => {
  const { followsNatively } = await import("../src/wiki/nav");
  expect(followsNatively("mailto:a@b.co")).toBe(true);
  expect(followsNatively("https://example.com")).toBe(true);
  expect(followsNatively("javascript:alert(1)")).toBe(false);
  expect(followsNatively("#top")).toBe(false);
  expect(followsNatively(null)).toBe(false);
});
