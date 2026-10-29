# Fix round brief (shared by every phase worker)

You fix one JamSesh phase after an independent code review, then run the next review yourself and report its verdict.

## Ground rules
Read /tmp/claude-501/rules.md (and /tmp/claude-501/pN-rules.md if it exists for your phase). They are binding:
- Never touch ports 4790/4747, the whisper-server on 8178, ~/.jamsesh, the real ~/.claude or ~/.codex config, the jamsesh MCP tools, or the running jamsesh-app.
- Nothing may play sound. JAMSESH_SILENT=1, `say` only with `-o <file>`, headless Chromium with --mute-audio.
- Run tests per file under a time limit with /tmp/claude-501/perfile.sh or `perl -e 'alarm 180; exec @ARGV' bun test <file>`. Never the whole hub suite at once.
- Kill processes by PID only. Never `pkill -f`.
- Rust/Tauri builds use a private CARGO_TARGET_DIR under /tmp/claude-501 that you delete when done (the disk is 95% full).
- Don't trigger macOS permission prompts.

## Fix
1. Read your phase's review file and your phase's context file (/tmp/claude-501/pN-context.md, which has every earlier round).
2. Verify each finding against the code. Fix every must-fix and reasonable should-fix. If a finding is wrong, don't fix it; write down why.
3. These reviews have now found new holes in the same areas several rounds in a row. Don't patch the single path the reviewer named. Find the invariant it breaks, enforce it in one place every path goes through, and test the other paths into that place too.
4. Add regression tests for each fix, including unhappy paths. Run the affected test files and `tsc` for hub and web.
5. Commit on your phase branch in small commits, ending with the trailer line given in your prompt. Don't push.
6. Append a "ROUND N notes" section to your context file: fixes, disputed findings with reasons, what you could not verify.

## Re-review
7. Write /tmp/claude-501/rN-next.sh by copying the latest /tmp/claude-501/r<phase><letter>.sh for your phase (your prompt names it). Change:
   - the log name to the next round number,
   - the "Confirm each finding" focus to point at your phase's latest review copy,
   - the other --focus lines to name the areas you just changed.
   Keep the --diff, --repo, --title, and --author-model claude-opus-5-5 as they are.
8. Start it detached: `nohup /tmp/claude-501/rN-next.sh >/dev/null 2>&1 & disown`.
9. Wait for it: poll the log every 60 seconds with `grep '^exit' <log>`, for up to 40 minutes. Exit 0 is AGREE, 10 is AGREE-WITH-CHANGES, 11 is DISAGREE.
10. Copy the review file named in the log's `"review":` field to /tmp/claude-501/pN-reviewM.md (M = that round).

## Report (under 200 words)
Fixes, disputes, test results, final sha, the new verdict and its one-line summary, and the path of the new review copy.
