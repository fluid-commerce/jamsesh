import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Person } from "./types";

/**
 * Profile photos belong to the team (people outlive sessions), so they live in the team folder and are
 * served from /photos/<file>. Before this they were written to the session's renders folder, and the
 * next session didn't serve them.
 */
export const PHOTO_URL = "/photos/";
const OLD_URL = /^\/renders\/uploads\/([\w.-]+)$/;

/** Where an earlier session may have left the photo: this session's uploads, its sibling sessions', and every session of every project. */
export function earlierUploads(dataDir: string, home: string): string[] {
  const subdirs = (d: string) => {
    try {
      return readdirSync(d).map((n) => join(d, n)).filter((p) => statSync(p).isDirectory());
    } catch {
      return [];
    }
  };
  const sessions = [dataDir, ...subdirs(dirname(dataDir))];
  for (const project of subdirs(join(home, "projects"))) sessions.push(...subdirs(join(project, "sessions")));
  return [...new Set(sessions)].map((s) => join(s, "renders", "uploads"));
}

/**
 * Moves each person's old photo link (/renders/uploads/<file>) into the team photos folder: the file is copied from the first
 * place it is found and the link updated; a photo that can't be found is cleared (the person shows their initials).
 */
export function migratePhotos(o: { people: Person[]; photosDir: string; uploads: string[]; setPhoto: (id: string, url: string | null) => void }): { moved: number; cleared: number } {
  let moved = 0;
  let cleared = 0;
  for (const p of o.people) {
    const name = p.photo?.match(OLD_URL)?.[1];
    if (!name || name !== basename(name)) continue;
    const from = o.uploads.map((d) => join(d, name)).find((f) => existsSync(f));
    if (from) {
      mkdirSync(o.photosDir, { recursive: true });
      try {
        copyFileSync(from, join(o.photosDir, name));
        o.setPhoto(p.id, `${PHOTO_URL}${name}`);
        moved++;
        continue;
      } catch {}
    }
    o.setPhoto(p.id, null);
    cleared++;
  }
  return { moved, cleared };
}
