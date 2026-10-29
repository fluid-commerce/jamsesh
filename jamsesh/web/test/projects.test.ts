import { expect, test } from "bun:test";
import { when } from "../src/projects/ProjectsView";

const now = new Date(2026, 5, 10, 15, 0, 0).getTime();
const at = (days: number, h = 9) => new Date(2026, 5, 10 - days, h, 5, 0).getTime();

test("dates read as the day people remember: today, yesterday, a weekday, then the date", () => {
  expect(when(at(0), now)).toStartWith("Today, ");
  expect(when(at(1), now)).toStartWith("Yesterday, ");
  expect(when(at(3), now)).toBe(new Date(at(3)).toLocaleDateString([], { weekday: "long" }));
  expect(when(at(20), now)).toBe(new Date(at(20)).toLocaleDateString([], { day: "numeric", month: "short" }));
  expect(when(new Date(2025, 2, 4).getTime(), now)).toContain("2025");
});

test("late last night is yesterday even when it was under 24 hours ago", () => {
  expect(when(new Date(2026, 5, 9, 23, 50).getTime(), new Date(2026, 5, 10, 0, 10).getTime())).toStartWith("Yesterday, ");
});
