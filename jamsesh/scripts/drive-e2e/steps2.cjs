module.exports = async ({ mk, api, cfg, hubUrl, ok, log, sleep, browser }) => {
  const S = "/tmp/claude-501/p6cursor/";
  const host = await mk("host");
  await host.page.goto(`http://127.0.0.1:${cfg.port}/host`);
  const drv = await mk("chey");
  // Pointer Lock isn't available in headless Chromium: stand in for it so the relative-motion path runs.
  await drv.ctx.addInitScript(() => {
    HTMLElement.prototype.requestPointerLock = function () { Object.defineProperty(document, "pointerLockElement", { configurable: true, get: () => this }); document.dispatchEvent(new Event("pointerlockchange")); return Promise.resolve(); };
    document.exitPointerLock = () => { Object.defineProperty(document, "pointerLockElement", { configurable: true, get: () => null }); document.dispatchEvent(new Event("pointerlockchange")); };
  });
  await drv.page.goto(`${hubUrl}/client`);
  await sleep(3000);
  await api("chey", "/stage", { mode: "canvas", title: "Canvas", personId: cfg.people.chey });
  await sleep(4000);
  const cf = () => host.page.frames().find((f) => /canvas|figcraft/i.test(f.url()) && f !== host.page.mainFrame());
  log("  frames:", host.page.frames().map((f) => f.url().slice(0, 80)).join(" | "));
  await host.page.screenshot({ path: S + "c1-canvas.png" });
  const fc = (cmd, p) => host.page.evaluate(([cmd, p]) => { const w = document.querySelector("iframe").contentWindow; return w.figcraft.execute(cmd, p); }, [cmd, p]);
  // The big screen's canvas is view-only; the rectangle is made from the driver's own editable canvas and syncs over.
  const rect = await drv.page.evaluate(() => { const f = document.querySelector("[data-jam-target*='\"canvas\"'] iframe"); return f.contentWindow.figcraft.execute("shape.rectangle", { x: 100, y: 100, width: 300, height: 200 }); }).catch((e) => "ERR " + e);
  await sleep(1500);
  log("  rect:", JSON.stringify(rect).slice(0, 120));
  await sleep(500);
  const view0 = await fc("view.get", {});
  const nodes = await fc("select.layersAt", { x: 250, y: 200 }).catch((e) => "ERR " + e);
  log("  layersAt(250,200) on the big screen:", JSON.stringify(nodes).slice(0, 160));
  log("  view0:", JSON.stringify(view0));
  await drv.page.getByRole("button", { name: "Drive", exact: true }).click();
  await drv.page.waitForSelector(".drive-surface");
  const surf = drv.page.locator(".drive-surface");
  const sb = await surf.boundingBox();
  await drv.page.mouse.click(sb.x + 50, sb.y + 50);
  await sleep(200);
  const locked = await drv.page.evaluate(() => !!document.pointerLockElement);
  ok(locked, "the stand-in pointer lock is held: relative motion path");
  // Relative motion: events with movementX/Y (the surface turns them into stage fractions).
  const mv = (dx, dy) => drv.page.evaluate(([dx, dy]) => document.querySelector(".drive-surface").dispatchEvent(new PointerEvent("pointermove", { bubbles: true, movementX: dx, movementY: dy, pointerType: "mouse" })), [dx, dy]);
  const pos = () => { const m = drv.frames.sent.filter((f) => f.m.ev && f.m.ev.x !== undefined).at(-1); return m.m.ev; };
  const a = pos();
  await mv(90, 0); await sleep(150);
  log('  sent tail:', JSON.stringify(drv.frames.sent.slice(-4).map((f) => f.m.ev)));
  const b = pos();
  ok(Math.abs(b.x - a.x - 0.1) < 0.02 && Math.abs(b.y - a.y) < 1e-6, `90 px of trackpad moves the dart a tenth of a 900 px stage: ${a.x.toFixed(3)} -> ${b.x.toFixed(3)}`);
  await mv(-5000, -5000); await sleep(200);
  const c = pos();
  ok(c.x === 0 && c.y === 0, "the dart stops at the stage's edge");
  // Park the dart over the rectangle on the canvas, in the relative mode.
  const cv = await host.page.evaluate(() => { const f = document.querySelector("iframe"); const r = f.getBoundingClientRect(); const b = document.querySelector(".stage-body").getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height, bx: b.left, by: b.top, bw: b.width, bh: b.height }; });
  const view = view0;
  const toStage = (px, py) => { const fx = (px - view.cx) * view.zoom / view.vw + 0.5, fy = (py - view.cy) * view.zoom / view.vh + 0.5; return { x: (cv.l + fx * cv.w - cv.bx) / cv.bw, y: (cv.t + fy * cv.h - cv.by) / cv.bh }; };
  const goto = async (t) => { for (let i = 0; i < 30; i++) { const p = pos(); const dx = t.x - p.x, dy = t.y - p.y; if (Math.abs(dx) < 0.003 && Math.abs(dy) < 0.003) break; const r = await surf.boundingBox(); const vw = Math.max(r.width, 900); await mv(dx * vw, dy * vw * (r.height / r.width)); await sleep(40); } await sleep(300); };
  await goto(toStage(250, 200));
  await host.page.screenshot({ path: S + "c2-dart-over-canvas.png" });
  await drv.page.mouse.down(); await drv.page.mouse.up();
  await sleep(600);
  const insp = await host.page.evaluate(() => document.querySelector("iframe").contentWindow.figcraft.request("ui.inspect", {})).catch((e) => "ERR " + e);
  const selected = JSON.stringify(insp).match(/"selection":\[[^\]]*\]/)?.[0];
  log("  after the click, FigCraft says:", selected);
  ok(!!selected && selected !== '"selection":[]', "a click on the dart's spot selects the rectangle through FigCraft's own pointer");
  // Scroll pans.
  const c0 = await fc("view.get", {});
  for (let i = 0; i < 4; i++) { await drv.page.mouse.wheel(0, 100); await sleep(40); }
  await sleep(500);
  const c1 = await fc("view.get", {});
  ok(c1.cy > c0.cy + 50, `wheel pans the canvas: cy ${c0.cy.toFixed(0)} -> ${c1.cy.toFixed(0)}`);
  // ctrl-wheel zooms about the dart.
  for (let i = 0; i < 4; i++) { await drv.page.keyboard.down("Control"); await drv.page.mouse.wheel(0, -20); await drv.page.keyboard.up("Control"); await sleep(40); }
  await sleep(500);
  const c2 = await fc("view.get", {});
  ok(c2.zoom > c1.zoom * 1.1, `ctrl-wheel zooms in: ${c1.zoom.toFixed(2)} -> ${c2.zoom.toFixed(2)}`);
  // A drag pans.
  await drv.page.mouse.down();
  await mv(120, 60); await sleep(50); await mv(60, 30); await sleep(50);
  await drv.page.mouse.up();
  await sleep(500);
  const c3 = await fc("view.get", {});
  ok(Math.hypot(c3.cx - c2.cx, c3.cy - c2.cy) > 5, `a drag pans: centre moved ${Math.hypot(c3.cx - c2.cx, c3.cy - c2.cy).toFixed(1)}`);
  await host.page.screenshot({ path: S + "c3-after.png" });
};
