// Keeps the project's record current while a session runs: who came, when it was last used, and a
// small picture of the canvas for the Projects picker. Every few minutes and when the session ends.
import { config } from "./config";
import type { Hub } from "./hub";
import { writeProjectContext } from "./carryover";
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
    this.save().catch(() => {});
    this.timer = setInterval(() => this.save().catch((e) => console.error("project:", e instanceof Error ? e.message : e)), EVERY_MS);
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
    writeProjectContext(this.home, p.slug, p.sessionId, s);
    const png = await this.hub.canvas.thumbnail().catch(() => null);
    if (png?.length) saveThumbnail(this.home, p.slug, png);
  }
}
