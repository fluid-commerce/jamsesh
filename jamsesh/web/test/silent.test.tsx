import { afterEach, expect, test } from "bun:test";
import { hub } from "../src/shared/hub";
import { playChime, roomSilent, soundAllowed } from "../src/shared/sound";

const was = hub.snap.state;
afterEach(() => {
  hub.snap.state = was;
  delete (globalThis as any).AudioContext;
});

test("the page reads silent from the hub's session state", () => {
  expect(roomSilent(null)).toBe(false);
  expect(roomSilent({ session: { silent: false } })).toBe(false);
  expect(roomSilent({ session: { silent: true } })).toBe(true);
  hub.snap.state = { session: { silent: true } } as any;
  expect(soundAllowed()).toBe(false);
  hub.snap.state = { session: { silent: false } } as any;
  expect(soundAllowed()).toBe(true);
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
  hub.snap.state = { session: { silent: true } } as any;
  playChime();
  expect(made).toBe(0);
  hub.snap.state = { session: { silent: false } } as any;
  playChime();
  expect(made).toBe(1);
});
