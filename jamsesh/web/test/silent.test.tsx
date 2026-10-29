// A silent room (the hub runs with JAMSESH_SILENT=1) plays nothing in any page: not the brain's voice, not a
// voice sample, not the chime, and nothing a frame inside the page could play.
import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

(globalThis as any).location ??= { origin: "http://127.0.0.1:4790", pathname: "/client", search: "" };
(globalThis as any).navigator ??= {};
const { hub } = await import("../src/shared/hub");
const { clip, dropAudio, htmlFrame, playChime, roomSilent, soundAllowed, stopAllSound, forgetChimeContext, QUIET_CSP } = await import("../src/shared/sound");
const { CanvasFrame, ScaledFrame } = await import("../src/shared/ui");
const { HtmlTile } = await import("../src/host/Stage");

const was = hub.snap.state;
const setSilent = (silent: boolean) => (hub.snap.state = { session: { silent, canvas: { status: "starting", reason: "" } }, devservers: [] } as any);
afterEach(() => {
  hub.snap.state = was;
  delete (globalThis as any).AudioContext;
});

test("the page reads silent from the hub's session state", () => {
  expect(roomSilent(null)).toBe(false);
  expect(roomSilent({ session: { silent: false } })).toBe(false);
  expect(roomSilent({ session: { silent: true } })).toBe(true);
  setSilent(true);
  expect(soundAllowed()).toBe(false);
  setSilent(false);
  expect(soundAllowed()).toBe(true);
});

test("a spoken clip is never made in a silent room, so the host, client and voice sample have nothing to play", () => {
  const made: string[] = [];
  const make = (src: string) => (made.push(src), {} as HTMLAudioElement);
  setSilent(true);
  expect(clip("audio/mpeg", "AAAA", make)).toBeNull();
  expect(made).toEqual([]);
  setSilent(false);
  expect(clip("audio/mpeg", "AAAA", make)).not.toBeNull();
  expect(made).toEqual(["data:audio/mpeg;base64,AAAA"]);
});

test("a clip already playing stops the moment the hub says the room is silent", () => {
  const paused: string[] = [];
  const make = (src: string) => ({ pause: () => paused.push(src) }) as unknown as HTMLAudioElement;
  setSilent(false);
  clip("audio/mpeg", "ONE", make);
  clip("audio/mpeg", "TWO", make);
  expect(paused).toEqual([]);
  // The hub (re)connects and its state now says silent.
  (hub as any).set({ state: { session: { silent: true }, devservers: [] } });
  expect(paused.sort()).toEqual(["data:audio/mpeg;base64,ONE", "data:audio/mpeg;base64,TWO"]);
  // Nothing is left to stop twice.
  stopAllSound();
  expect(paused.length).toBe(2);
});

test("a clip stops when the connection drops, since the hub may come back silent", () => {
  let paused = 0;
  const a = { pause: () => paused++, addEventListener() {} } as unknown as HTMLAudioElement;
  setSilent(false);
  clip("audio/mpeg", "Z", () => a);
  (hub as any).set({ status: "connecting" });
  expect(paused).toBe(1);
  (hub as any).set({ status: "connected" });
});

test("a clip that has ended, been paused or failed is forgotten, so a long session doesn't keep every one", () => {
  for (const ev of ["ended", "pause", "error"]) {
    const handlers = new Map<string, () => void>();
    let paused = 0;
    const a = { pause: () => paused++, addEventListener: (e: string, f: () => void) => handlers.set(e, f) } as unknown as HTMLAudioElement;
    setSilent(false);
    clip("audio/mpeg", "X", () => a);
    handlers.get(ev)?.();
    stopAllSound();
    expect(paused, ev).toBe(0);
  }
});

test("a clip the browser refuses to play is forgotten too", async () => {
  let paused = 0;
  const a = { pause: () => paused++, play: () => Promise.reject(new Error("NotAllowedError")), addEventListener() {} } as unknown as HTMLAudioElement;
  setSilent(false);
  const c = clip("audio/mpeg", "Y", () => a)!;
  await c.play().catch(() => {});
  stopAllSound();
  expect(paused).toBe(0);
});

test("a chime makes no audio context at all in a silent room, and does in a normal one", () => {
  let made = 0;
  (globalThis as any).AudioContext = class {
    currentTime = 0;
    destination = {};
    constructor() {
      made++;
    }
    createOscillator() {
      return { frequency: {}, connect: () => ({ connect: () => {} }), start() {}, stop() {} };
    }
    createGain() {
      return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: () => ({ connect: () => {} }) };
    }
  };
  setSilent(true);
  playChime();
  expect(made).toBe(0);
  setSilent(false);
  playChime();
  expect(made).toBe(1);
});

test("a live page frame is not loaded in a silent room (a page in a frame can't be muted from here), and is otherwise", () => {
  setSilent(true);
  const quiet = renderToStaticMarkup(<ScaledFrame src="http://localhost:5100/" title="Demo app" />);
  expect(quiet).not.toContain("<iframe");
  expect(quiet).toContain("data-quiet-frame");
  expect(quiet).toContain("Demo app");
  setSilent(false);
  expect(renderToStaticMarkup(<ScaledFrame src="http://localhost:5100/" title="Demo app" />)).toContain("<iframe");
});

test("the silent document keeps its doctype first (no quirks mode) and its policy blocks scripts and media", () => {
  const f = htmlFrame(true, "<!doctype html><html><body>hi</body></html>");
  expect(f.srcDoc.startsWith("<!doctype html><meta http-equiv=")).toBe(true);
  expect(f.sandbox).toBe("");
  expect(QUIET_CSP).toContain("script-src 'none'");
  expect(QUIET_CSP).toContain("media-src 'none'");
  expect(htmlFrame(true, "<p>no doctype</p>").srcDoc.startsWith("<meta")).toBe(true);
  expect(htmlFrame(false, "<p>x</p>")).toEqual({ srcDoc: "<p>x</p>", sandbox: "allow-scripts" });
});

test("a silent room drops any audio track that arrives on a shared screen", () => {
  const track = () => ({ enabled: true, stopped: false, stop() { this.stopped = true; } });
  const a = track();
  const stream = { getAudioTracks: () => [a] };
  dropAudio(stream, false);
  expect(a.enabled).toBe(true);
  dropAudio(stream, true);
  expect([a.enabled, a.stopped]).toEqual([false, true]);
});

test("the live canvas is not mounted in a silent room, and is otherwise", () => {
  setSilent(true);
  const quiet = renderToStaticMarkup(<CanvasFrame kind="view" title="Live canvas" />);
  expect(quiet).not.toContain("<iframe");
  expect(quiet).toContain("data-quiet-frame");
  setSilent(false);
  // Not silent: the live canvas component runs (it has nothing to show without a link, but it isn't the quiet card).
  expect(renderToStaticMarkup(<CanvasFrame kind="view" title="Live canvas" />)).not.toContain("data-quiet-frame");
});

test("when the room turns silent the chime's audio context is closed, so no old chime plays when sound is back", () => {
  const made: { closed: boolean }[] = [];
  (globalThis as any).AudioContext = class {
    currentTime = 0;
    destination = {};
    closed = false;
    constructor() {
      made.push(this);
    }
    close() {
      this.closed = true;
      return Promise.resolve();
    }
    createOscillator() {
      return { frequency: {}, connect: () => ({ connect: () => {} }), start() {}, stop() {} };
    }
    createGain() {
      return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: () => ({ connect: () => {} }) };
    }
  };
  forgetChimeContext();
  setSilent(false);
  playChime();
  expect(made.length).toBe(1);
  (hub as any).set({ state: { session: { silent: true, canvas: { status: "starting", reason: "" } }, devservers: [] } });
  expect(made[0].closed).toBe(true);
  setSilent(false);
  playChime();
  // A fresh context, not the old one with its unfinished notes.
  expect(made.length).toBe(2);
  expect(made[1].closed).toBe(false);
});

// The real thing, in a real browser (muted): each production frame, flipped from a normal room to a silent one.
for (const which of ["frame", "tile", "custom"]) {
  test(`in a browser, the mounted ${which} stops running and goes inert when the room turns silent`, async () => {
    const pw = require(`${(await import("node:child_process")).execSync("npm root -g").toString().trim()}/playwright`);
    const built = await Bun.build({ entrypoints: [`${import.meta.dir}/browser-entry.tsx`], target: "browser" });
    expect(built.success).toBe(true);
    const code = await built.outputs[0].text();
    // A page that makes sound would be running a script: this one reports a heartbeat, has a navigating link and a video.
    const doc = `<script>setInterval(()=>parent.postMessage("tick","*"),40)</script><a href="data:text/html,<audio autoplay src=x.mp3></audio>" target="_self" style="display:block;padding:40px">play</a><video autoplay src="http://127.0.0.1:9/x.mp4"></video>`;
    const run = async (silent: boolean) => {
      const browser = await pw.chromium.launch({ args: ["--mute-audio"] });
      try {
        const page = await browser.newPage();
        const requested: string[] = [];
        page.on("request", (r: any) => requested.push(r.url()));
        await page.setContent(`<body style="margin:0"><div id="root"></div><script>window.__ticks=0;addEventListener("message",e=>{if(e.data==="tick")window.__ticks++});window.__which=${JSON.stringify(which)};window.__doc=${JSON.stringify(doc).replace(/</g, "\\u003c")}</script><script>${code.replace(/<\/script/g, "<\\/script")}</script></body>`);
        await page.waitForSelector("iframe");
        await page.waitForFunction(() => (window as any).__ticks > 3);
        if (silent) {
          await page.evaluate(() => (window as any).setSilent(true));
          await page.waitForFunction(() => document.querySelector("iframe")?.hasAttribute("inert"));
        }
        // The old page is gone the moment the room is silent: its heartbeat stops (in a normal room it keeps going).
        const before = await page.evaluate(() => (window as any).__ticks);
        requested.length = 0;
        await page.waitForTimeout(400);
        const after = await page.evaluate(() => (window as any).__ticks);
        const frame = page.frames().find((f: any) => f !== page.mainFrame());
        const box = await frame.locator("a").boundingBox();
        await page.mouse.click(box.x + 20, box.y + 20);
        await page.waitForTimeout(300);
        return { running: after > before, url: frame.url(), media: requested.filter((u) => u.includes("x.mp4") || u.includes("x.mp3")) };
      } finally {
        await browser.close();
      }
    };
    // Control: in a normal room the page runs and its link does navigate the frame, so this test could fail.
    const loud = await run(false);
    expect(loud.running).toBe(true);
    expect(loud.url).not.toBe("about:srcdoc");
    const quiet = await run(true);
    expect(quiet.running).toBe(false);
    expect(quiet.url).toBe("about:srcdoc");
    expect(quiet.media).toEqual([]);
  }, 60000);
}
