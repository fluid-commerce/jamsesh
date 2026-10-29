JamSesh is a room-collaboration app (Bun/TS hub, React web, Tauri Mac app) in the FigCraft repo. This is Phase 1 ("Fix what's broken in the room") of an approved plan in /Users/cheyrasmussen/jamsesh/jamsesh-improvement-plan.md, items 1.1 to 1.10. Changes: canvas fonts and reconnect; one share per request; shares fill the screen and stop when off-screen; sharper shares; the transcript keeps the reader's place; the brain answers to its aliases and speaks with MAI Voice 2.1; voiceprint status shows; agents stop getting each other's news as tasks; history paging; and the Mac app recovers on its own (watchdog, heartbeat).

This is a confirmation rerun. An earlier staff-engineer review (receipt 6b361d146d031084) returned AGREE-WITH-CHANGES with 1 must-fix: setStage reverted a live share after 6 minutes. It also listed 7 should-fixes: agent input tool restriction, a shared alias cleaner, children trap/SIGKILL, heartbeat as a Tauri command with narrowed capabilities, watchdog shared pid and occlusion, NaN history limit, and misc. All were addressed in later commits.

Since then:
- 'tests never use the Mac say voice' (NODE_ENV=test or JAMSESH_SILENT).
- A test-harness fix: bench.ts settle() now waits on brain.exclusive. About 26 scenario failures were harness-only, and all 37 scenarios now pass twice.
- A brain prompt change in shippedBatch, so shipped user-visible features still get a coordinate directive to the other platform.
Please confirm the earlier findings are fixed, and look for anything new.

ROUND 3: The second review (receipt a292a45715afa9da, AGREE-WITH-CHANGES) had 8 must-fixes and 4 should-fixes, all now addressed in 12 commits after 9dcf0e2b. Changes: shipped-news filtering plus a parity-only pass with coordinate_parity and no_action that runs only when another platform's app agent is online, and a platformSpecific flag; window-owned devices, with share and decline authority tied to the owning window, the person asked, or the host; placement recorded on display; one share per person; stale request pruning; bounded and serialized collab.peers polls; bounded canvas stderr, unhealthy-child stop, and dead-host restart; history cursor on raw events; decisions filtered before limit; bench forwards tool scope; timers cleared; watchdog resets hidden windows; first-host transition. Known remaining: a paired window can still name itself as any person through /devices. A separate Phase 3 fix is binding person identity to the device record. Confirm the fixes and look for anything new.

ROUND 4: The third review (/tmp/claude-501/p1-review3.md, AGREE-WITH-CHANGES, 6 must-fixes and 3 should-fixes) was addressed in e41c6acd, 81b2e9cd, and e9d60654:
- Only active displays count a share as visible.
- Fixed per-share deadlines that stage changes can't postpone.
- Session.placeShare places a share immediately without the brain.
- The parity product decision: a coordinate directive is a check, not a build task. coordinate_parity requires a 'seen' field, and there's no directive when nothing a person sees ships.
- Single-flight canvas recovery marks the canvas failed on error.
- A share id is reused only for the same kind and device.
- The previous stage is restored per display.
- Decision paging continues until filled.
- The 45s model wait for share placement is removed.
Confirm and look for anything new.

ROUND 5: The fourth review (/tmp/claude-501/p1-review4.md, AGREE-WITH-CHANGES) was addressed in 6eb2aa90..274da8f7:
- Host-ended shares are final: the window is told, a re-register gets 409, and only 'lost' shares re-register.
- A resync that works after a failure restores live status with a new generation. The generation bumps only when recovering from not-live, so routine resyncs don't force rejoins; this is deliberate.
- Decisions paged oldest first, with the mark advanced only over what was handed over.
- coordinate_parity 'seen' must share content words with the shipper's text.
- Feature-level dedupe.
- True single-flight polls.
- Font retry with backoff.
- SPEC parity text.
Confirm and look for anything new.

ROUND 6: The fifth review (/tmp/claude-501/p1-review5.md, AGREE-WITH-CHANGES, 3 must-fixes and 1 should-fix) was fixed in f3efc860, fe855df1, and eaa919d6:
- The main display counts only while its window reports, so a share shown only on main stops after its window closes. This is Chey's rule: a share not on any host surface stops.
- The final parity decision: parity happens only when the shipping agent writes 'seen' (what a person sees) on its own jam_update. The brain never writes it, and coordinate_parity uses it verbatim.
- A synchronous fc.execute throw counts as a failed read.
- Two-way feature dedupe.
Confirm and look for anything new.

ROUND 7: The sixth review (/tmp/claude-501/p1-review6.md, AGREE-WITH-CHANGES, 5 must-fixes and 1 should-fix) was fixed in ec162d57..e86eeb97:
- A socket speaks only for its window's own device.
- A failed first canvas start cleans up and retries with backoff.
- Bounded stderr drain.
- Parity grouped per feature by shipment id.
- Extra-display deadlines re-armed on restart.
- RejoinTimer is cancelled by a live poll.
Confirm and look for anything new.

ROUND 8: The seventh review (/tmp/claude-501/p1-review7.md) was fixed in bf9e8a24..814ca64d:
- The watchdog reads occlusionState on the main thread via run_on_main_thread with a timeout, before taking the lock.
- Single-flight capture per kind.
- /devices strips the device from other windows' sockets, and ownership is rechecked on every use.
- A stop token after every startup await.
- The key helper has a 10 s timeout and is killed and reaped.
- Docs updated, and the presenter model is removed.
Confirm and look for anything new.

## ROUND 9 notes (1.R8)
Fixed (review f90fe5a48ecbdeaa):
- Canvas host child: tracked in this.host from spawn (before init), so Stop during the MCP handshake closes it; FigcraftMcp now spawns under withParentWatch (hub death reaps it); withParentWatch keeps stdin (`<&0`) or the backgrounded child lost its pipe. Tests in canvas-reconnect.test.ts (pending-init Stop, wrapper still gets stdin).
- Relay: queue capped at 1000 frames / 8 MB and a 10 s upstream-open deadline; both close with 1013 (retryable). RELAY_LIMITS exported/tunable. Tests: relay-limits.test.ts (end-to-end against a stalled TCP listener).
- Shipped fixes: parityCandidate rejects fix/patch/corrected/crash/bug/regression/workaround anywhere in the text (was start-anchored). Tests through the real ship path with seen. Cost: some feature names containing "fix" or "crash" become news-only (safe direction). Not added: an explicit classification field on jam_update.
- Inbox reminder: open coordinate directives now get "compare through jam_message first, build only for a gap you both confirm"; others unchanged.
- feature input removed from coordinate_parity; directives quote the shipper's `seen` text.
Disputed: recipient scoping by product/workstream. Agents carry no product/workstream field (only repo, platform), so there is nothing reliable to scope by; the check asks "does your app have it", so an unrelated app answers "no gap" and acks. Needs a data-model decision.
Not verified: brain.scenarios.test.ts (live-model scenarios; "5. decisions > I like direction B" failed at ~16s, likely model-dependent and unrelated; the earlier run also hit my time limit); real Mac watchdog; real figcraft-cli (tests use a fake binary).

ROUND 10: The ninth review (/tmp/claude-501/p1-review9.md) was fixed in 1.R9 commits:
- Relay: Bun's WebSocket client reports bufferedAmount 0 however much it holds for a peer that stopped reading (measured: 100 MB accepted against a peer that never read), so the relay now uses its own upstream client (hub/src/relay.ts: handshake, framing, write() accounting, drain) that counts unsent bytes and ends the relay with 1013 at RELAY_LIMITS.bytes. Downstream: ws.send()==0 or getBufferedAmount over the cap also ends it. One pair of functions (relayUp/relayDown) carries every frame, before and after open.
- Children: the wrapper itself sends TERM then KILL after a grace (default 3 s), on its own TERM and on hub death. Stop reaps the server (stopHelper), FigcraftMcp.close() uses stopHelper, and the key helper is wrapped, tracked and killed by Stop.
- Fonts: the Mac returns one entry per file plus a `deferred` list (families past the cap or not fitting in the response; a family goes whole). The page loads every file of a family and does not settle a deferred family.
- Parity: a jam_update never closes a coordinate directive; jam_ack done needs a recorded exchange (a message sent to another agent and one received, not from the brain) since the directive; cancelled is always allowed. Enforced in Session.setDirectiveFor. Skill text updated.
- Tests: deleted the vacuous relay assertion and the obsolete `feature` args.
Disputed/limits: recipient scoping stays as before (no product identity in the data model; needs a decision). Not verified on a real Mac: watchdog, real figcraft-server (tests use fakes). The new relay is exercised against Bun's echo server and a raw stalled socket, not the real figcraft-server.

ROUND 11: The tenth review (/tmp/claude-501/p1-review10.md) was fixed in 1.R10 commits:
- Relay: each frame costs its encoded size + FRAME_OVERHEAD (64) against RELAY_LIMITS.bytes, in Upstream.send and the pre-open queue, so empty frames count. Test: paused raw peer, 32 KB frames then empty ones until send() refuses.
- Fonts: the Mac returns `incomplete` (file over the limit, unreadable, or cut by the response cap) next to `deferred`. The page settles a family only when nothing was incomplete and every file loaded; otherwise it backs off and keeps the family in the returned (substituted) list via FontTries.partial. Rust + web tests.
- Parity/directives: Directive.counterparts (set by coordinate_parity and pair_agents). Messages and jam_ask carry directiveId; answers inherit the ask's id; a plain reply to a directive-linked message inherits it (store.lastLinkedMessage). exchangeGap needs a message from the target to a counterpart and one from a counterpart back, both tied to the directive, queried from the store with no window; inline asks count. setDirectiveFor: only targets (jam_update and jam_ack throw otherwise), done/cancelled are final and idempotent, no backwards moves. Skill and inbox text tell agents to pass directiveId.
- Smoke (real binaries): built figcraft-cli and figcraft-server with CARGO_TARGET_DIR=/tmp/claude-501/p1-r10-target (deleted after). Ran /tmp/claude-501/p1-r10-smoke.ts: starts `bun run hub/src/index.ts --no-whisper` from the worktree on free ports with JAMSESH_FIGCRAFT_BIN_DIR set; canvas went live; a real `figcraft-cli mcp` joined through the hub relay (ws://127.0.0.1:<hub>/collab/?file&token), ran `shape.rectangle` (id 8589934593); a second real participant joined the server directly and `get_node` returned RECTANGLE 123x45 at 11,22. Hub exited 0 and no helpers were left.
- Not done here (office checklist): bundled Mac app watchdog / hung page / hub restart recovery. Left as should-fixes: awaiting helper reaping on graceful hub shutdown and process groups; product identity for parity recipients; feed history bound in ui.tsx.

ROUND 12: The eleventh review (/tmp/claude-501/p1-review11.md) was fixed in 1.R11 commits:
- Inbox: store.messagesTo filters by recipient in SQL, then takes the OLDEST 50 after the read mark (nothing is skipped; the rest comes on the next read).
- jam_answer: ask found by id in the store (messageByAsk), only the addressee may answer, a second answer is refused.
- Parity: exchangeGap needs both directions with the same named counterpart. Only an explicit directiveId links a message; a plain reply inherits only when the other agent's message, still the last between the two, is linked and both are parties to that directive.
- Fonts: a family in FontTries.partial is asked for again (when due) even when the canvas no longer reports it missing.
- Should-fixes: an empty relay send counts as success; the feed keeps 1500 lines while following (older ones reload on scroll); Canvas.stop()/Hub.stop() return a promise that resolves once helpers (host, agents, server, key helper) are reaped, and shutdown awaits it (6 s cap); SPEC no longer promises a host relay for WebRTC.
- Not done by decision: platform-only parity recipients (decision 10 open with the owner).
- Bundled Mac recovery (hung page, hub restart, watchdog) is an owner-run release check on the office checklist; I did not build or start the bundled app.
- Process groups for helper descendants: not done (helpers are direct children; the wrapper kills the direct child only).
- canvas-reconnect.test.ts key-helper test was load-flaky (wrapper start time); timeout raised.

ROUND 13: The twelfth review (/tmp/claude-501/p1-review12.md) was fixed in 1.R12:
- Directive linkage: inheritance deleted. Only a message carrying an explicit directiveId counts. jam_message, jam_ask and jam_answer accept it; the inbox QUESTION line names it for jam_answer, MESSAGE lines say to reply with it; answers no longer copy the ask's id. Removed lastBetween/lastLinkedMessage.
- Shutdown: stopHelper returns true only when proc.exited was observed (TERM, grace, KILL, brief wait); Canvas.stop and Hub.stop return whether every helper exit was seen; Hub.shutdown no longer races a sleep, it awaits and warns if one is still running. Tests: TERM-ignoring helper reports true after KILL; a process whose exit never arrives reports false.
- Empty-frame test now fills the kernel with big frames, then sets the cap just above what is held and asserts empty frames were accepted before the first refusal.
- Bundled Mac recovery stays an owner-run release check (office checklist).

ROUND 14 / STOPPED HERE (1.R13 wip, machine going offline; no review run):
Done (compiles, tsc clean): HelperRegistry in children.ts (stopHelper rejected exit -> false; registry.stopAll); Hub.helpers registry passed to Canvas and Transcriber; whisper-server now wrapped in withParentWatch and tracked; Canvas.halt()/stop() (stop = halt + registry.stopAll); FigcraftMcp/key helper/server tracked; failed canvas start awaits host.close() and stopHelper before clearing refs; Session.createDirective refuses coordinate without known counterparts; exchangeGap with none never passes; brain create_directive gets counterparts (other targets + optional list); POST /directives fills/validates counterparts.
Left: fix tests broken by the above: agent-news (2 tests create coordinate directives without counterparts), canvas-reconnect (tests use plain-object canvases lacking halt(); 'Stop reaps...' test must track its manually spawned serverProc via canvas.helpers.track; check 'never gets healthy' line 109 and key-helper line 381 which may be load-flaky); add tests for: whisper tracked/stopped, Hub.stop true only when all exits seen, rejected exited -> false, coordinate-without-counterparts refused (session, brain tool, HTTP), exchangeGap with none. Then run tsc/tests, commit "JamSesh 1.R13", run review 14 (r14-next.sh from r13-next.sh). Bonjour dns-sd is still outside the registry (module-global, stopped by stopAdvertising).
The bundled Mac check result is being run by another agent and goes into this context when it lands.
