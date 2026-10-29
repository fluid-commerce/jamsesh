# Ground rules for every Phase 6 worker (read fully)

Project: JamSesh, inside the FigCraft repo. Hub = Bun/TS in `jamsesh/hub/src`, web = React 19 in `jamsesh/web/src`, Mac app = Tauri 2 in `jamsesh/app/src-tauri`. Plan: `/Users/cheyrasmussen/jamsesh/jamsesh-improvement-plan.md` (Phase 6 section). Specs: `jamsesh/SPEC.md`, `jamsesh/STATUS.md`, agent skill text in `jamsesh/skill/`.

## Never disturb the live room
- A real JamSesh session is running on this machine. NEVER connect to 127.0.0.1:4790 or :4747, never call any `jamsesh` MCP tool, never write to `~/.jamsesh`, never stop the `jamsesh-app` process, never edit `~/.claude/skills/jamsesh` or `~/.claude/CLAUDE.md` or `~/chey-skills`.
- Test hubs use throwaway dirs and ports: `JAMSESH_HOME`, `JAMSESH_DATA` (mktemp), `JAMSESH_PORT`, `JAMSESH_FIGCRAFT_PORT`, `JAMSESH_DEV_PORT_START`, `JAMSESH_OFFLINE=1`, `JAMSESH_BONJOUR_SERVICE=_jamsesh-test._tcp`. Kill any hub you start before you finish.

## Silent: Chey is asleep
- Nothing may play sound. Always export `JAMSESH_SILENT=1`. Never run `say`, `afplay`, or a browser without `--mute-audio`.

## Tests
- Run ONLY the test files you touch or add, each with a time limit: `perl -e 'alarm 180; exec @ARGV' bun test hub/test/<file>.test.ts` from `jamsesh/`. Never run the whole hub suite (the lead does that; overlapping full runs hung the machine before). `hub/test/audio.bench.test.ts` is slow; don't run it.
- Web: `cd jamsesh/web && perl -e 'alarm 180; exec @ARGV' bun test`. Typecheck: `bunx tsc --noEmit -p .` in `jamsesh/hub` and `jamsesh/web`.
- Every behaviour change gets a test. Bug fixes get a regression test.
- For UI changes, look at the result: run a throwaway test hub plus the web dev build and screenshot with headless Playwright (`NODE_PATH=$(npm root -g) node script.cjs`, chromium launched with `args:['--mute-audio']`), then Read the PNG. Fix what looks off.

## Code
- Match the surrounding code's style, comment density and naming. Every line earns its keep. No new dependencies unless unavoidable (say why).
- UI copy: plain, short, sentence case, no exclamation marks.
- Commit on your own branch only, small commits, messages like `JamSesh 2.1: <what>`, ending with the line:
  `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`
- Don't push. Don't merge. Don't touch files owned by another worker (listed in your brief) unless a one-line hook is unavoidable; then say so in your report.
- Use `/usr/bin/grep`, `/usr/bin/tail`, `/bin/mv -f` (shell aliases interfere).

## Report
End with: what you built (per item), files changed, tests added and their results, screenshots you checked, anything left undone or uncertain, and any item that needs a real room (for the office checklist).
- Stop only processes you started, by PID. Never use `pkill -f` or `killall` with a pattern; other workers and the lead's reviews share this machine.
- Test the unhappy paths, not just the scripted flow. For every new route or tool, cover a caller who isn't allowed (another device, an agent acting as a person, an unjoined chat), a lost or repeated request, and multiple targets. For every UI action, test the real client call path (the `api()` helper), not only the session method underneath.
- Any shell script that is installed on people's machines must never `source` or `eval` text that came from the room, and must keep tokens out of process arguments.
