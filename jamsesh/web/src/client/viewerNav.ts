// What the Work tab's viewer needs that isn't drawing: which items form a group, and what a key does.
import type { Artifact } from "../shared/hub";

export type WorkFilter = "all" | "mockup" | "built";

/** The Work tab's groups: one per workstream/title, variants read A, B, C rather than in the order they landed. */
export function groupArtifacts(artifacts: Artifact[], filter: WorkFilter = "all"): [string, Artifact[]][] {
  const map = new Map<string, Artifact[]>();
  for (const a of artifacts) if (filter === "all" || a.stage === filter) map.set(a.group || a.title, [...(map.get(a.group || a.title) ?? []), a]);
  for (const list of map.values()) if (list.length > 1 && list.every((a) => a.variant)) list.sort((x, y) => x.variant.localeCompare(y.variant));
  return [...map.entries()];
}

/** The index one step on, staying inside the group (the arrows go dim at the ends). */
export function step(index: number, count: number, dir: 1 | -1): number {
  return Math.max(0, Math.min(count - 1, index + dir));
}

export type ViewerAction = "prev" | "next" | "close" | "zoom" | null;

/** Keyboard first: arrows (or h/l) step, Esc closes, Space or Z toggles actual size. */
export function keyAction(e: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean }): ViewerAction {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  switch (e.key) {
    case "ArrowLeft":
    case "ArrowUp":
    case "h":
      return "prev";
    case "ArrowRight":
    case "ArrowDown":
    case "l":
      return "next";
    case "Escape":
      return "close";
    case " ":
    case "z":
      return "zoom";
    default:
      return null;
  }
}

/** Where the viewer lands when the item it holds goes away or the group changes under it. */
export function settle(items: Artifact[], currentId: string, fallback: number): number {
  const at = items.findIndex((a) => a.id === currentId);
  return at >= 0 ? at : Math.max(0, Math.min(items.length - 1, fallback));
}
