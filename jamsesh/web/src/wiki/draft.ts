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
const held = new Map<string, { text: string; base: string; n: number }>();
let armed = false;

export const drafts = {
  hold(slug: string, text: string, base: string) {
    // Each change of text is one more edit; a save remembers which edit it sent.
    const was = held.get(slug);
    held.set(slug, { text, base, n: was && was.text === text ? was.n : (was?.n ?? 0) + 1 });
    if (!armed && typeof window !== "undefined") {
      armed = true;
      window.addEventListener("beforeunload", (e) => void (held.size && e.preventDefault()));
    }
  },
  get: (slug: string) => held.get(slug),
  /** The edit number of the text held now (what a save sends along with the text). */
  edit: (slug: string) => held.get(slug)?.n ?? 0,
  /**
   * A save of edit `n` was answered with the page now at `rev`. The draft goes only if it is still that edit; typing done
   * while the save was out stays as the draft, built on the saved revision. Works the same whether or not the view is still mounted.
   */
  saved(slug: string, n: number, rev: string): boolean {
    const d = held.get(slug);
    if (!d) return true;
    if (d.n === n) return held.delete(slug), true;
    held.set(slug, { ...d, base: rev });
    return false;
  },
  drop: (slug: string) => void held.delete(slug),
};

/** What PageView starts with when it mounts: the held draft (text and the revision it began from), or nothing. */
export const restore = (slug: string): { editing: string | null; base: string } => {
  const d = held.get(slug);
  return { editing: d?.text ?? null, base: d?.base ?? "" };
};

/** Called by PageView whenever its editor text changes: a text is held, null (saved or cancelled) drops it. Unmounting calls nothing. */
export const track = (slug: string, editing: string | null, base: string) => (editing === null ? drafts.drop(slug) : drafts.hold(slug, editing, base));

/** The page to show once a fetch lands: the fetched one unless a refresh left the open one alone; a reopened draft with no page yet gets the fetched one too. */
export const pageAfterLoad = (cur: WikiPage | null, latest: WikiPage, r: { page?: WikiPage }): WikiPage => r.page ?? cur ?? latest;
