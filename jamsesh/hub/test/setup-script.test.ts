// Runs the real /agent/setup.sh against a throwaway home folder: finding agent CLIs that aren't on
// PATH, never wiping a settings file it can't parse, and failing when no agent was set up.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hub } from "../src/hub";
import { OLD_BLOCKS, agentGuide, hookScript, joinScript } from "../src/install-scripts";

let server: ReturnType<typeof Bun.serve>;
let origin = "";
let people = 0;
/** The name the host knows this computer's person by (the room controls it); null: /api/me fails. */
let meName: string | null = "Chey";
const HOOK_OK = "#!/usr/bin/env bash\nexit 0\n";
/** What the fake host serves as hook.sh (null: an error). */
let hookBody: string | null = HOOK_OK;
/** The credential each request to the fake host carried. */
const auths: string[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const path = new URL(req.url).pathname;
      auths.push(req.headers.get("authorization") ?? "");
      if (path === "/hook.sh") return hookBody === null ? new Response("down", { status: 503 }) : new Response(hookBody);
      if (path === "/skill.md") return new Response("# JamSesh skill\n");
      if (path === "/launcher.md") return new Response("# JamSesh launcher\n");
      if (path === "/api/me") return meName === null ? new Response("down", { status: 503 }) : Response.json({ person: { id: "p_1", name: meName } });
      if (path === "/api/people") return (people++, Response.json({ ok: true }));
      return new Response("not found", { status: 404 });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

/** A home folder, a bin folder for stub CLIs, and the log the stubs write their arguments to. */
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "jamsesh-setup-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  return { home, bin, log: join(root, "cli.log") };
}

function stubCli(path: string, log: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `#!/bin/sh\necho "$0 $*" >> "${log}"\n`);
  chmodSync(path, 0o755);
}

async function run(box: ReturnType<typeof sandbox>, name = "Felipe") {
  const proc = Bun.spawn(["/bin/bash", "-c", joinScript({} as Hub, origin, "tok")], {
    env: { HOME: box.home, PATH: `${box.bin}:/usr/bin:/bin`, JAMSESH_NAME: name, JAMSESH_CLI_DIRS: box.bin },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr: stderr.trim(), code };
}

describe("agent setup script", () => {
  test("keeps other settings and replaces earlier JamSesh hooks", async () => {
    const box = sandbox();
    stubCli(join(box.bin, "claude"), box.log);
    const settings = join(box.home, ".claude/settings.json");
    mkdirSync(join(box.home, ".claude"), { recursive: true });
    writeFileSync(settings, JSON.stringify({ theme: "dark", hooks: { Stop: [{ hooks: [{ type: "command", command: "/old/.jamsesh/hook.sh stop" }] }, { hooks: [{ type: "command", command: "mine.sh" }] }] } }));
    const r = await run(box);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("ok  Claude Code");
    const data = JSON.parse(readFileSync(settings, "utf8"));
    expect(data.theme).toBe("dark");
    expect(data.hooks.Stop.map((e: { hooks: { command: string }[] }) => e.hooks[0]!.command)).toEqual(["mine.sh", `'${box.home}/.jamsesh/hook.sh' stop`, `'${box.home}/.jamsesh/hook.sh' listen`]);
    expect(data.hooks.PostToolUse).toHaveLength(1);
    expect(data.hooks.Stop[2].hooks[0].asyncRewake).toBe(true);
    // Claude Code still enforces the timeout on an async hook: it has to outlast the listener's loop (about 3000 seconds).
    expect(data.hooks.Stop[2].hooks[0].timeout).toBe(3300);
    expect(data.hooks.UserPromptSubmit).toHaveLength(1);
    expect(existsSync(`${settings}.jamsesh-tmp`)).toBe(false);
    // The token is never an argument: Claude Code gets the header from a helper that reads a mode-600 file.
    const log = readFileSync(box.log, "utf8");
    expect(log).toContain(`mcp add-json -s user jamsesh {"headersHelper":"${box.home}/.jamsesh/mcp-headers.sh","type":"http","url":"${origin}/mcp"}`);
    expect(log).not.toContain("tok");
    const helper = Bun.spawnSync([join(box.home, ".jamsesh/mcp-headers.sh")]);
    expect(JSON.parse(helper.stdout.toString())).toEqual({ authorization: "Bearer tok" });
    for (const f of ["mcp-headers.json", "auth.header", "client.env"]) expect(statSync(join(box.home, ".jamsesh", f)).mode & 0o077).toBe(0);
    expect(existsSync(join(box.home, ".claude/skills/jamsesh/SKILL.md"))).toBe(true);
  });

  test("a settings file that doesn't parse is left alone and the setup fails", async () => {
    const box = sandbox();
    stubCli(join(box.bin, "claude"), box.log);
    const settings = join(box.home, ".claude/settings.json");
    mkdirSync(join(box.home, ".claude"), { recursive: true });
    writeFileSync(settings, '{"theme": "dark", oops');
    const r = await run(box);
    expect(r.code).not.toBe(0);
    expect(r.stderr.split("\n").at(-1)).toContain("isn't valid JSON");
    expect(readFileSync(settings, "utf8")).toBe('{"theme": "dark", oops');
  });

  test("finds the Claude Code inside the Claude desktop app when none is on PATH", async () => {
    const box = sandbox();
    const bundled = join(box.home, "Library/Application Support/Claude/claude-code/2.1.309/abc/claude.app/Contents/MacOS/claude");
    stubCli(bundled, box.log);
    const r = await run(box);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("ok  Claude Code");
    expect(readFileSync(box.log, "utf8")).toContain(`${bundled} mcp add`);
  });

  test("finds Claude Code installed with nvm", async () => {
    const box = sandbox();
    const nvm = join(box.home, ".nvm/versions/node/v22.1.0/bin/claude");
    stubCli(nvm, box.log);
    const r = await run(box);
    expect(r.code).toBe(0);
    expect(readFileSync(box.log, "utf8")).toContain(`${nvm} mcp add`);
  });

  test("fails, instead of reporting success, when no agent is installed", async () => {
    const box = sandbox();
    const r = await run(box);
    expect(r.code).not.toBe(0);
    expect(r.stdout).not.toContain("Done.");
    expect(r.stderr.split("\n").at(-1)).toContain("no agent was connected");
  });

  test("takes the person from the host and never adds one", async () => {
    const box = sandbox();
    stubCli(join(box.bin, "claude"), box.log);
    const before = people;
    expect((await run(box)).code).toBe(0);
    expect(people).toBe(before);
    expect(readFileSync(join(box.home, ".jamsesh/client.env"), "utf8")).toContain("JAMSESH_NAME='Chey'");
  });

  test("a name from the room is data: it never runs, in the setup, the hook, or a script that sources client.env", async () => {
    const hostile = `Eve $(touch "$HOME/pwned1") \`touch "$HOME/pwned2"\` "q" 'x' ; touch "$HOME/pwned3"`;
    const pwned = (home: string) => ["pwned1", "pwned2", "pwned3"].filter((f) => existsSync(join(home, f)));
    const box = sandbox();
    stubCli(join(box.bin, "claude"), box.log);
    meName = hostile;
    try {
      expect((await run(box)).code).toBe(0);
      const env = join(box.home, ".jamsesh/client.env");
      const sourced = Bun.spawnSync(["/bin/bash", "-c", '. "$1"; printf %s "$JAMSESH_NAME"', "x", env], { env: { HOME: box.home, PATH: "/usr/bin:/bin" } });
      expect(sourced.stdout.toString()).toBe(hostile);
      // The hook reads client.env without running it.
      const hook = Bun.spawn(["/bin/bash", "-c", hookScript({} as Hub), "hook", "prompt"], { env: { HOME: box.home, PATH: "/usr/bin:/bin", JAMSESH_CLIENT_ENV: env, JAMSESH_DIR: join(box.home, ".jamsesh") }, stdin: new Blob(['{"session_id":"c1","prompt":"hi"}']) });
      await hook.exited;
      expect(pwned(box.home)).toEqual([]);
      // An older client.env (double quotes) holding such a name, read back when the host doesn't answer.
      writeFileSync(env, `JAMSESH_HUB="${origin}"\nJAMSESH_TOKEN="tok"\nJAMSESH_NAME="${hostile.replace(/"/g, "")}"\nJAMSESH_ACTIVE=1\n`);
      meName = null;
      expect((await run(box, "")).code).toBe(0);
      expect(pwned(box.home)).toEqual([]);
      const again = Bun.spawnSync(["/bin/bash", "-c", '. "$1"; printf %s "$JAMSESH_NAME"', "x", env], { env: { HOME: box.home, PATH: "/usr/bin:/bin" } });
      expect(again.stdout.toString()).toBe(hostile.replace(/"/g, ""));
      expect(pwned(box.home)).toEqual([]);
    } finally {
      meName = "Chey";
    }
  });

  test("the credential travels in headers read from files, never in a command line", async () => {
    const box = sandbox();
    stubCli(join(box.bin, "claude"), box.log);
    auths.length = 0;
    expect((await run(box)).code).toBe(0);
    // Every request the setup made carried it.
    expect(auths.length).toBeGreaterThan(2);
    expect(new Set(auths)).toEqual(new Set(["Bearer tok"]));
    expect(readFileSync(join(box.home, ".jamsesh/auth.header"), "utf8")).toBe("authorization: Bearer tok\n");
    // Neither script puts a token on a command line.
    const setup = joinScript({} as Hub, origin, "tok");
    expect(setup).not.toMatch(/-H "authorization|--header|Bearer \$TOKEN"? "\$/);
    expect(setup).not.toMatch(/perl [^\n]*"\$TOKEN"/);
    expect(hookScript({} as Hub)).not.toContain("Bearer");
    // Nor in a child's environment (Codex's config is written from the header file).
    expect(setup).not.toMatch(/[A-Z_]+="\$TOKEN" /);
  });

  test("the pairing guide never puts the token in a command: the agent writes it to a private file first", () => {
    const guide = agentGuide("http://host:4790", "jst_secret123");
    const commands = [...guide.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]!).concat([...guide.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!));
    expect(commands.some((c) => c.includes("curl"))).toBe(true);
    for (const c of commands) expect(c).not.toContain("jst_secret123");
    expect(guide).toContain("authorization: Bearer jst_secret123");
    expect(guide).toContain('-H @"$HOME/.jamsesh/auth.header"');
  });

  test("the hook keeps Claude Code's own notices out of the room", async () => {
    const box = sandbox();
    const posted: string[] = [];
    const hub = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = await req.text();
        if (new URL(req.url).pathname.endsWith("/hooks/joined")) return Response.json({ joined: true });
        posted.push(body);
        return Response.json({ ok: true });
      },
    });
    try {
      const env = join(box.home, "client.env");
      writeFileSync(env, `JAMSESH_HUB="http://127.0.0.1:${hub.port}"\nJAMSESH_TOKEN="t"\nJAMSESH_ACTIVE=1\n`);
      const hook = async (prompt: string) => {
        const proc = Bun.spawn(["/bin/bash", "-c", hookScript({} as Hub), "hook", "prompt"], {
          env: { HOME: box.home, PATH: "/usr/bin:/bin", JAMSESH_CLIENT_ENV: env, JAMSESH_DIR: box.home },
          stdin: new Blob([JSON.stringify({ prompt, session_id: "chat-1" })]),
        });
        await proc.exited;
      };
      await hook("<task-notification>\n<task-id>a1</task-id>\n</task-notification>");
      await hook("\n<bash-stdout>ok</bash-stdout>");
      await hook("put the mobile build next to the mockup");
      expect(posted).toHaveLength(1);
      expect(posted[0]).toContain("mobile build");
    } finally {
      hub.stop(true);
    }
  });

  test("Codex: replaces its earlier JamSesh server, and takes its old instructions block out", async () => {
    const box = sandbox();
    mkdirSync(join(box.home, ".codex"), { recursive: true });
    const config = join(box.home, ".codex/config.toml");
    const agents = join(box.home, ".codex/AGENTS.md");
    writeFileSync(config, 'model = "gpt"\n\n[mcp_servers.jamsesh]\nurl = "http://old/mcp"\n\n[mcp_servers.jamsesh.http_headers]\nauthorization = "Bearer old"\n\n[mcp_servers.other]\nurl = "http://x"\n');
    writeFileSync(agents, `# Mine\n\n${OLD_BLOCKS[0]}\n`);
    for (let i = 0; i < 2; i++) expect((await run(box)).code).toBe(0);
    const toml = readFileSync(config, "utf8");
    expect(toml).toContain('model = "gpt"');
    expect(toml).toContain("[mcp_servers.other]");
    expect(toml).not.toContain("http://old/mcp");
    expect(toml.match(/\[mcp_servers\.jamsesh\]/g)).toHaveLength(1);
    expect(toml).toContain(`url = "${origin}/mcp"`);
    expect(toml).toContain('authorization = "Bearer tok"');
    // Nothing of ours is left in the person's own instructions, and nothing of theirs is lost.
    expect(readFileSync(agents, "utf8")).toBe("# Mine\n");
  });

  test("reinstalling never widens a file's mode, and tightens JamSesh's own credential files", async () => {
    const box = sandbox();
    stubCli(join(box.bin, "claude"), box.log);
    mkdirSync(join(box.home, ".codex"), { recursive: true });
    const dir = join(box.home, ".jamsesh");
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    chmodSync(dir, 0o755);
    for (const f of ["auth.header", "client.env", "mcp-headers.json"]) writeFileSync(join(dir, f), "old\n", { mode: 0o644 });
    const settings = join(box.home, ".claude/settings.json");
    mkdirSync(join(box.home, ".claude"), { recursive: true });
    writeFileSync(settings, JSON.stringify({ env: { SECRET: "s3cret" } }), { mode: 0o600 });
    chmodSync(settings, 0o600);
    expect((await run(box)).code).toBe(0);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    for (const f of ["auth.header", "client.env", "mcp-headers.json"]) expect(statSync(join(dir, f)).mode & 0o777).toBe(0o600);
    expect(statSync(settings).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(settings, "utf8")).env.SECRET).toBe("s3cret");
    expect(statSync(join(box.home, ".codex/config.toml")).mode & 0o777).toBe(0o600);
  });

  test("a home folder with spaces still runs the hooks", async () => {
    const box = sandbox();
    box.home = join(box.home, "Jo Smith's Mac");
    mkdirSync(box.home, { recursive: true });
    stubCli(join(box.bin, "claude"), box.log);
    expect((await run(box)).code).toBe(0);
    const cmd: string = JSON.parse(readFileSync(join(box.home, ".claude/settings.json"), "utf8")).hooks.Stop[0].hooks[0].command;
    // Run the command the way Claude Code does, through a shell: the hook (the stub host's) runs.
    writeFileSync(join(box.home, ".jamsesh/hook.sh"), "#!/bin/sh\necho ran \"$1\"\n", { mode: 0o755 });
    const out = Bun.spawnSync(["/bin/sh", "-c", cmd]);
    expect(out.stdout.toString().trim()).toBe("ran stop");
  });

  test("Codex: JamSesh's tables go by their header lines, whatever brackets the values hold", async () => {
    const box = sandbox();
    mkdirSync(join(box.home, ".codex"), { recursive: true });
    const config = join(box.home, ".codex/config.toml");
    writeFileSync(
      config,
      [
        'model = "gpt"',
        "",
        "[mcp_servers.jamsesh]",
        'url = "http://[::1]:4747/mcp" # the old [v1] address',
        'note = """',
        "[not.a.header]",
        '"""',
        "",
        "[mcp_servers.jamsesh.http_headers]",
        'authorization = "Bearer old"',
        "",
        "[mcp_servers.other]",
        'url = "http://[fe80::1]:9000/mcp" # keep [me]',
        "",
        '[ mcp_servers . "jamsesh" . env ]',
        'X = "y"',
        "",
        "[profiles.a]",
        "k = 1",
        "",
      ].join("\n"),
    );
    for (let i = 0; i < 2; i++) expect((await run(box)).code).toBe(0);
    const toml = readFileSync(config, "utf8");
    expect(toml).not.toContain("[::1]");
    expect(toml).not.toContain("not.a.header");
    expect(toml).not.toContain('X = "y"');
    expect(toml).toContain('[mcp_servers.other]\nurl = "http://[fe80::1]:9000/mcp" # keep [me]');
    expect(toml).toContain("[profiles.a]\nk = 1");
    expect(toml.match(/\[mcp_servers\.jamsesh\]/g)).toHaveLength(1);
    expect(toml).toContain(`url = "${origin}/mcp"`);
  });

  test("reinstalling takes out only JamSesh's own hook commands, keeping a person's hooks even in the same group", async () => {
    const box = sandbox();
    stubCli(join(box.bin, "claude"), box.log);
    const settings = join(box.home, ".claude/settings.json");
    mkdirSync(join(box.home, ".claude"), { recursive: true });
    const mine = { type: "command", command: "~/bin/jamsesh-notify.sh --room jamsesh" };
    writeFileSync(
      settings,
      JSON.stringify({
        hooks: {
          Stop: [
            { hooks: [{ type: "command", command: "/Users/old/.jamsesh/hook.sh stop" }, mine] },
            { matcher: "", hooks: [{ type: "command", command: "'/Users/old/.jamsesh/hook.sh' listen", asyncRewake: true }] },
          ],
          PostToolUse: [{ hooks: [{ type: "command", command: "echo jamsesh is great" }] }],
          SessionStart: [{ hooks: [{ type: "command", command: "/x/.jamsesh/hook.sh start" }] }],
        },
      }),
    );
    expect((await run(box)).code).toBe(0);
    const hooks = JSON.parse(readFileSync(settings, "utf8")).hooks;
    const cmds = (event: string) => hooks[event].flatMap((g: any) => g.hooks.map((h: any) => h.command));
    expect(cmds("Stop")).toEqual([mine.command, `'${box.home}/.jamsesh/hook.sh' stop`, `'${box.home}/.jamsesh/hook.sh' listen`]);
    expect(cmds("PostToolUse")).toEqual(["echo jamsesh is great", `'${box.home}/.jamsesh/hook.sh' tool`]);
    expect(hooks.SessionStart).toBeUndefined();
    // Reinstalling again changes nothing more.
    expect((await run(box)).code).toBe(0);
    expect(JSON.parse(readFileSync(settings, "utf8")).hooks).toEqual(hooks);
  });

  test("Codex: triple quotes in a comment don't hide JamSesh's table", async () => {
    const box = sandbox();
    mkdirSync(join(box.home, ".codex"), { recursive: true });
    const config = join(box.home, ".codex/config.toml");
    writeFileSync(config, ['model = "gpt" # a comment with """ in it', "", "[mcp_servers.jamsesh]", 'url = "http://old/mcp"', "", "[keep]", 'a = "b\\" # [c]"', ""].join("\n"));
    expect((await run(box)).code).toBe(0);
    const toml = readFileSync(config, "utf8");
    expect(toml).not.toContain("http://old/mcp");
    expect(toml.match(/\[mcp_servers\.jamsesh\]/g)).toHaveLength(1);
    expect(toml).toContain('[keep]\na = "b\\" # [c]"');
  });

  test("a hook download that fails or comes back broken leaves the installed hook as it was", async () => {
    const box = sandbox();
    stubCli(join(box.bin, "claude"), box.log);
    expect((await run(box)).code).toBe(0);
    const hook = join(box.home, ".jamsesh/hook.sh");
    const good = readFileSync(hook, "utf8");
    for (const broken of ["#!/usr/bin/env bash\nif [ x = x; then\n", "<html>Gateway timeout</html>", null]) {
      hookBody = broken;
      const r = await run(box);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("couldn't download its hook");
      expect(readFileSync(hook, "utf8")).toBe(good);
      expect(readdirSync(join(box.home, ".jamsesh")).filter((f) => f.startsWith("hook.sh."))).toEqual([]);
    }
    hookBody = HOOK_OK;
  });

  test("if Claude Code won't take the new MCP entry, the earlier one is put back, without its token on a command line", async () => {
    const box = sandbox();
    // A claude that logs its arguments and refuses the new entry (the one for this host).
    writeFileSync(join(box.bin, "claude"), `#!/bin/sh\necho "$0 $*" >> "${box.log}"\ncase "$*" in *"add-json"*"${origin}/mcp"*) exit 1 ;; esac\nexit 0\n`, { mode: 0o755 });
    writeFileSync(join(box.home, ".claude.json"), JSON.stringify({ mcpServers: { jamsesh: { type: "http", url: "http://old-host:4747/mcp", headers: { Authorization: "Bearer old-secret", "X-Other": "1" } } } }));
    const r = await run(box);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("the earlier one was put back");
    const log = readFileSync(box.log, "utf8").trim().split("\n");
    const back = log.find((l) => l.includes("add-json") && l.includes("old-host"))!;
    expect(back).toBeDefined();
    expect(back).toContain(`"headersHelper":"${box.home}/.jamsesh/mcp-headers.sh"`);
    expect(back).toContain('"X-Other":"1"');
    expect(log.join("\n")).not.toContain("old-secret");
  });
});
