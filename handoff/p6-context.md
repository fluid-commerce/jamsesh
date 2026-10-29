JamSesh is a room-collaboration app (Bun/TS hub, React web, Tauri 2 Mac app) in the FigCraft repo (Rust crates under crates/, with FigCraft's rules: no unwrap/expect/panic, everything is a command, no third-party assets). This is Phase 6 of an approved plan, "Driving and reviewing together". The diff is jamsesh/phase-3...jamsesh/phase-6. Items:
- 6.1: Drive the big screen with your own dart, FigCraft's collaborator cursor drawn in SVG and scaled for TVs. Events go over the hub websocket, sanitized and rate-capped. Pass control and Drive together. Live builds get an injected devdrive.ts script that replays input from the framing page. Canvas input goes through FigCraft's pointer API.
- 6.2: Record, with a rainbow trail and notes aligned to the pointer (hub/src/record.ts), a tidy-then-send flow, and directives to the owning agents.
- 6.3: Live app tiles: iOS Simulator via simctl screenshots or a 30 fps ScreenCaptureKit helper (hub/native/jamsesh-live.swift, compiled on first use), taps and typing via the idb companion gRPC (hand-encoded protobuf), Mac and Electron capture and CGEvent input. Control follows the screen's drivers.
- 6.4: FigCraft panels on demand (view.canvasPanel command).
- 6.5: Room fonts (hub/src/fonts.ts): open fonts from Google Fonts or Fontsource, and lending gated by a native Mac dialog (lend_font in Rust). Kept in memory only.
Known: GET /api/drive/online is reachable by agents and should be people-only.

ROUND 2: phase-3 was merged in c8b16fc3. The first review (/tmp/claude-501/p6-review.md, DISAGREE, 12 must-fixes and 3 should-fixes) was fixed in a12bc60e..3b6f2a06:
- New Phase 6 routes need a person or the host-window key.
- local_fonts is removed. lend_font uses a native dialog, a one-time hub ticket, and an HMAC.
- devdrive accepts only the exact hub origin plus a hashed frame key.
- Hub-generated crop names with realpath confinement.
- Window-owned recording devices.
- Recordings release only their own lock.
- Send reservation before await.
- Bundle-id app matching in the Swift helper.
- CSP injection before meta, plus header widening.
- Streamed font size caps.
- idb success only with gRPC status 0.
- Focus-only key forwarding.
- A per-person rate cap.
- drive/online is people-only.
- Per-face font retry.
Confirm and look for anything new.

## ROUND 3 notes (6.R2 commits, branch jamsesh/phase-6, last 2c624829)
Fixed (second review, AGREE-WITH-CHANGES):
1. Legacy /prompt-window/start and /prompt-window now need the caller's own device (403 otherwise). Test in record.test.ts.
2. Stop (and promptWindow) end only the recording they captured (recordEnd takes `only`); a Start during the transcription wait survives. Test.
3. recordStart validates screen, person and driving permission before ending the earlier recording; refusal (404/409) keeps it. Test.
4. Mac input: sends run in order per tile (inOrder, extra moves dropped, never down/up); pointercancel / lost capture send a terminal up; leaving the tile with the button down sends up at the last position. New web/src/shared/tileinput.ts, test/tile-input.test.ts.
5. Open fonts: bytes read by in-flight downloads are reserved (`reserved`), released in finally; concurrent test with a small maxOpen option.
6. Frame key: refreshFrameKey() on hub reconnect; changed key reloads the build frame. Test in frame-driver.test.ts.
Should-fix done: Mac helper pause/resume (Swift stdin "pause"/"resume", typechecked with swiftc -typecheck, hub test with a fake helper); lend tickets capped per caller (8, oldest replaced); module-global record controller replaced by RecordScope context (no DOM test infra in web/, so verified by tsc only); SPEC trail text now says hue follows age (code unchanged).
Disputed: none. Not done: a real-host test of ScreenCaptureKit/CGEvent (needs permission prompts; forbidden by rules; stays on the office checklist). No Rust or FigCraft crate changed in this round, so cargo xtask ci / cargo check were not re-run (the Swift helper compiles only via typecheck).
Results: record.test.ts 31 pass; fonts.test.ts 30 pass; liveapps.test.ts 19 pass; prompt-window.test.ts 8 pass; web full suite 96 pass; tsc clean in hub and web.

## ROUND 3 native verification (run by the orchestrator, 07:07)
- cargo clippy --all-targets -D warnings (src-tauri): exit 0 (0 errors)
- cargo test (src-tauri): exit 0 — test result: ok. 42 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 2.35s 
- swiftc -typecheck jamsesh-live.swift: exit 0
- No FigCraft crate changes in this phase, so cargo xtask ci is not applicable. ScreenCaptureKit/CGEvent behavior needs permission prompts and is on the office checklist.

## ROUND 4 notes (6.R3 commits, branch jamsesh/phase-6, last 2cf24b34)
Fixed (third review, AGREE-WITH-CHANGES). Each fix enforces one invariant in the place every path goes through:
1. Recording identity: Start returns the recording id; Stop requires it (`recordingId`) and covers the window the hub opened (rec.t0, not the caller's); a Stop for an ended/replaced/unknown recording is 409 and ends nothing; a second concurrent Stop is 409 (`rec.stopping`). Legacy /prompt-window takes an optional recordingId and ends only a matching one. Client awaits Start on own screen too (failure is shown), keeps the id in the live state and sends it on Stop and on the unmount prompt-window.
2. Mac button release: `LiveApps.macSend` is the one choke point and tracks the held button (position, who, idle timer). `releaseHeld` runs on any controller change (`update`), tile end (grace before kill), another person's input (screen drivers changed), 4 s of no input (`pressIdleMs`). Swift helper: held button tracked; released on stdin EOF, SIGTERM and 6 s stale. Page also releases on unmount of the tile's replay (liveapp cleanup) and DriveLayer lets go for a removed driver and on unmount.
3. Build input: injected script keeps per-driver state (buttons, held keys; messages now carry `who`); `leave` releases both (up events, no click), 8 s page-side backstop. DriveLayer sends `leave` to a removed driver's tiles; canvasDriver clears a drag on leave.
4. Font cap: capacity is reserved before the read (by the file's Content-Length when stated, else min(face cap, room left)), shrunk to what was read in finally. Barrier test with a node:http server failed on the old code (3 held) and passes.
5. Frame reconnect: `keepFrameCurrent` remembers the key a frame was served under (fetched at mount) and a reconnect that finds a different key, none, or never knew one reloads; `refreshFrameKey` always asks. Tests include the never-driven case.
6. Should-fix: lend tickets only for wanted (or just-lent) families, full pool drops the oldest. Native checks: SPEC/STATUS call real capture/input a release check; the office checklist (/Users/cheyrasmussen/jamsesh/jamsesh-office-checklist.md) had 6.3 items 2-3 for capture and input; added item 7 for button release.
Disputed: "delete the duplicated Mac press lifecycle in liveapp.tsx / tileinput.ts" is not done. The hub now guarantees release but only after control change or up to 4 s; the page's own up on cancel/capture-loss/leave is what ends a drag at once, and the in-order sender is needed for smooth drags. Removing it would turn every lost pointer into a 4 s stuck button. The hub no longer depends on it.
Could not verify: real ScreenCaptureKit/CGEvent behavior and the Swift release paths against a real app (permissions). Pre-existing failing test in this environment (also on the base commit): record.test.ts "a picture whose path leads out of the renders folder (a link) gets no crop" (needs sips/symlink behavior).
Results: record.test.ts 34 pass 1 fail (the pre-existing one); record.client 2; prompt-window 8; liveapps 22; driving 15; fonts 33; web full 98 pass; tsc clean hub and web; swiftc -typecheck exit 0 (warnings only, same kind as before). No Rust changed.

## ROUND 4 native verification (run by the orchestrator, 07:59)
- cargo clippy --all-targets -D warnings (src-tauri): exit 0 (0 errors)
- cargo test (src-tauri): exit 0 — test result: ok. 42 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 2.33s 
- swiftc -typecheck jamsesh-live.swift: exit 0
- No FigCraft crate changes in this phase, so cargo xtask ci is not applicable. ScreenCaptureKit/CGEvent behavior needs permission prompts and is on the office checklist.

## ROUND 5 notes (6.R4 commits, branch jamsesh/phase-6, last 1a6d95e5)
Fixed (fourth review, AGREE-WITH-CHANGES, p6-review4.md), at the choke point:
1. Prompt window keyed by recording id only: promptMode entries carry `rec`; /prompt-window with an id acts only if it is the device's current recording and its window; a stale id is 409 and a no-op; an id-less close can only close a window opened by the older start call (no recording). Both Stop paths mark `rec.stopping` so two closes can't race.
2. Timestamps are the hub's clock only (`Hub.clock`): Start records clock(), Stop/prompt-window end at clock(); body t0/t1 are not read; pointer moments outside the window (1 s slack) are dropped. Client stops sending them. Tests set `hub.clock`; new tests cover adjacent recordings and far-future caller times.
3. Swift helper: one `quit()` (release the held button, then exit) replaces every exit(); `up` with no window still releases the held press at where it went down; the hub's helper-error path now goes through `end()` so cleanup runs.
4. Screen driver changes: `Session.onStageCommit` runs after every stage/lock/drivers commit; `LiveApps.syncHeld` lets go of a press whose person no longer drives the tile (screen drivers or controller). Test: pass control and unlock with a press held, no further input.
5. Frame keys are numbered; an answer applies only if no later ask has been answered. Test with out-of-order answers, including a late failure.
6. Every request body kind (json, multipart, raw) is read through one capped reader (`readCapped`), so chunked multipart no longer buffers past the cap. readBody is exported and tested directly (Bun itself answers some oversized chunked uploads with 400 before the handler, so HTTP-level tests of that were not reliable).
7. The injected script releases buttons 0 to 4.
8. scripts/drive-e2e deleted (secrets to a fixed log, hard-coded checkout; nothing referenced it).
9. Crop path test "a picture whose path leads out of the renders folder": the GUARD IS RIGHT, THE TEST WAS WRONG. record.test.ts imported the hub before any JAMSESH_HOME was set, so `canvas.rendersDir` was the real ~/.jamsesh/host/renders; the test's symlink() there hit EEXIST on the second run (a previous run left linked.png). The test now sets a throwaway JAMSESH_HOME and imports the hub dynamically. NOTE: earlier runs of this test (mine and others') left linked.png, login.png and sketch.png in ~/.jamsesh/host/renders; I did not touch the real folder. About 20 other hub tests build a Hub without JAMSESH_HOME (they use canvas:false and a dataDir, so only record.test.ts was found writing renders).
Not done / pending the owner: real ScreenCaptureKit capture and CGEvent input (including the new button-release paths and the Swift helper's release-on-exit) can only be checked on a host where a person grants macOS Screen Recording and Accessibility. It stays the documented release check (STATUS, office checklist 6.3 items 2, 3 and 7). Pending the owner; no permission prompt was triggered.
Results: record 37 pass; liveapps 22; driving 15; fonts 34; prompt-window 8; audio-fixes 8; security-fixes 12; web 99 pass; tsc clean hub and web; swiftc -typecheck exit 0.

## ROUND 5 native verification (run by the orchestrator, 08:19)
- cargo clippy --all-targets -D warnings (src-tauri): exit 0 (0 errors)
- cargo test (src-tauri): exit 0 — test result: ok. 42 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 2.29s 
- swiftc -typecheck jamsesh-live.swift: exit 0
- No FigCraft crate changes in this phase, so cargo xtask ci is not applicable. ScreenCaptureKit/CGEvent behavior needs permission prompts and is on the office checklist.

## ROUND 5 addendum: real-Mac helper fixes (commit 17687c823 on jamsesh/phase-6)
Applied /tmp/claude-501/native/fix.diff (patch applied cleanly on top of the quit()/release-on-exit work; result identical to jamsesh-live.fixed.swift): (a) frontmost window not largest; (b) SCStream kept in a global (1 frame became about 29 fps); (c) mouse and scroll events carry window field 51, the window-relative point and a click count (undocumented; commented in the Swift file and said in SPEC); (d) minimized, hidden or other-Space windows are "away" (input dropped, stream kept), only a vanished window ends the tile.
Real-host evidence (owner's runs, /tmp/claude-501/native/runs and shots): about 29 fps; taps, typing, named keys, scroll and drag landed when the target window was frontmost; the held button was released on SIGTERM and on stdin EOF. Still unverified, now office checklist item 8: other Spaces, Electron apps, other macOS versions; also the hub-driven release paths against a real app.
Native checks after the change: swiftc -typecheck exit 0; cargo clippy --all-targets -D warnings exit 0; cargo test 42 passed. Review 5 (/tmp/claude-501/p6-review5.md) ran before this commit.
Review 5 verdict AGREE-WITH-CHANGES, findings not yet fixed: tap not tracked as held and down/up not atomic with held state in Swift; previous recording's 300 ms slack can take the next recording's first utterance; owner and sent-receipt caps (200 each) can evict a receipt but keep authorization, allowing duplicate sends; legacy /prompt-window/start replaces an active recording's window without ending that recording; real-host check still pending the owner.

## STOPPED HERE (ROUND 6, JamSesh 6.R5 (wip))
Done and committed: Swift single press state machine (pressLock, tap = down+up held between); speech windows start at the recording's start and never run past the next recording's start (300 ms slack only for the stopping one); noteRecs merges authorization and receipt (evicted together, duplicate-send-after-eviction test); legacy /prompt-window/start returns 409 while a recording runs (tested). record.test.ts 40 pass; hub tsc clean; swiftc typecheck 0 errors.
NOT done: clippy/cargo test rerun for this round, the release-check record (run commands, numbers, paths from /tmp/claude-501/native; other Spaces, Electron and other macOS versions to the office checklist, already item 8), SPEC text for the new speech-window and receipt rules, review 6 (not started).

## ROUND 6 notes (cloud, finishing 6.R5)
- Finished the wip (cadb1ba): reviewed the diff against review 5's four code findings; each is addressed in the stated form. No code change was needed.
- SPEC 11.3: a line belongs to the recording it began in (at or after Start, before Stop, 300 ms more only for the stopping one, never past the next Start on the device); the older `/prompt-window/start` is refused with 409 while a recording runs; the right to send and the send receipt are one record (last 200 kept), and a send for a dropped one is a 404, never a second send.
- STATUS: a Record row for the above, and the Swift press state machine noted as typechecked, not run.
- Tests (Linux, JAMSESH_SILENT=1 JAMSESH_OFFLINE=1, per file, 180 s limit): record 40/40, prompt-window 8/8, liveapps 22/22, driving 15/15, fonts 34/34, audio-fixes 8/8, security-fixes 12/12, web 99/99; hub and web tsc clean.
- Rust (app/src-tauri): it can't build or run tests on Linux (objc2 is Apple-only). `cargo clippy --target aarch64-apple-darwin --all-targets -D warnings` was run from Linux by stubbing the two C build steps that need the Apple SDK (ring's build script overridden with `--config target.aarch64-apple-darwin.ring_core_0_17_14_.rustc-cfg=[]`, clang for objc2-exception-helper): exit 0. `cargo test` for the app needs the Mac.
- Needs macOS: `swiftc -typecheck` for this round's Swift changes (no Swift on Linux), `cargo test` in src-tauri, the release-check record from the owner's runs (`/tmp/claude-501/native` is on the Mac), and the office checklist item 8 (other Spaces, Electron, other macOS versions, hub-driven release on a real app), plus interrupting a press at each transition on a permission-enabled host (review 5 finding 1).
- Not reviewed: review 6 has not run.
