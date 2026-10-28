import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session, weightForRole } from "../src/session";
import { Store } from "../src/store";
import { addressesBrain, compareCaption } from "../src/brain/brain";

const session = () => new Session(new Store(mkdtempSync(join(tmpdir(), "jam-lead-"))));

test("a name matches exactly first, and an ambiguous first name matches nobody", () => {
  const s = session();
  const lee = s.upsertPerson({ name: "Sam Lee" });
  const cho = s.upsertPerson({ name: "Sam Cho" });
  const alex = s.upsertPerson({ name: "Alex" });
  expect(s.personByName("sam cho")?.id).toBe(cho.id);
  expect(s.personByName("Sam Lee")?.id).toBe(lee.id);
  expect(s.personByName("Sam")).toBeUndefined();
  expect(s.personByName("Al")).toBeUndefined();
  expect(s.personByName("Alex")?.id).toBe(alex.id);
  expect(s.personByName("Ale")?.id).toBe(alex.id);
});

test("product designers don't weigh like managers", () => {
  expect(weightForRole("Product Designer")).toBe(1);
  expect(weightForRole("Product Manager")).toBe(2);
  expect(weightForRole("Head of Product")).toBe(3);
  expect(weightForRole("PM")).toBe(2);
});

test("language is a setting", () => {
  const s = session();
  expect(s.settings().language).toBe("en");
  s.updateSettings({ language: "auto" });
  expect(s.settings().language).toBe("auto");
});

test("two agents never share a name", () => {
  const s = session();
  const a = s.registerAgent({ ownerName: "Chey", harness: "claude-code", repo: "acme/web", cwd: "/w", machine: "m1", name: "Builder" }).agent;
  const b = s.registerAgent({ ownerName: "Dana", harness: "claude-code", repo: "acme/ios", cwd: "/i", machine: "m2", name: "Builder" }).agent;
  expect(a.name).toBe("Builder");
  expect(b.name).toBe("Builder 2");
  // Rejoining keeps the name it had.
  expect(s.registerAgent({ ownerName: "Dana", harness: "claude-code", repo: "acme/ios", cwd: "/i", machine: "m2" }).agent.name).toBe("Builder 2");
});

test("wake word: likely transcriptions count, talking about it doesn't", () => {
  for (const t of ["Hey jam session, bring up the nav", "Jamsey show me", "can you do that, JamSesh?", "JamSesh, has the build finished?"]) expect([t, addressesBrain(t, "JamSesh")]).toEqual([t, true]);
  for (const t of ["JamSesh is great", "the jam session was fun", "update the jamsesh skill"]) expect([t, addressesBrain(t, "JamSesh")]).toEqual([t, false]);
});

test("compare captions name the variants", () => {
  expect(compareCaption([{ variant: "A", agentName: "Sam's Claude" }, { variant: "B", agentName: "Sam's Claude" }, { variant: "C" }])).toBe("3 directions: A, B and C, from Sam's Claude");
  expect(compareCaption([{ variant: "A" }, { variant: "B" }])).toBe("2 directions: A and B");
});
