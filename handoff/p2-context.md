JamSesh is a room-collaboration app (Bun/TS hub, React web, Tauri Mac app) inside the FigCraft repo. Phase 2 of an approved improvement plan ("Agents join on purpose and keep working") is the diff from jamsesh/phase-1 to jamsesh/phase-2. Plan items, in /Users/cheyrasmussen/jamsesh/jamsesh-improvement-plan.md:
- 2.1: Only chats a person connects join. No writes to CLAUDE.md/AGENTS.md; the old block is stripped; agents are keyed per chat (chatId / mcp session); join notice with Remove/purge.
- 2.2: Busy Claude Code agents get room items through a PostToolUse hook. Idle ones stop and are woken by an asyncRewake Stop hook (verified working in a real interactive Claude Code 2.1.308 chat). Codex keeps the jam_inbox/jam_wait loop. Old installs keep the forced jam_wait.
- 2.3: Honest tile status, task aging with nudge, offer and reassign, workstream pause.
- 2.4: Observer agents.
- 2.5: A short join briefing (~950 tokens, down from 8k); long notes are stored once as documents.
- 2.6: Unprompted claims are made visible.
- 2.7: A dev-server sharing nudge; stopped-build tiles explain themselves and clear after 5 min.
Known pre-existing test failures that also fail on main are being fixed separately: brain.scenarios live cases, brain.speech "overheard talk is silent", and prompt-window "no engine and no gateway". All Phase 2 test files pass.
Constraints: hooks run on people's machines (shell scripts in install-scripts.ts), and hook routes are reachable by agents. People-only routes are guarded in http.ts. Nothing may write to users' instruction files except stripping JamSesh's own block.

RERUN: The previous review (receipt 8fdbd7fe93381f4f, DISAGREE) listed 11 must-fixes and 1 should-fix. Fixes were merged as acb0e639 (security and delivery: MCP session bound to its creating machine, chatId hidden from state, hooks require an agent credential plus a matching machine, safe client.env quoting, tokens moved out of argv via a header file and headersHelper, exact-block stripping that preserves symlinks, delivery ids with ack and retry, a rejoin gate after Remove, joined revalidation on every hook) and 89d7d1d7 (purge scope, the Reassign URL, per-target reassign and aging, Done kept across its own PostToolUse, first claim treated as asked, observer role kept and claims refused). Confirm each finding is fixed and look for anything new.

ROUND 3: The second review (/tmp/claude-501/p2-review2.md, DISAGREE) was addressed as follows. Commit 3561e836 handles removal (listeners, deliveries, and targets), outbox prompt ids with server dedupe and confirmed deletes under a lock, the feed purge with no cap, the pairing token kept in a file, and a stricter connect-claim match. Findings 1, 5, and 6 were Phase 1 code, now fixed on phase-1 and merged in as 0ca393fb. Finding 2, same-machine impersonation, is documented as a trust boundary in SPEC: all chats on one Mac run as the same OS user and can read ~/.jamsesh. Known remaining: person identity is self-declared per paired window, and a Phase 3 fix is binding it. Confirm and look for anything new.

ROUND 4: The third review (/tmp/claude-501/p2-review3.md, DISAGREE, 8 must-fixes and 3 should-fixes) was fixed in commit f9322ca5:
- Chat-id-only resume, with legacy migration only for records that have no chat id.
- The inbox reads forward from its cursor and filters before the limit.
- The forwarded host is trusted only from loopback with a strict host:port check, and shell values are single-quoted.
- A private-file helper writes mode 600 and never widens a mode.
- Revocation wakes listeners and jam_wait, and they recheck.
- Terminal directives are immutable, and endDirective ends every target.
- Offered tasks always show.
- The TOML edit is line-anchored and respects multi-line strings.
- Per-target tick reloads, observer-only refusal, and quoted hook paths.
Confirm and look for anything new.

ROUND 5: The fourth review (/tmp/claude-501/p2-review4.md, AGREE-WITH-CHANGES, 7 must-fixes and 1 should-fix) was fixed in af9d62d3:
- The MCP instructions now say to join only when the person asks.
- Observer guard on jam_update, and new-workstream announcements.
- The decision cursor reads forward and advances only on acknowledgement.
- Hook removal is limited to JamSesh's exact commands.
- File::Temp/mktemp private temp files.
- A TOML scanner that skips comments.
- A named reassignment is refused when invalid.
- A dev-server generation guard.
Confirm and look for anything new.

ROUND 6: The fifth review (/tmp/claude-501/p2-review5.md, AGREE-WITH-CHANGES, 5 must-fixes and 1 should-fix) was fixed in 08b2c62e and 0e1db24a:
- A stable Codex identity, codex:<machine>:<cwd>, so removal sticks across reconnects. Documented limit: two Codex chats in the same folder act as one agent.
- jam_ask is cancelled on removal or revocation, and rechecks afterwards.
- Background outbox replay with a budget.
- stateDirectives includes every open task.
- Blocked and question statuses are kept through hooks.
- Prompted-ness is checked by time.
Confirm and look for anything new.

ROUND 7: The sixth review (/tmp/claude-501/p2-review6.md, AGREE-WITH-CHANGES, 3 must-fixes and 2 should-fixes) was fixed in 7e26c168:
- A per-file outbox with lock-free queueing, a single background replayer, and deletes only after confirmation.
- Outbox entries and chat markers are bound to the room id.
- The dev-proxy generation is recorded before any await.
- The block stripper re-reads before the rename.
- The docs are aligned with the code.
Confirm and look for anything new.

ROUND 8: The seventh review (/tmp/claude-501/p2-review7.md, AGREE-WITH-CHANGES, 4 must-fixes and 1 should-fix) was fixed in 28faf706:
- Removal is keyed by machine, folder, and harness for chat-less joins.
- unchanged() runs before unlink.
- x-jam-room on every hook POST, with 409 before any side effect.
- Uncapped removal records.
- onListen is deleted.
Confirm and look for anything new.

ROUND 9: The eighth review (/tmp/claude-501/p2-review8.md) was addressed in c5a57d3f:
- Observer-only product work throws ONLY_OBSERVERS and saves nothing.
- Staged and verified hook install, with MCP entry rollback.
- Prompt-id dedupe by a 20-minute window, persisted.
Disputed, with reasoning in SPEC: the microsecond window between the final re-read and rename can't be closed without an atomic compare-and-swap, which POSIX doesn't have.
Confirm and look for anything new.

ROUND 10 notes (ninth review, /Users/cheyrasmussen/.local/state/chey-skills/receipts/second-opinion/staff-engineer/687ca6b95b4f01bf.review.md, 4 must-fixes), commits 2.15 on jamsesh/phase-2:
- MCP rollback: the old entry and its credential are saved before the new token is written (mcp-headers.json.prev; an inline Authorization goes to mcp-headers.rollback.json/.sh, never argv). On failure the credential is restored, the entry re-added, and `claude mcp get jamsesh` checked; the message says plainly if it could not be put back. Spare copies removed on success.
- Room switch: HubState.session.roomId; hub client drops purge ids when the room changes; RoomFeed is keyed by room so seen lines, history cursor and scroll reset. Tested at state level only (no DOM test harness; the key remount is not rendered in a test).
- Codex config.toml symlink edited at target (also a dangling link).
- Instruction migration: finding 4 accepted, but the earlier round's dispute stood on a real limit (no atomic compare-and-swap). Resolved by removing the write: setup now only names the old block's lines on stderr (FIND_BLOCK_PL, no rename/unlink/tempfile) and the person deletes them. Cost: old blocks linger until deleted, which still tell agents to join on start; the notice says so.
Could not verify: a real Claude Code `mcp add-json/get` (tests use a fake claude), a real two-Mac room switch, the remounted feed visually.

ROUND 11 notes (tenth review, /tmp/claude-501/p2-review10.md, AGREE-WITH-CHANGES, 3 must-fixes, 1 should-fix), commit 2.16 on jamsesh/phase-2:
- Setup saves auth.header, client.env and hook.sh (a private .saved dir) before touching them and restores all three (removing any that did not exist) on a failed hook download and on a refused MCP entry; asserted by file contents. Removed JAMSESH_TOKEN from client.env (nothing read it) and updated SPEC.
- Mac app: a successful Connect my agents appends the old-block notices (file, lines) from the setup's stderr, with the plain warning that the old block can still make a chat join by itself; notice wording in the script says the same. Rust unit test for the stderr filter only; the dialog itself not rendered.
- Web: one private adopt(state) in the hub client for the socket and the HTTP fallback; HTTP fallback test added.
Could not verify: real Claude Code mcp add-json/get, the Tauri dialog visually, a real room switch.

ROUND 12 notes (eleventh review, /tmp/claude-501/p2-review11.md, 3 must-fixes, 2 should-fixes, 1 delete), commit 2.17:
- Setup is one transaction: every file it can change (connection files, mcp-headers.*, Claude settings/command/skill, Codex config/prompt/skill; symlinks resolved to targets) is saved before the first change; an EXIT trap restores them and the earlier Claude MCP entry on ANY failure before the last step; saved copies are deleted only at the end. A restore that fails is listed by path, keeps the saved dir, and exits non-zero with a plain message (no || swallowing). Tests: malformed settings after MCP, failing Codex step, symlinked Codex config, no agent installed, partial restore failure.
- Web: /state responses are dropped if a newer socket state arrived or the current room is no longer the one the request was made for; room change clears thinking/speaking/levels/toasts. Tests for deferred response order.
- SPEC sentence qualified; static regex test deleted.
Could not verify: real Claude Code mcp add-json/get, Tauri dialog visual, real room switch.

ROUND 13 notes (twelfth review, /tmp/claude-501/p2-review12.md, 2 must-fixes, 2 should-fixes), commit 2.18:
- MCP rollback reads the result from the CLI: after `mcp remove` it runs `mcp get`; entry still there = failed (reported, saved copies kept, non-zero); earlier entry re-added and verified = restored; no earlier entry and gone = removed (message says none is registered). The test CLI is now stateful (add-json stores, remove deletes, get reflects it) with a refuse-remove case.
- Web: one monotonic sequence over every state source (each HTTP request, each socket state, each new connection); a state is taken only if nothing later has been taken. Test: two overlapping fallbacks resolved out of order from a null state. Room change also resets clockSynced and clockOffset.
- STATUS.md no longer claims block removal or a stripper.
Could not verify: real Claude Code mcp CLI, Tauri dialog, real room switch.

ROUND 14 notes (thirteenth review, /tmp/claude-501/p2-review13.md, 3 must-fixes, 1 should-fix), commit 2.19:
- Web: every socket message that can change held state (a state, or any message once a state exists) takes the next sequence number, so an HTTP fallback answer is applied only if nothing was applied since its request started. With no state yet, patches change nothing and the fallback still applies.
- Setup lock: setup.lock folder under ~/.jamsesh holding the holder's PID, taken before the first change, released by the EXIT trap on every path; a lock whose PID is dead is moved aside and taken over; a second run waits JAMSESH_LOCK_WAIT (default 10) seconds then exits "Another JamSesh setup is running". The Mac app refuses a second Connect my agents while one runs (SetupGuard, unit tested).
- Secrets: rollback never passes the saved entry's secrets on argv. Every header (not only Authorization) moves to the rollback helper file; an entry with a secret elsewhere (env, args, command, oauth, credential in the address, non-http type) is written back into ~/.claude.json by a narrow temp+rename edit of the mcpServers.jamsesh key (mode kept, rest untouched), then checked with mcp get. Tests: extra secret header, and env/args secret entry with the log checked for leaks.
- devproxy: re-registration on the same port keeps the listener and changes only its target; a moved port closes the old listener only after the new one bound; a failed bind puts the earlier record back (or removes a first one). Tests added.
Could not verify: real Claude Code mcp CLI (writing ~/.claude.json directly in a rollback is the one place JamSesh touches that file; only for entries that cannot be re-added without a secret on a command line), Tauri dialog, real room switch.

ROUND 15 notes (fourteenth review, /tmp/claude-501/p2-review14.md, 3 must-fixes, 2 should-fixes), commit 2.20. Simplified rather than added:
- MCP restore: `claude mcp add-json` is gone from rollback, and so is the "safe for argv" classifier and the rollback helper files. The saved entry (0600, in the saved folder) is always put back by a temp+rename edit of the one mcpServers.jamsesh key in ~/.claude.json (mode kept, rest untouched), then checked with `mcp get`. Reported as restored/removed/failed from the real result. Tests: headers, a secret in the URL path, env/args, with the CLI log checked for leaks. The test CLI now keeps its entry in the sandbox's ~/.claude.json.
- Temp files: rollback writes each file through `mktemp` beside the target (exclusive, 0600) then mv; no predictable `.restore` path. (Install-time writes of the Claude command file and the downloaded skills still go straight to their paths; they are not part of rollback.)
- Lock: replaced the lock folder and its takeover with flock on ~/.jamsesh/setup.lock held as fd 9 for the whole run (taken through perl; the kernel releases it when the process ends), so there is no stale lock to take over and no way to move a live one. Waits JAMSESH_LOCK_WAIT seconds (0.2s polls) then "Another JamSesh setup is running". Caveat: a child that inherits fd 9 and outlives setup would keep the lock; setup starts none that do. Tests: a real holder process (second setup exits, first's files untouched), a stale lock file holds nothing, a failed setup releases it, and two setups against a stale lock run 20 times with an overlap detector (never overlap, both succeed).
- devtile: a real port conflict (a second server squatting the port) for the bind-failure test; the register-level record restore test still stubs listen because the port check runs just before the bind. Deleted `void hooksOf`.
Could not verify: real Claude Code mcp CLI and ~/.claude.json being edited while Claude Code runs (this is the one place a rollback writes that file), Tauri dialog, room switch.

STOPPED HERE (round 16, commit "JamSesh 2.21 (wip)"): done: every setup write goes through safe_write (resolves symlinks, refuses instruction files and targets outside home, mktemp beside target then mv); a journal records prior content and the hash setup wrote, and rollback restores only paths whose hash still equals it (others listed as changed by someone else); ~/.claude.json rollback is a key-level edit of mcpServers.jamsesh, verified from the file, not `mcp get`. setup-script.test.ts 44/44 with tests for each scenario. Left: grep audit that no other > >> cp mv writes a destination (scratch files in the saved folder and the flock file remain), run join-only-when-told/devtile and hub tsc, update SPEC/STATUS, write ROUND 16 notes, run review 16. Nothing running from me.
