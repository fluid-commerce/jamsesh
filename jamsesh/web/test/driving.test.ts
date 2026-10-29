import { expect, test } from "bun:test";
import { glide, textOn } from "../src/host/DriveLayer";
import { keyAction, travel } from "../src/shared/DriveSurface";
import { driveScale, driverState, targetAt, registerDriveTarget, anyoneDriving } from "../src/shared/driving";

test("the dart's tag text is black on a light colour and white on a dark one (live.rs text_on)", () => {
  expect(textOn("#ffd54a")).toBe("#1e1e1e");
  expect(textOn("#3b82f6")).toBe("#fff");
  expect(textOn("nonsense")).toBe("#fff");
});

test("the glide covers 1 - exp(-20 dt) of the way and jumps with Reduce Motion", () => {
  expect(glide(0, 100, 0.05, false)).toBeCloseTo(100 * (1 - Math.exp(-1)), 5);
  expect(glide(0, 100, 5, false)).toBeCloseTo(100 * (1 - Math.exp(-2)), 5); // dt is capped at 0.1 s
  expect(glide(0, 100, 0.01, true)).toBe(100);
});

test("trackpad motion moves the dart a stage-width fraction and stops at the edges", () => {
  expect(travel({ x: 0.5, y: 0.5 }, 90, 0, 1200, 675).x).toBeCloseTo(0.5 + 90 / 1200);
  expect(travel({ x: 0.5, y: 0.5 }, 90, 0, 450, 250).x).toBeCloseTo(0.6); // a small mirror still travels like 900 px
  expect(travel({ x: 0.1, y: 0.1 }, -9999, -9999, 1200, 675)).toEqual({ x: 0, y: 0 });
});

test("driver state reads the lock; nobody is driving without one", () => {
  const people = [{ id: "a", name: "Chey" }, { id: "b", name: "Felipe" }] as any;
  const state = { people, screens: [], stage: { lock: { by: "Chey", personId: "a", drivers: ["b"] } } } as any;
  const d = driverState("main", state, "b");
  expect(d.owner?.name).toBe("Chey");
  expect(d.drivers.map((p) => p.name)).toEqual(["Felipe"]);
  expect(d.me).toEqual({ id: "b", isOwner: false, driving: true });
  expect(driverState("main", { ...state, stage: {} }, "a").me.driving).toBe(false);
  expect(anyoneDriving(state)).toBe(true);
  expect(anyoneDriving({ ...state, stage: {} })).toBe(false);
});

test("the smallest registered tile under a point takes the input", () => {
  const box = (r: { left: number; top: number; width: number; height: number }) => ({ isConnected: true, getBoundingClientRect: () => ({ ...r, right: r.left + r.width, bottom: r.top + r.height }) }) as any;
  const root = { contains: () => true } as any;
  const big = box({ left: 0, top: 0, width: 100, height: 100 });
  const small = box({ left: 10, top: 10, width: 20, height: 20 });
  const offs = [registerDriveTarget(big, () => {}), registerDriveTarget(small, () => {})];
  expect(targetAt(root, 15, 15)?.el).toBe(small);
  expect(targetAt(root, 60, 60)?.el).toBe(big);
  expect(targetAt(root, 500, 500)).toBeNull();
  offs.forEach((f) => f());
});

test("the dart is 2x at a 1920 stage on the big screen, never below 1x or above 3x, and 1x in an app", () => {
  expect(driveScale(1920, true)).toBe(2);
  expect(driveScale(1000, true)).toBeCloseTo(1.04, 2);
  expect(driveScale(400, true)).toBe(1);
  expect(driveScale(7680, true)).toBe(3);
  expect(driveScale(1920, false)).toBe(1);
});

test("trackpad keys go to the big screen only while the trackpad has the keyboard", () => {
  const k = (key: string, over: Partial<KeyboardEvent> = {}) => ({ key, code: `Key${key.toUpperCase()}`, type: "keydown", repeat: false, altKey: false, shiftKey: false, ctrlKey: false, metaKey: false, ...over }) as KeyboardEvent;
  const captured = { locked: false, captured: true };
  expect(keyAction(k("a"), captured, true)).toMatchObject({ k: "key", key: "a", down: true });
  // Captured, but another field (a chat box, a note) has the keyboard: the key stays there.
  expect(keyAction(k("a"), captured, false)).toBeNull();
  expect(keyAction(k("a"), { locked: true, captured: true }, false)).toBeNull();
  // Not captured at all: nothing is taken.
  expect(keyAction(k("a"), { locked: false, captured: false }, true)).toBeNull();
  // Esc lets go (without pointer lock), Option+R stays for Record, a held letter's repeats are dropped but a held arrow repeats.
  expect(keyAction(k("Escape"), captured, true)).toBe("release");
  expect(keyAction(k("r", { altKey: true, code: "KeyR" }), captured, true)).toBeNull();
  expect(keyAction(k("Shift", { repeat: true }), captured, true)).toBe("swallow");
  expect(keyAction(k("ArrowDown", { repeat: true }), captured, true)).toMatchObject({ key: "ArrowDown" });
});
