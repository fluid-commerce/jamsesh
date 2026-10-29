JamSesh is a room-collaboration app (Bun/TS hub, React web, Tauri app) in the FigCraft repo. This is Phase 7 of an approved plan, the project wiki. The diff is jamsesh/phase-4...jamsesh/phase-7. The design is in /Users/cheyrasmussen/jamsesh/jamsesh-wiki-proposal.md (decided by Chey: one wiki per project; people edit freely with edits logged as sources; the graph is a big-screen stage mode; the fact list folds into the wiki). Built:
- An Obsidian-compatible vault at projects/<slug>/ (WIKI.md, index, log, raw/, wiki/, optional git).
- Ingest every 15 minutes and at session end via the router model, from the transcript, documents (Add to wiki, jam_source_add), agent ship and decision updates, and people's edits.
- Approval through one Tasks-board card per ingest, with a per-page toggle and diffs.
- Query and lint.
- Agent tools jam_wiki_read, jam_wiki_search, and jam_wiki_query, with jam_join returning the index and the agent's workstream pages.
- The fact list migrated to pages.
- A web Wiki tab (markdown-it with raw HTML off, DOMPurify, a d3-force canvas graph, a local graph, editing with rev conflicts, history), a big-screen wiki stage mode, and Work tab links.
Phase 4 (triage board and attachments) has its own review and fixes in progress separately.

ROUND 2: The first review (/tmp/claude-501/p7-review.md, AGREE-WITH-CHANGES, 9 must-fixes and 3 should-fixes) was fixed in d812998e:
- Wiki routes are HUMAN_ONLY with an actor person.
- Sources are marked read only on accept or dismiss, and project-scoped proposals are re-raised in new sessions.
- A forward transcript cursor that advances after the write.
- Pages go to the model whole, the diff lists every deletion, and large deletions are flagged.
- Drafts keep their base revision.
- vaultDir and readPlain reject symlinked components.
- Explicit-path git commits.
- Atomic writes with retry-safe accept.
- Non-overwriting idempotent migration.
- A fixed system prompt with randomly tagged data.
- Category-based Work links.
- An idle graph stops repainting.
Confirm and look for anything new.

ROUND 3: The second review (/tmp/claude-501/p7-review2.md, AGREE-WITH-CHANGES, 8 must-fixes and 3 should-fixes) was fixed in 09e334d9:
- Chunked long sources with read offsets.
- Revision captured before the model call, with stale marking.
- Source writes via temp file plus link.
- A keep() queue for ship and decision reports.
- An idempotent keyed log.
- Accept done-marking plus restore().
- An answer's source stays unread until its card is resolved.
- The card shows the full diff with a fold.
- The host window must pick a person.
- Facts are filed into the wiki too. The session fact store remains as the live layer, documented.
- Context goes in random tags.
- A post-rename failure keeps the edit.
Confirm and look for anything new.

ROUND 4: The third review (receipt staff-engineer/8ae6d76a976012a5, AGREE-WITH-CHANGES, 8 must-fixes, 3 should-fixes) is fixed in the "JamSesh 7.7" commits.

ROUND 4 notes (fixer):
Fixes
- Diff: common start and end lines are matched first; only an over-700-line remainder is shown whole (removed, then added). A reordered page can no longer read as zero change.
- Card/proposal identity: the card id is made first (newId "tri"), the proposal file is written under it, then the card (board.proposeWiki takes an id). The pending-* handoff is gone. restore() raises a proposal lacking a card under its own id, and dismisses an open non-lint wiki card lacking a proposal (its sources become pending again). Legacy pending-* files are raised afresh.
- Agent reports: no longer in the in-memory queue. agentUpdate() reads the session's events from a cursor (state.reports) and moves it only past a written source; run on each agent update and every tick. The queue (saved facts only) is no longer truncated and is rewritten to the state file when that write failed (queueDirty).
- Log: every source gets a keyed log line (%%src:id%%) derived from raw/; catchUpLog() runs on finish, source add and each tick, in timestamp order. Edit lines use the same key.
- Transcript: no 600-char cut; document-backed events (shelved long text) are read in full; an event longer than a source is written in parts with state.partial offsets.
- State: malformed or non-object .wiki-state.json throws (code ESTATE), a .damaged copy is kept, nothing overwrites it.
- Project root: projectRoot() refuses a symlinked project folder, a parent that is not the projects folder, and traversal; hub falls back to the session's own folder.
- Bus: ingest message carries touched [] and is not forwarded to agent sockets; SPEC updated.
- Should-fix: map cap raised to 1500 (vault max), mailto clicks allowed (nav.followsNatively), sources list reports state pending/held/ingested.

Disputed / not done
- Concurrent swap of a child folder between lstat and a path-based write: not fixed. Needs fd-relative opens (openat), which Bun/Node do not expose. The attacker would need write access to the project folder while the hub runs.
- Agent-report cursor starting at 0 for a session with no cursor can re-file reports from a session that ran under the old code (rare duplicate, never a loss). A cursor save failure followed by a restart can duplicate reports since the last saved cursor, never lose them.
- Legacy vaults: the log back-fill adds one line per existing non-transcript source that has no keyed line the first time it runs (unreleased branch, so accepted).
- The graph at 1500 nodes: not performance-checked in a browser.
Not verified: wiki.live.test.ts (needs a model), browser screenshots (no UI layout changed), power-loss behaviour.

ROUND 5: The fourth review (/tmp/claude-501/p7-review4.md, AGREE-WITH-CHANGES, 5 must-fixes, 4 should-fixes) is fixed in the "JamSesh 7.8" commits.

ROUND 5 notes (fixer):
Fixes
- Approval diff: the card's per-page diff is cut at 6,000 characters at a line, never by choosing lines (the old "keep removed lines" tail is gone), with a count of the changed lines left out and change.cut. GET /api/wiki/proposal/:card/:slug (HUMAN_ONLY) returns the whole change; the card offers "Show the whole change". The edit source keeps its whole diff (no cut).
- Accept: pages recorded in proposal.applied are always part of the record whatever is checked on a retry. Dismissing (or restart clean-up of a dismissed/added card) goes through settle(), which logs, indexes and commits the pages already written (keyed log, idempotent) before the proposal goes.
- Unhandled model output: an update/create for an existing page the model wasn't shown whole is not dropped with its source. propose() returns needs (showable slugs) and again (the batch's source ids); the proposal's `again` keeps those sources pending when its card closes (partsOf), no-card passes don't markRead them, and state.need makes the next ingest show those pages first. Pages too big to show are let go (no loop).
- State: readState validates every field (nested tables, queue entries, need, booleans); a wrong shape fails closed with the .damaged copy.
- Graph: nameRoom uses a grid so work follows the number of names; names are budgeted (NAME_BUDGET 120) for the stage; rank and name sets are memoized; startup ticks stop at a 250 ms budget (settleFor); useWiki memoizes the graph. Measured in headless Chromium at 1,500 nodes, 1920x1080: before, a 1.6 s startup task and 75 ms frames; after, one 250 ms task and no long frames (also with reduced motion).
- Should-fix: agent report sources are named by their event (report-<session hash>-<event id>), so a replay finds the source already there. Transcript sources stay out of the keyed log (SPEC narrowed: a line every 15 minutes would bury History). Capacity: past 4,800 sources the oldest read-in ones (not held, not part-read) move to raw/archive/, still readable and citable; archiveOld runs after the log catch-up each tick. The legacy pending-* handoff (moveProposal and the restore branch) is deleted; such a proposal is let go and its sources are read again.
Disputed / not done
- Transcript replay duplicates (cursor save fails after the source is written) are not made idempotent: the source's span depends on events that arrive between runs, so a fixed id could skip events. Rare duplicate, never a loss.
- At 1,500 pages the stage graph is still one dense blob (the zoom floor of 0.25 can't fit it); performance only was in scope.
Not verified: wiki.live.test.ts (needs a model), the new "Show the whole change" button in a browser (client call path tested through api()), power loss, hub tests need JAMSESH_OFFLINE=1 (two timeouts without it, same before my change).
CORRECTION to the Round 5 notes: editPage still passes a 20,000-character cap to lineDiff, so the edit source is NOT kept whole (the review-5 finding 3 is right).

ROUND 6: The fifth review (/tmp/claude-501/p7-review5.md, AGREE-WITH-CHANGES, 4 must-fixes) is fixed in the "JamSesh 7.9" commit.

ROUND 6 notes (fixer):
- Source ids: addSource skips any id held in raw/archive/ (checked for every allocation), and archiveSources never renames over an archived file. Ids are therefore unique across the live and archived sets.
- Accept intent: before each page write the proposal records `writing: <slug>`; after it, `applied`. reconcile() (run at accept, settle, dismissing and restore) checks the named page: on disk as proposed means applied, otherwise the intent is dropped (rolled back). Tested with a proposal-save failure injected right after the page rename: a retry that unchecks the page, a restart and a dismissal each record it; a write that never landed is rolled back.
- Dismiss: new session.wikiDismiss hook, called by Board.dismiss before the card closes; WikiService.dismissing() reconciles and logs/indexes written pages. If that fails Board.dismiss returns 500 with a message, the card stays open and its sources stay held. closed() now only reads sources.
- editPage: no cap on the stored diff (lineDiff default is unlimited; only the card's display is cut).
- Hover: nameCandidates() (exported, tested) puts the hovered page, the focus page, then by importance, and caps at NAME_BUDGET in every path.
- UI: screenshotted headless (700 px) with a real hub and a 701-line replacement: the card shows the cut diff with one note and one "Show the whole change" button; clicking it loads and unfolds all 701 added lines (counted in the DOM). Before, two controls competed and the fold hid the added lines after loading.
Not verified: wiki.live.test.ts (needs a model); hub tests run with JAMSESH_OFFLINE=1.

ROUND 7: The sixth review (/tmp/claude-501/p7-review6.md, AGREE-WITH-CHANGES, 2 must-fixes, 1 should-fix) is fixed in the "JamSesh 7.10" commit.

ROUND 7 notes (fixer):
- Proof of write: the intent is now {slug, token "<card>:<slug>", rev (hash of the exact bytes)}, saved by a beforeWrite hook inside writePage just before the rename. The token is a `write:` front-matter field (Obsidian shows it as a property, tolerates it); writePage drops it on any later write, so a person's edit never carries it. reconcile() counts a page applied only when its token (or the exact-bytes rev) matches; otherwise the intent is rolled back. The old "already on disk as proposed" markdown-equality shortcut in accept() is deleted: an identical person's edit is an edit, so the page is stale and skipped. editPage() reconciles every unrecorded intent before it reads or writes, so a later edit can't hide a landed write. Tests cover both interleavings, a rolled-back intent, and an injected failure of the page's own rename.
- Shutdown: WikiService.captureFinal() (queue, agent reports, log, whole transcript with final=true) runs first and on its own; it is synchronous file work, so it needs no lock and can't interleave with an ingest's state writes (those are sync between awaits). Hub.shutdown gives it a 5 s budget, then the ingest flush 15 s (was 25 s for both). Tested while an ingest is parked in its model call: the tail is on disk at once and a fresh service sees it pending.
- Full diff route: the proposal stores each change's `before` (the page as shown to the model); fullDiff() uses it. An older proposal without it falls back to the page now.
Not verified: hub.shutdown() end to end (service level only); wiki.live.test.ts needs a model.

ROUND 8: The seventh review (/tmp/claude-501/p7-review7.md, AGREE-WITH-CHANGES, 5 must-fixes) is fixed in the "JamSesh 7.11" commit, with two parts disputed.

ROUND 8 notes (fixer):
Design change (Chey's call): the `write:` token is gone from pages. The intent record {page, rev = hash of the exact bytes} lives only in the proposal store; reconcile() counts a page as written when its bytes hash to the intended bytes.
Disputed
- Item 2 (an identical human edit during the model call makes the proposal vanish and can mark its sources read): not a bug. If the vault already holds exactly what was proposed, applying nothing, recording the change as done and reading its sources is the correct outcome. propose() skips a change whose text equals the page. SPEC says so plainly. (The nit that the stored base is the later page: a stale change is skipped on accept either way; left as is.)
- The token half of item 1 (removing a token erases evidence of a landed write): moot, there is no token. The remaining half (hand edits) is fixed below.
Fixes
- Hand edits: syncVault() compares each page's file time then hash with state.seen; a changed or new page becomes an "edit" source ("Someone in the vault"), with a log line (keyed, via catchUpLog), index rebuild, commit and an edit notice. The first look only records. Run at hub start, every tick and before each app edit (editPage), after reconciling any pending write intent. The wiki's own writes (accept, app edit, migrate, reconcile) call markSeen so they are never taken for hand edits. Removed pages are forgotten, not filed.
- Shutdown: Hub.closing is set first; http.ts answers every non-GET/HEAD/OPTIONS request with 503; the brain and transcriber stop; then captureFinal (5 s) and the flush (15 s). Tested: a /say sent during the shutdown wait while an ingest is parked in its model call gets 503 and no event; earlier words are on disk before the ingest returns. Websocket messages carry no events (levels, pings, rtc), so are left open.
- Graph: graph() keeps each page's strongest links (target backlinks, then name), at most 8 a page and an even share of a 6,000-edge budget (floor(6000/pages), min 1); `trimmed` flag. /wiki/pages lists 20 links a page; the page route keeps all. shapeGraph on the web caps edges too. Test: 1,500 pages each linking all others: graph() well under the 8 s test bound, under 700 KB, every page keeps edges.
- State: cursors and offsets must be safe non-negative integers; a cursor (transcript or reports) past the last event, a read offset past the end of its source, or a part offset past the end of its event fails closed with the .damaged copy (checked at the top of each tick so nothing is rewritten first).
Not verified: a dense vault in a browser (hub-side size and time only; the web caps edges to 6,000, measured at 1,500 nodes in round 5); wiki.live.test.ts; websockets during shutdown.

STOPPED HERE (round 9, JamSesh 7.12 wip): done in service.ts/files.ts: syncVault always hashes (no mtime skip); fileHandChange (intent in state.filing, source id reused on retry, seen saved after, failures loud); deletions filed as sources (log says "deleted a page", index rebuilt); own writes via write()/state.own/settleOwn; checkState() validates all cursors/offsets before a tick; propose keeps pre-call text and counts category/workstream changes. Existing hub wiki tests pass (81). NOT DONE: shutdown tracking of in-flight requests/transcriptions and Store seal (hub.ts/http.ts/audio), shared slug limit (web slugify should slice(0,60) and strip trailing dashes like hub slugifyTitle), new tests for: preserved-mtime edit, filing retry without duplicate, markSeen failure, deletion, range check before writes, metadata-only change, shutdown races. No review run (r7i.sh not written).
