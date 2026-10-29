// A chat joins the room only when its person tells it to: installing writes nothing into CLAUDE.md or
// AGENTS.md, hooks do nothing for a chat that never called jam_join, and chats are told apart even in
// one folder. A wrongly joined agent can be removed, with what it caused.
import { afterAll, describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../src/hub";
import { OLD_BLOCKS, FIND_BLOCK_PL, hookScript, joinScript } from "../src/install-scripts";
import { Session } from "../src/session";
import { Store } from "../src/store";

const tmp = () => mkdtempSync(join(tmpdir(), "jam-join-"));
// The blocks earlier installs wrote, exactly: the longer one, then the first.
const [LONG, SHORT] = OLD_BLOCKS;
const block = (b: string) => `${b}\n`;
const BLOCK = block(LONG);

/** Runs the finder on a file; returns what it said and whether the file is byte for byte as it was. */
async function find(content: string | null, link = false) {
  const d = tmp();
  const file = join(d, "AGENTS.md");
  let given = file;
  if (content !== null) writeFileSync(file, content, { mode: 0o640 });
  if (link) symlinkSync(file, (given = join(d, "CLAUDE.md")));
  const before = readdirSync(d).map((n) => [n, lstatSync(join(d, n)).mtimeMs]);
  const proc = Bun.spawn(["perl", "-", given], { stdin: new Blob([FIND_BLOCK_PL]), stderr: "pipe" });
  expect(await proc.exited).toBe(0);
  const said = await new Response(proc.stderr).text();
  // It never writes: same files, same times, same bytes.
  expect(readdirSync(d).map((n) => [n, lstatSync(join(d, n)).mtimeMs])).toEqual(before);
  if (content !== null) expect(readFileSync(file, "utf8")).toBe(content);
  return said;
}

describe("telling the person where the block an earlier install wrote is", () => {
  test("a file with no block gets no message, and neither does a missing one", async () => {
    expect(await find("# Mine\r\nkeep   \r\n\r\n\r\n")).toBe("");
    expect(await find(null)).toBe("");
  });
  test("a block names its lines and how to remove it, and the file is untouched", async () => {
    const said = await find(`# Mine\n\nrules\n\n${BLOCK}`);
    const n = LONG.split("\n").length;
    expect(said).toContain(`(lines 5-${5 + n - 1})`);
    expect(said).toContain("until you delete those lines");
    expect(said).toContain("can still make a chat join the room by itself");
    expect(said.trim().split("\n")).toHaveLength(1);
  });
  test("CRLF files, a block at the very start, and one with no final newline", async () => {
    expect(await find(`# Mine\r\n${BLOCK.replaceAll("\n", "\r\n")}`)).toContain("(lines 2-");
    expect(await find(BLOCK)).toContain("(lines 1-");
    expect(await find(`a\n${BLOCK.trimEnd()}`)).toContain("(lines 2-");
  });
  test("two blocks are two lines of notice", async () => {
    const said = await find(`a\n${BLOCK}b\n${block(SHORT)}`);
    expect(said.trim().split("\n")).toHaveLength(2);
  });
  test("an edited block, an indented one, an unfinished one or the markers alone are the person's: no notice", async () => {
    const edited = BLOCK.replace("host or join a session.", "host or join a session. Also: my own rule.");
    for (const text of [`# Mine\n\n${edited}`, `# Mine\n\n${BLOCK.replace(/^/gm, "  ")}`, "a\n<!-- jamsesh:start -->\nmy notes\n<!-- jamsesh:end -->\nb\n", `x ${BLOCK}`, "# Mine\n<!-- jamsesh:start -->\nhalf\n"])
      expect(await find(text)).toBe("");
  });
  test("a symlinked file is read at its target and neither it nor the link changes", async () => {
    expect(await find(`# Shared\n\n${BLOCK}`, true)).toContain("lines 3-");
  });
  test("a save made while it runs can't be lost: it holds no write path at all", async () => {
    // The file the person is saving into is never opened for writing, so an edit at any moment stays.
    const d = tmp();
    const file = join(d, "AGENTS.md");
    writeFileSync(file, `# Mine\n\n${BLOCK}`);
    const proc = Bun.spawn(["perl", "-", file], { stdin: new Blob([FIND_BLOCK_PL]), stderr: "pipe" });
    writeFileSync(file, `# Mine, edited\n\n${BLOCK}`);
    expect(await proc.exited).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(`# Mine, edited\n\n${BLOCK}`);
    expect(readdirSync(d)).toEqual(["AGENTS.md"]);
  });
});

describe("the install", () => {
  test("never writes to CLAUDE.md or AGENTS.md, and leaves both untouched and says where the old block is", async () => {
    const root = tmp();
    const home = join(root, "home");
    const bin = join(root, "bin");
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(join(home, ".codex"), { recursive: true });
    mkdirSync(bin, { recursive: true });
    for (const n of ["claude", "codex"]) writeFileSync(join(bin, n), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(join(home, ".claude/CLAUDE.md"), `# Me\n\n${BLOCK}`);
    writeFileSync(join(home, ".codex/AGENTS.md"), `# Codex me\r\n\r\n${BLOCK.replaceAll("\n", "\r\n")}`);
    writeFileSync(join(home, ".claude/settings.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "/x/.jamsesh/hook.sh start" }] }, { hooks: [{ type: "command", command: "mine.sh" }] }] } }));
    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        const path = new URL(req.url).pathname;
        if (path === "/api/me") return Response.json({ person: { name: "Chey" } });
        return new Response(path === "/launcher.md" ? "LAUNCHER" : path === "/hook.sh" ? "#!/usr/bin/env bash\nexit 0\n" : "x");
      },
    });
    try {
      const proc = Bun.spawn(["/bin/bash", "-c", joinScript({} as Hub, `http://127.0.0.1:${server.port}`, "tok")], {
        env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, JAMSESH_CLI_DIRS: bin },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await proc.exited).toBe(0);
      // Neither file is touched; setup names the lines to delete.
      expect(readFileSync(join(home, ".claude/CLAUDE.md"), "utf8")).toBe(`# Me\n\n${BLOCK}`);
      expect(readFileSync(join(home, ".codex/AGENTS.md"), "utf8")).toBe(`# Codex me\r\n\r\n${BLOCK.replaceAll("\n", "\r\n")}`);
      const said = await new Response(proc.stderr).text();
      expect(said).toContain(`${join(home, ".claude/CLAUDE.md")} still has the block`);
      expect(said).toContain(`${join(home, ".codex/AGENTS.md")} still has the block`);
      expect(readFileSync(join(home, ".claude/skills/jamsesh/SKILL.md"), "utf8")).toBe("LAUNCHER");
      expect(readFileSync(join(home, ".codex/skills/jamsesh/SKILL.md"), "utf8")).toBe("LAUNCHER");
      const hooks = JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8")).hooks;
      expect(hooks.SessionStart.map((e: any) => e.hooks[0].command)).toEqual(["mine.sh"]);
      expect(Object.keys(hooks).sort()).toEqual(["PostToolUse", "SessionStart", "Stop", "UserPromptSubmit"]);
    } finally {
      server.stop(true);
    }
  });
});

describe("hooks do nothing for a chat that didn't join", () => {
  async function runHook(mode: string, payload: object, joined: boolean) {
    const dir = tmp();
    const calls: string[] = [];
    const hub = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const path = new URL(req.url).pathname;
        calls.push(path);
        return path.endsWith("/hooks/joined") ? Response.json({ joined }) : Response.json({});
      },
    });
    try {
      const env = join(dir, "client.env");
      writeFileSync(env, `JAMSESH_HUB="http://127.0.0.1:${hub.port}"\nJAMSESH_TOKEN="t"\nJAMSESH_ACTIVE=1\n`);
      const proc = Bun.spawn(["/bin/bash", "-c", hookScript({} as Hub), "hook", mode], {
        env: { HOME: dir, PATH: "/usr/bin:/bin", JAMSESH_CLIENT_ENV: env, JAMSESH_DIR: dir },
        stdin: new Blob([JSON.stringify(payload)]),
        stdout: "pipe",
      });
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      return { out, calls };
    } finally {
      hub.stop(true);
    }
  }

  test("an unrelated prompt sends nothing to the host and adds nothing", async () => {
    const r = await runHook("prompt", { session_id: "abc-1", prompt: "fix the typo in the readme" }, false);
    expect(r.calls).toEqual(["/api/hooks/joined"]);
    expect(r.out).toBe("");
  });
  test("the stop hook doesn't hold an unjoined chat", async () => {
    const r = await runHook("stop", { session_id: "abc-1" }, false);
    expect(r.calls).toEqual(["/api/hooks/joined"]);
    expect(r.out).toBe("");
  });
  test("asking to connect hands the chat its id for jam_join, and still sends nothing", async () => {
    const r = await runHook("prompt", { session_id: "abc-1", prompt: "connect to jamsesh" }, false);
    expect(r.calls).toEqual(["/api/hooks/joined"]);
    expect(r.out).toContain("abc-1");
  });
  test("a joined chat's prompt goes to the host", async () => {
    const r = await runHook("prompt", { session_id: "abc-1", prompt: "make it blue" }, true);
    expect(r.calls).toEqual(["/api/hooks/joined", "/api/hooks/prompt"]);
  });
  test("a hook without a session id does nothing at all", async () => {
    const r = await runHook("prompt", { prompt: "hi" }, true);
    expect(r.calls).toEqual([]);
  });
});

describe("chats are separate agents", () => {
  const fresh = () => new Session(new Store(tmp()));
  const join_ = (s: Session, chatId?: string, harness: "claude-code" | "codex" = "claude-code") =>
    s.registerAgent({ ownerName: "Jonathan", harness, repo: "fluid", cwd: "/Users/j/fluid", machine: "host", platform: "web", chatId });

  test("a second chat in the same folder is a new agent, and the first keeps its record", () => {
    const s = fresh();
    const a = join_(s, "chat-a");
    const b = join_(s, "chat-b");
    expect(b.resumed).toBe(false);
    expect(b.agent.id).not.toBe(a.agent.id);
    expect(join_(s, "chat-a").agent.id).toBe(a.agent.id);
    expect(s.agents()).toHaveLength(2);
  });
  test("a chat with no id never takes a named chat's record", () => {
    const s = fresh();
    const a = join_(s, "chat-a");
    expect(join_(s, undefined).agent.id).not.toBe(a.agent.id);
  });
  test("a hook finds only the chat that joined, whatever folder it is in", () => {
    const hub = { session: fresh() } as unknown as Hub;
    const a = join_(hub.session, "chat-a").agent;
    join_(hub.session, "chat-b", "codex");
    const find = (body: object, machine: string | null = "host") => Hub.prototype.hookAgent.call(hub, body, "127.0.0.1", machine);
    expect(find({ session_id: "chat-a", cwd: "/Users/j/fluid" })?.id).toBe(a.id);
    expect(find({ session_id: "chat-other", cwd: "/Users/j/fluid" })).toBeUndefined();
    expect(find({ cwd: "/Users/j/fluid" })).toBeUndefined();
    // A Codex connection has no hook; its id never answers one.
    expect(find({ session_id: "chat-b" })).toBeUndefined();
    // Nor does the chat answer a hook from another machine's credential, or one with no machine at all.
    expect(find({ session_id: "chat-a" }, "dev_other")).toBeUndefined();
    expect(find({ session_id: "chat-a" }, null)).toBeUndefined();
    expect(find({ agentId: a.id }, "host")).toBeUndefined();
  });
});

describe("joining is announced, and an accidental join can be removed", () => {
  test("the room hears who joined and from where", () => {
    const s = new Session(new Store(tmp()));
    s.registerAgent({ ownerName: "Jonathan", harness: "codex", repo: "fluid", cwd: `/Users/jonathan/fluid`, machine: "host", platform: "web", chatId: "mcp:1" });
    const ev = s.store.recentEvents({ kinds: ["join"] })[0]!;
    expect(ev.text).toBe("Jonathan's Codex joined from ~/fluid");
    expect(ev.data.agentId).toBeTruthy();
  });

  test("removing it frees its work and, with purge, deletes what it put in the room", () => {
    const s = new Session(new Store(tmp()));
    const person = s.upsertPerson({ name: "Jonathan" });
    const { agent } = s.registerAgent({ ownerName: "Jonathan", harness: "codex", repo: "fluid", cwd: "/Users/j/fluid", machine: "host", platform: "web", chatId: "mcp:1" });
    const keep = s.store.addEvent({ kind: "speech", authorType: "person", authorId: person.id, authorName: "Jonathan", text: "let's build it" });
    s.postUpdate(agent.id, "progress", "refactoring the cart", { workstream: "Cart" });
    const prompt = s.store.addEvent({ kind: "prompt", authorType: "person", authorId: person.id, authorName: "Jonathan", text: "unrelated prompt", data: { agentId: agent.id } });
    const gone = s.removeAgent(agent.id, { purge: true });
    expect(gone.removed).toBe(true);
    expect(gone.events).toBeGreaterThanOrEqual(2);
    expect(s.agent(agent.id)).toBeUndefined();
    expect(s.store.recentEvents().filter((e) => e.authorType !== "system").map((e) => e.id)).toEqual([keep.id, prompt.id]); // the person's own prompt stays
    expect(s.store.recentEvents().some((e) => e.kind === "join")).toBe(false);
    expect(s.store.all("workstreams").every((w) => w.ownerAgentId !== agent.id)).toBe(true);
    expect(s.store.searchEvents("cart")).toEqual([]);
    expect(s.removeAgent(agent.id).removed).toBe(false);
  });

  test("purge deletes only what the agent authored: its events and long documents, not messages to it or its person's prompts", () => {
    const s = new Session(new Store(tmp()));
    const person = s.upsertPerson({ name: "Jonathan" });
    const { agent } = s.registerAgent({ ownerName: "Jonathan", harness: "codex", repo: "fluid", cwd: "/Users/j/fluid", machine: "host", platform: "web", chatId: "mcp:1" });
    const other = s.registerAgent({ ownerName: "Chey", harness: "codex", repo: "api", cwd: "/Users/c/api", machine: "host", platform: "web", chatId: "mcp:2" }).agent;
    s.postUpdate(agent.id, "progress", "long ".repeat(400));
    expect(s.store.all("documents").filter((d) => d.authorId === agent.id)).toHaveLength(1);
    s.postUpdate(other.id, "progress", "other agent's long ".repeat(200));
    s.sendMessage(other.id, agent.id, "heads up from the other agent");
    s.store.addEvent({ kind: "prompt", authorType: "person", authorId: person.id, authorName: "Jonathan", text: "a prompt Jonathan wrote", data: { agentId: agent.id } });
    s.removeAgent(agent.id, { purge: true });
    const texts = s.store.recentEvents().map((e) => e.text);
    expect(texts).toContain("heads up from the other agent");
    expect(texts).toContain("a prompt Jonathan wrote");
    expect(texts.some((t) => t.startsWith("long long"))).toBe(false);
    expect(s.store.all("documents").map((d) => d.authorId)).toEqual([other.id]);
  });

  test("without purge the agent goes and its history stays", () => {
    const s = new Session(new Store(tmp()));
    const { agent } = s.registerAgent({ ownerName: "Jonathan", harness: "codex", repo: "fluid", cwd: "/Users/j/fluid", machine: "host", platform: "web", chatId: "mcp:1" });
    s.postUpdate(agent.id, "progress", "did a thing");
    s.removeAgent(agent.id);
    expect(s.agent(agent.id)).toBeUndefined();
    expect(s.store.recentEvents().some((e) => e.text === "did a thing")).toBe(true);
  });
});
