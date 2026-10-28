All G-findings in my area are done except G5 (partly), G13 and G15, and G7 is a spec correction only; the three items you asked me to skip (G1-G3) are untouched. Both `tsc` checks are clean, the 8 new hub tests pass, and the hub run on port 4873 is stopped. I did not run `vite build`. I also did not run the existing hub or web test suites.

**G4 (arranging after opening an app).** `arrange` in `hostctl.ts` now opens every app first. It then finds each app's process by bundle id or a name match (so Electron and Code resolve) and polls up to 15 seconds for a real window. It sets the window and reads the size back, and tells you when an app has a larger minimum size. Failures now say why: not running, no window yet, or a missing Accessibility grant. I could not run the System Events placement here because Accessibility isn't granted to osascript on this Mac. I added an `onBuilt(label, ok, text)` callback to `HostControl` for when a preview build finishes. The `open` path of a build is now restricted to the checkout.

**G5 (piloting the Simulator and apps).** Real and tested here: `sim_screenshot` (a simctl PNG, with a callback to show it to the room) and `sim_launch`. Also real: the existing `simulator` action for boot and open URL, and `screenshot` of the host screen or one app's window (needs Screen Recording for JamSesh).

Built but unverified, because Accessibility isn't granted here:
- **Taps and swipes:** `sim_tap` and `sim_swipe` take coordinates in the pixels of the latest `sim_screenshot`. They map those into the Simulator window (the mapping is unit-tested against this machine's real window numbers) and send mouse events.
- **Typing and host clicks:** `sim_type`, `type_text` and `click` use System Events typing and mouse events.

All of these need JamSesh to have Accessibility. There is no `idb` path.

**G6 (new session in an already-joined repo).**
- `jam_join` now always sends the full skill on the first join of a connection, instead of skipping it when the agent is "resumed". A re-join on the same connection gets a short pointer.
- `hook.sh` has a new `start` mode, registered as a Claude Code SessionStart hook. It only fires when the room is reachable. It reminds the agent to join, and it refreshes `~/.claude/skills/jamsesh/SKILL.md` from the host.
- The Codex setup now also installs `~/.codex/skills/jamsesh/SKILL.md`, and the AGENTS.md block tells Codex to join.

**G7 (Codex).** I did not install Codex hooks. They exist in codex 0.158 (`hooks.json`), but the binary stores a `trusted_hash` per hook, which suggests each hook needs approval inside Codex. That makes an unattended install unreliable. Instead the AGENTS.md block and the skill tell Codex to post a one-line `jam_update` per task and to loop `jam_wait`.

**G8 (dev-server LAN ports).** I rewrote `devproxy.ts`. Each dev port is now an HTTP and WebSocket forwarder that accepts only:
- loopback requests, or
- a paired device's token, as a bearer header or as the `jam_token` cookie. Browsers send that cookie to every port of the same address.

Anyone else gets a 401 page. Hot-reload sockets work, including their subprotocol. Redirects are rewritten, and the room's token is stripped before reaching the dev server. The tests confirm that a request arriving from this machine's LAN address is refused without a token and served with one. `jam_devserver` now only accepts a server on the agent's own machine, with at most six per agent. I used no signed tickets.

**G9 (dev-server tiles through the Mac relay).** Needs the changes in the cross-file list below. The relay mirrors each dev port so the tile can keep the same port number.

**G10.** `jam_wait` and `jam_ask` are clamped to 230 seconds, with the default at 200.

**G11 (idle agents and verification).**
- **Skill:** it now tells agents to re-call `jam_wait` immediately and never end the turn.
- **Warnings:** `jam_update done` warns when the canvas changed after the last `canvas_render`. `shipped` warns when there is no "(built)" screenshot from that agent.
- **Still needed:** the Stop-hook block is in `hub.ts`, which I don't own (see below).

**G12.** New `jam_devserver_remove` tool. A dev server that stays down for 30 minutes is removed along with its artifact.

**G14.**
- `jam_show` now sends a real toast when the screen is pinned.
- It no longer overrides something a person put up in the last 90 seconds.
- `noteActivity` now reads `commands` and `command`, the real schema names.
- `place` now handles frames made with `run_command` (`node.create` and `frame.create`).

**G16.** The hook outbox now stores a timestamp per line. Replay drops entries older than 10 minutes and keeps the newest 50. After a failure the hook skips the hub for 45 seconds, and the timeout is 2 seconds. I tested stale and fresh replay against the live hub.

**G17.**
- Credentials in a remote URL are stripped at join.
- `file.*` and `collab.*` canvas commands are blocked for agents.
- The skill covers Expo (`--web`, or Simulator screenshots) and the offline-gateway caveat for cross-repo `coordinate` directives.
- The 4790 relay-port fallback is not done. It is in `app/**`, which the lead owns.

**G18.** The skill now includes the Gatekeeper workaround (right-click Open, or Open Anyway) and the browser-view fallback.

**G13 and G15.** Not done. G13 is a Settings text and config change in files I don't own. G15 wasn't on my list.

**Tests.** `hub/test/agents-host.test.ts`, 8 tests (see the first paragraph).

**Spec statements to change**
- 4.5: Codex gets the MCP block, a prompt, a skill and a join block in `AGENTS.md`, but no hooks.
- 6.6 and 14: dev ports are open only to loopback and paired tokens, and targets must be the agent's own machine.
- 6.2 and the tool list: add `jam_devserver_remove`, the 230-second cap on `jam_wait` and `jam_ask`, and the done/shipped warnings.
- 13.2: say what is real for Simulator and host control as listed under G5. Tap, swipe and type need Accessibility, and taps and swipes use the latest screenshot's pixels.
- 8.13: cross-repo `coordinate` needs the brain online.
- 15: local whisper is not shipped in the app, so say "gateway only" unless the host installs it. The Settings help text is wrong too.
- Skill delivery: it is sent on each new connection, and the SessionStart hook is new.

**Changes I need from the lead**
- **`hub/src/brain/brain.ts`, `host_action` tool:** add the new actions to the zod enum (`screenshot`, `click`, `type_text`, `sim_screenshot`, `sim_tap`, `sim_swipe`, `sim_type`, `sim_launch`) and the new fields (`x`, `y`, `x2`, `y2`, `text`). `host.act(i)` already handles them. Describe the pixel convention for taps in the tool text.
- **`hub/src/hub.ts`:**
  - Set `this.host.onImage = (path, title) => …` to post the PNG as an artifact via `saveUpload`, so the room and the brain can see Simulator screenshots.
  - Set `this.host.onBuilt` to feed the result to the brain (for example a system event passed to `brain.hear`) so it can arrange the app after a build.
  - `onStop` should return `{decision:"block", reason:"Call jam_wait"}` while the agent is live and its status isn't offline. It should guard on `stop_hook_active`, and only for Claude, since Codex has no Stop hook.
- **`web/src/shared/ui.tsx` (web-fixes), `localize`:** when the page is the relay (127.0.0.1) or the host's own browser, rewrite a dev tile URL to `http://127.0.0.1:<hostPort>`.
- **`app/src-tauri/src/proxy.rs` (G9):** for each dev server in the hub state, bind `127.0.0.1:<hostPort>` on the Mac. Forward HTTP and WebSocket to `<upstream host>:<hostPort>` with the stored bearer token added, as the relay already does for the hub port. If the upstream is https, send `Host: dev-<port>.<domain>` to the public address instead; the hub already routes that. Note that a remote Mac user's `jam_devserver` registration can't reach their laptop over a public address (the hub sees their public IP), so dev tiles only work for people on the same network or Tailscale.
- **`hub/src/session.ts`:** append a numeric suffix when two agents get the same default name (G15).