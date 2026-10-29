// Opening a wiki page from outside the Wiki tab (the Work tab's links): the app switches tab, and the wiki opens the page.
let pending: string | null = null;
const EVENT = "jam-wiki-open";

export function openWiki(slug: string) {
  pending = slug;
  window.dispatchEvent(new CustomEvent(EVENT, { detail: slug }));
}
export const takePendingWikiPage = () => {
  const p = pending;
  pending = null;
  return p;
};
export const onWikiOpen = (fn: () => void) => {
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
};

/** A link in a page that the browser should follow itself (web and mail links); anything else stays inside the app. */
export const followsNatively = (href: string | null | undefined) => /^(https?|mailto):/i.test(href ?? "");
