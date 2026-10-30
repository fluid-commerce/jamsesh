import { expect, test } from "bun:test";
import { BARGE_MARGIN_DB, isEchoSegment, Mic } from "../src/shared/mic";

test("the brain's echo is dropped, a close voice over it is not", () => {
  expect(isEchoSegment(-40, -60, true)).toBe(true);
  expect(isEchoSegment(-60 + BARGE_MARGIN_DB + 3, -60, true)).toBe(false);
  expect(isEchoSegment(-50, -60, false)).toBe(false);
});

test("a mic switched off while its permission prompt is open is let go when the answer comes, not kept on", async () => {
  let release!: (s: unknown) => void;
  let stopped = 0;
  const track = { stop: () => stopped++ };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: { getUserMedia: () => new Promise((r) => (release = r)) } } });
  const mic = new Mic("dev");
  const on = mic.ensureOn();
  mic.stop();
  release({ getTracks: () => [track], getAudioTracks: () => [track] });
  expect(await on).toBe(false);
  expect(stopped).toBe(1);
  expect(mic.status.on).toBe(false);
});

test("the mic is lent to recordings: switched on if it was off, off again a moment after the last borrower, kept on for a borrower who comes in that moment, and never switched off if the person had it on", async () => {
  const mk = (on: boolean) => {
    const mic: any = new Mic("dev");
    mic.status = { ...mic.status, on };
    mic.ensureOn = async () => ((mic.status = { ...mic.status, on: true }), true);
    let stops = 0;
    mic.stop = () => (stops++, (mic.status = { ...mic.status, on: false }));
    return { mic: mic as Mic, stops: () => stops };
  };
  const a = mk(false);
  const one = await a.mic.lend();
  expect(one?.turnedOn).toBe(true);
  one!.release();
  one!.release();
  // Another recording starts inside the moment before the mute: it takes the mic over, and nothing is muted under it.
  const two = await a.mic.lend();
  await Bun.sleep(1800);
  expect(a.stops()).toBe(0);
  two!.release();
  await Bun.sleep(1800);
  expect(a.stops()).toBe(1);
  // A mic the person had on is theirs: lending it never turns it off.
  const b = mk(true);
  const mine = await b.mic.lend();
  expect(mine?.turnedOn).toBe(false);
  mine!.release();
  await Bun.sleep(1800);
  expect(b.stops()).toBe(0);
  // A mic that can't be switched on lends nothing.
  const c = mk(false);
  (c.mic as any).ensureOn = async () => false;
  expect(await c.mic.lend()).toBeNull();
}, 20_000);

test("the person's own mute and unmute win over a loan's pending mute", async () => {
  const mic: any = new Mic("dev");
  let opens = 0;
  mic.open = async () => (opens++, (mic.status = { ...mic.status, on: true }));
  const stopsBefore = () => (mic.status.on ? 0 : 1);
  const loan = await mic.lend();
  expect(loan.turnedOn).toBe(true);
  loan.release();
  // Muted by hand and switched back on by hand inside the loan's last moment: the mic is theirs now, and the timer must not mute it.
  mic.stop();
  await mic.start();
  expect(mic.status.on).toBe(true);
  await Bun.sleep(1800);
  expect(mic.status.on).toBe(true);
  expect(opens).toBe(2);
  expect(stopsBefore()).toBe(0);
}, 20_000);

test("a loan still switching the mic on when the person starts it by hand does not claim it: releasing the loan leaves their mic on", async () => {
  const mic: any = new Mic("dev");
  let finishOpen!: () => void;
  mic.open = () => new Promise<void>((r) => (finishOpen = () => (mic.status = { ...mic.status, on: true }, r())));
  const lending = mic.lend();
  // The person starts the mic themselves while the loan's start is unresolved (deferred open).
  const manual = mic.start();
  finishOpen();
  await manual;
  const loan = await lending;
  expect(loan.turnedOn).toBe(false);
  loan.release();
  await Bun.sleep(1800);
  expect(mic.status.on).toBe(true);
}, 20_000);
