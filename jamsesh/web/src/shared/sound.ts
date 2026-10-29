// A soft two-note chime, synthesized (no audio files): "heard you".
import { useSyncExternalStore } from "react";
import { hub } from "./hub";

let ctx: AudioContext | null = null;

/** The hub runs silent (JAMSESH_SILENT=1): nothing in the page may make a sound. */
export function roomSilent(state: { session?: { silent?: boolean } } | null | undefined) {
  return !!state?.session?.silent;
}

/** True when this page may play sound right now. */
export function soundAllowed() {
  return !roomSilent(hub.snap.state);
}

/** The same, as a hook: a component re-renders when the room goes silent or not. */
export function useSilent() {
  return roomSilent(useSyncExternalStore(hub.subscribe, hub.get, hub.get).state);
}

/**
 * A spoken clip (the brain's reply, a voice sample). In a silent room there is none: the element is
 * never made, so nothing can play, and the caller treats null as "didn't play".
 */
export function clip(mime: string, audio: string, make: (src: string) => HTMLAudioElement = (src) => new Audio(src)) {
  if (!soundAllowed()) return null;
  const a = make(`data:${mime};base64,${audio}`);
  clips.add(a);
  return a;
}

/** Clips made and not yet stopped, so a room that turns silent (a reconnect to a silent hub) can stop them. */
const clips = new Set<{ pause(): void }>();

/** Stops everything this page is playing: clips already going, and the chime's audio context. */
export function stopAllSound() {
  for (const a of clips) {
    try {
      a.pause();
    } catch {
      // already gone
    }
  }
  clips.clear();
  void ctx?.suspend?.().catch?.(() => {});
}

// The moment the hub says the room is silent, whatever was playing stops.
hub.subscribe(() => {
  if (!soundAllowed()) stopAllSound();
});

/**
 * Pages inside the app (a scripted HTML tile, a custom stage) can make sound on their own. In a silent room
 * they get no scripts, no media and no plugins: the document is still drawn, but it can't play anything.
 */
export const QUIET_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob: http: https:; font-src data:; media-src 'none'; script-src 'none'; object-src 'none'; frame-src 'none'";

export function htmlFrame(silent: boolean, doc: string): { srcDoc: string; sandbox: string } {
  if (!silent) return { srcDoc: doc, sandbox: "allow-scripts" };
  const meta = `<meta http-equiv="Content-Security-Policy" content="${QUIET_CSP}">`;
  const at = doc.search(/<!doctype html>/i);
  const srcDoc = at === 0 ? doc.replace(/^<!doctype html>/i, (m) => m + meta) : meta + doc;
  return { srcDoc, sandbox: "" };
}

/** A shared screen or camera carries no audio (it is captured without any), and a silent room drops any that arrives. */
export function dropAudio(stream: { getAudioTracks(): { enabled: boolean; stop(): void }[] }, silent = !soundAllowed()) {
  if (!silent) return;
  for (const t of stream.getAudioTracks()) {
    t.enabled = false;
    t.stop();
  }
}

export function playChime() {
  if (!soundAllowed()) return;
  try {
    ctx ??= new AudioContext();
    const t = ctx.currentTime + 0.01;
    for (const [i, f] of [660, 990].entries()) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = f;
      const start = t + i * 0.09;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.09, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.4);
    }
  } catch {
    // No audio output available; the toast still shows.
  }
}

/** Fades an element's audio out quickly (someone started talking over it). */
export function fadeOut(el: HTMLAudioElement, ms = 250) {
  const start = el.volume;
  const t0 = performance.now();
  const step = () => {
    const k = Math.min(1, (performance.now() - t0) / ms);
    el.volume = start * (1 - k);
    if (k < 1) requestAnimationFrame(step);
    else el.pause();
  };
  requestAnimationFrame(step);
}
