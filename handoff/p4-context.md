
ROUND 2: The first review (/tmp/claude-501/p4-review.md, DISAGREE, 9 must-fixes and 2 should-fixes) was fixed in d086f7e9:
- Overheard passes can only propose; cancel and pair become cards.
- Briefs, digest, and carry-over use accepted material only.
- Curation updates need a cited source, and a rewrite becomes a Replace card.
- A shared similarity module with negation and scope checks.
- Store.atomic transactions for card actions, with idempotent retries.
- Fully validated context.json with an activeAt guard.
- PDF text extraction (pdftotext or a built-in reader), and a needsWording state.
- The composer blocks Send on failed files.
- Attachments in a separate fenced message, with only the tools the person's own words ask for.
- Upload byte cap before parsing.
- Explicit artifact-to-directive attribution.
Two deliberate choices: jam_context still shows the last 10 minutes of raw room talk as context, and the agent-triggered consider pass (answering an agent's own question) may use room talk. Confirm and look for anything new.

ROUND 3: phase-3 (with Phases 1 and 2 and all their fixes) was merged in 106df12f. The second review's findings (/tmp/claude-501/p4-review2.md, DISAGREE, 9 must-fixes and 2 should-fixes) were fixed in 17eaa298:
- /say uses actor().
- File questions get only answer and search tools, and work tools need explicit work words.
- Overheard questions are 'asked', not direct.
- Scope-aware dedupe.
- Retire needs a cited line.
- Carry-over writes an empty snapshot on retire, and a session with its own data isn't seeded.
- needsWording blocks merge.
- Curation backoff without advancing the cursor.
- Send revalidates agents.
- A PDF worker with drawn-text-only extraction.
Confirm and look for anything new.

ROUND 4: The third review (/tmp/claude-501/p4-review3.md, DISAGREE) was fixed in aff969e9:
- A clause-based intent gate (brain/intent.ts) that understands negation and quotes.
- Option polarity in similarity.
- A forward eventsAfter curation cursor.
- Conflict and Replace scoped to kind, workstream, and platforms, and pinned to the matched fact.
- An empty snapshot on any retire.
- Snapshots clamped to the reader schema and validated before writing.
- context.json under an O_EXCL lock across processes.
- A Retire card refuses another factId.
- The live gateway attachments path is verified, and the PDF worker is fixed and verified in a compiled binary (--pdf-text).
- The PDF reader reads only page /Contents streams.
- The glossary is in the brief.
Confirm and look for anything new.

ROUND 5 notes (fourth review, /Users/cheyrasmussen/.local/state/chey-skills/receipts/second-opinion/staff-engineer/ae6ed05b59c508c4.review.md, DISAGREE; fixed in the "JamSesh 4.R4" commits on jamsesh/phase-4):
- File gate: create_directive with a file needs a clause that opens with the instruction (after please/can you/let's/go ahead and); "Summarize how to build...", "Explain what we need to fix..." offer no work tool. Ask-an-agent form now requires agent/claude/codex.
- Curation: pairing a supersede with an addition needs the same kind, workstream and platform. proposeContext ignores a named replaces across those. Replace re-checks old fact vs the final (edited) card for kind, workstream and platform. applyCuration now requires the hold; the direct-write branches are gone (phase4-brain tests use a recording hold).
- Lock: carryover.acquireLock/releaseLock. Lock file holds "pid token". Taken over only when old AND owner dead (or own pid, or unreadable); a paused live writer keeps it. Takeover moves the file aside and puts it back if it wasn't the one judged. Release removes only own token; the token is checked again before the rename.
- Keeper: saveProjectContext returns written/skipped/failed; ProjectKeeper.save throws on failed (after the thumbnail), so Hub.shutdown returns false. projects.run test updated: its stand-in session can't snapshot, so save now rejects.
- Attachments: MAX_MESSAGE_BYTES (25 MB) in refs() -> 413; brainInput caps file parts at 15 MB and names the rest as not shown. Attachment GET/HEAD need a paired device/agent or the host window cookie (401 otherwise, loopback included). Unreadable files keep the file-pass restrictions and the brain is told to say so.
- Scenario "same ask from two people": the brain, seeing its own waiting card, overruled it and re-proposed; proposeTask joined the overruled card (repeat kept the mark), so the board held one card marked overruled and bench newDirectives (which skips overruled) counted none. Fix: repeat() clears "overruled"; the router prompt says a second person agreeing is the same ask again, not an overrule. Passed 3/3 live runs.
Disputed: none. Not verified: the stale-lock takeover race between two live takers is narrowed (move-aside, token recheck before rename), not proven; no real two-process SIGSTOP test (a live-pid lock is simulated with the parent pid). The loopback 401 was tested over HTTP, not from the compiled Mac app (the host window cookie is what the web client sends). Mid-session, a "git stash pop" in this worktree produced a spurious conflict with wiki files from nowhere; I reset and restored my 8 files from the stash. If anything else was meant to be in the tree, it was lost then (nothing of mine; the wiki files are not on this branch).

ROUND 6 notes (fifth review, /tmp/claude-501/p4-review5.md, DISAGREE; fixed in the "JamSesh 4.R5" commits on jamsesh/phase-4):
- File gate, now structural (no wording heuristic; brain/intent.ts, askedFor, WORK/ASKS are deleted). With files in a pass, tools() gets `files`; one flag `proposeOnly = route === "overheard" || files` is read by every acting tool. Offered: FILE_TOOLS = say_to_room, no_action, search_artifacts + create_directive, record_decision, pair_agents, cancel_directive, and those four only put cards on the Tasks board (origin "document"); nothing reaches an agent or the saved context until a person sends/adds the card. A file pass can't mark a waiting card overruled. triage_card, screen tools, ask_agent, host, naming, notes are never offered; checked again at execution. A file with no words, or files that can't be read, get answering tools only. The model is told cards wait on the board. Trade-off: "send this file to Felipe's agent" now makes a card the person clicks Send on, not a direct directive.
- Carry-over rewritten on SQLite (projects/<slug>/context.db, tables items + meta). A session writes only what it changed (changedHere: own items, or carried items changed after carry-in), each under its project id (CarriedFrom.id from seeding). Items only carried are never written, so overlap can't erase another session's facts; an item both changed keeps the later change by changedAt, whichever saves last. A retire of an id the db doesn't know also retires active rows with the same kind/text/workstream. No count caps; fact limits 20k chars and a change past them fails the whole save (the brain's brief/goal/glossary are still cut). Each save is one BEGIN IMMEDIATE transaction (busy_timeout = waitMs, default 2 s): the lock is the connection's, released on process death, never taken over; the file lock, acquireLock/releaseLock, activeAt ownership and the Boolean wrappers (writeProjectContext/commitContext) are deleted. A non-database file is moved aside (context.db.unreadable-<t>, with -wal/-shm). After each save context.json is exported under the same lock (Phase 7's wiki reads it); an old context.json is imported once when no db exists.
- Veto: Board.overrule appends to card.vetoes {reason, by, at, eventIds} and nothing clears it. repeat() no longer clears overruled; proposeTask skips overruled cards and makes a new card with renews = the vetoed card's id (web shows "Asked again after the room overruled it"; describe() says so). proposeCancel likewise.
- File gate fallback: with files attached, directPass never falls back to offlineDirect/ruleRoute (no key, a failed pass, or an empty answer); it says it couldn't work through the files. Tested.
- Attachments: on loopback, GET/HEAD /api/attachments/<id> checks a supplied token (bearer, cookie, ?token); no credential and no host-window cookie is still 401. Only that route; other local routes are unchanged.
- Tests: new hub/test/p4-round5.test.ts (adversarial file + the review's three explanatory requests + imperative ones: nothing acts, cards only; the same request with no file acts; overlap and same-item merge; 350 facts/60 workstreams kept; a SIGSTOPped child holding BEGIN IMMEDIATE blocks writes, SIGKILL frees it; 3 concurrent writer processes plus a killed holder lose nothing; veto provenance; loopback agent/browser tokens, bad/revoked 401). carryover, p4-review, p4-round4 tests updated to the new API and semantics. Ran: those 4 + 23 other affected hub files all pass; hub and web tsc clean; web tests 70 pass. Screenshot of the Tasks board's "Asked again" card checked (desktop).
Disputed: none. Not verified: brain.scenarios/bench "same ask from two people" live run (needs gateway); with the new behaviour the board holds the vetoed card plus a new one, and bench's newDirectives (skips overruled) should count one. Not run against the compiled Mac app.

ROUND 7 notes (sixth review, /tmp/claude-501/p4-review6.md, DISAGREE, 7 must-fix + 2 should-fix; fixed in the "JamSesh 4.R6" commits on jamsesh/phase-4):
- Attachment gate on every route: brain.ts `withFiles(batch)` is the one check. tools() derives "this pass has files" from its batch (no parameter), so direct, overheard (hear -> route), by-name, and agentMessage passes all get FILE_TOOLS (answering only with noWords or unreadable files), with proposeOnly and the execution-time recheck. The keyword rules (ruleRoute, offlineDirect incl. triageByVoice) and decideByVoice drop lines with files. Test p4-round6 enumerates 10 routes (model, failing gateway, no key, by name, voice approve, agent message) with a model that obeys the file, plus a no-file control showing the rules do change the screen.
- Carry-over: rows carry a version; retired facts are tombstones that no write makes active again. A session saves only items whose meaning (status, kind, text, workstream; not sources, notes or timestamps) differs from the version it last saw (setting carryBase: projectId -> {v, sig}, set at seeding and after every save). Per-row merge inside the IMMEDIATE transaction: base == row version applies; a retirement always applies; two blind edits: later by (changedAt, session id). Source-only restatements are no longer saved, so they can't revive. Same-millisecond changes are caught by meaning, not time. Seeding by project id, deduped only when kind, workstream and wording all match. Invalid fact status fails the whole read. activeAt removed; ProjectContext has generation.
- Export: after commit, a second IMMEDIATE transaction reads the committed state and writes context.json (tmp + rename), skipped if the export already shows that generation or later. A failed save never touches it. Import of context.json (export or pre-database file) only into a new empty database, validated whole.
- Recovery: no renames. A damaged context.db stays; openForWrite moves to the next generation (context-1.db ...), which every process that finds the damage opens identically; the new file imports the export once (meta 'imported', inside an IMMEDIATE transaction). Busy on a fresh file is retried until the wait is up.
- Vetoes: full history kept (no slice).
- Attachments: credential from Authorization header or jam_token cookie only; ?token= -> 400; Cache-Control: no-store.
- Tests: new hub/test/p4-round6.test.ts (8 tests: routes; six save orders of retire/accept/restate across three sessions; same-ms change; same words in other kinds/workstreams; bad status; failed save leaves export; 3 processes x 40 saves, export == db at generation 121; 4 processes recover from a damaged db into one context-1.db losing nothing; 13 vetoes). The race tests passed 10/10 in a loop. carryover, p4-review, p4-round4, p4-round5 updated; 24 other affected hub files and web tests pass; hub and web tsc clean.
Disputed: none. Not verified: live gateway, compiled Mac app.

ROUND 8 notes (seventh review, /tmp/claude-501/p4-review7.md, DISAGREE, 5 must-fix + 2 should-fix + 1 note; fixed in the "JamSesh 4.R7" commits on jamsesh/phase-4):
- Export is lossless: ProjectContext.rows = every item row (tombstones, versions, changed_at, session) and every meta row; importJson restores rows exactly when present (checked by loading them into a scratch DB and reading back first), legacy shape otherwise. Test: retire, damage, recover, older session's edit -> stays retired.
- Seeding/reading recovers first: readProjectContext on a damaged newest DB runs openForWrite (next generation, imports the export under its write lock) and reads that; null only when nothing valid exists (logged).
- Per-row result: apply returns applied (id -> version) and superseded (id -> the row that stands). saveProjectContext advances carryBase only for applied rows. A superseded fact is pulled into the session as the row stands (retired, or the other wording; note says so) and the lost wording becomes a context card ("Not saved for the project: another session ... first") for a person to add again or dismiss; a superseded workstream is pulled in. No repeated retries.
- Export failure: exportJson throws; commitChanges returns "failed" with result.reason and result.committed (bases still advance for committed rows, so nothing is re-sent); a later save with nothing new still opens the DB and writes a stale export (outcome "skipped" if it succeeded, "failed" if not).
- Send: if any target is gone or only watching, nothing is sent (409), the card gets unavailable: [names] (from targetNames kept on the card at propose/edit) and shows "Not sent: X isn't available"; a successful Send clears it. Screenshot checked (390 px).
- Merge: same kind, workstream and sameScope check as Replace in Board.merge; the web picker lists only facts of the card's kind and workstream.
- STATUS rows updated (structural gate; SQLite carry-over). Session.onDirective removed.
- Tests: new hub/test/p4-round7.test.ts (6). triage-board, p4-review and web tasks-board tests updated for Send/Merge rules. All 34 affected hub files, web 70 pass; tsc clean.
Disputed: none. Not verified: live gateway, compiled Mac app.

STOPPED HERE (machine going offline): round 7 fixes committed (last c275731d); review 8 was started and killed before it finished (no verdict, no p4-review8.md). Next: rerun /tmp/claude-501/r4h.sh.
