// Throwaway hub for the driving e2e: prints one JSON line when ready, then runs until killed.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "jam-e2e-drive-"));
Object.assign(process.env, { JAMSESH_HOME: dir, JAMSESH_DATA: dir, JAMSESH_PORT: process.env.E2E_PORT ?? "4871", JAMSESH_FIGCRAFT_PORT: "4872", JAMSESH_DEV_PORT_START: "5710", JAMSESH_OFFLINE: "1", JAMSESH_SILENT: "1", JAMSESH_BONJOUR_SERVICE: "_jamsesh-test._tcp" });
import { symlinkSync } from "node:fs";
try { symlinkSync(`${process.env.HOME}/.jamsesh/web-canvas`, join(dir, "web-canvas")); } catch {}
process.env.JAMSESH_FIGCRAFT_BIN_DIR = `${process.env.HOME}/.jamsesh/bin`;
const R = "/Users/cheyrasmussen/jamsesh-p6-cursor/jamsesh/hub/src";
const { Hub } = await import(`${R}/hub`);
const { startHttp } = await import(`${R}/http`);
const { config } = await import(`${R}/config`);
const hub = new Hub({ canvas: !!process.env.E2E_CANVAS, whisper: false, dataDir: dir });
const s = hub.session;
const server = startHttp(hub, Number(config.port));
await hub.start();
const person = (name: string) => s.upsertPerson({ name });
const host = person("Host"), chey = person("Chey"), felipe = person("Felipe"), maya = person("Maya");
s.store.setSetting("hostPersonId", host.id);
const lan = process.env.E2E_LAN ?? "127.0.0.1";
const tok = (p: any, kind: "browser" | "agent" = "browser") => hub.auth.issue({ kind, label: p?.name ?? "agent", ip: lan, personId: p?.id ?? null });
const t = { chey: tok(chey), felipe: tok(felipe), maya: tok(maya), agent: tok(null, "agent") };
// A tiny build to put on the screen.
const page = `<!doctype html><meta charset=utf-8><title>Test build</title><style>body{margin:0;font:16px system-ui;background:#f4f1ea}header{padding:20px;background:#223}main{padding:20px}#box{height:260px;overflow:auto;border:2px solid #223;margin:20px 0}#box div{height:2000px;background:linear-gradient(#fc6,#6cf)}.tall{height:2400px;background:repeating-linear-gradient(#eee 0 100px,#ddd 100px 200px)}button{font-size:28px;padding:20px 40px}input,textarea{font-size:22px;display:block;margin:10px 0;width:420px}</style>
<header><h1>Checkout</h1></header><main><button id=btn>Pay now: 0</button> <a id=lnk href="/other">A link</a><input id=name placeholder="Name"><textarea id=notes placeholder="Notes"></textarea><div id=box><div>scroll me</div></div><div class=tall>tall</div></main>
<script>window.__log=[];let n=0;btn.onclick=()=>{btn.textContent='Pay now: '+(++n)};for(const t of ['mousedown','mouseup','click','wheel','keydown'])addEventListener(t,e=>__log.push([t,Math.round(e.clientX||0),Math.round(e.clientY||0),e.key||'',e.isTrusted]),true)</script>`;
const app = Bun.serve({ port: 5790, hostname: "127.0.0.1", fetch: (r) => new URL(r.url).pathname === "/other" ? new Response("<h1>Other page</h1>", { headers: { "content-type": "text/html" } }) : new Response(page, { headers: { "content-type": "text/html" } }) });
const agent = s.registerAgent({ ownerName: "Felipe", harness: "claude-code", repo: "acme/app", cwd: "/f/app", machine: "m1", platform: "desktop" }).agent;
const dev = await hub.devproxy.register({ agentId: agent.id, name: "Checkout build", target: `127.0.0.1:${app.port}` });
const art = s.artifacts().find((a: any) => a.kind === "devserver");
const winKey = hub.auth.windows.take(hub.auth.windows.mint());
console.log(JSON.stringify({ port: server.port, devPort: dev.hostPort, art: art.id, winKey, people: { host: host.id, chey: chey.id, felipe: felipe.id, maya: maya.id }, tokens: { chey: t.chey.token, felipe: t.felipe.token, maya: t.maya.token, agent: t.agent.token }, devices: { chey: t.chey.device.id, felipe: t.felipe.device.id } }));
await new Promise(() => {});
