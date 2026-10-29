// The Projects picker before any session exists (JAMSESH_LOBBY=1): a small server for the Mac app's
// first screen when hosting. It serves the web app and the project routes to this Mac's own windows
// and nothing else. Choosing a project makes the app start the real hub for it.
import { buffered } from "./body";
import { HostWindows, readWindowLinks } from "./auth";
import { config } from "./config";
import { cookie, hostWindowRoute, json, sameOrigin, webApp } from "./http";
import { projectsRoute } from "./projects-api";

export function startLobby(port = config.port) {
  const windows = new HostWindows();
  if (process.env.JAMSESH_WINDOW_LINKS === "stdin") void readWindowLinks(windows);
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(incoming) {
      const req = await buffered(incoming);
      if (!req) return json({ error: "That request is too large." }, 413);
      const url = new URL(req.url);
      const path = url.pathname;
      const hostWindow = windows.matches(cookie(req, "jam_window"));
      try {
        if (path.endsWith("/healthz")) return new Response("ok");
        if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && !sameOrigin(req)) return json({ error: "Not from this site." }, 403);
        if (path === "/host-window" && req.method === "GET") return await hostWindowRoute(windows, req, url);
        // The app checks that its window key was accepted by asking for the pairing code; there is none yet.
        if (path === "/api/pair/code") return hostWindow ? json({ code: null, lobby: true, addresses: [] }) : json({ error: "Only the host's window." }, 403);
        if (path === "/api/pair/info") return json({ name: "Projects", brainName: "JamSesh", hostId: "lobby" });
        const api = await projectsRoute(req, url, { local: true, hostWindow });
        if (api) return api;
        if (path.startsWith("/api/")) return json({ error: "Pick a project first." }, 409);
        if (path === "/" || path === "/host") return Response.redirect("/projects", 302);
        return webApp(path);
      } catch (e) {
        console.error("lobby:", path, e);
        return json({ error: e instanceof Error ? e.message : String(e) }, 500);
      }
    },
  });
  console.log(`  JamSesh Projects picker on http://127.0.0.1:${port}/projects`);
  return server;
}
