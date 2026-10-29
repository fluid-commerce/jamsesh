// Runs the real /agent/setup.sh against a throwaway home folder: finding agent CLIs that aren't on
// PATH, never wiping a settings file it can't parse, and failing when no agent was set up.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Hub } from "../src/hub";
import { OLD_BLOCKS, agentGuide, hookScript, joinScript } from "../src/install-scripts";

let server: ReturnType<typeof Bun.serve>;
let origin = "";
let people = 0;
/** The name the host knows this computer's person by (the room controls it); null: /api/me fails. */
let meName: string | null = "Chey";
const HOOK_OK = "#!/usr/bin/env bash\nexit 0\n";
/** What the fake host serves as skill.md (null: an error). */
let skillBody: string | null = "# JamSesh skill\n";
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
      if (path === "/skill.md") return skillBody === null ? new Response("down", { status: 503 }) : new Response(skillBody);
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
  // realpath: on macOS tmpdir() is under /var, a link to /private/var, and the script reports the real path.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "jamsesh-setup-")));
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  return { home, bin, log: join(root, "cli.log") };
}

/**
 * A CLI that logs its arguments and keeps the "jamsesh" MCP entry where Claude Code does, in the sandbox's
 * ~/.claude.json: `mcp add-json` stores it, `mcp remove` deletes it, `mcp get` succeeds only while it is there.
 * Marker files next to the log make it refuse: `.refuse-add` (an `add-json` call whose arguments contain its
 * text fails; empty refuses all), `.refuse-remove` and `.refuse-get`.
 */
function stubCli(path: string, log: string, opts: { refuseAdd?: string; refuseRemove?: boolean; refuseGet?: boolean } = {}) {
  mkdirSync(join(path, ".."), { recursive: true });
  const cfg = join(dirname(log), "home/.claude.json");
  if (opts.refuseAdd !== undefined) writeFileSync(`${log}.refuse-add`, opts.refuseAdd);
  if (opts.refuseRemove) writeFileSync(`${log}.refuse-remove`, "");
  if (opts.refuseGet) writeFileSync(`${log}.refuse-get`, "");
  const edit = (code: string) => `perl -MJSON::PP -e 'my ($cfg, $arg) = @ARGV; my $d = -f $cfg ? decode_json(do { local $/; open my $f, "<", $cfg or exit 1; <$f> }) : {}; ${code}; open my $o, ">", $cfg or exit 1; print $o encode_json($d)' "${cfg}"`;
  writeFileSync(
    path,
    `#!/bin/sh
echo "$0 $*" >> "${log}"
for last; do :; done
case "$*" in
  *"mcp remove"*) [ -e "${log}.refuse-remove" ] && exit 1; [ -f "${cfg}" ] && ${edit("delete $d->{mcpServers}{jamsesh}")}; exit 0 ;;
  *"add-json"*) if [ -e "${log}.refuse-add" ]; then pat="$(cat "${log}.refuse-add")"; case "$*" in *"$pat"*) exit 1 ;; esac; fi; ${edit("$d->{mcpServers}{jamsesh} = decode_json($arg)")} "$last"; exit $? ;;
  *"mcp get"*) [ -e "${log}.refuse-get" ] && exit 1; [ -f "${cfg}" ] && perl -MJSON::PP -0777 -ne 'exit(decode_json($_)->{mcpServers}{jamsesh} ? 0 : 1)' "${cfg}"; exit $? ;;
esac
exit 0
`,
  );
  chmodSync(path, 0o755);
}

async function run(box: ReturnType<typeof sandbox>, name = "Felipe", extra: Record<string, string> = {}) {
  const proc = Bun.spawn(["/bin/bash", "-c", joinScript({} as Hub, origin, "tok")], {
    env: { HOME: box.home, PATH: `${box.bin}:/usr/bin:/bin`, JAMSESH_NAME: name, JAMSESH_CLI_DIRS: box.bin, ...extra },
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

  test("Codex: replaces its earlier JamSesh server, and leaves its old instructions block for the person to delete", async () => {
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
    // The person's instructions are never edited, and the notice says which lines are the old block.
    expect(readFileSync(agents, "utf8")).toBe(`# Mine\n\n${OLD_BLOCKS[0]}\n`);
  });

  test("Codex: a symlinked config.toml stays a link and its target is what changes", async () => {
    const box = sandbox();
    mkdirSync(join(box.home, ".codex"), { recursive: true });
    mkdirSync(join(box.home, "dotfiles"), { recursive: true });
    const target = join(box.home, "dotfiles/codex.toml");
    const link = join(box.home, ".codex/config.toml");
    writeFileSync(target, 'model = "gpt"\n\n[mcp_servers.jamsesh]\nurl = "http://old/mcp"\n');
    symlinkSync(target, link);
    for (let i = 0; i < 2; i++) expect((await run(box)).code).toBe(0);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(target);
    const toml = readFileSync(target, "utf8");
    expect(toml).toContain('model = "gpt"');
    expect(toml).not.toContain("http://old/mcp");
    expect(toml).toContain(`url = "${origin}/mcp"`);
    expect(readdirSync(join(box.home, "dotfiles"))).toEqual(["codex.toml"]);
  });

  test("Codex: a symlink to a config that doesn't exist yet is filled in, not replaced", async () => {
    const box = sandbox();
    mkdirSync(join(box.home, ".codex"), { recursive: true });
    mkdirSync(join(box.home, "dotfiles"), { recursive: true });
    const target = join(box.home, "dotfiles/codex.toml");
    const link = join(box.home, ".codex/config.toml");
    symlinkSync(target, link);
    expect((await run(box)).code).toBe(0);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toContain(`url = "${origin}/mcp"`);
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

  test("if Claude Code won't take the new MCP entry, the earlier one is put back, with none of its secrets on a command line", async () => {
    const box = sandbox();
    stubCli(join(box.bin, "claude"), box.log, { refuseAdd: `${origin}/mcp` });
    const entry = { type: "http", url: "http://old-host:4747/mcp", headers: { Authorization: "Bearer old-secret", "X-Other": "x-secret" } };
    writeFileSync(join(box.home, ".claude.json"), JSON.stringify({ mcpServers: { jamsesh: entry } }));
    const r = await run(box);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("the earlier one was put back");
    expect(JSON.parse(readFileSync(join(box.home, ".claude.json"), "utf8")).mcpServers.jamsesh).toEqual(entry);
    expect(readFileSync(box.log, "utf8")).not.toMatch(/old-secret|x-secret/);
    expect(existsSync(join(box.home, ".jamsesh/mcp-headers.json"))).toBe(false);
  });

  test("a failed reinstall puts the earlier room's credential back, so the earlier entry still signs in to it", async () => {
    const box = sandbox();
    stubCli(join(box.bin, "claude"), box.log, { refuseAdd: `${origin}/mcp` });
    const dir = join(box.home, ".jamsesh");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "mcp-headers.json"), '{"authorization":"Bearer old-room"}', { mode: 0o600 });
    writeFileSync(join(dir, "mcp-headers.sh"), `#!/bin/sh\nexec cat '${dir}/mcp-headers.json'\n`, { mode: 0o700 });
    const entry = { type: "http", url: "http://old-host:4747/mcp", headersHelper: join(dir, "mcp-headers.sh") };
    writeFileSync(join(box.home, ".claude.json"), JSON.stringify({ mcpServers: { jamsesh: entry } }));
    const r = await run(box);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("the earlier one was put back");
    expect(readFileSync(join(dir, "mcp-headers.json"), "utf8")).toBe('{"authorization":"Bearer old-room"}');
    expect(JSON.parse(readFileSync(join(box.home, ".claude.json"), "utf8")).mcpServers.jamsesh).toEqual(entry);
  });

  test("if the earlier entry can't be put back, setup says so instead of claiming it was", async () => {
    const box = sandbox();
    // add-json is refused and leaves a folder where ~/.claude.json was, so no file can be renamed over it
    // (a read-only home would do on a Mac, but not for root, which these tests may run as).
    writeFileSync(join(box.bin, "claude"), `#!/bin/sh\ncase "$*" in *"add-json"*) rm -f "$HOME/.claude.json"; mkdir "$HOME/.claude.json"; exit 1 ;; esac\nexit 0\n`, { mode: 0o755 });
    writeFileSync(join(box.home, ".claude.json"), JSON.stringify({ mcpServers: { jamsesh: { type: "http", url: "http://old-host:4747/mcp" } } }));
    const r = await run(box);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("couldn't put the jamsesh entry");
    expect(r.stderr).toContain("couldn't put your earlier connection back completely");
    expect(r.stderr).not.toContain("was put back");
    expect(readdirSync(box.home).filter((f) => f.startsWith(".claude.jamsesh-"))).toEqual([]);
  });

  test("a failed first install leaves no credential behind, and a good one leaves no spare copies", async () => {
    const failing = sandbox();
    stubCli(join(failing.bin, "claude"), failing.log, { refuseAdd: "" });
    expect((await run(failing)).code).not.toBe(0);
    expect(existsSync(join(failing.home, ".jamsesh/mcp-headers.json"))).toBe(false);
    const good = sandbox();
    stubCli(join(good.bin, "claude"), good.log);
    writeFileSync(join(good.home, ".claude.json"), JSON.stringify({ mcpServers: { jamsesh: { type: "http", url: "http://old/mcp", headers: { Authorization: "Bearer x" } } } }));
    expect((await run(good)).code).toBe(0);
    expect(readdirSync(join(good.home, ".jamsesh")).filter((f) => /\.prev$|rollback/.test(f))).toEqual([]);
  });

  /** A home with an earlier install for another host: its connection files, which a failed setup must leave exactly as they were. */
  function earlierInstall(box: ReturnType<typeof sandbox>) {
    const dir = join(box.home, ".jamsesh");
    mkdirSync(dir, { recursive: true });
    const files = { "auth.header": "authorization: Bearer old-room\n", "client.env": "JAMSESH_HUB='http://old-host:4747'\nJAMSESH_NAME='Old'\nJAMSESH_ACTIVE=1\n", "hook.sh": "#!/usr/bin/env bash\n# old hook\n" };
    for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, f), body, { mode: f === "hook.sh" ? 0o755 : 0o600 });
    return { dir, files };
  }
  const connectionIntact = (dir: string, files: Record<string, string>) => {
    for (const [f, body] of Object.entries(files)) expect(readFileSync(join(dir, f), "utf8")).toBe(body);
    expect(statSync(join(dir, "hook.sh")).mode & 0o777).toBe(0o755);
    expect(readdirSync(dir).filter((f) => f.startsWith(".saved") || f.endsWith(".restore"))).toEqual([]);
  };

  test("a failed hook download leaves auth.header, client.env and hook.sh as they were", async () => {
    const box = sandbox();
    stubCli(join(box.bin, "claude"), box.log);
    const { dir, files } = earlierInstall(box);
    hookBody = null;
    try {
      const r = await run(box);
      expect(r.code).not.toBe(0);
      connectionIntact(dir, files);
    } finally {
      hookBody = HOOK_OK;
    }
  });

  test("a refused MCP entry leaves auth.header, client.env and hook.sh as they were, so no file points at the new host", async () => {
    const box = sandbox();
    stubCli(join(box.bin, "claude"), box.log, { refuseAdd: `${origin}/mcp` });
    const { dir, files } = earlierInstall(box);
    const r = await run(box);
    expect(r.code).not.toBe(0);
    connectionIntact(dir, files);
    expect(readFileSync(join(dir, "client.env"), "utf8")).not.toContain(origin);
  });

  test("a failed first install leaves none of the connection files; a good one keeps no token in client.env", async () => {
    const failing = sandbox();
    stubCli(join(failing.bin, "claude"), failing.log, { refuseAdd: "" });
    expect((await run(failing)).code).not.toBe(0);
    expect(readdirSync(join(failing.home, ".jamsesh")).filter((f) => ["auth.header", "client.env", "hook.sh"].includes(f) || f.startsWith(".saved"))).toEqual([]);
    const good = sandbox();
    stubCli(join(good.bin, "claude"), good.log);
    expect((await run(good)).code).toBe(0);
    expect(readFileSync(join(good.home, ".jamsesh/client.env"), "utf8")).not.toContain("tok");
    expect(readdirSync(join(good.home, ".jamsesh")).filter((f) => f.startsWith(".saved"))).toEqual([]);
  });

  /** An earlier install for another host that still works: its MCP entry (credential in a helper), settings and Codex config. */
  function earlierWholeInstall(box: ReturnType<typeof sandbox>) {
    const earlier = earlierInstall(box);
    const { dir } = earlier;
    writeFileSync(join(dir, "mcp-headers.json"), '{"authorization":"Bearer old-room"}', { mode: 0o600 });
    writeFileSync(join(dir, "mcp-headers.sh"), `#!/bin/sh\nexec cat '${dir}/mcp-headers.json'\n`, { mode: 0o700 });
    writeFileSync(join(box.home, ".claude.json"), JSON.stringify({ mcpServers: { jamsesh: { type: "http", url: "http://old-host:4747/mcp", headersHelper: join(dir, "mcp-headers.sh") } } }));
    mkdirSync(join(box.home, ".claude/skills/jamsesh"), { recursive: true });
    mkdirSync(join(box.home, ".codex"), { recursive: true });
    const extra = { ".claude/skills/jamsesh/SKILL.md": "old launcher\n", ".codex/config.toml": '[mcp_servers.jamsesh]\nurl = "http://old-host:4747/mcp"\n' };
    for (const [f, body] of Object.entries(extra)) writeFileSync(join(box.home, f), body);
    return { ...earlier, extra, mcp: { ...earlier.files, "mcp-headers.json": '{"authorization":"Bearer old-room"}' } };
  }
  /** A claude that records its arguments, keeps no state, and passes `mcp get`. */
  const okClaude = (box: ReturnType<typeof sandbox>) => stubCli(join(box.bin, "claude"), box.log);
  const earlierEntryBack = (box: ReturnType<typeof sandbox>) => {
    expect(JSON.parse(readFileSync(join(box.home, ".claude.json"), "utf8")).mcpServers.jamsesh.url).toBe("http://old-host:4747/mcp");
    expect(readFileSync(box.log, "utf8")).not.toContain("old-host");
  };

  test("settings that won't parse, after the MCP entry is in, undo the whole install", async () => {
    const box = sandbox();
    okClaude(box);
    const { dir, files, mcp, extra } = earlierWholeInstall(box);
    mkdirSync(join(box.home, ".claude"), { recursive: true });
    writeFileSync(join(box.home, ".claude/settings.json"), "{ not json");
    const r = await run(box);
    expect(r.code).not.toBe(0);
    connectionIntact(dir, files);
    for (const [f, body] of Object.entries(mcp)) expect(readFileSync(join(dir, f), "utf8")).toBe(body);
    for (const [f, body] of Object.entries(extra)) expect(readFileSync(join(box.home, f), "utf8")).toBe(body);
    expect(readFileSync(join(box.home, ".claude/settings.json"), "utf8")).toBe("{ not json");
    earlierEntryBack(box);
    expect(r.stdout).toContain("your earlier connection was put back");
    expect(r.stderr.split("\n").at(-1)).toContain("isn't valid JSON");
  });

  test("a failing Codex step undoes the Claude Code step too, including the Codex config", async () => {
    const box = sandbox();
    okClaude(box);
    const { dir, files, mcp, extra } = earlierWholeInstall(box);
    skillBody = null;
    try {
      const r = await run(box);
      expect(r.code).not.toBe(0);
      connectionIntact(dir, files);
      for (const [f, body] of Object.entries(mcp)) expect(readFileSync(join(dir, f), "utf8")).toBe(body);
      for (const [f, body] of Object.entries(extra)) expect(readFileSync(join(box.home, f), "utf8")).toBe(body);
      expect(existsSync(join(box.home, ".claude/commands/jamsesh.md"))).toBe(false);
      earlierEntryBack(box);
    } finally {
      skillBody = "# JamSesh skill\n";
    }
  });

  test("a symlinked Codex config is put back at its target on failure, and stays a link", async () => {
    const box = sandbox();
    okClaude(box);
    mkdirSync(join(box.home, ".codex"), { recursive: true });
    const target = join(box.home, "dotfiles-config.toml");
    writeFileSync(target, "model = \"x\"\n");
    symlinkSync(target, join(box.home, ".codex/config.toml"));
    skillBody = null;
    try {
      expect((await run(box)).code).not.toBe(0);
    } finally {
      skillBody = "# JamSesh skill\n";
    }
    expect(lstatSync(join(box.home, ".codex/config.toml")).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe('model = "x"\n');
  });

  test("when no agent is installed nothing is left behind", async () => {
    const box = sandbox();
    const r = await run(box);
    expect(r.code).not.toBe(0);
    expect(readdirSync(join(box.home, ".jamsesh")).filter((f) => f !== "setup.lock")).toEqual([]);
  });

  test("a restore that fails is reported by path, keeps its saved copy and exits non-zero, without claiming success", async () => {
    const box = sandbox();
    okClaude(box);
    const { dir } = earlierInstall(box);
    mkdirSync(join(box.home, ".claude"), { recursive: true });
    writeFileSync(join(box.home, ".claude/settings.json"), "{ not json");
    // A mv that lets the install put hook.sh in place but refuses the second time, when the rollback puts the earlier one back.
    writeFileSync(join(box.bin, "mv"), `#!/bin/sh\nfor last; do :; done\ncase "$last" in */hook.sh) [ -e "${box.log}.mv" ] && exit 1; : > "${box.log}.mv" ;; esac\nexec /bin/mv "$@"\n`, { mode: 0o755 });
    const r = await run(box);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain(`${dir}/hook.sh`);
    expect(r.stderr).toContain("couldn't put your earlier connection back completely");
    expect(r.stderr).not.toContain("nothing was changed");
    const saved = readdirSync(dir).filter((f) => f.startsWith(".saved"));
    expect(saved).toHaveLength(1);
    expect(readFileSync(join(dir, "auth.header"), "utf8")).toBe("authorization: Bearer old-room\n");
    // No half-made temporary file is left beside it.
    expect(readdirSync(dir).filter((f) => /^hook\.sh\./.test(f))).toEqual([]);
  });

  test("a file someone else changed while setup ran is left as it is and listed; the rest is put back", async () => {
    const box = sandbox();
    const dir = join(box.home, ".jamsesh");
    const { files } = earlierInstall(box);
    mkdirSync(join(box.home, ".claude"), { recursive: true });
    mkdirSync(join(box.home, ".codex"), { recursive: true });
    writeFileSync(join(box.home, ".claude/settings.json"), "{ not json");
    writeFileSync(join(box.home, ".codex/config.toml"), "model = \"mine\"\n");
    // While the MCP entry is being added, a person saves client.env and edits the Codex config (setup never reaches it).
    writeFileSync(join(box.bin, "claude"), `#!/bin/sh\ncase "$*" in *"add-json"*) echo theirs > "$HOME/.jamsesh/client.env"; echo 'model = "edited meanwhile"' > "$HOME/.codex/config.toml" ;; esac\nexit 0\n`, { mode: 0o755 });
    const r = await run(box);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("Changed by someone else while setup ran");
    expect(r.stderr).toContain(`${dir}/client.env`);
    expect(readFileSync(join(dir, "client.env"), "utf8")).toBe("theirs\n");
    expect(readFileSync(join(dir, "auth.header"), "utf8")).toBe(files["auth.header"]);
    expect(readFileSync(join(dir, "hook.sh"), "utf8")).toBe(files["hook.sh"]);
    // Never written by setup, so never touched by its rollback.
    expect(readFileSync(join(box.home, ".codex/config.toml"), "utf8")).toBe('model = "edited meanwhile"\n');
  });

  test("a rollback keeps what Claude Code wrote to ~/.claude.json meanwhile, and only puts the jamsesh key back", async () => {
    const box = sandbox();
    const entry = { type: "http", url: "http://old-host:4747/mcp" };
    writeFileSync(join(box.home, ".claude.json"), JSON.stringify({ numStartups: 1, mcpServers: { jamsesh: entry } }));
    // The add is refused, but Claude Code (the stub) saved its own settings in the same file first.
    writeFileSync(join(box.bin, "claude"), `#!/bin/sh\ncase "$*" in *"mcp remove"*|*"add-json"*) perl -MJSON::PP -e 'my $c = "$ENV{HOME}/.claude.json"; open my $f, "<", $c; local $/; my $d = decode_json(<$f>); delete $d->{mcpServers}{jamsesh}; $d->{numStartups} = 7; $d->{newKey} = "kept"; open my $o, ">", $c; print $o encode_json($d)' ;; esac\ncase "$*" in *"add-json"*) exit 1 ;; esac\nexit 0\n`, { mode: 0o755 });
    const r = await run(box);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("the earlier one was put back");
    const after = JSON.parse(readFileSync(join(box.home, ".claude.json"), "utf8"));
    expect(after).toEqual({ numStartups: 7, newKey: "kept", mcpServers: { jamsesh: entry } });
  });

  test("the entry is judged from the user-scope key in the file: another jamsesh entry elsewhere proves nothing", async () => {
    const box = sandbox();
    stubCli(join(box.bin, "claude"), box.log, { refuseAdd: `${origin}/mcp` });
    const project = { "/some/project": { mcpServers: { jamsesh: { type: "http", url: "http://project/mcp" } } } };
    writeFileSync(join(box.home, ".claude.json"), JSON.stringify({ projects: project }));
    const r = await run(box);
    expect(r.code).not.toBe(0);
    // There was no user-scope entry before; the CLI would have said one exists (the project's), the file says none does.
    expect(r.stderr).toContain("none is registered");
    const after = JSON.parse(readFileSync(join(box.home, ".claude.json"), "utf8"));
    expect(after.mcpServers?.jamsesh).toBeUndefined();
    expect(after.projects).toEqual(project);
  });

  test("an entry someone else set while setup ran is not overwritten by the rollback", async () => {
    const box = sandbox();
    writeFileSync(join(box.home, ".claude.json"), JSON.stringify({ mcpServers: { jamsesh: { type: "http", url: "http://old-host:4747/mcp" } } }));
    writeFileSync(join(box.bin, "claude"), `#!/bin/sh\ncase "$*" in *"add-json"*) perl -MJSON::PP -e 'my $c = "$ENV{HOME}/.claude.json"; open my $o, ">", $c; print $o encode_json({ mcpServers => { jamsesh => { type => "http", url => "http://theirs/mcp" } } })'; exit 1 ;; esac\nexit 0\n`, { mode: 0o755 });
    const r = await run(box);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("was changed by someone else");
    expect(JSON.parse(readFileSync(join(box.home, ".claude.json"), "utf8")).mcpServers.jamsesh.url).toBe("http://theirs/mcp");
  });

  test("a link that leads to CLAUDE.md or AGENTS.md is never written through, and nothing else is left changed", async () => {
    for (const [link, target] of [
      [".claude/skills/jamsesh/SKILL.md", ".claude/CLAUDE.md"],
      [".claude/commands/jamsesh.md", ".claude/CLAUDE.md"],
      [".codex/prompts/jamsesh.md", ".codex/AGENTS.md"],
      [".codex/skills/jamsesh/SKILL.md", ".codex/AGENTS.md"],
    ]) {
      const box = sandbox();
      stubCli(join(box.bin, "claude"), box.log);
      for (const d of [".claude/skills/jamsesh", ".claude/commands", ".codex/prompts", ".codex/skills/jamsesh"]) mkdirSync(join(box.home, d), { recursive: true });
      writeFileSync(join(box.home, target), "my own rules\n");
      symlinkSync(join(box.home, target), join(box.home, link));
      const { dir, files } = earlierInstall(box);
      const r = await run(box);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("instruction file");
      expect(readFileSync(join(box.home, target), "utf8")).toBe("my own rules\n");
      expect(lstatSync(join(box.home, link)).isSymbolicLink()).toBe(true);
      connectionIntact(dir, files);
    }
  }, 60_000);

  test("a folder where setup would put a file is refused, and nothing is put inside it or left changed", async () => {
    const box = sandbox();
    stubCli(join(box.bin, "claude"), box.log);
    mkdirSync(join(box.home, ".claude/commands/jamsesh.md"), { recursive: true });
    const { dir, files } = earlierInstall(box);
    const r = await run(box);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("it is a folder");
    expect(readdirSync(join(box.home, ".claude/commands/jamsesh.md"))).toEqual([]);
    connectionIntact(dir, files);
  });

  test("a folder that took a written file's place by the rollback is left as it is and listed", async () => {
    const box = sandbox();
    const { dir } = earlierInstall(box);
    mkdirSync(join(box.home, ".claude"), { recursive: true });
    writeFileSync(join(box.home, ".claude/settings.json"), "{ not json");
    writeFileSync(join(box.bin, "claude"), `#!/bin/sh\ncase "$*" in *"add-json"*) rm -f "$HOME/.jamsesh/client.env"; mkdir "$HOME/.jamsesh/client.env" ;; esac\nexit 0\n`, { mode: 0o755 });
    const r = await run(box);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain(`Changed by someone else while setup ran, so not put back: ${dir}/client.env`);
    expect(readdirSync(join(dir, "client.env"))).toEqual([]);
  });

  test("a ~/.claude.json that is a link to an instruction file is never written by the rollback", async () => {
    const box = sandbox();
    mkdirSync(join(box.home, ".claude"), { recursive: true });
    // Contrived so that it parses: the point is that the rollback's one edit of that file passes the guard.
    const rules = join(box.home, ".claude/CLAUDE.md");
    writeFileSync(rules, "{}");
    symlinkSync(rules, join(box.home, ".claude.json"));
    stubCli(join(box.bin, "claude"), box.log);
    writeFileSync(join(box.home, ".claude/settings.json"), "{ not json");
    const r = await run(box);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("instruction file");
    expect(r.stderr).toContain("couldn't put the jamsesh entry");
    // What the CLI (the stub) wrote through the link is all that changed; setup's rollback didn't rewrite it.
    expect(JSON.parse(readFileSync(rules, "utf8")).mcpServers.jamsesh.url).toBe(`${origin}/mcp`);
    expect(lstatSync(join(box.home, ".claude.json")).isSymbolicLink()).toBe(true);
  });

  test("a setup lock that is a link is refused before anything is written", async () => {
    const box = sandbox();
    stubCli(join(box.bin, "claude"), box.log);
    const { dir, files } = earlierInstall(box);
    symlinkSync(join(box.home, ".claude/CLAUDE.md"), join(dir, "setup.lock"));
    const r = await run(box);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("it is a link");
    expect(existsSync(join(box.home, ".claude/CLAUDE.md"))).toBe(false);
    connectionIntact(dir, files);
  });

  test("a link that leads outside the home folder is refused", async () => {
    const box = sandbox();
    stubCli(join(box.bin, "claude"), box.log);
    const outside = mkdtempSync(join(tmpdir(), "jamsesh-outside-"));
    writeFileSync(join(outside, "x"), "keep\n");
    mkdirSync(join(box.home, ".claude/commands"), { recursive: true });
    symlinkSync(join(outside, "x"), join(box.home, ".claude/commands/jamsesh.md"));
    const r = await run(box);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("outside your home folder");
    expect(readFileSync(join(outside, "x"), "utf8")).toBe("keep\n");
  });

  test("a symlinked settings file is replaced at its target, a link stays a link, and an unchanged file is not touched", async () => {
    const box = sandbox();
    stubCli(join(box.bin, "claude"), box.log);
    mkdirSync(join(box.home, ".claude"), { recursive: true });
    const target = join(box.home, "dotfiles-settings.json");
    writeFileSync(target, '{"theme":"dark"}');
    symlinkSync(target, join(box.home, ".claude/settings.json"));
    expect((await run(box)).code).toBe(0);
    expect(lstatSync(join(box.home, ".claude/settings.json")).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(target, "utf8")).theme).toBe("dark");
    expect(JSON.parse(readFileSync(target, "utf8")).hooks).toBeDefined();
  });

  test("a first install that fails later has its entry removed again, read back from the file", async () => {
    const box = sandbox();
    stubCli(join(box.bin, "claude"), box.log);
    mkdirSync(join(box.home, ".claude"), { recursive: true });
    writeFileSync(join(box.home, ".claude/settings.json"), "{ not json");
    const r = await run(box);
    expect(r.code).not.toBe(0);
    expect(JSON.parse(readFileSync(join(box.home, ".claude.json"), "utf8")).mcpServers.jamsesh).toBeUndefined();
  });

  test("an earlier entry with extra secret headers goes back whole, with none of them in any command", async () => {
    const box = sandbox();
    stubCli(join(box.bin, "claude"), box.log, { refuseAdd: `${origin}/mcp` });
    const entry = { type: "http", url: "http://old-host:4747/mcp/s3cret-path", headers: { Authorization: "Bearer a-secret", "X-Api-Key": "k-secret" } };
    writeFileSync(join(box.home, ".claude.json"), JSON.stringify({ mcpServers: { jamsesh: entry } }));
    expect((await run(box)).code).not.toBe(0);
    expect(readFileSync(box.log, "utf8")).not.toMatch(/a-secret|k-secret|s3cret-path/);
    expect(JSON.parse(readFileSync(join(box.home, ".claude.json"), "utf8")).mcpServers.jamsesh).toEqual(entry);
  });

  test("an earlier entry whose secret is in env (or the address) is written back to Claude Code's config, never passed as an argument", async () => {
    const box = sandbox();
    const config = join(box.home, ".claude.json");
    const entry = { type: "stdio", command: "old-jamsesh", args: ["--token", "arg-secret"], env: { TOKEN: "env-secret" } };
    writeFileSync(config, JSON.stringify({ other: 1, mcpServers: { jamsesh: entry, keep: { type: "http", url: "http://keep/mcp" } } }), { mode: 0o600 });
    stubCli(join(box.bin, "claude"), box.log, { refuseAdd: `${origin}/mcp` });
    const r = await run(box);
    expect(r.code).not.toBe(0);
    expect(readFileSync(box.log, "utf8")).not.toMatch(/env-secret|arg-secret/);
    expect(r.stderr).not.toMatch(/env-secret|arg-secret/);
    const after = JSON.parse(readFileSync(config, "utf8"));
    expect(after.mcpServers.jamsesh).toEqual(entry);
    expect(after.mcpServers.keep).toEqual({ type: "http", url: "http://keep/mcp" });
    expect(after.other).toBe(1);
    expect(statSync(config).mode & 0o777).toBe(0o600);
    expect(r.stdout + r.stderr).toContain("put back");
  });

  /** A process that holds the setup lock until killed (the way a running setup does). */
  async function holdLock(dir: string) {
    mkdirSync(dir, { recursive: true });
    const holder = Bun.spawn(["perl", "-MFcntl=:flock", "-e", '$| = 1; open(F, ">>", $ARGV[0]) or die; flock(F, LOCK_EX) or die; print "held\\n"; sleep 60', join(dir, "setup.lock")], { stdout: "pipe" });
    const reader = holder.stdout.getReader();
    await reader.read();
    return holder;
  }

  test("a second setup waits, then says another is running, and leaves the first one's files alone", async () => {
    const box = sandbox();
    stubCli(join(box.bin, "claude"), box.log);
    const dir = join(box.home, ".jamsesh");
    const holder = await holdLock(dir);
    try {
      writeFileSync(join(dir, "client.env"), "mine\n");
      const r = await run(box, "Felipe", { JAMSESH_LOCK_WAIT: "1" });
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("Another JamSesh setup is running");
      expect(readFileSync(join(dir, "client.env"), "utf8")).toBe("mine\n");
      expect(readdirSync(dir).filter((f) => f.startsWith(".saved"))).toEqual([]);
    } finally {
      holder.kill();
    }
    // The holder is gone and so is its lock: the next setup just runs.
    expect((await run(box)).code).toBe(0);
  });

  test("a lock file left by a run that died holds nothing, and a failed setup releases its lock too", async () => {
    const box = sandbox();
    stubCli(join(box.bin, "claude"), box.log);
    const dir = join(box.home, ".jamsesh");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "setup.lock"), "999999\n");
    expect((await run(box)).code).toBe(0);
    hookBody = null;
    try {
      expect((await run(box)).code).not.toBe(0);
    } finally {
      hookBody = HOOK_OK;
    }
    expect((await run(box)).code).toBe(0);
  });

  test("two setups started at once against a stale lock never run at the same time, twenty times over", async () => {
    // A setup's transaction is open from the moment its saved folder is made (just after the lock) until it
    // is removed at the end. Every CLI call takes a moment and checks that its run's folder is the only one.
    const marker = (box: ReturnType<typeof sandbox>) => {
      writeFileSync(join(box.bin, "claude"), `#!/bin/sh\nn="$(ls -d "$HOME"/.jamsesh/.saved.* 2>/dev/null | wc -l)"\n[ "$n" -eq 1 ] || echo "overlap $n" >> "${box.log}.overlap"\nsleep 0.1\nexit 0\n`, { mode: 0o755 });
    };
    for (let i = 0; i < 20; i++) {
      const box = sandbox();
      marker(box);
      mkdirSync(join(box.home, ".jamsesh"), { recursive: true });
      writeFileSync(join(box.home, ".jamsesh/setup.lock"), "999999\n");
      const [a, b] = await Promise.all([run(box), run(box)]);
      expect([a.code, b.code]).toEqual([0, 0]);
      expect(existsSync(`${box.log}.overlap`)).toBe(false);
    }
  }, 240_000);
});
