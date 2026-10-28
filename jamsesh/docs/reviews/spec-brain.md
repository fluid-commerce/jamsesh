B-findings for the room brain, ranked by how much they would hurt tomorrow. I read the code and ran the offline and live-gateway brain tests: 28 pass, which also confirms the default model IDs resolve. No files edited. Brain lines are in `hub/src/brain/brain.ts` unless noted.

**B1. blocker, bug, spec-wrong (A33, B16, B14).** A casual "go ahead" or "build it" approves a host build and swallows the line.
- Evidence: `brain.ts:901-917` (APPROVE includes `go ahead`, `build it`, `approved`), `:91-96` (`hear()` returns right after deciding), `:118`.
- What's wrong: with exactly one build pending, any person line of 10 words or fewer matching those phrases approves it. That includes ambient talk and `kind:"prompt"` lines typed to an agent. "Okay, build it" said about the nav decision approves the host shell build, and the decision never reaches triage or routing.
- Fix:
  - Accept only explicit `approve`/`deny` words, or generic phrases only when addressed to the brain, or within about 20s of the spoken request.
  - Never treat `kind:"prompt"` as an approval.
  - Still pass the line on to triage instead of returning early.
  - Spec 8.11 should say this.

**B2. major, bug (A10, A8d).** The wake word is fragile.
- Evidence: `addressesBrain` at `brain.ts:861-878`; the STT hint at `audio/pipeline.ts:214-217`; no hint on the gateway path (`audio/transcribe.ts:105-107`).
- What's wrong:
  - Whisper will often write "Jam Session", which joins to "jamsession" and never matches "jamsesh".
  - The hint hardcodes "JamSesh", so a renamed brain gets no biasing.
  - The gateway transcription path gets no hint at all.
- Fix: accept variants (jam session, jam sesh, jamsession), add `brainName` to the hint, and pass the hint on the gateway path.

**B3. major, ux, code-gap (A8d).** Saying the name and then pausing fails.
- Evidence: `brain.ts:97-100`; the tests at `hub/test/brain.scenarios.test.ts:401-426` don't cover it.
- What's wrong: "Hey JamSesh…" then "bring up the nav" arrives as two utterances. The first fires `direct()` with no request. The second goes through ambient triage with no chime and a text-only reply.
- Fix: treat the same speaker's next utterance within about 6–8s as addressed.

**B4. major, bug (A3, B20).** `oneAgentPerRepo` overrides explicit targets.
- Evidence: `brain/affinity.ts:69-85`, `repoKey` at `:92`, applied at `brain.ts:351` and `:680`.
- What's wrong:
  - It collapses by `owner/name` only, ignoring owner and machine. Coworkers each have the same repo checked out, so "Chey's agent, do X" can be sent to Jonathan's agent.
  - It applies to `answer` and `coordinate` directives, so an agent waiting on `jam_ask_room` can have its answer dropped.
  - Agents that report an empty or unknown repo all share the key `""`, so only one is kept.
- Fix:
  - Exempt `answer` and `coordinate`.
  - When a person or agent is named, don't drop it.
  - Make the key `repo + machine/owner`, or only drop within one owner or machine.
  - Warn the router when a target was dropped.

**B5. major, spec-wrong (B16, B24).** Codex prompts never reach context, and Codex gets no turn-end directives.
- Evidence: SPEC 4.5 (line 280) claims Codex hooks. `install-scripts.ts:146-180` installs only MCP, a prompt file and an AGENTS block. The gap is still open as spec-gaps #9.
- What's wrong: Codex prompts never reach the store, and Codex gets directives only through `jam_wait`.
- Fix: either build the hook equivalent, or fix the spec and add to the Codex prompt file "after each prompt, `jam_update` progress and `jam_wait` when idle".

**B6. major, ux, code-gap (brief: a decision kicks the agent into gear).** There is no push to an idle agent.
- Evidence: directives only reach agents via UserPromptSubmit (`hub.ts:360-395`), the Stop hook (`:397-415`), or `jam_wait` (`mcp.ts:394`).
- What's wrong: an agent whose turn ended and isn't in `jam_wait` never sees "go with B" until its person types. Nothing tells the room.
- Fix: if a directive is still `pending` after about 45s and the agent's status isn't `waiting`, raise a toast and a card ("Dana's Claude hasn't picked this up; send it a prompt"). Keep the skill's `jam_wait` loop.

**B7. major, bug (spec 7.3: "a batch that fails to curate is retried").**
- Evidence: `brain.ts:763-764`.
- What's wrong: `setDigest(..., lastId)` runs before `await this.curate(...)`. If curate or a workstream brief throws, `throughEvent` has already advanced and that batch is never curated. A gateway blip loses facts permanently.
- Fix: advance `throughEvent` only after curate succeeds, or keep a separate curated-through marker.

**B8. major, bug (gateway fallback, A16a).** There are no timeouts and no breaker on gateway calls.
- Evidence: every `generateText` has no `abortSignal` (`brain.ts:149,176,206,239,263,758,782,833`), and `busy` is held across the call.
- What's wrong: a hung request stalls triage for everyone. During an outage every batch pays the full retry delay before falling back to rules.
- Fix: abort after about 15s for triage and 40s for the router, and add a cooldown of about 60s that goes straight to rules after a failure.

**B9. major, bug/security (spec 13.3).** The shell and build tools trust any person line in the batch.
- Evidence: `brain.ts:328` (`personAsked = batch.some(authorType==="person")`), used at `:342` and `:361`.
- What's wrong:
  - Overheard ambient speech and prompts typed to agents count as a person asking.
  - The spec says "the brain asks the room and a person approves", which isn't implemented.
- Fix: require `ev.data.direct` (the brain was addressed) for `host_action:shell` and `build_preview`, or route those through the build-approval card.

**B10. major, spec-wrong/code-gap (A17).** Snapshot restore doesn't exist.
- Evidence: SPEC 8.12 says "Settings > Saved ... restores one". `hub/src/http.ts:458-468` only lists, saves and downloads. A grep for `restore` finds nothing.
- Also: `context.json` has no room transcript, so a snapshot isn't self-contained.
- Fix: add restore (canvas, facts, layouts, brief), or mark it unbuilt in the spec and the Settings UI.

**B11. major, spec-wrong/code-gap (B21, B16).** Parity coordination only happens after a "shipped" update.
- Evidence: `brain.ts:595-622` (`agentUpdated` ignores every other kind). `ROUTER_SYSTEM` (`brain.ts:~563`) tells the router not to forward typed prompts unless the person names another agent.
- What's wrong: the owner's scenario (Jonathan's desktop work reasoned through for the mobile agent) starts only after desktop has shipped. Parity also needs distinct `platform` values, otherwise it never fires (`brain.ts:608-613`).
- Fix: on a typed prompt or an implement directive in a repo with a sibling-platform agent, send the sibling a heads-up `coordinate` directive. Spec this explicitly.

**B12. major, ux (A11, 8.13).** Offline or failed addressing does nothing visible.
- Evidence: `brain.ts:199` (`direct()` without a model goes to `ruleRoute`, which handles only directive, present and decision).
- What's wrong: with no key or a gateway error, "JamSesh, talk less" or a question produces nothing, not even a toast.
- Fix: say "I'm on simple rules right now, I can't do X". Also store behavior notes by keyword, since `remember_feedback` is purely LLM-driven.

**B13. minor→major, bug (B16/B25 fallback).** The rule router is crude in ways that will show.
- Evidence: `brain.ts:679` (no named agent and no affinity sends to all agents), `:681` (`build` means implement), `ruleTriage` directive regex.
- What's wrong:
  - "Can you grab lunch" becomes a directive.
  - "Let's build three nav options" becomes implement.
  - Cold start with nothing to match fans out to every agent.
  - Decision letter matching treats "go with a plan" as variant A.
- Fix: variants/options/try/mock should override `build`. Drop the fan-out to all. Require an agent, platform or owner name for directives.

**B14. minor, code-gap (spec 12 "brain names a new workstream").**
- Evidence: `brain.ts:357`.
- What's wrong: an unmatched `workstream` is ignored, so `workstreamId` is null. The directive text never tells the agent which workstream to claim.
- Fix: create the workstream and tell the agent in the directive.

**B15. minor, bug.** Triage can be starved.
- Evidence: `brain.ts:102-104`.
- What's wrong: the debounce timer resets on every line, with no max wait, so continuous talk delays triage.
- Fix: add a max wait of about 6s.

**B16. minor, ux.** Every typed prompt costs a triage call, often followed by a Sonnet router pass, behind the single `busy` lock.
- Evidence: `hub.ts:375`; `busy` is held by `flush` and `direct` (`brain.ts:109-113,201-203`).
- What's wrong: this delays "JamSesh, …" by up to 15s. `direct()` also gives up waiting after 15s and runs concurrently.
- Fix: skip or cheap-triage prompts that don't mention another agent or platform, and separate the lock from the direct path.

**B17. minor, code-gap.** Directives to offline agents (no activity for over 20 minutes) toast "→ Name" and silently wait.
- Fix: warn in both the tool result and the toast.

**B18. minor, ux.**
- The router's situation lists only the stage mode and title, not `stage.items`, so "I like A" is ambiguous when two variant groups exist (`brain.ts:~300`).
- `workstreamBriefs` re-queries every active workstream each digest. It reads only the newest 300 events (`:826-840`) and only events carrying a `workstreamId`, so briefs are thin and wasteful.
- `jam_context` has no brief or facts when the digest model is unavailable.
- Duplicate directives can result after a partial router failure followed by `ruleRoute`. The dedupe needs identical target sets.

**What's right.**
- Banter is stored but not routed.
- The explore/implement guidance lives in the router prompt, `skill/SKILL.md` and the `modeHint` text.
- Affinity scoring and the 5-minute dedupe both work.
- `pair_agents` and `ask_agent` exist.
- Curation supersede/resolve works, and `sameSpecifics` stops A→B changes being dropped as duplicates.
- Behavior notes are team-level and capped at 30.
- The speech policy is correct and tested.
- Autosave runs every 5 minutes on change, plus once on shutdown, with labeled snapshots kept.
- Voice build approval enforces `saidAt >= createdAt` in `hostctl.decide` (`hostctl.ts:253`), and agents can't approve.
- Gateway failure falls back to rules with a throttled toast.

**Verdict.**
- **Spec complete?** Mostly. It covers all the in-scope requirements (brief routing, directives, context, intent, gateway, A3, A11, A16, A17, A27, A33). It misstates four things: Codex hooks (B5), snapshot restore (B10), curate retry (B7), and brain-created workstreams (B14). It also omits the parity timing (B11) and the approval phrase risks (B1).
- **Fulfilled?** Partly. The normal LLM path with a key works and is tested live. The weak points are the ones a first real session will hit: the wake word and approval phrases (B1–B3), same-repo routing across people (B4), idle agents not being kicked (B6), and the outage behavior (B7, B8, B12).

Fix B1–B4, B6 and B8 first.