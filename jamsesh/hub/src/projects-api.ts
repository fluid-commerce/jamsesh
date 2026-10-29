// The Projects picker's routes (/api/projects…), shared by the running hub and the lobby. Only the
// host's own windows may use them: they list project names and the people who came.
import { assertLive } from "./room-context";
import { config } from "./config";
import { cleanName, createProject, findProject, isSlug, listProjects, thumbnailPath } from "./projects";

const reply = (v: unknown, status = 200) => Response.json(v, { status, headers: { "cache-control": "no-store" } });
const fail = (error: string, status = 400) => reply({ error }, status);

/** What the Mac app may be asked to open: an existing project by slug, or a new one by name. */
export interface OpenChoice {
  slug?: string;
  name?: string;
}

export async function projectsRoute(req: Request, url: URL, who: { local: boolean; hostWindow: boolean }, home = config.home): Promise<Response | null> {
  const path = url.pathname;
  if (path !== "/api/projects" && !path.startsWith("/api/projects/")) return null;
  if (!who.hostWindow) return fail(who.local ? "Open this from the JamSesh window on the host." : "Only the host picks the project.", 403);

  if (path === "/api/projects" && req.method === "GET") {
    return reply({ projects: listProjects(home), current: config.project?.slug ?? null, lobby: config.lobby });
  }

  const thumb = path.match(/^\/api\/projects\/([^/]+)\/thumbnail\.png$/);
  if (thumb && req.method === "GET") {
    const file = thumbnailPath(home, thumb[1]);
    return file ? new Response(Bun.file(file), { headers: { "content-type": "image/png", "cache-control": "no-cache" } }) : fail("No thumbnail yet.", 404);
  }

  if (req.method !== "POST") return fail("Not found.", 404);
  // A JSON body only: a form post from another site can't make projects here.
  if (!(req.headers.get("content-type") ?? "").includes("application/json")) return fail("Send JSON.", 415);
  const body = (await req.json().catch(() => ({}))) as { name?: unknown; slug?: unknown; fresh?: unknown };

  if (path === "/api/projects") {
    assertLive();
    try {
      return reply({ project: createProject(home, cleanName(body.name)) }, 201);
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  }

  // Opening swaps the session, which only the Mac app (it runs the hub) can do. From a terminal this
  // makes the project and says how to start it; the picker shows that.
  if (path === "/api/projects/open") {
    assertLive();
    const project = isSlug(body.slug) ? findProject(home, body.slug) : body.name ? (findProject(home, cleanName(body.name)) ?? createProject(home, cleanName(body.name))) : null;
    if (!project) return fail("That project isn't here.", 404);
    return reply({ switched: false, project, command: `jamsesh host --project ${project.slug}` }, 200);
  }
  return fail("Not found.", 404);
}
