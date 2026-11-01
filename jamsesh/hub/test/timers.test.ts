import { expect, test } from "bun:test";
import { Timers } from "../src/timers";

test("a callback that throws, rejects or finds the store sealed never escapes the timer", async () => {
  const t = new Timers();
  const seen: unknown[] = [];
  const catcher = (e: unknown) => void seen.push(e);
  process.on("uncaughtException", catcher);
  process.on("unhandledRejection", catcher);
  const logged: string[] = [];
  const { error, warn } = console;
  console.error = (...a: unknown[]) => void logged.push(`E ${a.join(" ")}`);
  console.warn = (...a: unknown[]) => void logged.push(`W ${a.join(" ")}`);
  try {
    t.after(() => { throw new Error("plain"); }, 1);
    t.after(async () => { throw Object.assign(new Error("closed"), { code: "ESEALED" }); }, 1);
    t.after(() => Promise.reject(new Error("late")), 1);
    await Bun.sleep(60);
  } finally {
    console.error = error;
    console.warn = warn;
    process.off("uncaughtException", catcher);
    process.off("unhandledRejection", catcher);
  }
  expect(seen).toEqual([]);
  expect(logged.filter((l) => l.startsWith("E")).length).toBe(2);
  expect(logged.some((l) => l.startsWith("W") && l.includes("closed"))).toBe(true);
  expect(t.size).toBe(0);
});

test("stop() ends pending and repeating timers and refuses new ones", async () => {
  const t = new Timers();
  let fired = 0;
  t.after(() => fired++, 20);
  t.every(() => fired++, 10);
  t.stop();
  expect(t.size).toBe(0);
  expect(t.after(() => fired++, 1)).toBeNull();
  expect(t.every(() => fired++, 1)).toBeNull();
  await Bun.sleep(80);
  expect(fired).toBe(0);
});

test("clear() removes one timer from the registry", () => {
  const t = new Timers();
  const a = t.after(() => {}, 10_000);
  expect(t.size).toBe(1);
  t.clear(a);
  expect(t.size).toBe(0);
  t.clear(null);
});
