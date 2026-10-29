# JamSesh: cloud session report (2026-10-29, Linux)

The cloud session couldn't push. GitHub refused every push with 403, because the Claude
GitHub App has read access to `fluid-commerce/jamsesh` but not write access. Every branch
below exists only in the git bundle `jamsesh-cloud.bundle`, which was sent with this report.
`main` was never touched. No independent review ran (`chey second-opinion` isn't available
in the cloud), so **every phase still needs review**. None of this has passed.

## Getting it onto the Mac

```bash
cd ~/jamsesh   # the FigCraft checkout that holds jamsesh/
git fetch ~/Downloads/jamsesh-cloud.bundle 'refs/heads/jamsesh/*:refs/remotes/cloud/jamsesh/*'
git log --oneline -3 cloud/jamsesh/improvements
```

Then, for each branch, fast-forward the local branch (all of them sit on top of the pushed
tips) and push. Push `jamsesh/*` only, never `main`:

```bash
for b in phase-1 phase-2 phase-5 phase-6 phase-7 improvements handoff; do git push origin cloud/jamsesh/$b:refs/heads/jamsesh/$b; done
```

| Branch | Pushed tip (before) | Cloud tip |
| --- | --- | --- |
| jamsesh/phase-1 | a5451b6 | 060839e |
| jamsesh/phase-2 | e17d0e8 | 425c43c |
| jamsesh/phase-3 | a722e47 | a722e47 (unchanged) |
| jamsesh/phase-4 | c275731 | c275731 (unchanged) |
| jamsesh/phase-5 | a614509 | 9b1a65f |
| jamsesh/phase-6 | cadb1ba | 5a6fd1a |
| jamsesh/phase-7 | 1987e6f | 9bcd3dd |
| jamsesh/improvements | 5dcc5a5 | 38a1063 |
| jamsesh/handoff | cdf5678 | this commit |

Every test below ran on Linux as root, one file at a time with a 180 s limit, with
`JAMSESH_SILENT=1 JAMSESH_OFFLINE=1`. Nothing played sound.

## Per phase

Full round notes are appended to each `p<N>-context.md` (headed "(cloud)").

**Phase 1 (1.R13): finished.** Tests were fixed and added for the helper registry (whisper
tracked, `Hub.stop` true only when every exit was seen, a rejected exit counts as not reaped,
late spawns stopped) and for counterparts (session, brain tool, HTTP). Real bug fixed: on
Linux the parent-watch wrapper cut off stdin (dash), so canvas participants saw end of input
at once. Results: agent-news 27/0, canvas-reconnect 20/0, children 11/0, helper-reaping 3/0,
http-agents-fixes 10/0, web 54/0. astra2-fixes fails 1 on the branch: the test is stale, and
the integration branch already has its fix (6810e8a). Still open: a helper's own children
can outlive it (no process groups), Bonjour isn't in the registry, and `Hub.stop` doesn't
clear the devproxy refresh interval. Needs macOS: the bundled-app check (hung page, killed
hub, restart, port release) and the wrapper under macOS's shell.

**Phase 2 (2.21): finished.** The write audit of the setup script found and fixed: a folder
at a destination (mv would have put the file inside it), the `~/.claude.json` key edit
skipping the guard, and a linked `setup.lock`. Test fixes: the 20-run lock test never ran
its fake CLI, and the "can't be put back" test relied on a read-only home, which root
ignores. Results: setup-script 48/0, join-only-when-told 20/0, devtile 9/0. Still open: a
real Claude Code `mcp add-json`/`remove`, including Claude Code writing `~/.claude.json`
during setup. Needs macOS: the script on BSD tools (it avoids GNU-only flags, but this
wasn't run on a Mac).

**Phase 3 (3.R7): no new work.** Its review 8 never finished, and it still needs review.

**Phase 4 (4.R7): no new work.** Its review 8 was killed before a verdict. Next step:
rerun `r4h.sh`.

**Phase 5 (5.R6): finished, including the agreed split design.** A copy within 10 dB of
the best, or loudest at its own laptop for 400 ms, is transcribed. Different words become
their own line, which never auto-enrolls and is named by voice only. Also done: echo needs
the exact same words; merging tries every eligible twin; the hub issues the reset epoch;
strict WAV parser (malformed is 400); Whisper deletes only the file it downloaded
(manifest and realpath); realpath before the Parakeet check; the Mac app deletes
`voiceprint.json` and its `.part` files; the voice-travel wording is gone. Whisper load with
4 laptops: 1 transcription per line before; 2 (spread across a room) to 4 (around one
table) after. Results: all phase 5 files pass. voices skips 23 (needs `say`),
phase5-round6 skips 7 (no speaker model). transcription fails 1 ("jamsesh" not recased)
because Linux has no system word list; it fails the same way on the base. Still open: a
quieter copy that whisper hears slightly differently shows as a second line (the agreed
"keep both" limit), and `install.sh` doesn't write the Whisper manifest. Needs macOS: the
Tauri crate's tests (the new Rust function was compiled and tested standalone), the voice
simulation and bench, and real microphones for the 10 dB and 400 ms thresholds.

**Phase 6 (6.R5): finished on Linux.** The wip covers review 5's four code findings. Added
SPEC and STATUS text for one-recording speech windows, the joined send record (a dropped
record is a 404, never a second send) and the older start being refused during a
recording. Results: record 40/0, prompt-window 8/0, liveapps 22/0, driving 15/0, fonts
34/0, audio-fixes 8/0, security-fixes 12/0, web 99/0. Clippy on the Mac app for
`aarch64-apple-darwin` from Linux exits 0 (recipe below). Needs macOS: `swiftc -typecheck`
for this round's Swift, `cargo test`, the release-check record from
`/tmp/claude-501/native`, office checklist item 8, and interrupting a press at each
transition on a permission-enabled host.

**Phase 7 (7.12): finished.** Shutdown now waits up to 10 s for in-flight requests,
speech and the brain's pass, seals the store's events before the final wiki capture, and
seals everything at the end. A write after the seal throws `ESEALED`, and a request gets
503. The web and hub slug rules are shared and tested on both sides. A half-filed hand
change is finished on the next pass. Results: wiki 87/4 as root (the 4 need a read-only
folder, which root ignores; as user `nobody` it was 90/1, a timing limit under load);
others pass. Still open: a timer that adds an event after the seal stops Bun mid-flush,
and an MCP streaming response counts as finished when it returns.

## Integration (`jamsesh/improvements`, 38a1063)

Phases 1 to 7 and polish were merged in order. Each merge commit message says what was
kept from each side. Hub and web `tsc` are clean after every merge. Integration fixes
beyond plain conflict resolution:

- **Coordinate counterparts reach the Tasks board.** After 1.R13 the session refuses a
  coordinate directive without counterparts. Phase 4's board and Reassign created those
  without them, so cards now carry counterparts, Send checks them (409, "Add one with
  Edit"), and Reassign keeps them.
- **Whisper and Parakeet are tracked in the hub's helper registry.** Phase 5's managers
  replaced the code phase 1 had wrapped. The transcriber stops only its own engines,
  because the registry is shared with the canvas and stopping all of it early would kill
  the canvas server before the final snapshot.
- **Stage claims (3.R7) across other phases.** An approved build's live app takes its
  claim before waiting for the window. A recording gives its lock back through
  `releaseLock`. Other phases' tests pass a claim. `share-delay.test.ts` was removed,
  because share placement is immediate in the session (1.R3), so its 45 s race no longer
  exists.
- **One capped reader for every request body.** The upload reader now goes through 6.R5's
  byte reader.
- **Shutdown budget.** The steps are now 10 s for in-flight work, then 8 + 4 + 5 + 12 +
  3 s, then up to 4 s to reap helpers. The Mac app's `SHUTDOWN_WAIT` goes from 45 s to
  50 s (`host.rs`, with its test and SPEC).
- **Migration.** A database with no WAL files is snapshotted from a private copy, so the
  original folder gains no `-wal`/`-shm` files. "Leaves the originals exactly as they
  were" failed on Linux before this, and also on phase 3 alone.
- **Rust.** Phase 5's voice-copy tests and phase 2's tests were both `mod tests` in
  `main.rs`, so phase 5's is renamed. Clippy now passes for the macOS target.
- **Merge choices.** Phase 6's lend-only fonts supersede phase 1's `local_fonts` fixes
  (R9 to R11). Phase 4's file rule (`FILE_TOOLS`) replaces the earlier wording check.
  Phase 5's "only the host or the person removes someone" holds, and the fonts test was
  updated to match.

### Known failures on the integration branch (not fixed)
- `stage-lock.test.ts`, "a paired window is the person it's bound to…" (line 591): after
  `removePerson(maya)`, an unpaired window registering a device for Felipe resolves to
  no one. It started failing with the phase 6 merge (5.R6's removal rules plus phase 6's
  device code). Unresolved: work out which rule is intended.
- transcription 1 (Linux word list), wiki 4 and projects 1 (root ignores `chmod`): these
  depend on the environment.
- `helper-reaping.test.ts` failed 1 of 3 once under load and passed on rerun.

## Not done in the cloud
- **Step 3, the whole suite file by file**, was run only for the files each merge touched
  (about 45 hub files plus web). The full per-file pass, and the live-model files
  (`brain.scenarios`, `wiki.live`), are unverified.
- **Step 4, silent mode in the page.** Not done. The plan: in `speech.ts`, a single
  `silent()` check makes `speak()` send `audio: null` (the text still shows) and `chime()`
  send nothing. `/voice-preview` refuses in silent mode. `HubState.session.silent` lets
  the page's `HostView`/`ClientView` playback, `playChime` and the Settings preview skip
  playing too. Add a hub test on the bus messages and a web test.
- **Step 5, Mac-app isolation overrides.** Not done. The plan: in `main.rs:27-28`,
  `JAMSESH_RELAY_PORT` and `JAMSESH_KEYCHAIN_SERVICE`; in `host.rs:31`,
  `JAMSESH_HUB_PORTS`; and the app data folder via `JAMSESH_APP_DATA` (`main.rs`
  `app_data_dir`). The defaults stay the same, and each value is read once.

## Checking the Mac app's Rust from Linux

`cargo test` can't run on Linux (objc2 is Apple-only), but clippy can check the code:

```bash
rustup target add aarch64-apple-darwin
cd jamsesh/app/src-tauri && mkdir -p ../resources
CARGO_TARGET_DIR=/tmp/ct CC_aarch64_apple_darwin=clang CFLAGS_aarch64_apple_darwin=--target=arm64-apple-macos11 \
  cargo clippy --target aarch64-apple-darwin --config 'target.aarch64-apple-darwin.ring_core_0_17_14_.rustc-cfg=[]' --all-targets -- -D warnings
```
