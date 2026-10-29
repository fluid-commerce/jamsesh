// Keeps the project's record current while a session runs: who came, when it was last used, and a
// small picture of the canvas for the Projects picker. Every few minutes and when the session ends.
import { config } from "./config";
import type { Hub } from "./hub";
import { saveProjectContext } from "./carryover";
import { saveThumbnail, touchSession } from "./projects";

const EVERY_MS = 5 * 60_000;

export class ProjectKeeper {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private hub: Hub,
    private home = config.home,
    private project: { slug: string; sessionId: string } | null = config.project,
  ) {}

  start() {
    if (!this.project) return;
    const report = (e: unknown) => console.error("project:", e instanceof Error ? e.message : e);
    this.save().catch(report);
    this.timer = setInterval(() => this.save().catch(report), EVERY_MS);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async save() {
    const p = this.project;
    if (!p) return;
    const s = this.hub.session;
    const people = this.hub.store.speakers().map((name) => ({ name, color: s.personByName(name)?.color }));
    touchSession(this.home, p.slug, p.sessionId, people);
    // The context file is a copy of what the session's own store holds: failing to write it doesn't stop the rest.
    let saved = true;
    try {
      saved = saveProjectContext(this.home, p.slug, p.sessionId, s) !== "failed";
    } catch (e) {
      console.error("project context:", e instanceof Error ? e.message : e);
      saved = false;
    }
    const png = await this.hub.canvas.thumbnail().catch(() => null);
    if (png?.length) saveThumbnail(this.home, p.slug, png);
    // The thumbnail is a nicety; the context is what the next session reads. A failed save is the caller's to know.
    if (!saved) throw new Error("The project's context wasn't saved.");
  }
}
