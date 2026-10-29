
ROUND 2: The first review (/tmp/claude-501/p3-review.md, DISAGREE, 8 must-fixes and 4 should-fixes) was fixed in 3d0cbe12..cbed1dad:
- Credential-bound person identity.
- open_project restricted to the picker window.
- Migration with per-source retry and partial dirs.
- Serialized project switches.
- Display-set slot inheritance.
- Host-window auth for expand and screens/config.
- No offline queue for stage actions.
- Per-screen show requests.
- Save errors propagated, lapse for a person-less lock, validated tile keys, resume at the picker.
Then phase-2 was merged (c1de2280), unifying window-owned devices with credential-bound persons. Session.stop() now clears timers. Known open product decision: first-join identity is trust-on-pairing. Confirm and look for anything new.

ROUND 3: The second review (/tmp/claude-501/p3-review2.md, DISAGREE, 9 must-fixes) was fixed in af86fe04..543057e3:
- Show requests are bound to lockSince and expire on any lock change.
- The display routes require the host window.
- The brain unlocks only on the owner's own direct request.
- unlock_screen requires a line id whose words the code checks against a fixed yes-set; negations and questions are refused, and a bystander's yes only counts within 3 minutes of the question.
- keepLock for the owner's own share.
- Hub shutdown reports completion and the app waits 20 s.
- A migration lock with per-attempt staging.
- Leave goes through the switching lock.
- Placement checks window frames.
Confirm and look for anything new.

ROUND 4: The third review (/tmp/claude-501/p3-review3.md, DISAGREE, 5 must-fixes and 2 should-fixes) was fixed in 8f39a6ea..4fc57ec4:
- The consent window opens only when the brain tells the room, tied to lockSince, and a yes counts only after the question.
- sharedOnce shutdown, and Quit takes the transition lock and waits.
- The migration lock is stolen only from a dead PID, with a removal token.
- Placement on resize.
- rolled_back on failed host, join, or resume.
- Atomic config writes.
- Expand goes through stageAction, and the shared useNow is used.
Confirm and look for anything new.

ROUND 5: The fourth review (12889f2fc4fa1086.review.md, DISAGREE, 5 must-fixes and 3 should-fixes) was fixed in the "JamSesh 3.R4" commits:
- Quit: `Turns` (main.rs) replaces the bare switching mutex. Quit takes its turn, sets quitting, and holds it through the acknowledged stop and exit; any switch/host/join/leave/resume queued behind it gets None and does nothing. Rust test nothing_starts_a_session_once_quit_has_its_turn.
- Migration retry: session.json of a copy carries migratedFrom (kept by touchSession/openSession); a retry adopts a published copy whose counts still match the source, instead of copying again. Collisions are checked on the real destination (host -> last-session, then -copy, -copy-2). Tests: adopt after lost marker (repeatedly, even after touchSession), occupied last-session.
- Migration lock timeout now throws (startup fails, "Try again in a minute"); config.enterProject propagates it. Tests updated/added.
- Lock consent: new ask_to_replace_screen tool posts the fixed question and only then opens the consent window (needs a refusal this pass, same lock). say_to_room no longer opens it. unlockRefused cleared per pass.
- Owner implicit unlock: lockBlock requires asksForScreen(ev): triage intent === "present" when triage ran, otherwise a screen verb and not a wh/yes-no question. batch events now carry their triage intent.
- Expand note: CastHost mounted on host windows too (picker only for people); cast() resolves after putOnScreen with the hub's answer.
Disputed/deferred: duplicate tile-key derivation (server stageTileKeys vs web stageTiles) left as is; it is a should-fix design concern and merging them means a protocol change (server-supplied key list) with the web still needing its own nodes. Not verified: no live room, no real displays, no Tauri window run (cargo test only); Stage host-screen note was not screenshotted (no DOM renderer in web tests; checked by a source assertion on main.tsx); asksForScreen is a heuristic for direct requests that skip triage.

ROUND 6: The fifth review (/tmp/claude-501/p3-review5.md, DISAGREE, 6 must-fixes and 2 should-fixes) was fixed in the "JamSesh 3.R5" commits (4da7f875..e4c2a5b7). Each fix is one place every path goes through:
- One consent gate: Session.releaseLock(screen, consent) is the only deliberate unlock (lapse is the other, via private dropLock). Consent is {owner} (the lock's personId, from a paired window's credential or the owner's own words to JamSesh), {hostWindow} (host's windows, only for a person-less lock or the hostPersonId's lock; a body personId never counts), or {answeredAt} (a yes after the question about that very lock, within 3 min; the question record moved into the session: askedAboutLock). /stage/unlock (403 "Only X can unlock this screen."), unlock_screen, lockBlock and ruleRoute all call it. unlockConsent now says "unlock" (words name unlocking/replacing) or "yes"; the owner's bare yes only counts as an answer to the lock question. Web shows Unlock only to the owner (or for a person-less lock).
- One screen resolver: Session.screenRef(ref): omitted/"main" is main, an unknown id or name is null. HTTP /stage, /stage/unlock, /stage/restore, /stage/expand return 404 "That screen isn't connected any more."; every brain screen tool refuses.
- Migration lock: an exclusive SQLite transaction (BEGIN EXCLUSIVE, busy_timeout = wait) on projects/.migration-lock.db. The OS advisory lock is released when the holder exits or dies; nothing is ever unlinked, so no start can remove a live or replacement lock. Tests: two starters against a lock left by a SIGKILLed holder migrate once; a live holder in another process (lock file an hour old) is never taken; in-process holder makes a start time out.
- Transitions (main.rs): Turns now hands out Tickets (the epoch when the request was made); a turn whose ticket is stale (another transition ran while it waited) gets None and does nothing; Leave uses lock_now (never stale), Quit/Reopen take the last turn. Inside its turn each transition checks may_start: Host/Join only from no hub and no relay; a project switch (picker or menu) only while hosting, with the picker check redone in the turn. Reopen (relaunch) is now async: final_stop (shared with Quit) takes the last turn, awaits Hub::stop, and only then request_restart (not restart, which blocks a worker); a failed save is said, the turn is given back (keep_running), leave_now, and no reopen. Any ExitRequested with a code (not ours) is prevented and routed through Quit until `ended`; the Exit fallback waits up to 5 s for the lock and logs a failed stop to logs/exit.log. Rust tests: stale request behind Leave, Leave never stale, reopen-failure keeps the app going, may_start matrix.
- Tile keys (should-fix, was disputed last round): Session.stageTileKeys is the only key maker (layoutIndex added); HubState.stageTiles per screen, patched on any stage commit and when artifacts change (bus flush). Web stageTiles and every Expand button look keys up there.
- viewer.test source assertion deleted. Rendered check done headless (Playwright, throwaway in-process hub, built web): big screen /host in compare mode shows 2 Expand buttons from hub keys, expanding works (strip shown), and a refused Expand shows .cast-note visible and topmost (elementFromPoint). Not kept as an automated test: the repo has no browser test harness.
- Also: the share-placement test now runs without a model (it could hit the 5 s timeout on a gateway call).
Not verified: no live room, no real displays; the Tauri app was not run (cargo test + clippy only), so Reopen/exit routing on a real Mac and ExitRequested on logout are unexercised.

ROUND 7: The sixth review (/tmp/claude-501/p3-review6.md, DISAGREE, 6 must-fixes and 1 should-fix) was fixed in the "JamSesh 3.R6" commits (0ef9c43a..0faf3ef4):
- Questions: lock questions get ids (lq_...). Session.openQuestionsFor(person) lists what a plain answer could mean: that person's pending show requests and the room's open lock questions (same lock, within 3 min). Voice (decideByVoice): an answer settles a show request only when it is the owner's only open question; with more, none is settled and JamSesh says "<name>, which one? ... Use the card for the one you mean." releaseLock's answer consent ({answeredAt, by}) requires the lock question to be the speaker's only open question; unlock_screen refuses with "more than one question open". A line answers one question once (Brain.answerLines; showVerdict now returns the line id). Cards (by request id) unchanged. Tests: two show requests for one owner on two screens; owner's show request plus a lock question; a used line can't unlock.
- Share fallback: setStage takes ifRev, a compare-and-set on Session.stageRev(screen) (bumped by every commitStage: casts, expand, unlock, lapse). placeShare captures the rev when it decides and the fallback also checks the share is live and the brain not stopped. Tests (share-delay.test.ts, presenter mocked to resolve on demand): a cast during the wait wins and the old lock isn't restored; an ended share or a stopped brain isn't put up; with nothing newer it still goes up with its sharer's lock.
- Screens: Session.screenMatch: exact id, exact normalized name, or the start of exactly one name in whole words ("left" -> "Left TV"); never substrings or part of an id/word. Several -> choices: HTTP 409 "Which screen: Left TV or Left monitor?", the brain refuses with 'Ask the room which one'. Stale "screen-20" with "screen-2" connected -> 404. SPEC:167 fixed.
- Migration: each old database is read as one snapshot, VACUUM INTO from a read-only connection (one read transaction, WAL included), never file copies of db/WAL/shm. Test: a live writer that keeps 50 rows only in the WAL then writes and TRUNCATE-checkpoints every 3 ms: the copy has every row committed before the migration, integrity ok. Honest limit: that test also passed with the old file copy in 3 tries (the checkpoint race isn't hit deterministically); correctness rests on SQLite's read-transaction semantics for VACUUM INTO.
- App: Turns::lock_quiet (waits for transitions, refuses stale tickets, doesn't bump the epoch). screens::arrange_for(app, ticket) takes a quiet turn and reads the hub origin inside it; used by display-change scheduling, the menu (bigscreen, reopen), the setup window's save, the user-less toggle. A closed screen's DELETE /api/display takes its ticket at the close, so windows closed by Leave/switch never retire screens on the next hub. arrange() itself is only called with a turn held (in-transition from start_hosting).
- Reopen: quit_for(ticket) so two queued Reopens act once (the second is stale). Any failed stop (Reopen, Leave, switch) sets Turns::unsaved; a Reopen with unsaved set doesn't restart, the app stays, and the dialog offers "Reopen anyway" (clears it and reopens for the session asked about) or "Not now". Rust tests: two queued Reopens with a failed save; quiet arrangement behind a switch.
Not verified: no live room, real displays, or running Tauri app (cargo test + clippy only).

ROUND 8: The seventh review (/tmp/claude-501/p3-review7.md, AGREE-WITH-CHANGES, 5 must-fixes) was fixed in a722e478 ("JamSesh 3.R7"):
- Questions: Session.openQuestionsFor now covers every yes/no a person can be asked: pending host build approvals (anyone may answer), their show requests, the room's lock questions. decideByVoice: a build verdict that doesn't name its kind (bare yes/go ahead) settles nothing when the person has more than one open question; "deny the build"/"approve the build" name the kind and count. Build decisions use up their line too. The "which one?" prompt lists builds. Test: build + show request open together.
- Stage writes: setStage(next, by, screen, opts) now requires opts to be a person, override (upkeep now), or a StageClaim (Session.stageClaim(): per-screen revisions when the work decided). Claimed writes land only if the screen's revision is unchanged and advance the claim; expandTile/expandWhich, showReady, restoreHistory and releaseLock take claims too. setStage itself drops tiles of shares that aren't live and refuses a layout left empty. The brain's tools get one claim per pass (tools() param; placeShare passes its own to the presenter's set_layout), ruleRoute and the auto-compare take one, mcp jam_show takes one. Brain tools now report "The screen changed while you were deciding..." when their write didn't land. Tests: share-delay.test.ts adds the presenter's set_layout answering late (after another write, and after the share ended).
- Screen names: ids ("main", "screen-N") are looked up as ids only; a name counts only when exactly one screen has it (duplicates -> 409/brain asks, naming "Left TV (main)" etc.); unique whole-word start still works.
- Reopen: checks Turns::unsaved before stopping anything (the running session is left as is); "Reopen anyway" clears unsaved only inside a valid quit_for turn (reopen(..., discard=true)). Rust test: an old dialog's ticket can't clear a later failure.
- Screen setup (screens_save) and the user-less toggle (menu and command) take their quiet turn before saving config or touching windows, then arrange_current inside it; the user-less config is saved before being applied in memory.
- Kept: viewerNav step() (used in 4 places in WorkViewer); the reviewer marked it optional.
- Tests updated mechanically for setStage's required opts (claims). brain.scenarios.test.ts and the review-fixes voice-preview test hit their time limits before and after this change (live model/TTS), so they're environment-bound, not regressions.
Not verified: no live room, real displays, or running Tauri app.
