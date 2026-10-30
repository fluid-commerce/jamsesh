# What's tested

Status of each major capability as of October 29, 2026. **Tested live** means exercised end to end
with the real pieces (real Claude Code or Codex, the live brain on the AI Gateway, real network
connections). **Simulated** means covered by automated tests or emulation, not the real thing.
**Not tested** means built but not exercised yet.

## Mac app

| Capability | Status | Notes |
|---|---|---|
| Host mode from the app alone (bundled hub, canvas, big screen, your window) | Tested live | Clean home folder, no checkout. Hub up in about 1.5 seconds. |
| Join mode: pairing, name, live session, shared canvas, through the local relay | Tested live | Pairing and the canvas relay checked through the app's relay address. |
| Hosts found on the local network (Bonjour) | Tested live | The host advertises; the app lists it. |
| Join help: why no room was found, type the address, scan the big screen's QR code, and where the code is | Simulated | Reasons checked in Rust unit tests with made-up results; the QR scan checked in headless Chromium with a fake camera, in the app's start page (stubbed commands) and the browser pairing page. Not run in the real Mac app or on a network that blocks Bonjour. |
| "Connect my agents" setup, then "connect to jamsesh" | Tested live | A real Claude Code joined with no address, code, or name; posted its repo card and claimed a workstream. |
| Codex "connect to jamsesh" | Simulated | Setup writes Codex's MCP server, skill and prompt; not run with a real Codex session tonight. |
| Permission setup window | Simulated | Rendered and laid out; the macOS prompts themselves weren't clicked through. |
| Microphone inside the app's window (WebKit) | Not tested | The page is a secure origin, so the browser allows it; macOS will ask for Microphone on first use. |
| Big screen on a second display, same-Space full screen | Not tested | Needs a second display. |
| Helpers stop with the hub (canvas server, participants, key helper, local whisper), graceful or killed | Simulated | Hub tests with stand-in helpers, including ones that ignore `SIGTERM` and a hub killed outright; the bundled app's hung-page, hub-restart and port-release check is an owner-run release check on a Mac, still to run. |
| Screens setup: display map, roles, names, Identify, remembered per display set (3.4) | Simulated | Placement, naming, roles, ids and window plans unit-tested with simulated layouts (side by side, stacked, mixed scales, laptop lid closed, a TV unplugged); setup page rendered in headless Chromium with a stub. Real TVs not tried: see the office checklist in the 3.4 report. |
| Put on screen picker with live thumbnails; "put it on the left TV" (3.4) | Simulated | Two screens reported to a throwaway hub; picker screenshot checked, the cast landed on the chosen screen; brain tool tested with a screen name. |
| Opening the app on another Mac | Not tested | Ad-hoc signed: needs **Open Anyway** once in Privacy & Security. Permissions reset if the app is rebuilt. |

## Projects (phase 3.7)

| Capability | Status | Notes |
|---|---|---|
| Project storage, opening (new session, or today's), people, last used | Simulated | Unit tests on temp `JAMSESH_HOME` dirs; real hub processes started on a project, restarted (continues today's session) and with `JAMSESH_NEW_SESSION`. |
| Migration of old sessions into projects | Simulated | Tested on temp copies built with the real store: grouped by name, originals byte-identical, counts verified, damaged database skipped, runs once. Not run on a real `~/.jamsesh`. |
| Projects picker page (0, 1 and 8 projects, long names, keyboard) | Simulated | Looked at in headless Chromium against a throwaway lobby hub with seeded projects. |
| Canvas thumbnail saved every 5 minutes and when the session ends | Not tested | The keeper is tested with a fake canvas; the real call reuses the frame screenshot request and needs a room with a canvas. |
| Host starts at the picker; choosing a project opens its session in the same window | Not tested | Built and compiles; needs the app run on a Mac (the picker's `open_project` call only exists inside the app). |
| Menu bar Projects submenu; switching ends the session cleanly, then opens the other | Not tested | Needs the app run on a Mac. |

## Room and brain

| Capability | Status | Notes |
|---|---|---|
| Only chats you connect join the room; the install never writes CLAUDE.md or AGENTS.md; Remove on a join notice | Built, tests only | The old block is only located, never edited (CRLF, EOF, none, symlink tested on temp files), hooks tested with a fake host, two Claude Code chats in one folder tested as two agents (Codex chats in one folder are one agent by design), Remove checked in a throwaway room. Not yet tried with real Claude Code and Codex chats. |
| A chat's hooks and MCP session answer only the machine that joined it; transport ids stay out of room state; a removed chat, and any new chat from its machine and folder, stays out until a person allows it (Settings ▸ Removed chats ▸ Allow again; "connect to jamsesh" in that chat only tells it who can) | Simulated | Cross-device requests with real credentials over HTTP against a throwaway hub, the real `hook.sh` through a relay stand-in, and a restart. Allow again clicked in headless Chromium. Not yet tried with two real Macs. |
| At-least-once delivery: hook and listener answers are acknowledged by the next hook call and offered again after 60 seconds if not | Simulated | Lost answers simulated by dropping the acknowledgement, with the real `hook.sh` and scripted hooks. Not yet seen with a real Claude Code session. |
| Removing an agent ends its listener and `jam_wait`, and cancels its share of open tasks; queued prompts replay once each under a stable id, safely when hooks run at once | Simulated | Real `hook.sh` against fake hosts (a slow answer, a failed replay, twelve hooks queueing at once) and a throwaway hub. |
| Third review: chats never inherit another chat's record; inbox reads forward from its cursor; revocation ends open waits; finished tasks stay finished; Reassign shows for every offered task; installer keeps file modes, quotes values and paths, and edits Codex TOML by headers | Simulated | `review3.test.ts` and `setup-script.test.ts` against a throwaway hub and sandboxed homes; the agent tile checked in headless Chromium with four open tasks and an offer on the fourth. |
| Fourth review: the MCP server waits to be asked; observers can't claim through updates; decision bursts all arrive; reinstall keeps a person's hooks; private temp files; comment-aware Codex TOML; a named reassignment never falls back; a stale dev-server check leaves a new registration alone | Simulated | `review4.test.ts`, `setup-script.test.ts`, `join-only-when-told.test.ts` and `devtile.test.ts`, in sandboxed homes and throwaway hubs. |
| Fifth review: Codex keeps its identity across MCP sessions (reconnect resumes, removal sticks); `jam_ask` ends on removal or disconnection; queued prompts replay in the background; all open tasks in the state; blocked and question reports survive their hooks; "asked for" judged by time | Simulated | `review5.test.ts` with real MCP sessions over HTTP and a hub restart, and the real `hook.sh` against a slow fake host. Not yet with a real Codex. |
| Sixth review: queued prompts are one file each (never wait on the replay, never lost), carry their room and never replay into another; a stale dev-server refresh can't close a new registration; (the block stripper of that round is gone: setup now only names the old block's lines) | Simulated | Real `hook.sh` against fake hosts (a failed prompt during a slow replay, a room switch), a held refresh racing a registration, and a timed edit during stripping. |
| Seventh review: a chatless join from a removed chat's folder is refused; removals never expire; hook calls name their room and another room refuses them (409); (the stripper is gone, see round 10) | Simulated | `review7.test.ts` (fresh MCP sessions, 205 removals across a restart, room-mismatched hook calls, a switch mid-replay with the real `hook.sh`) and `join-only-when-told.test.ts`. |
| Round 10 (ninth review): a failed MCP reinstall puts back the earlier credential and entry and says when it couldn't; a new room starts a fresh feed with no old purge ids; a symlinked Codex config stays a link; setup never edits CLAUDE.md or AGENTS.md (it names the old block's lines) | Simulated | `setup-script.test.ts` (credential restored, rollback failure reported, symlinked and dangling config), `join-only-when-told.test.ts` (the finder holds no write path), `web/test/events-removed.test.ts` (room switch). |
| Eighth review: no task for observers alone (the brain's pairing and parity tools pick working agents); the hook download is staged and checked, a refused MCP entry puts the old one back; prompt ids are remembered for 20 minutes | Simulated | `review8.test.ts` and `setup-script.test.ts` (a broken or failed hook download, a claude that refuses the new entry). |
| Rounds 12 to 16: setup is one journaled transaction under an `flock`; every file write goes through `safe_write` (symlinks kept, instruction files, folders and targets outside home refused); a rollback puts back only files that still hold what setup wrote; `~/.claude.json` is edited only at its `mcpServers.jamsesh` key and read back from the file | Simulated | `setup-script.test.ts` in sandboxed homes with a stateful fake `claude`: links to `CLAUDE.md`/`AGENTS.md`, a folder in a file's place, a linked lock and `~/.claude.json`, edits made by someone else mid-run, a same-name project-scope entry, a failed restore, a real lock holder and twenty concurrent runs. Not yet with a real Claude Code writing `~/.claude.json` while setup runs. |
| The setup never runs room text as code and keeps tokens out of command lines | Simulated | A name with `$(…)`, backticks and quotes through the setup, the hook and a script that sources `client.env`; real Claude Code confirmed calling the `headersHelper` (a probe server saw the header). |
| Directives reach agents (Stop hook, `jam_wait`, inbox) | Tested live | Real Claude Code and Codex in two-repository scenarios, earlier in the project. |
| Parity and pairing: `coordinate` directives name their counterparts and finish only after a two-way exchange with one of them | Simulated | Hub tests through the session, the brain's tools, MCP and `POST /directives`; not yet run with two real agents. |
| A busy agent hears the room between steps (`PostToolUse` hook); an idle one returns to its person and is woken by the background `Stop` listener (`asyncRewake`) | Partly live | Scripted agents drive the hooks and the listener against a real hub, and `hook.sh listen` is run for real (exits 2 with the news). The `asyncRewake` wake-up was verified on 2026-10-29 in a real interactive Claude Code 2.1.308 chat: an idle chat woke when a background Stop hook exited 2. The full JamSesh path (the hooks installed by setup, a hub, a real room) still needs a real room. |
| Codex hears the room: a "you have new items" line on every JamSesh tool result | Simulated | Codex has no hooks; an agent that makes no JamSesh calls hears nothing until its person prompts it. |
| Tiles: "Done: <summary>", repo card moves repository, platform and focus; open task age; nudge at 20 minutes, Reassign offer 10 minutes later; workstream pauses when its owner goes offline | Simulated | Time-travelled in tests; tile checked in a screenshot of the agent rows. Thresholds not yet tuned in a real room. |
| Observers (`role: "observer"`): no repository, no product tasks, can skip broadcasts | Simulated | The brain's own handling (it never targets an observer) is covered by code paths, not by a live-gateway scenario. |
| An agent starting work nobody asked for is announced | Simulated | Claude Code agents only; Codex reports no prompts, so it can't be told apart. |
| Brain routing, decisions, affinity, curation | Tested live | 37 live scenarios on the gateway pass; a few are occasionally flaky under parallel load. |
| "How do I join?" puts the Join view up | Tested live | Two phrasings, about 3 seconds. |
| Brain knows the big screen and display sizes | Tested live | It answered with the exact resolution and aspect ratio. |
| Text-to-speech through the gateway | Tested live | `openai/tts-1`, about 3 seconds, when it was the default; the default is now `microsoft/mai-voice-2.1`, not yet timed on this row. Falls back to macOS `say`. |
| Arranging windows, listing windows, preview builds on the host | Not tested | Built; needs the Accessibility and Automation permissions granted on the host. |
| Agents asking the host to build their branch | Not built | Waiting on a decision: it lets any paired agent run commands on the host. |

## Audio

| Capability | Status | Notes |
|---|---|---|
| Multi-device grouping, lag, echo, degraded copies | Simulated | Real recorded voices, degraded and lagged in tests. |
| Speaker ID when someone walks away from their laptop | Simulated | About 50 percent without a voice sample; better after "Teach JamSesh your voice". |
| Join voice read; its calibration copies kept out of the transcript (5.3, 5.4) | Simulated | Four `say` voices on three fake laptops (Cam and Dee share the unowned one); the read heard by all three laptops leaves no line, ordinary talk beside it is kept. The modal is looked at in headless Chromium (desktop and phone width). Real voices and real mics not tried. |
| Corrections that stick: a correction counts as ten samples, takes back what the wrong label taught, relabels earlier "Someone" lines, says "Learning Felipe's voice." (5.3) | Simulated | Tested on the voice sim and the popover; the spoken line goes through `speak()`, which tests keep silent. Not heard in a real room. |
| Only the named person or the host teaches a voice by correcting a line; only the wrongly named person or the host takes a sample back; anyone else, and a relabel said to the brain, relabels only (5.R6) | Simulated | Synthetic embeddings, in the pipeline and over HTTP (another paired browser, the person's own browser, the host's window). |
| Two people talking over the same span on different laptops are two lines (5.R6) | Simulated | Synthetic voices with stubbed transcription: a copy within 10 dB of the best, or loudest at its laptop for 400 ms, is transcribed too and is its own line when its words differ; both sides of the threshold tested. Whisper load with 4 laptops: 1 transcription per line before, 2 (room spread) to 4 (one table) after. Not run against real voices (the voice sim needs macOS `say`). |
| A voice lives only on the host that learned it; Reset forgets it there (5.3, 5.R5) | Simulated | Voice travel between hosts was cut from this release: no device copy, no export or import, no Mac app store. Tested: another host doesn't know a person until they read there; only their own window resets or reads (other person, agent, nobody, no credential); nothing heard before a reset teaches the voice again; samples an earlier build brought are deleted when the store opens, and what an earlier build kept in the browser when the page loads. A reset epoch issued by the host makes a read started before a Reset, and audio buffered across one with a clock ahead, teach nothing (5.R6). The Mac app's deletion of an earlier copy (and interrupted `.part` writes) has unit tests; it is not exercised in a running app. |
| Voice matching off: the reason and the fix (5.3) | Simulated | Missing model and a broken model file checked in a child process. The live host's actual cause is still unread. |
| One line shown once across laptops with clocks 1.5 s apart and late copies, merged only when the words agree one by one (and voices, when both have one); typed / said / overheard on every line (5.4, 5.R5) | Simulated | Same sim. When unsure both lines are kept: a skewed copy that lost a word shows twice, by design. Acoustic matching was cut from this release. Every line with the same words is tried, not only the nearest, and a hybrid echo needs the very same words ("Yes" and "Yes please" stay two) (5.R6). |
| Audio and models the host can't be tricked with: a malformed or oversized WAV is a 400; Whisper deletes only the model file it downloaded itself, never a chosen one; the managed Parakeet copy is checked however its path is spelled (5.R5, 5.R6) | Simulated | Truncated, missing, late and doubled `fmt` chunks, chunks past the end and partial samples, over HTTP too; path aliases and symlinks. |
| A real room with real microphones | Not tested | |
| Room vocabulary and correction pass for every engine; whisper.cpp default, Parakeet opt-in (5.2) | Simulated | Bake-off on 50 synthetic clips (macOS voices, noise, a second voice), after correction: whisper with the vocabulary prompt 4.7% word error and 96% of names; Parakeet with hotwords 5.2% and 97%. The opt-in, its download, the child process, crash and hub-exit handling, the cloud fallback and the correction's false positives are covered by `hub/test/transcription.test.ts`. whisper-server is built and bundled by `app/bundle-hub.sh` (checked with a bundle run and a Metal transcription on a spare port); its model's first-session download and the discovery order are tested with fakes. Not yet checked in a full Tauri release build or on a fresh Mac. Real room clips not yet run; they decide the default. |

## Agent briefing and live builds

| Capability | Status | Notes |
|---|---|---|
| Short `jam_join` briefing (about 1,000 tokens on a seeded busy session, was 8,000) | Simulated | Test with 4 agents, 14 facts, 30 decisions, 12 directives. Not run with a real agent. |
| Long notes stored once with a pointer in other agents' inboxes | Simulated | `jam_artifacts` with `id` returns the full text. |
| Localhost mention gets the "share it" step | Simulated | Via `jam_update` and `jam_message` results. Needs a real agent to see if it acts on it. |
| A stopped build's tile says why, tells its agent, clears after 5 minutes | Simulated | Throwaway local server started and stopped; tile screenshot checked in headless Chromium. |

## Big screen: locks, versions, history

| Capability | Status | Notes |
|---|---|---|
| A person's cast is locked; agents, the brain, the automatic compare and new shares don't replace it; agents' items wait as "ready to show" | Simulated | Fake people and agents against a test hub (`stage-lock.test.ts`); lock badge, queue and Unlock checked in headless Chromium. |
| A 5-minute-old lock makes an agent's request ask its owner on screen and out loud; button or voice answers it | Simulated | The spoken line is built and passed to the speech policy but never played in tests. The card was checked on the host and in the owner's window. Not heard in a real room. |
| Lock stays while its owner is here; lets go when they leave | Simulated | Time-travelled in tests. |
| A rebuilt screen is one item with versions; "v3 · 2 min ago" badge opens the earlier builds; the screen swaps in place | Simulated | Uploads through the same path as `jam_post_image`; badge and version viewer checked in a screenshot. |
| What each screen showed is kept; tapping the strip or "bring back what Jonathan had up" restores it | Simulated | Strip checked in the client window. The brain's tool is tested without a model; not tried with the live gateway. |

## Phones and browsers

| Capability | Status | Notes |
|---|---|---|
| Phone layout (tabs, dock, pins, room sheet, profile, connect page) | Simulated | iPhone emulation in Chromium and WebKit. |
| Phone microphone | Not tested | Needs the host's HTTPS address (remote access). |
| Canvas sizing on high-density screens | Simulated | Correct in WebKit (Safari, iPhone, the Mac app). Real Chrome on a Retina Mac not checked. |

## Big screen: viewer and expand

| Capability | Status | Notes |
|---|---|---|
| Work tab viewer (arrows, Esc, Show on big screen as the person) | Simulated | Headless Chromium at 1440 and 390 px wide against a throwaway hub; keys and click-does-not-cast checked. |
| Expand / Collapse on a bento | Simulated | Headless Chromium at 1920x1080 and 3840x2160. Phone Screen tab has a chip per tile (390 px). |
| Full-size frame render (`/renders/full`) | Tested live | Against a real figcraft-server: 1440x900 frame came back 1600, 3200 and 4096 px wide. Not yet seen on a TV. |
| Expand on a second display | Not tested | Needs a real second screen. |

## Remote access

| Capability | Status | Notes |
|---|---|---|
| Pairing, rotating code, lockout, revocation | Tested live | |
| Router port mapping (NAT-PMP, UPnP) | Tested live | On this network's router. |
| DuckDNS name and Let's Encrypt certificate | Not tested | Try with the staging certificate first. |
| A real remote join over the internet | Not tested | |
