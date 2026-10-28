// Found live: after the Mac's identity changed, agents rejoined as "… 2" beside their own stale
// records, and a window labeled from a person's old name kept it after the person was renamed.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "../src/session";
import { Store } from "../src/store";

const fresh = () => new Session(new Store(mkdtempSync(join(tmpdir(), "jam-rejoin-"))));
// `sameMachine` stands in for the hub's check (auth.machineOf): dev-old was this Mac's earlier credential.
const join_ = (s: Session, machine: string, sameMachine?: (m: string) => boolean) =>
  s.registerAgent({ ownerName: "Chey", harness: "claude-code", repo: "jamsesh", cwd: "/Users/chey/jamsesh", machine, platform: "desktop", sameMachine });
const quiet = (s: Session, id: string, ms: number) => s.store.put("agents", { ...s.store.get("agents", id)!, lastSeen: Date.now() - ms });

test("a quiet agent coming back on a new credential of the same Mac takes over its own record", () => {
  const s = fresh();
  const first = join_(s, "dev-old").agent;
  quiet(s, first.id, 5 * 60_000);
  const again = join_(s, "dev-new", (m) => m === "dev-old");
  expect(again.resumed).toBe(true);
  expect(again.agent.id).toBe(first.id);
  expect(again.agent.name).toBe("Chey's Claude");
  expect(s.store.all("agents")).toHaveLength(1);
});

test("another Mac naming the same owner, harness and folder can't take a record that may still be live", () => {
  const s = fresh();
  const victim = join_(s, "mac-a").agent;
  // Busy for five minutes: quiet, but still live (the UI shows agents offline after 20).
  quiet(s, victim.id, 5 * 60_000);
  const thief = join_(s, "mac-b", (m) => m === "mac-b");
  expect(thief.resumed).toBe(false);
  expect(thief.agent.id).not.toBe(victim.id);
  expect(s.agent(victim.id)?.machine).toBe("mac-a");
});

test("a record gone long enough to show offline can be picked up from another credential", () => {
  const s = fresh();
  const old = join_(s, "mac-a").agent;
  quiet(s, old.id, 21 * 60_000);
  const back = join_(s, "mac-b", () => false);
  expect(back.resumed).toBe(true);
  expect(back.agent.id).toBe(old.id);
});

test("a live agent with the same folder on another Mac keeps its record", () => {
  const s = fresh();
  const live = join_(s, "mac-a").agent;
  const other = join_(s, "mac-b");
  expect(other.resumed).toBe(false);
  expect(other.agent.id).not.toBe(live.id);
});

test("a person's rename carries to their windows' labels", () => {
  const s = fresh();
  const p = s.upsertPerson({ name: "Felipe" });
  s.touchDevice("client-1", { label: "Felipe's laptop", personId: p.id });
  s.touchDevice("client-2", { label: "Studio iPad", personId: p.id });
  s.upsertPerson({ id: p.id, name: "Chey", role: "Designer" });
  expect(s.store.get("devices", "client-1")?.label).toBe("Chey's laptop");
  expect(s.store.get("devices", "client-2")?.label).toBe("Studio iPad");
});
