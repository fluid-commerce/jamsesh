// Fills a running hub with a realistic session: three agents join over MCP, draw
// variants on the canvas, post updates, register a dev server, and the room talks.
// Usage: bun scripts/demo.ts [hubUrl]   (default http://127.0.0.1:4747)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const HUB = process.argv[2] ?? "http://127.0.0.1:4747";
const quiet = process.argv.includes("--no-room");

async function agent(join: Record<string, string>) {
  const client = new Client({ name: "demo", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${HUB}/mcp`)));
  const call = async (name: string, args: object = {}) => {
    const r: any = await client.callTool({ name, arguments: args as any });
    const text = r.content?.find((c: any) => c.type === "text")?.text ?? "";
    if (r.isError) throw new Error(`${name}: ${text}`);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };
  const brief = await call("jam_join", join);
  const id = String(brief).match(/agent id (a_\w+)/)?.[1];
  return { call, id, close: () => client.close() };
}

const say = (personId: string | null, text: string) =>
  fetch(`${HUB}/api/say`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ personId, text }) }).then((r) => r.json());

type Step = { command: string; as?: string; params: any };

function phone(name: string, x: number, y: number, v: { bg: string; ink: string; accent: string; nav: "tabs" | "pill" | "drawer"; title: string }): Step[] {
  const steps: Step[] = [
    { command: "node.create", as: "f", params: { type: "frame", name, x, y, width: 390, height: 844, props: { fill: v.bg, cornerRadius: 44, layout: "vertical", padding: 24, gap: 16 } } },
    { command: "node.create", params: { type: "text", parent: { $ref: "f" }, text: "9:41", props: { fontSize: 15, fontStyle: "Semi Bold", fill: v.ink } } },
    { command: "node.create", params: { type: "text", parent: { $ref: "f" }, text: v.title, props: { fontSize: 34, fontStyle: "Bold", fill: v.ink, letterSpacing: "-2%" } } },
    { command: "node.create", params: { type: "text", parent: { $ref: "f" }, text: "Good morning, Chey. 3 orders need you today.", props: { fontSize: 16, fill: v.ink, opacity: 0.6 } } },
  ];
  for (const [i, label] of ["Orders  ·  12 new", "Customers  ·  4 waiting", "Payouts  ·  $8,240"].entries()) {
    steps.push({ command: "node.create", as: `c${i}`, params: { type: "frame", parent: { $ref: "f" }, name: "Card", width: 342, height: 92, props: { fill: i === 0 ? v.accent : "#FFFFFF", cornerRadius: 20, padding: 20, layout: "vertical", gap: 6 } } });
    steps.push({ command: "node.create", params: { type: "text", parent: { $ref: `c${i}` }, text: label, props: { fontSize: 18, fontStyle: "Semi Bold", fill: i === 0 ? "#FFFFFF" : "#16181B" } } });
  }
  if (v.nav === "tabs") {
    steps.push({ command: "node.create", as: "nav", params: { type: "frame", parent: { $ref: "f" }, name: "Tab bar", width: 342, height: 72, props: { fill: "#FFFFFF", cornerRadius: 22, layout: "horizontal", padding: 16, gap: 34 } } });
    for (const t of ["Home", "Orders", "Shop", "Me"]) steps.push({ command: "node.create", params: { type: "text", parent: { $ref: "nav" }, text: t, props: { fontSize: 14, fontStyle: "Medium", fill: t === "Home" ? v.accent : "#8A8F98" } } });
  } else if (v.nav === "pill") {
    steps.push({ command: "node.create", as: "nav", params: { type: "frame", parent: { $ref: "f" }, name: "Floating pill", width: 240, height: 60, props: { fill: "#16181B", cornerRadius: 30, layout: "horizontal", padding: 20, gap: 24 } } });
    for (const t of ["◉", "▤", "◎", "☺"]) steps.push({ command: "node.create", params: { type: "text", parent: { $ref: "nav" }, text: t, props: { fontSize: 18, fill: "#FFFFFF" } } });
  } else {
    steps.push({ command: "node.create", as: "nav", params: { type: "frame", parent: { $ref: "f" }, name: "Menu button", width: 120, height: 48, props: { fill: v.ink, cornerRadius: 14, layout: "horizontal", padding: 14 } } });
    steps.push({ command: "node.create", params: { type: "text", parent: { $ref: "nav" }, text: "☰  Menu", props: { fontSize: 15, fontStyle: "Semi Bold", fill: v.bg } } });
  }
  return steps;
}

function desktop(name: string, x: number, y: number, v: { side: boolean; accent: string }): Step[] {
  const s: Step[] = [{ command: "node.create", as: "d", params: { type: "frame", name, x, y, width: 1440, height: 900, props: { fill: "#F6F5F2", layout: "horizontal", padding: 0, gap: 0 } } }];
  if (v.side) {
    s.push({ command: "node.create", as: "side", params: { type: "frame", parent: { $ref: "d" }, name: "Sidebar", width: 260, height: 900, props: { fill: "#16181B", layout: "vertical", padding: 28, gap: 18 } } });
    for (const t of ["Fluid", "Dashboard", "Orders", "Settings", "Team", "Billing"]) s.push({ command: "node.create", params: { type: "text", parent: { $ref: "side" }, text: t, props: { fontSize: t === "Fluid" ? 22 : 16, fontStyle: t === "Settings" || t === "Fluid" ? "Bold" : "Regular", fill: t === "Settings" ? v.accent : "#FFFFFF" } } });
  }
  s.push({ command: "node.create", as: "main", params: { type: "frame", parent: { $ref: "d" }, name: "Main", width: v.side ? 1180 : 1440, height: 900, props: { fill: "#F6F5F2", layout: "vertical", padding: 56, gap: 22 } } });
  if (!v.side) {
    s.push({ command: "node.create", as: "tabs", params: { type: "frame", parent: { $ref: "main" }, name: "Tabs", width: 640, height: 48, props: { fill: "#FFFFFF", cornerRadius: 24, layout: "horizontal", padding: 14, gap: 30 } } });
    for (const t of ["General", "Team", "Billing", "Integrations"]) s.push({ command: "node.create", params: { type: "text", parent: { $ref: "tabs" }, text: t, props: { fontSize: 15, fontStyle: t === "General" ? "Semi Bold" : "Regular", fill: t === "General" ? v.accent : "#55595F" } } });
  }
  s.push({ command: "node.create", params: { type: "text", parent: { $ref: "main" }, text: "Settings", props: { fontSize: 44, fontStyle: "Bold", fill: "#16181B", letterSpacing: "-2%" } } });
  for (const [i, t] of ["Store name", "Default currency", "Notifications"].entries()) {
    s.push({ command: "node.create", as: `r${i}`, params: { type: "frame", parent: { $ref: "main" }, name: "Row", width: 860, height: 84, props: { fill: "#FFFFFF", cornerRadius: 18, layout: "horizontal", padding: 26, gap: 20 } } });
    s.push({ command: "node.create", params: { type: "text", parent: { $ref: `r${i}` }, text: t, props: { fontSize: 18, fontStyle: "Medium", fill: "#16181B" } } });
  }
  s.push({ command: "node.create", as: "btn", params: { type: "frame", parent: { $ref: "main" }, name: "Save", width: 160, height: 52, props: { fill: v.accent, cornerRadius: 26, layout: "horizontal", padding: 16 } } });
  s.push({ command: "node.create", params: { type: "text", parent: { $ref: "btn" }, text: "Save changes", props: { fontSize: 16, fontStyle: "Semi Bold", fill: "#FFFFFF" } } });
  return s;
}

const state = await (await fetch(`${HUB}/api/state`)).json();
const person = async (name: string, role: string) =>
  (state.people.find((p: any) => p.name === name) ??
    (await (await fetch(`${HUB}/api/people`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, role }) })).json()));
const chey = await person("Chey", "Design lead");
const jonathan = await person("Jonathan", "Engineer");
const felipe = await person("Felipe", "CPO");
await person("Britain", "Designer");

const mobile = await agent({ owner: "Chey", harness: "claude-code", repo: "git@github.com:acme/mobile-app.git", branch: "nav-refresh", cwd: "/Users/chey/mobile-app", platform: "mobile", focus: "Mobile navigation refresh" });
const desk = await agent({ owner: "Jonathan", harness: "claude-code", repo: "git@github.com:acme/desktop.git", branch: "settings", cwd: "/Users/jonathan/desktop", platform: "desktop", focus: "Settings page" });
const codex = await agent({ owner: "Britain", harness: "codex", repo: "acme/design-system", branch: "main", cwd: "/Users/britain/design-system", platform: "design", focus: "Tokens audit" });

await mobile.call("jam_claim", { workstream: "Mobile nav" });
await desk.call("jam_claim", { workstream: "Desktop settings" });
await codex.call("jam_claim", { workstream: "Tokens audit" });
await mobile.call("jam_update", { kind: "progress", text: "Reading the mobile theme tokens and tab bar component before mocking nav options." });

const variants = [
  { name: "Mobile nav / A: bottom tabs", nav: "tabs" as const, bg: "#F6F5F2", ink: "#16181B", accent: "#FF6B4A", title: "Today" },
  { name: "Mobile nav / B: floating pill", nav: "pill" as const, bg: "#EEF2FF", ink: "#16181B", accent: "#3E5BFF", title: "Today" },
  { name: "Mobile nav / C: menu drawer", nav: "drawer" as const, bg: "#101114", ink: "#F3F2EF", accent: "#22C08B", title: "Today" },
];
for (const [i, v] of variants.entries()) {
  await mobile.call("canvas_batch", { label: v.name, commands: phone(v.name, i * 470, 0, v) });
}
await mobile.call("jam_update", { kind: "done", text: "Three nav directions on the canvas: A bottom tabs, B floating pill, C menu drawer. All use the app's type scale and radii.", workstream: "Mobile nav" });

await desk.call("canvas_batch", { label: "Settings A", commands: desktop("Desktop settings / A: sidebar", 0, 1000, { side: true, accent: "#FF6B4A" }) });
await desk.call("canvas_batch", { label: "Settings B", commands: desktop("Desktop settings / B: top tabs", 1540, 1000, { side: false, accent: "#3E5BFF" }) });
await desk.call("jam_update", { kind: "done", text: "Two settings layouts up: A keeps the sidebar, B moves sections into top tabs.", workstream: "Desktop settings" });
await codex.call("jam_message", { to: "Chey's Claude", text: "Heads up: the accent token is #FF6B4A on mobile but #FF7050 on desktop. I'll flag it in the audit." });

// A built version, served by a tiny dev server on this machine.
const app = Bun.serve({
  port: 5199,
  hostname: "0.0.0.0",
  fetch: () =>
    new Response(
      `<!doctype html><html><body style="margin:0;font-family:-apple-system,system-ui;background:#F6F5F2;color:#16181B"><div style="padding:28px 24px"><div style="font-weight:600">9:41</div><h1 style="font-size:34px;margin:18px 0 6px;letter-spacing:-.02em">Today</h1><p style="opacity:.6;margin:0 0 20px">Good morning, Chey. 3 orders need you today.</p>${["Orders · 12 new", "Customers · 4 waiting", "Payouts · $8,240"].map((t, i) => `<div style="background:${i ? "#fff" : "#FF6B4A"};color:${i ? "#16181B" : "#fff"};border-radius:20px;padding:22px 20px;margin-bottom:14px;font-weight:600;font-size:18px">${t}</div>`).join("")}<div style="position:fixed;left:24px;right:24px;bottom:28px;background:#fff;border-radius:22px;padding:22px;display:flex;justify-content:space-around;font-size:14px;color:#8A8F98"><b style="color:#FF6B4A">Home</b><span>Orders</span><span>Shop</span><span>Me</span></div></div></body></html>`,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    ),
});
console.log(await mobile.call("jam_devserver", { name: "Mobile app (Expo web)", url: "http://localhost:5199", platform: "mobile" }));

if (!quiet) {
  await say(chey.id, "Okay these nav options are looking pretty good honestly");
  await Bun.sleep(400);
  await say(jonathan.id, "haha the drawer one looks like it's from 2014");
  await Bun.sleep(2500);
  await say(felipe.id, "I like direction A, the bottom tabs. Let's build that for real in the mobile app.");
}
console.log("Demo is running. Agents:", mobile.id, desk.id, codex.id, "Press Ctrl+C to stop.");
await new Promise(() => {});
void app;
