module.exports = async ({ mk, api, cfg, hubUrl, ok, log, sleep }) => {
  const S = "/tmp/claude-501/p6cursor/";
  const host = await mk("host");
  await host.page.goto(`http://127.0.0.1:${cfg.port}/host`);
  const drv = await mk("chey");
  await drv.page.goto(`${hubUrl}/client`);
  const fel = await mk("felipe");
  await fel.page.goto(`${hubUrl}/client`);
  await sleep(2500);
  await api("chey", "/stage", { mode: "spotlight", items: [cfg.art], title: "Checkout", personId: cfg.people.chey });
  await sleep(2000);
  const dev = () => host.page.frames().find((f) => f.url().includes(`:${cfg.devPort}`));
  ok(!!dev(), "the build is framed on the big screen: " + (dev() && dev().url()));
  await dev().evaluate(() => { for (const t of ['focusin', 'focusout']) addEventListener(t, (e) => __log.push([t, e.target.id || e.target.tagName, new Error().stack.split('\n').slice(2,5).join('|')]), true); });
  // ---- A. start driving ----
  await drv.page.getByRole("button", { name: "Drive", exact: true }).click();
  await drv.page.waitForSelector(".drive-surface");
  ok(true, "Drive shows the trackpad surface");
  const surf = drv.page.locator(".drive-surface");
  const sb = await surf.boundingBox();
  await drv.page.mouse.click(sb.x + 100, sb.y + 100);
  await sleep(300);
  const locked = await drv.page.evaluate(() => !!document.pointerLockElement);
  const cap = await surf.getAttribute("data-captured");
  log("  mode:", locked ? "pointer lock (relative)" : "absolute over the mirror", "captured=" + cap);
  ok(cap === "1", "first click captures the trackpad");
  // Where the cursor is, as the driver last said it.
  const lastPos = () => { const m = drv.frames.sent.filter((f) => f.m.ev && f.m.ev.x !== undefined).at(-1); return m ? { x: m.m.ev.x, y: m.m.ev.y } : { x: 0.5, y: 0.5 }; };
  const body = await host.page.locator(".stage-body").first().boundingBox();
  const moveTo = async (fx, fy) => {
    for (let i = 0; i < 40; i++) {
      const p = lastPos();
      const dx = (fx - p.x), dy = (fy - p.y);
      if (Math.abs(dx) < 0.004 && Math.abs(dy) < 0.004) break;
      const cur = await drv.page.evaluate(() => 0);
      if (locked) {
        const r = await surf.boundingBox();
        const vw = Math.max(r.width, 900), vh = vw * (r.height / r.width);
        await drv.page.mouse.move(sb.x + 200 + 0, sb.y + 200, {}); // keep inside
        await drv.page.mouse.move(sb.x + 200 + dx * vw, sb.y + 200 + dy * vh);
      } else {
        await drv.page.mouse.move(sb.x + fx * sb.width, sb.y + fy * sb.height);
      }
      await sleep(40);
    }
    await sleep(400);
  };
  // ---- C. smoothness and latency ----
  const before = drv.frames.sent.length, hb = host.frames.recv.length;
  const t0 = performance.now();
  for (let i = 0; i < 150; i++) { await drv.page.mouse.move(sb.x + 200 + Math.cos(i / 10) * 150, sb.y + 200 + Math.sin(i / 10) * 100); await sleep(8); }
  await sleep(300);
  const secs = (performance.now() - t0) / 1000;
  const sent = drv.frames.sent.length - before, got = host.frames.recv.length - hb;
  log(`  150 mouse moves in ${secs.toFixed(2)} s: ${sent} sent (${(sent / secs).toFixed(0)}/s), ${got} reached the big screen (${(got / secs).toFixed(0)}/s)`);
  ok(got >= sent - 1 && sent > 20, "every event sent reaches the big screen");
  const lat = [];
  for (const r of host.frames.recv.slice(hb)) { const s = drv.frames.sent.find((f) => f.m.ev && r.m.ev && f.m.ev.x === r.m.ev.x && f.m.ev.y === r.m.ev.y); if (s) lat.push(r.t - s.t); }
  lat.sort((a, b) => a - b);
  log(`  latency driver -> big screen: median ${lat[Math.floor(lat.length / 2)]?.toFixed(1)} ms, p95 ${lat[Math.floor(lat.length * 0.95)]?.toFixed(1)} ms (n=${lat.length})`);
  ok(lat.length > 10 && lat[Math.floor(lat.length / 2)] < 50, "median latency under 50 ms");
  // The glide: sample the dart on the host as it moves.
  const cur = host.page.locator(".drive-cursor").first();
  ok(((await cur.locator(".drive-tag").innerText()) === "Chey"), "the dart carries the name tag");
  // ---- over the build: screenshot ----
  const frameBox = await host.page.locator("iframe[title='Checkout build']").boundingBox().catch(() => null);
  log("  frame box", JSON.stringify(frameBox), "stage body", JSON.stringify(body));
  const btnBox = await dev().locator("#btn").boundingBox().catch(() => null);
  // Button position in host page coordinates: ask the iframe geometry (scaled).
  const geo = await host.page.evaluate(() => { const f = document.querySelector("iframe"); const r = f.getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height, iw: f.offsetWidth, ih: f.offsetHeight }; });
  const inner = async (sel) => dev().evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; }, sel);
  const toFrac = (p) => ({ x: (geo.l + (p.x / geo.iw) * geo.w - body.x) / body.width, y: (geo.t + (p.y / geo.ih) * geo.h - body.y) / body.height });
  const btn = toFrac(await inner("#btn"));
  await moveTo(btn.x, btn.y);
  await host.page.screenshot({ path: S + "s2-dart-over-build.png" });
  // ---- D. click lands ----
  await drv.page.mouse.down(); await drv.page.mouse.up();
  await sleep(300);
  let txt = await dev().locator("#btn").innerText();
  ok(txt === "Pay now: 1", "a click on the big screen's button lands in the build: " + txt);
  const logd = await dev().evaluate(() => window.__log.filter((e) => e[0] === "click"));
  log("  page saw:", JSON.stringify(logd));
  // ---- E. scroll ----
  const box = toFrac(await inner("#box"));
  await moveTo(box.x, box.y);
  for (let i = 0; i < 5; i++) { await drv.page.mouse.wheel(0, 60); await sleep(30); }
  await sleep(300);
  const st = await dev().evaluate(() => document.querySelector("#box").scrollTop);
  ok(st > 100, "wheel scrolls the scrollable box under the dart: scrollTop=" + st);
  const tall = toFrac({ x: 700, y: 120 });
  await moveTo(tall.x, tall.y);
  for (let i = 0; i < 5; i++) { await drv.page.mouse.wheel(0, 100); await sleep(30); }
  await sleep(300);
  const wy = await dev().evaluate(() => window.scrollY);
  ok(wy > 200, "wheel over the page scrolls the page: scrollY=" + wy);
  // ---- F. typing ----
  await dev().evaluate(() => window.scrollTo(0, 0)); await sleep(200);
  const inp = toFrac(await inner("#name"));
  await moveTo(inp.x, inp.y);
  await drv.page.mouse.down(); await drv.page.mouse.up();
  await sleep(200);
  log("  after click, active:", JSON.stringify(await dev().evaluate(() => [JSON.stringify(window.__log.filter(e=>e[0].startsWith('focus')).slice(-4)), document.activeElement.tagName, document.elementFromPoint(234, 242)?.id, document.elementFromPoint(234, 242)?.tagName, window.scrollY, innerWidth, innerHeight])));
  await drv.page.keyboard.type("Hello Chey");
  await sleep(400);
  const v1 = await dev().evaluate(() => document.querySelector("#name").value);
  ok(v1 === "Hello Chey", "typing lands in the focused field: " + JSON.stringify(v1));
  log("  after type, active:", await dev().evaluate(() => [document.activeElement.id, document.hasFocus()]));
  await drv.page.keyboard.press("Backspace"); await drv.page.keyboard.press("Backspace");
  await sleep(300);
  const v2 = await dev().evaluate(() => document.querySelector("#name").value);
  ok(v2 === "Hello Ch", "Backspace edits: " + JSON.stringify(v2));
  const typedHere = await drv.page.evaluate(() => document.body.innerText.includes("Hello Chey"));
  ok(!typedHere, "keys did not leak into the driver's own app");
  await dev().evaluate(() => window.scrollTo(0, 0));
  // ---- G. link ----
  await sleep(300);
  const lnk = toFrac(await inner("#lnk"));
  await moveTo(lnk.x, lnk.y);
  await drv.page.mouse.down(); await drv.page.mouse.up();
  await sleep(800);
  ok(/Other page/.test(await dev().innerText("body").catch(() => "")), "a link navigates the build, and the script survives it");
  await dev().goBack?.().catch(() => {});
  await host.page.screenshot({ path: S + "s3-after.png" });
  // ---- H. unhappy paths ----
  const wsSend = (p, ev) => p.evaluate(async (ev) => {
    const ws = new WebSocket(location.origin.replace("http", "ws") + "/ws?device=probe-" + Math.random());
    const got = [];
    ws.onmessage = (e) => { try { const m = JSON.parse(e.data); if (m.type === "drive-denied" || m.type === "drive") got.push(m); } catch {} };
    await new Promise((r) => (ws.onopen = r));
    ws.send(JSON.stringify({ type: "drive", screen: "main", ev }));
    await new Promise((r) => setTimeout(r, 400));
    ws.close();
    return got;
  }, ev);
  const fdeny = await wsSend(fel.page, { k: "move", x: 0.3, y: 0.3 });
  ok(fdeny.some((m) => m.type === "drive-denied"), "Felipe (not driving) is told no: " + JSON.stringify(fdeny.find((m) => m.type === "drive-denied")));
  ok(!fdeny.some((m) => m.type === "drive"), "and his move reaches nobody");
  const ag = await api("agent", "/drive/start", {});
  ok(ag.status === 403, "an agent can't start driving (" + ag.status + ")");
  const fstart = await api("felipe", "/drive/start", {});
  ok(fstart.status === 403, "a non-owner can't start driving (" + fstart.status + ": " + (fstart.body && fstart.body.error) + ")");
  // Pass control to Maya, who is offline.
  await drv.page.keyboard.press("Escape");
  await sleep(200);
  await drv.page.getByRole("button", { name: "Pass control" }).click();
  await drv.page.getByRole("menuitem", { name: "Maya" }).click();
  await sleep(500);
  const alert = await drv.page.locator(".drive-note").innerText().catch(() => "");
  ok(/Maya/.test(alert) && /isn't in the room/.test(alert), "passing to someone offline says so: " + alert);
  // Pass control to Felipe.
  await drv.page.getByRole("menuitem", { name: "Felipe" }).click();
  await sleep(800);
  ok((await fel.page.locator(".drive-surface").count()) === 1, "Felipe gets the trackpad when Chey passes control");
  ok((await drv.page.locator(".drive-surface").count()) === 0, "and Chey's trackpad goes away");
  const cdeny = await wsSend(drv.page, { k: "move", x: 0.3, y: 0.3 });
  ok(cdeny.some((m) => m.type === "drive-denied"), "Chey's window is refused after passing control");
  // Felipe drives: his own tag.
  const fsb = await fel.page.locator(".drive-surface").boundingBox();
  await fel.page.mouse.click(fsb.x + 120, fsb.y + 120);
  await sleep(200);
  await fel.page.mouse.move(fsb.x + 300, fsb.y + 250); await fel.page.mouse.move(fsb.x + 340, fsb.y + 270);
  await sleep(600);
  const tags = await host.page.locator(".drive-tag").allInnerTexts();
  ok(tags.includes("Felipe"), "the big screen draws Felipe's cursor: " + JSON.stringify(tags));
  // Chey takes it back and drives together.
  await drv.page.getByRole("button", { name: "Drive", exact: true }).click();
  await drv.page.getByRole("button", { name: "Drive together" }).click();
  await drv.page.getByRole("menuitem", { name: "Felipe" }).click();
  await sleep(600);
  await drv.page.waitForSelector(".drive-surface");
  const dsb = await drv.page.locator(".drive-surface").boundingBox();
  await drv.page.mouse.click(dsb.x + 100, dsb.y + 100);
  await drv.page.mouse.move(dsb.x + 200, dsb.y + 160); await drv.page.mouse.move(dsb.x + 260, dsb.y + 200);
  await fel.page.mouse.move(fsb.x + 420, fsb.y + 300); await fel.page.mouse.move(fsb.x + 470, fsb.y + 330);
  await sleep(700);
  const two = await host.page.evaluate(() => [...document.querySelectorAll(".drive-cursor")].filter((e) => e.style.opacity === "1").map((e) => e.querySelector(".drive-tag").textContent));
  ok(two.includes("Chey") && two.includes("Felipe"), "drive together: two cursors at once: " + JSON.stringify(two));
  await host.page.screenshot({ path: S + "s4-together.png" });
  // The lock moves: Felipe casts something, Chey's driving ends everywhere.
  await api("felipe", "/stage", { mode: "spotlight", items: [cfg.art], title: "Checkout again", personId: cfg.people.felipe });
  await sleep(800);
  ok((await drv.page.locator(".drive-surface").count()) === 0 && (await fel.page.locator(".drive-surface").count()) === 0, "a new cast takes the lock and everyone's trackpad goes away");
  const visible = await host.page.evaluate(() => [...document.querySelectorAll(".drive-cursor")].length);
  ok(visible === 0, "and their cursors leave the big screen");
  const stale = await wsSend(drv.page, { k: "move", x: 0.3, y: 0.3 });
  ok(stale.some((m) => m.type === "drive-denied"), "a stale driver's events are refused");
};
