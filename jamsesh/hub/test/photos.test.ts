// Profile photos live in the team folder, with the people they belong to: a new session still serves them,
// and a link left by an older hub (/renders/uploads/…) is carried over, or cleared when its file is gone.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../src/hub";
import { startHttp } from "../src/http";

const dir = mkdtempSync(join(tmpdir(), "jam-photos-"));
const team = join(dir, "team");
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
const opts = (session: string) => ({ canvas: false, whisper: false, dataDir: join(dir, session), teamDir: team });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("a saved photo is in the team folder, is served from /photos, and survives a new session", async () => {
  const hub = new Hub(opts("s1"));
  const server = startHttp(hub, 0);
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const pat = hub.session.upsertPerson({ name: "Pat" });
    const saved = (await hub.savePhoto(pat.id, PNG))!;
    expect(saved.photo).toMatch(/^\/photos\/[\w-]+\.png$/);
    const name = saved.photo!.slice("/photos/".length);
    expect(existsSync(join(team, "photos", name))).toBe(true);
    expect(existsSync(join(dir, "s1", "renders", "uploads", name))).toBe(false);

    const window = { cookie: `jam_window=${hub.auth.windows.take(hub.auth.windows.mint())}` };
    const got = await fetch(`${base}${saved.photo}`, { headers: window });
    expect(got.status).toBe(200);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(PNG);
    // Read-only, contained, and not served without a credential.
    expect((await fetch(`${base}${saved.photo}`, { method: "POST", headers: window })).status).toBe(405);
    expect((await fetch(`${base}/photos/nope.png`, { headers: window })).status).toBe(404);
    // An escaped "../" never reaches the photos route (it takes plain file names only), so the team database is never served;
    // what answers instead is whatever the hub serves for an unknown page (the web app's page when it's built, else not found).
    for (const escape of ["%2e%2e%2fteam.db", "..%2fteam.db", "%2e%2e/team.db"]) {
      const res = await fetch(`${base}/photos/${escape}`, { headers: window });
      expect(new TextDecoder().decode((await res.arrayBuffer()).slice(0, 15))).not.toBe("SQLite format 3");
    }
    expect((await fetch(`${base}${saved.photo}`, { headers: { "x-forwarded-for": "9.9.9.9" } })).status).toBeGreaterThanOrEqual(400);
    await hub.stop();
  } finally {
    server.stop(true);
  }
  // The next session of the same team serves the same file.
  const next = new Hub(opts("s2"));
  const server2 = startHttp(next, 0);
  try {
    const p = next.session.people().find((x) => x.name === "Pat")!;
    const res = await fetch(`http://127.0.0.1:${server2.port}${p.photo}`, { headers: { cookie: `jam_window=${next.auth.windows.take(next.auth.windows.mint())}` } });
    expect(res.status).toBe(200);
  } finally {
    server2.stop(true);
    await next.stop();
  }
});

test("on start, an old /renders/uploads photo is copied from this or an earlier session; one that can't be found is cleared", async () => {
  const old = new Hub(opts("s3"));
  const found = old.session.upsertPerson({ name: "Found" });
  const missing = old.session.upsertPerson({ name: "Missing" });
  const mine = old.session.upsertPerson({ name: "Kept" });
  old.session.setPhoto(found.id, "/renders/uploads/found.png");
  old.session.setPhoto(missing.id, "/renders/uploads/missing.png");
  old.session.setPhoto(mine.id, "/photos/kept.png");
  await old.stop();
  // The file is in an earlier session of the project, not the one that starts now.
  const earlier = join(dir, "s0", "renders", "uploads");
  mkdirSync(earlier, { recursive: true });
  writeFileSync(join(earlier, "found.png"), PNG);

  const now = new Hub(opts("s4"));
  try {
    const photoOf = (id: string) => now.session.person(id)?.photo;
    expect(photoOf(found.id)).toBe("/photos/found.png");
    expect(readFileSync(join(team, "photos", "found.png"))).toEqual(Buffer.from(PNG));
    expect(photoOf(missing.id)).toBeNull();
    expect(photoOf(mine.id)).toBe("/photos/kept.png");
  } finally {
    await now.stop();
  }
});
