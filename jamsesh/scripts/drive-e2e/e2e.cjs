const { chromium } = require("playwright");
const fs = require("fs");
const cfg = JSON.parse(fs.readFileSync("/tmp/claude-501/p6cursor/hub.log", "utf8").split("\n").find((l) => l.startsWith("{")));
const LAN = "192.168.68.64";
const hubUrl = `http://${LAN}:${cfg.port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const fail = [];
const ok = (cond, msg) => { log(cond ? "  ok  " : "  FAIL", msg); if (!cond) fail.push(msg); };

async function api(who, path, body) {
  const r = await fetch(`${hubUrl}/api${path}`, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", cookie: `jam_token=${cfg.tokens[who]}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}

(async () => {
  const browser = await chromium.launch({ args: ["--mute-audio", "--use-fake-ui-for-media-stream"] });
  const mk = async (who, size = { width: 1920, height: 1080 }, scale = 1) => {
    const local = who === "host";
    const origin = local ? `http://127.0.0.1:${cfg.port}` : hubUrl;
    const ctx = await browser.newContext({ viewport: size, permissions: [], deviceScaleFactor: scale });
    if (local) await ctx.addCookies([{ name: "jam_window", value: cfg.winKey, url: origin }]);
    else await ctx.addCookies([{ name: "jam_token", value: cfg.tokens[who], url: origin }]);
    const personId = cfg.people[local ? "host" : who];
    await ctx.addInitScript(([origin, personId, name, dev]) => {
      try {
        const k = `jamsesh.identity::${origin}`;
        if (!localStorage.getItem(k)) localStorage.setItem(k, JSON.stringify({ hubOrigin: origin, personId, name, location: "room", deviceId: dev, devices: { client: dev, host: dev }, lastSeen: Date.now(), sessions: [], prefs: { tab: "screen", enrollAsked: "1" } }));
      } catch {}
    }, [origin, personId, who, `dev_${who}`]);
    const page = await ctx.newPage();
    const frames = { sent: [], recv: [] };
    page.on("websocket", (ws) => {
      if (!ws.url().includes("/ws")) return;
      ws.on("framesent", (f) => { const p = String(f.payload); if (p.includes('"drive"')) frames.sent.push({ t: performance.now(), m: JSON.parse(p) }); });
      ws.on("framereceived", (f) => { const p = String(f.payload); if (p.includes('"type":"drive')) frames.recv.push({ t: performance.now(), m: JSON.parse(p) }); });
    });
    page.on("console", (m) => { if (m.type() === "error") log("   [" + who + " console error]", m.text().slice(0, 200)); });
    page.on("pageerror", (e) => log("   [" + who + " pageerror]", String(e).slice(0, 300)));
    return { page, frames, ctx, who };
  };
  module.exports = { mk, api, cfg, hubUrl, ok, log, sleep, fail, browser, LAN };
  await require(process.argv[2] || "./steps.cjs")({ mk, api, cfg, hubUrl, ok, log, sleep, browser, LAN });
  await browser.close();
  log(fail.length ? `\n${fail.length} FAILED` : "\nall ok");
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
