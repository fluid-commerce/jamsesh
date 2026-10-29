cd /Users/cheyrasmussen/jamsesh-p6/jamsesh/app/src-tauri
export CARGO_TARGET_DIR=/tmp/claude-501/p6-target
{
echo; echo "## ROUND 4 native verification (run by the orchestrator, $(date '+%H:%M'))"
perl -e 'alarm 1500; exec @ARGV' cargo clippy --all-targets -- -D warnings >/tmp/claude-501/p6-clippy.log 2>&1; echo "- cargo clippy --all-targets -D warnings (src-tauri): exit $? ($(grep -c '^error' /tmp/claude-501/p6-clippy.log) errors)"
perl -e 'alarm 1500; exec @ARGV' cargo test >/tmp/claude-501/p6-ctest.log 2>&1; echo "- cargo test (src-tauri): exit $? — $(grep '^test result' /tmp/claude-501/p6-ctest.log | tr '\n' ' ')"
swiftc -typecheck /Users/cheyrasmussen/jamsesh-p6/jamsesh/hub/native/jamsesh-live.swift >/tmp/claude-501/p6-swift.log 2>&1; echo "- swiftc -typecheck jamsesh-live.swift: exit $?"
echo "- No FigCraft crate changes in this phase, so cargo xtask ci is not applicable. ScreenCaptureKit/CGEvent behavior needs permission prompts and is on the office checklist."
} >> /tmp/claude-501/p6-context.md
rm -rf /tmp/claude-501/p6-target
cd /tmp/claude-501
chey second-opinion --preset staff-engineer --author-model claude-opus-5-5 --title "JamSesh Phase 6: driving and reviewing together" --diff jamsesh/phase-3...jamsesh/phase-6 --repo "$HOME/jamsesh-p6" --context @/tmp/claude-501/p6-context.md \
 --focus "Recording identity: Start returns an id, Stop requires it. Can any Stop, repeated, late, racing or from the unmount path, end or read a recording that isn't the one it names? Does the client wait for Start?" \
 --focus "Mac button release in liveapps.ts macSend/releaseHeld and the Swift helper: can a button stay down after control change, tile end, another driver, a lost up, or the hub closing? Any double or wrong release?" \
 --focus "Injected devdrive.ts per-driver state, DriveLayer letGo, liveapp replay cleanup: can a button or key stay held in a build or tile after leave, driver removal or unmount?" \
 --focus "Fonts: reservation before reading in download(), Content-Length handling, and lend tickets only for wanted fonts. Can concurrent downloads or callers exceed the caps, or a legitimate lender be blocked?" \
 --focus "Frame key: keepFrameCurrent and refreshFrameKey. First-use reconnect, reload loops, stale keys" \
 --focus "Confirm each finding in /tmp/claude-501/p6-review3.md is fixed, and read the native verification results in the context" --focus "Are the tests meaningful, and what should be deleted?" > /tmp/claude-501/p6-review4.log 2>&1
echo "exit $?" >> /tmp/claude-501/p6-review4.log
