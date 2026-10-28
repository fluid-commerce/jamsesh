JamSesh's agent and host-machine area is not fulfilled yet. The spec covers most of it but misstates or over-claims several things, and the code has gaps that would hurt in a first real session. I read the code and cited lines. I ran nothing apart from two read-only checks: `codex mcp list`, which accepted the generated Codex config, and a `codesign` inspection of the built app. This machine is already set up, with the hub on the Mac app's local relay at `127.0.0.1:4790`.

## Findings, ranked by how much they'd hurt tomorrow

**G1. major / bug + spec-wrong. Host-build approval fires on ordinary speech or a normal prompt to an agent.** Requirements: A33a, A33b.
- Evidence:
  - `buildVerdict` in `hub/src/brain/brain.ts:905-917` accepts any person line of ten words or fewer that matches `go ahead`, `build it`, `not now` and similar. It does not require the brain's name.
  - The prompt hook creates a `prompt` event with `authorType:"person"` (`hub/src/hub.ts:366-375`) and passes it to `brain.hear`, which approves or denies at `brain.ts:90-96`. So what someone types to their own Claude counts, and so does an agent calling `/api/hooks/prompt` with a fake prompt.
- What's wrong: while one build waits (up to 10 minutes), someone saying "ok go ahead and mock that up" in the room, or typing "go ahead" to their own Claude, runs an arbitrary agent-supplied shell command on the host. The requesting agent can also approve itself by posting a fake prompt. `SPEC.md` 8.11 sanctions the "whether or not it names the brain" behaviour and also says agents "can't approve" (8.11 and section 14), which is false for the hook channel.
- Fix:
  - Exclude `prompt` events from verdicts.
  - Require the brain name, or the exact phrase "approve <agent name>", or an answer within a few seconds of the spoken request.
  - Have the spoken request include the agent and repo.
  - Update 8.11 to match.

**G2. major / code-gap + spec-wrong. "Agents can't approve" is not enforced for agents on the host or behind a Mac's relay.** Requirements: A33a.
- Evidence:
  - `hub/src/http.ts:515-521` lets any loopback request approve a build.
  - `app/src-tauri/src/proxy.rs:146-153` injects the Mac's browser token into any request without credentials.
  - `SPEC.md` section 14 claims requests "through a Mac's relay on behalf of an agent" never approve.
- What's wrong: an agent running on the host, or on any Mac with the app, can curl `/api/build-requests/<id>` and approve its own build. The relay can't tell an agent's request from a person's.
- Fix:
  - Make approval a UI-only action with a one-time nonce delivered over the WebSocket to people's windows.
  - Alternatively, have the relay tag agent traffic by path (MCP, hooks, `/agent`) and have the hub refuse approvals from it.

**G3. major / bug + spec-wrong. The shell guard is weak and §14 over-claims.** Requirements: B41, B44, A33.
- Evidence:
  - `personAsked = batch.some(e => e.authorType === "person")` (`brain.ts:328`) gates `shell` (`:465`) and `build_preview` (`:480`).
  - In `brain.ts`, `batch` is whatever lines were debounced together.
- What's wrong:
  - Any person line in the batch, such as banter next to an agent's untrusted update or repo-card text, lets the model run a zsh command.
  - `SPEC.md` section 14 says "every command it runs needs a person's approval". In reality `open_app`, `open_url`, `arrange` and `simulator` need none, and `shell` only needs someone to have spoken.
- Fix:
  - Require that the triggering line is itself classed as a directive that names the action.
  - Otherwise ask with "say approve" and use the same verdict flow as builds.
  - Reword section 14.

**G4. major / bug. Arranging windows right after opening an app usually fails.** Requirements: B42, A29c.
- Evidence: in `arrange` (`hub/src/hostctl.ts:187` onward), the loop does `open -a`, then immediately `set position of window 1`. A freshly launched app has no window yet.
- What's wrong: "bring up the Electron app next to Expo" is the headline demo. It gets "Arranged with problems", and the process name often differs from the app name (Electron, Code).
- Fix: after opening, poll System Events up to about 10 seconds for `count of windows > 0`, and resolve the process name from the bundle.
- Related: the brain is never told when a preview build finishes (the build completion is only logged and toasted), so it can't arrange the result.

**G5. major / spec-wrong + code-gap. Piloting the Simulator and apps is claimed but doesn't exist.** Requirements: the brief's "piloting that iPhone simulator", B44, B45b.
- Evidence: `SPEC.md` 13.2 states tap, swipe, type and click as present tense. The coverage table lists B45b as Missing. `hostctl.ts` `HostAction` has no such action.
- Fix:
  - Reword 13.2 as not built.
  - Add `sim_tap`, `sim_swipe`, `sim_type` and `sim_screenshot`, via `idb` or System Events clicks mapped to the Simulator window.
  - Add click, type and screenshot for windows.

**G6. major / code-gap. A new Claude or Codex session in an already-joined repo gets no skill.** Requirements: B8, the brief's skill requirement.
- Evidence: `registerAgent` resumes by machine, cwd and harness, so `resumed` is true (`hub/src/mcp.ts:334`). The briefing then says "the JamSesh skill is in your context already" (`mcp.ts:535-550`) and omits the skill text.
- What's wrong:
  - Every repo anyone joined tonight is "resumed" tomorrow.
  - Codex has no auto-loaded skill, only a prompt file.
  - A fresh conversation therefore never gets the design-system and mockup-versus-build rules.
- Fix: always include a short skill digest (the connect, loop, explore versus implement, and check-your-work rules) and the full text on request. Better, key the "first join" on the MCP session or conversation, not the agent record.

**G7. major / spec-wrong. Codex is documented with hooks but gets none.** Requirements: B24, B14, A30.
- Evidence: `SPEC.md` 4.5 says Codex gets "prompt-capture and turn-end hooks equivalent to Claude Code's". `hub/src/install-scripts.ts:129-180` installs only the MCP block, a prompt file and `AGENTS.md`. `codex features list` shows hooks are stable in codex-cli 0.158.0.
- What's wrong: Codex users' prompts never reach the room, and directives reach them only through `jam_wait`.
- Fix: install Codex hooks, or correct the spec. Also say in the skill that Codex must loop `jam_wait`.

**G8. major / bug. Dev-server LAN ports are unauthenticated, and the spec says they're locked down.** Requirements: B18, §14.
- Evidence:
  - `hub/src/devproxy.ts:62-66` is a raw TCP listener on `0.0.0.0:5100` and up, with no auth. The registered URL is `http://<lan>:<port>`.
  - `SPEC.md` 6.6 and 14 say the LAN ports refuse anyone who isn't paired. Only the `dev-<port>.<domain>` subdomain checks a token (`http.ts:47-52`).
- What's wrong:
  - Anyone on the office or cafe network can open every coworker's dev server.
  - `jam_devserver` accepts any host:port, so an agent can point the forwarder at internal addresses.
- Fix: bind the forwarders to 127.0.0.1 and always serve through an authenticated hub route. Restrict targets to the agent's own machine address, and fix the spec.

**G9. major / bug. Dev-server tiles break for remote users in the Mac join app.** Requirements: B18, A18, A4b.
- Evidence: `web/src/shared/ui.tsx:51-60` (`localize`) only rewrites for `https:` pages. The join window is `http://127.0.0.1:4790`, and the code explicitly skips `127.0.0.1`.
- What's wrong: a remote coworker using the Mac app gets `http://192.168.x.x:5100`, which doesn't load. The relay doesn't carry dev ports.
- Fix: route dev servers through the hub (`/dev/<port>/…` on the relayed origin) for every client.

**G10. minor / bug. `jam_wait` accepts up to 540 seconds, but the server idle timeout is 255 seconds.**
- Evidence: `mcp.ts:396` and `http.ts:36`.
- What's wrong: keep-alives are sent only if the client supplies a progress token. A call with `seconds` above about 250 gets the connection dropped.
- Fix: clamp to 230, in both the spec and the tool description.

**G11. major / ux. Nothing makes an idle agent reachable, and nothing verifies the "check your work" rules.** Requirements: the brief's "wait for directives", B30, B31, B14.
- Evidence: the Stop hook returns `{}` when nothing is pending (`hub.ts:397-405`). Delivery to an idle agent depends on the model obeying "keep calling `jam_wait`". The design-system and mockup-versus-build checks live only in `skill/SKILL.md`.
- What's wrong: once an agent ends its turn it is unreachable until its person types. After 20 minutes it shows as offline and loses routing.
- Fix:
  - While the agent is in a live session, have the Stop hook return a block with "call jam_wait" (guard on `stop_hook_active`).
  - Add server-side nudges: `jam_update done` without a canvas render, or `shipped` without a "(built)" screenshot from that agent, returns a warning.

**G12. minor / bug. Spec says an agent can remove its own dev server, but there's no tool.**
- Evidence: `devproxy.remove` has no caller, and there is no route for it (`http.ts`).
- Fix: add `jam_devserver_remove`, or auto-remove entries that stay down for a while, since a failing target keeps its listener.

**G13. minor / bug. Local inference is overstated.** Requirements: B28a, B28b.
- Evidence:
  - `SPEC.md` section 15 says clients run whisper.cpp and register via `/api/workers`, and that the speech model "downloads on first use". The table marks B28b Missing.
  - Whisper needs `/opt/homebrew/bin/whisper-server` plus a model in `~/.cache/whisper-cpp` (`config.ts:99-106`). Only `install.sh:42-44` downloads one, and the app bundle ships neither.
  - The Settings text "then on laptops that offer theirs" is wrong too.
- Fix: on a Mac mini installed from the DMG, either download the model and binary on first host start or say "gateway only". Reword section 15 and the Settings help.

**G14. minor / bug. Pending claims that aren't true.**
- `jam_show` says the request is "queued as a toast" when the screen is pinned (`mcp.ts:503`), but nothing is queued.
- `jam_show` has no guard against overriding a room request made seconds ago, unlike `artifactsLanded`.
- `noteActivity` counts batch steps using `args.steps` and `s.tool` (`canvas.ts:399`), while the real schema is `commands` and `command`.
- `place` (`canvas.ts:375`) ignores frames created through `run_command node.create`.
- Fix: send the toast, add a recency guard, and align the schema names.

**G15. minor / ux. Names and titles.** Requirements: A13, A15.
- Evidence: `registerAgent` (`session.ts:300-302`) doesn't check default names for uniqueness, so two people named Sam both get "Sam's Claude". `jam_rename` lets an agent set its person's title, which maps to a decision weight (`session.ts` `weightForRole`) without that person confirming.
- Fix: suffix duplicates at join, and confirm titles in the person's window.

**G16. minor / ux. The hook outbox grows without bound.**
- Evidence: `install-scripts.ts:19-25`. Every prompt is queued when the hub is unreachable and replayed with new timestamps. `JAMSESH_ACTIVE=1` stays on forever.
- What's wrong: stale prompts from days earlier can land in a later session's context. With a remote host that's unreachable, each prompt and each stop also waits up to 3 seconds.
- Fix: age out entries older than about 10 minutes, cap the file, and set the flag only while a session is live.

**G17. minor / spec-missing. Gaps in what the spec and skill cover.**
- Credentials in remotes: a remote like `https://user:token@…` passes the regex and ends up in rosters and on screen.
  - Strip userinfo at join.
- Expo: `expo start --lan` serves a Metro manifest, not a viewable page.
  - Say to use `--web` for the live tile or `exp://` on the host Simulator, and post Simulator screenshots.
- Offline gateway: cross-repo coordination after a `shipped` needs the gateway.
  - Section 8.13 doesn't say so.
- Canvas guardrails: agents can call `canvas_run_command` with `file.*` and `collab.*` commands.
  - Block them for agents.
- Relay port: the relay prefers 4790 but falls back to a random port, and the setup script writes the port at that moment.
  - If 4790 is ever taken, "connect to jamsesh" fails with a misleading "open the app".

**G18. minor. First-run friction for coworkers.** Setup requires restarting Claude or Codex, and the app is ad-hoc signed, so a DMG downloaded from the host will be quarantined by Gatekeeper. Tell coworkers to use the browser view, or to right-click Open or use Open Anyway.

## Spec coverage and what I verified

**Checked and fine**
- Join, claim, inbox, wait, ack, update, message, ask, answer, repo card, `jam_show` and `jam_post_image` match section 6.2.
- Baked-in rules:
  - canvas page-per-workstream
  - frame naming
  - clear-space placement
  - explore versus implement hints
  - the design-system and build-versus-mockup checks (skill only)
  - the rule against acting on banter
- The MCP tool set, setup scripts, `/jamsesh` command, Claude hooks and Codex MCP config all exist and match what the spec describes, apart from the Codex hooks (G7).
- `claude mcp list` shows `jamsesh` connected.
- Preview builds: `https`/`git@`/`ssh` remote check, one pending request per agent, 10-minute expiry, spoken twice, and "words before the request don't count".
- The display and big-screen aspect-ratio reporting works as described.
- The hardened-runtime concern for the bundled Bun hub does not apply: the hub binary isn't signed with the hardened-runtime flag.

**Spec accurate, code honestly incomplete**
- B45b and B28b are marked Missing in the table.
- A29d is marked Partial.

**Verdict.** The spec is incomplete or wrong in G1, G2, G3, G5, G7, G8 and G13 (sections 8.11, 13.2, 14, 4.5, 6.6 and 15). It is only partly fulfilled in the code. Joining, messaging, asking, claiming, dev-server registration, preview builds with approval, window arranging and the permissions flow all exist. The brief's "pilot the Simulator" does not, the approval gate is much weaker than the spec says, and cross-session skill delivery and idle-agent reachability depend on the model behaving.

Fix first, before the session:
1. G1 and G2 (the approval gate).
2. G4 and G6 (arranging windows, and the skill for returning agents).
3. G8 and G9 (dev-server access).