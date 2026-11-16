// A chat whose local MCP server restarted joins again under a new transport id (`mcp:<session>`): it is the
// same agent, not a second one with a suffix. A live chat in the same folder, and a chat with its own id, are
// not taken over.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "../src/session";
import { Store } from "../src/store";

const fresh = () => new Session(new Store(mkdtempSync(join(tmpdir(), "jam-rejoin-"))));
const join_ = (s: Session, chatId: string | undefined, over: Record<string, unknown> = {}) =>
  s.registerAgent({ ownerName: "Chey", harness: "claude-code", repo: "jamsesh", branch: "main", cwd: "/work/jamsesh", machine: "host", platform: "web", chatId, ...over });
/** The agent has been quiet for `ms`. */
const quiet = (s: Session, id: string, ms: number) => s.store.put("agents", { ...s.agent(id)!, lastSeen: Date.now() - ms });

describe("rejoining after the MCP connection restarted", () => {
  test("a quiet agent under a new transport id is resumed: same id and name, no duplicate", () => {
    const s = fresh();
    const first = join_(s, "mcp:old").agent;
    quiet(s, first.id, 5 * 60_000);
    const again = join_(s, "mcp:new");
    expect(again.resumed).toBe(true);
    expect(again.agent.id).toBe(first.id);
    expect(again.agent.name).toBe(first.name);
    expect(again.agent.chatId).toBe("mcp:new");
    expect(s.agents()).toHaveLength(1);
  });

  test("a chat that is still live in another connection stays its own agent: two chats, one folder", () => {
    const s = fresh();
    const a = join_(s, "mcp:one").agent;
    const b = join_(s, "mcp:two");
    expect(b.resumed).toBe(false);
    expect(b.agent.id).not.toBe(a.id);
    expect(s.agents()).toHaveLength(2);
    expect(s.agent(a.id)!.chatId).toBe("mcp:one");
  });

  test("another folder, owner or harness is never taken over", () => {
    const s = fresh();
    const a = join_(s, "mcp:old").agent;
    quiet(s, a.id, 5 * 60_000);
    expect(join_(s, "mcp:x", { cwd: "/work/other" }).agent.id).not.toBe(a.id);
    expect(join_(s, "mcp:y", { ownerName: "Felipe" }).agent.id).not.toBe(a.id);
    expect(join_(s, "mcp:z", { harness: "codex" }).agent.id).not.toBe(a.id);
  });

  test("a chat with its own id behaves as before: it keeps its own record, and a named chat is never inherited", () => {
    const s = fresh();
    const named = join_(s, "chat-a").agent;
    quiet(s, named.id, 5 * 60_000);
    // A transport join does not take over a chat that names itself.
    expect(join_(s, "mcp:new").agent.id).not.toBe(named.id);
    // The named chat resumes by its own id, and a different named chat is a new agent.
    expect(join_(s, "chat-a").agent.id).toBe(named.id);
    expect(join_(s, "chat-b").agent.id).not.toBe(named.id);
    // A named chat never takes a transport chat's record either.
    const t = join_(s, "mcp:t", { cwd: "/work/t" }).agent;
    quiet(s, t.id, 5 * 60_000);
    expect(join_(s, "chat-c", { cwd: "/work/t" }).agent.id).not.toBe(t.id);
  });

  test("a removed chat stays removed: its folder is still blocked for a new transport id", () => {
    const s = fresh();
    const a = join_(s, "mcp:old").agent;
    s.removeAgent(a.id);
    expect(s.agent(a.id)).toBeUndefined();
    expect(s.rejoinBlocked("mcp:new", null, { machine: "host", cwd: "/work/jamsesh", harness: "claude-code" })).toBeDefined();
  });
});
