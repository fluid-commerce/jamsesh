# JamSesh improvements: where things stopped (2026-10-29, morning)

All seven phases are built. None has passed independent review yet. Nothing is
pushed, and `main` is unchanged.

## Branches and worktrees

| Phase | Branch | Worktree | Latest review | Notes file |
| --- | --- | --- | --- | --- |
| 1 Coordination | `jamsesh/phase-1` | `~/jamsesh-p1` | 13: fix these first | `p1-context.md` |
| 2 Agents join | `jamsesh/phase-2` | `~/jamsesh-p2` | 15: fix these first | `p2-context.md` |
| 3 Big screen | `jamsesh/phase-3` | `~/jamsesh-p3` | 8: check `p3-review8.log` | `p3-context.md` |
| 4 Tasks and brain | `jamsesh/phase-4` | `~/jamsesh-p4` | 8: check `p4-review8.log` | `p4-context.md` |
| 5 Hearing | `jamsesh/phase-5` | `~/jamsesh-p5` | 6: don't ship (voice travel and sound-based dedupe now cut) | `p5-context.md` |
| 6 Driving and fonts | `jamsesh/phase-6` | `~/jamsesh-p6` | 5: fix these first | `p6-context.md` |
| 7 Wiki | `jamsesh/phase-7` | `~/jamsesh-p7` | 8: fix these first | `p7-context.md` |
| Polish | `jamsesh/polish` | `~/jamsesh-polish` | Done, 5 UI fixes | |
| Integration | `jamsesh/improvements` | `~/jamsesh-final` | Stale: assembled before most review rounds | |
| Bundled-app test | `jamsesh/apptest` | `~/jamsesh-apptest` | Interrupted; see its report | |

Each context file ends with a "STOPPED HERE" note from its worker: what was
done and what's left. Work in progress was committed as "(wip)" where it
compiled.

## Files in this folder

- `*-context.md`: every review round's notes, fixes, and disputes per phase.
- `p*-review*.md`: the reviewer's full findings, per round.
- `r*.sh`: the review scripts. Copy the latest one per phase and bump the
  round number.
- `fix-round-brief.md`: the brief every fix worker follows.
- `rules.md`, `p*-rules.md`: live-room safety and silent-test rules.
- `remerge.sh`: merges every phase plus polish into `jamsesh/improvements`,
  stopping at the first conflict.
- `morning-decisions.md`: decisions for Chey. 7, 8, 12, and 13 are decided;
  10, 11, and 14 are open.
- `polish.md`: the polish queue (done).
- `fix.diff`, `jamsesh-live.fixed.swift`: the proven real-Mac capture
  fixes (already applied on phase-6).

## Fastest path to a release (about 2 hours)

1. Finish or drop each phase's wip commit, and run each phase's affected
   tests.
2. Run `remerge.sh` into `jamsesh/improvements`, then the full test suite
   (per file, with time limits).
3. Build and run the bundled Mac app with an isolated HOME (see the
   app-test report), checking hosting, switching projects, Quit and
   relaunch, and recovery after a hub crash.
4. If green, merge to `main` and push. That push triggers the release
   build. Ship with the open review findings listed as known edge cases.

## Open decisions for Chey

- 10: parity questions go to every agent on a platform, not per product.
- 11: a message with a file attached only makes Tasks cards; it never
  acts directly.
- 14: a person's edit that matches a wiki proposal exactly counts as
  accepting it.
- Whether to keep looping until every phase passes clean, or cap the
  rounds and release.
