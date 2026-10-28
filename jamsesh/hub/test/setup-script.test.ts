// Runs the real /agent/setup.sh against a throwaway home folder: finding agent CLIs that aren't on
// PATH, never wiping a settings file it can't parse, and failing when no agent was set up.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hub } from "../src/hub";
import { hookScript, joinScript } from "../src/install-scripts";

let server: ReturnType<typeof Bun.serve>;
let origin = "";
let people = 0;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/hook.sh") return new Response("#!/usr/bin/env bash\nexit 0\n");
      if (path === "/skill.md") return new Response("# JamSesh skill\n");
      if (path === "/api/me") return Response.json({ person: { id: "p_1", name: "Chey" } });
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

async function run(box: ReturnType<typeof sandbox>) {
  const proc = Bun.spawn(["/bin/bash", "-c", joinScript({} as Hub, origin, "tok")], {
    env: { HOME: box.home, PATH: `${box.bin}:/usr/bin:/bin`, JAMSESH_NAME: "Felipe", JAMSESH_CLI_DIRS: box.bin },
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
    expect(data.hooks.Stop.map((e: { hooks: { command: string }[] }) => e.hooks[0]!.command)).toEqual(["mine.sh", `${box.home}/.jamsesh/hook.sh stop`]);
    expect(data.hooks.UserPromptSubmit).toHaveLength(1);
    expect(existsSync(`${settings}.jamsesh-tmp`)).toBe(false);
    expect(readFileSync(box.log, "utf8")).toContain(`mcp add --transport http -s user jamsesh ${origin}/mcp`);
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
    expect(readFileSync(join(box.home, ".jamsesh/client.env"), "utf8")).toContain('JAMSESH_NAME="Chey"');
  });

  test("the hook keeps Claude Code's own notices out of the room", async () => {
    const box = sandbox();
    const posted: string[] = [];
    const hub = Bun.serve({ port: 0, fetch: async (req) => (posted.push(await req.text()), Response.json({ ok: true })) });
    try {
      const env = join(box.home, "client.env");
      writeFileSync(env, `JAMSESH_HUB="http://127.0.0.1:${hub.port}"\nJAMSESH_TOKEN="t"\nJAMSESH_ACTIVE=1\n`);
      const hook = async (prompt: string) => {
        const proc = Bun.spawn(["/bin/bash", "-c", hookScript({} as Hub), "hook", "prompt"], {
          env: { HOME: box.home, PATH: "/usr/bin:/bin", JAMSESH_CLIENT_ENV: env, JAMSESH_DIR: box.home },
          stdin: new Blob([JSON.stringify({ prompt })]),
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

  test("Codex: replaces its earlier JamSesh server and instructions once", async () => {
    const box = sandbox();
    mkdirSync(join(box.home, ".codex"), { recursive: true });
    const config = join(box.home, ".codex/config.toml");
    const agents = join(box.home, ".codex/AGENTS.md");
    writeFileSync(config, 'model = "gpt"\n\n[mcp_servers.jamsesh]\nurl = "http://old/mcp"\n\n[mcp_servers.jamsesh.http_headers]\nauthorization = "Bearer old"\n\n[mcp_servers.other]\nurl = "http://x"\n');
    writeFileSync(agents, "# Mine\n\n<!-- jamsesh:start -->\nold\n<!-- jamsesh:end -->\n");
    for (let i = 0; i < 2; i++) expect((await run(box)).code).toBe(0);
    const toml = readFileSync(config, "utf8");
    expect(toml).toContain('model = "gpt"');
    expect(toml).toContain("[mcp_servers.other]");
    expect(toml).not.toContain("http://old/mcp");
    expect(toml.match(/\[mcp_servers\.jamsesh\]/g)).toHaveLength(1);
    expect(toml).toContain(`url = "${origin}/mcp"`);
    expect(toml).toContain('authorization = "Bearer tok"');
    const md = readFileSync(agents, "utf8");
    expect(md.startsWith("# Mine\n\n<!-- jamsesh:start -->")).toBe(true);
    expect(md.match(/jamsesh:start/g)).toHaveLength(1);
    expect(md).not.toContain("old");
  });
});
