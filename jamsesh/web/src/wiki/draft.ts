// An edit in progress is pinned to the revision it started from. The page refreshes in the background whenever the
// wiki changes; while someone is editing, a refresh never moves that revision, so a save over a newer page is a
// conflict the person sees and decides, never a silent overwrite.
import type { WikiPage } from "./types";

/** What a background refresh does to an open page: replaces it when nobody is editing; otherwise only says the page has moved on. */
export function onRefresh(editing: boolean, base: string, latest: WikiPage): { page?: WikiPage; theirs?: WikiPage } {
  if (!editing) return { page: latest };
  return latest.rev !== base ? { theirs: latest } : {};
}

/** The revision a save is checked against: the one the edit began from, or the newer page's once the person chose to save over it. */
export const saveRev = (base: string, theirs: WikiPage | null, overTheirs: boolean): string | undefined => (overTheirs && theirs ? theirs.rev : base) || undefined;

/**
 * Unsaved edits, held outside the page view: whatever unmounts the editor (a page link, the phone's Index button, a tab or
 * host-mode switch, the Wiki view closing) leaves the text here, and the page opens back into it. It goes only when the
 * person saves or cancels. Closing or reloading the window asks first while anything is held.
 */
const held = new Map<string, { text: string; base: string }>();
let armed = false;

export const drafts = {
  hold(slug: string, text: string, base: string) {
    held.set(slug, { text, base });
    if (!armed && typeof window !== "undefined") {
      armed = true;
      window.addEventListener("beforeunload", (e) => void (held.size && e.preventDefault()));
    }
  },
  get: (slug: string) => held.get(slug),
  drop: (slug: string) => void held.delete(slug),
  count: () => held.size,
};
