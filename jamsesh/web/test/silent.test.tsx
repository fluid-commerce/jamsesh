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

test("a scripted HTML tile gets no scripts, no media and no plugins in a silent room", () => {
  const tile = `<video autoplay src="x.mp4"></video><script>new AudioContext()</script>`;
  setSilent(true);
  const quiet = renderToStaticMarkup(<HtmlTile html={tile} title="Tile" />);
  expect(quiet).toContain('sandbox=""');
  expect(quiet).toContain("Content-Security-Policy");
  expect(quiet).toContain("media-src");
  setSilent(false);
  const loud = renderToStaticMarkup(<HtmlTile html={tile} title="Tile" />);
  expect(loud).toContain('sandbox="allow-scripts"');
  expect(loud).not.toContain("Content-Security-Policy");
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

test("a silent tile is inert (no click or key reaches its links, even target=_self), sandboxed with nothing allowed; a normal one is interactive", () => {
  const tile = `<a href="https://example.com/song" target="_self">play</a>`;
  setSilent(true);
  const quiet = renderToStaticMarkup(<HtmlTile html={tile} title="Tile" />);
  expect(quiet).toMatch(/\sinert(=""|\s|>)/);
  expect(quiet).toContain('sandbox=""');
  expect(quiet).not.toContain("allow-popups");
  expect(quiet).not.toContain("allow-top-navigation");
  expect(quiet).not.toContain("allow-same-origin");
  expect(QUIET_CSP).toContain("form-action 'none'");
  setSilent(false);
  const loud = renderToStaticMarkup(<HtmlTile html={tile} title="Tile" />);
  expect(loud).not.toContain("inert");
});

test("the chime's audio context is suspended when the room turns silent and resumed when sound is back", () => {
  const calls: string[] = [];
  let state = "running";
  (globalThis as any).AudioContext = class {
    currentTime = 0;
    destination = {};
    get state() {
      return state;
    }
    suspend() {
      calls.push("suspend");
      state = "suspended";
      return Promise.resolve();
    }
    resume() {
      calls.push("resume");
      state = "running";
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
  (hub as any).set({ state: { session: { silent: true, canvas: { status: "starting", reason: "" } }, devservers: [] } });
  expect(calls).toContain("suspend");
  setSilent(false);
  playChime();
  expect(calls.at(-1)).toBe("resume");
});
