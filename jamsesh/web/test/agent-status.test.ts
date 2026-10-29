import { expect, test } from "bun:test";
import { openTasksFor, statusLine } from "../src/shared/ui";

const agent = (over: object) => ({ id: "a1", status: "idle", activity: "", ...over }) as any;

test("a finished agent reads Done until its next task", () => {
  expect(statusLine(agent({ activity: "Done: Header spacing fixed" }))).toBe("Done: Header spacing fixed");
  expect(statusLine(agent({ status: "working", activity: "Working on: the footer" }))).toBe("Working on: the footer");
  expect(statusLine(agent({ activity: "Idle" }))).toBe("Idle");
  expect(statusLine(agent({ status: "working", activity: "Editing the header" }))).toBe("Working · Editing the header");
  expect(statusLine(agent({ status: "offline", activity: "Done: x" }))).toBe("Offline");
});

test("open tasks are the ones the agent hasn't finished, oldest first", () => {
  const d = (id: string, ts: number, progress: string) => ({ id, ts, targets: ["a1"], status: progress, progress: { a1: progress } });
  const state = { directives: [d("d2", 20, "acked"), d("d1", 10, "pending"), d("d3", 5, "done"), d("d4", 1, "cancelled")] } as any;
  expect(openTasksFor(state, "a1").map((x) => x.id)).toEqual(["d1", "d2"]);
});
