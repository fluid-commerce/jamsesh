import { z } from "zod";
import type { Stage } from "./types";

// The one shape check for a stage: a person's cast arriving over HTTP, and every stage read back from the store. Counts and
// lengths are bounded so a malformed or hostile body can't be saved and then break every read of the room's state.
const id = z.string().max(200);
const label = z.string().max(300).optional();
const tile = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("artifact"), artifactId: id, label }),
  z.object({ kind: z.literal("canvas"), follow: id.nullish(), page: id.nullish(), label }),
  z.object({ kind: z.literal("web"), url: z.string().max(2000), label }),
  z.object({ kind: z.literal("screen"), shareId: id, label }),
  z.object({ kind: z.literal("agent"), agentId: id, label }),
  z.object({ kind: z.literal("html"), html: z.string().min(1).max(200_000), label }),
  z.object({ kind: z.literal("feed"), label }),
]);

const stageShape = {
  mode: z.enum(["board", "spotlight", "compare", "parity", "agents", "canvas", "custom", "layout", "welcome", "join"]),
  title: z.string().max(500).optional(),
  caption: z.string().max(2000).optional(),
  items: z.array(id).max(60).optional(),
  columns: z.array(z.object({ label: z.string().max(300), items: z.array(id).max(60) })).max(4).optional(),
  layout: z
    .object({
      tiles: z.array(tile).max(12),
      grid: z.object({ columns: z.string().max(200), rows: z.string().max(200), areas: z.array(z.string().max(100)).max(12) }).optional(),
    })
    .optional(),
  html: z.string().max(500_000).optional(),
  follow: id.nullish(),
  page: id.nullish(),
  expanded: z.string().max(100).optional(),
  pinned: z.boolean().optional(),
  pinnedById: z.string().max(200).optional(),
  since: z.number().finite().optional(),
  by: z.string().max(200).optional(),
  screenId: z.string().max(100).optional(),
  lock: z.object({ by: z.string().max(200), personId: z.string().max(200).nullable(), since: z.number().finite(), lastActive: z.number().finite() }).optional(),
};
const stageSchema = z.object(stageShape).superRefine((s, ctx) => {
  // A screen that locks should show what was asked for.
  const need = (ok: boolean, path: string, message: string) => ok || ctx.addIssue({ code: "custom", path: [path], message });
  if (s.mode === "spotlight" || s.mode === "compare") need((s.items?.length ?? 0) > 0, "items", "needs at least one item");
  if (s.mode === "layout") need((s.layout?.tiles.length ?? 0) > 0, "layout", "needs at least one tile");
  if (s.mode === "custom") need(!!s.html, "html", "needs content");
});

/** A stage's fields checked and cleaned (unknown fields dropped), or why it isn't one. */
export function parseStage(raw: unknown): { ok: true; stage: Partial<Stage> & { mode: Stage["mode"] } } | { ok: false; error: string } {
  const r = stageSchema.safeParse(raw);
  if (r.success) return { ok: true, stage: r.data as Partial<Stage> & { mode: Stage["mode"] } };
  const i = r.error.issues[0];
  return { ok: false, error: `Not a screen: ${i?.path.join(".") || "stage"} ${i?.message ?? "is invalid"}` };
}
