// A chat joins the room only when its person tells it to: installing writes nothing into CLAUDE.md or
// AGENTS.md, hooks do nothing for a chat that never called jam_join, and chats are told apart even in
// one folder. A wrongly joined agent can be removed, with what it caused.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../src/hub";
import { OLD_BLOCKS, STRIP_BLOCK_PL, hookScript, joinScript } from "../src/install-scripts";
import { Session } from "../src/session";
import { Store } from "../src/store";

const tmp = () => mkdtempSync(join(tmpdir(), "jam-join-"));
// The blocks earlier installs wrote, exactly: the longer one, then the first.
const [LONG, SHORT] = OLD_BLOCKS;
const block = (b: string) => `${b}\n`;
const BLOCK = block(LONG);

async function strip(content: string | null) {
  const file = join(tmp(), "AGENTS.md");
  if (content !== null) writeFileSync(file, content);
  const proc = Bun.spawn(["perl", "-", file], { stdin: new Blob([STRIP_BLOCK_PL]), stderr: "pipe" });
  expect(await proc.exited).toBe(0);
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

describe("removing the block an earlier install wrote", () => {
  test("a file with no block is left exactly as it is", async () => {
    const text = "# Mine\r\nkeep   \r\n\r\n\r\n";
    expect(await strip(text)).toBe(text);
  });
  test("a block at the end of the file takes its blank line with it", async () => {
    expect(await strip(`# Mine\n\nrules\n\n${BLOCK}`)).toBe("# Mine\n\nrules\n");
  });
  test("a block at the end with no final newline", async () => {
    expect(await strip(`# Mine\n\n${BLOCK.trimEnd()}`)).toBe("# Mine\n");
  });
  test("a block in the middle leaves everything around it byte for byte", async () => {
    expect(await strip(`# Mine\n\n${BLOCK}\nMore rules  \n\n\n`)).toBe("# Mine\n\n\nMore rules  \n\n\n");
  });
  test("CRLF files keep their line endings", async () => {
    const crlf = BLOCK.replaceAll("\n", "\r\n");
    expect(await strip(`# Mine\r\n\r\nrules\r\n\r\n${crlf}`)).toBe("# Mine\r\n\r\nrules\r\n");
    expect(await strip(`a\r\n${crlf}b\r\n`)).toBe("a\r\nb\r\n");
  });
  test("a file that was only the block is removed, and a missing file is fine", async () => {
    expect(await strip(BLOCK)).toBeNull();
    expect(await strip(null)).toBeNull();
  });
  test("an unfinished block (no end marker) is left alone", async () => {
    const text = "# Mine\n<!-- jamsesh:start -->\nhalf\n";
    expect(await strip(text)).toBe(text);
  });
  test("two blocks both go", async () => {
    expect(await strip(`a\n${BLOCK}b\n${block(SHORT)}`)).toBe("a\nb\n");
  });
  test("only the exact block goes: an edited one, an indented one, or the markers alone stay", async () => {
    const edited = BLOCK.replace("host or join a session.", "host or join a session. Also: my own rule.");
    for (const text of [`# Mine\n\n${edited}`, `# Mine\n\n${BLOCK.replace(/^/gm, "  ")}`, "a\n<!-- jamsesh:start -->\nmy notes\n<!-- jamsesh:end -->\nb\n", `x ${BLOCK}`])
      expect(await strip(text)).toBe(text);
  });
  test("blank lines and indentation around the block stay byte for byte", async () => {
    expect(await strip(`# Mine\n\n\n${BLOCK}\n\n  indented rule\n\t\n`)).toBe("# Mine\n\n\n\n\n  indented rule\n\t\n");
    expect(await strip(`  - item\n${BLOCK}    - next\n`)).toBe("  - item\n    - next\n");
  });
  test("a symlinked file is edited at its target and stays a symlink", async () => {
    const d = tmp();
    const target = join(d, "shared-instructions.md");
    writeFileSync(target, `# Shared\n\n${BLOCK}`, { mode: 0o640 });
    const link = join(d, "CLAUDE.md");
    symlinkSync(target, link);
    const proc = Bun.spawn(["perl", "-", link], { stdin: new Blob([STRIP_BLOCK_PL]), stderr: "pipe" });
    expect(await proc.exited).toBe(0);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(target);
    expect(readFileSync(target, "utf8")).toBe("# Shared\n");
    expect(statSync(target).mode & 0o777).toBe(0o640);
    // A link whose target was only the block keeps the link, now to an empty file.
    writeFileSync(target, BLOCK);
    expect(await Bun.spawn(["perl", "-", link], { stdin: new Blob([STRIP_BLOCK_PL]) }).exited).toBe(0);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(link, "utf8")).toBe("");
  });
});

describe("the install", () => {
  test("never writes to CLAUDE.md or AGENTS.md, and removes the old block from both", async () => {
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
        return new Response(path === "/launcher.md" ? "LAUNCHER" : "x");
      },
    });
    try {
      const proc = Bun.spawn(["/bin/bash", "-c", joinScript({} as Hub, `http://127.0.0.1:${server.port}`, "tok")], {
        env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, JAMSESH_CLI_DIRS: bin },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await proc.exited).toBe(0);
      expect(readFileSync(join(home, ".claude/CLAUDE.md"), "utf8")).toBe("# Me\n");
      expect(readFileSync(join(home, ".codex/AGENTS.md"), "utf8")).toBe("# Codex me\r\n");
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
    s.store.addEvent({ kind: "prompt", authorType: "person", authorId: person.id, authorName: "Jonathan", text: "unrelated prompt", data: { agentId: agent.id } });
    const gone = s.removeAgent(agent.id, { purge: true });
    expect(gone.removed).toBe(true);
    expect(gone.events).toBeGreaterThanOrEqual(3);
    expect(s.agent(agent.id)).toBeUndefined();
    expect(s.store.recentEvents().filter((e) => e.authorType !== "system").map((e) => e.id)).toEqual([keep.id]);
    expect(s.store.recentEvents().some((e) => e.kind === "join")).toBe(false);
    expect(s.store.all("workstreams").every((w) => w.ownerAgentId !== agent.id)).toBe(true);
    expect(s.store.searchEvents("cart")).toEqual([]);
    expect(s.removeAgent(agent.id).removed).toBe(false);
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
