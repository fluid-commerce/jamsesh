# What's tested

Status of each major capability as of October 27, 2026. **Tested live** means exercised end to end
with the real pieces (real Claude Code or Codex, the live brain on the AI Gateway, real network
connections). **Simulated** means covered by automated tests or emulation, not the real thing.
**Not tested** means built but not exercised yet.

## Mac app

| Capability | Status | Notes |
|---|---|---|
| Host mode from the app alone (bundled hub, canvas, big screen, your window) | Tested live | Clean home folder, no checkout. Hub up in about 1.5 seconds. |
| Join mode: pairing, name, live session, shared canvas, through the local relay | Tested live | Pairing and the canvas relay checked through the app's relay address. |
| Hosts found on the local network (Bonjour) | Tested live | The host advertises; the app lists it. |
| "Connect my agents" setup, then "connect to jamsesh" | Tested live | A real Claude Code joined with no address, code, or name; posted its repo card and claimed a workstream. |
| Codex "connect to jamsesh" | Simulated | Setup writes Codex's MCP server, skill and prompt; not run with a real Codex session tonight. |
| Permission setup window | Simulated | Rendered and laid out; the macOS prompts themselves weren't clicked through. |
| Microphone inside the app's window (WebKit) | Not tested | The page is a secure origin, so the browser allows it; macOS will ask for Microphone on first use. |
| Big screen on a second display, same-Space full screen | Not tested | Needs a second display. |
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

## Attachments and carry-over (phase 4.6, 4.7)

| Capability | Status | Notes |
|---|---|---|
| Upload checks (type by bytes, sizes, path tricks, foreign devices, agents, repeats) and fetching | Simulated | Hub tests over real HTTP on a throwaway hub. |
| Message box: button, paste, drag states, image and file chips, refused file, feed thumbnails | Simulated | Looked at in headless Chromium, desktop and 390 px, against a throwaway hub; paste and drag were dispatched as events, not a real clipboard or Finder drag. |
| The brain seeing images and PDFs | Not tested | The message is built and unit tested; a real gateway call with an image needs a room with a key. |
| Agents fetching a task's files with their credential | Simulated | Fetch tested with an agent token; no real agent run. |
| Document with no request becomes proposed context | Simulated | Goes through a stub until the Tasks board lands. |
| Context carried between two sessions of a project | Simulated | Temp `JAMSESH_HOME` tests, and a real hub process started twice on a project (second with a new session). |

## Room and brain

| Capability | Status | Notes |
|---|---|---|
| Only chats you connect join the room; the install never writes CLAUDE.md or AGENTS.md; Remove on a join notice | Built, tests only | Block removal tested on temp files (CRLF, EOF, none), hooks tested with a fake host, two chats in one folder tested as two agents, Remove checked in a throwaway room. Not yet tried with real Claude Code and Codex chats. |
| Directives reach agents (Stop hook, `jam_wait`, inbox) | Tested live | Real Claude Code and Codex in two-repository scenarios, earlier in the project. |
| A busy agent hears the room between steps (`PostToolUse` hook); an idle one returns to its person and is woken by the background `Stop` listener (`asyncRewake`) | Simulated | Scripted agents drive the hooks and the listener against a real hub, and `hook.sh listen` is run for real (exits 2 with the news). Not yet seen with a real Claude Code session: needs the setup re-run to install the new hooks, and the wake-up relies on Claude Code honouring `asyncRewake` on a Stop hook. |
| Codex hears the room: a "you have new items" line on every JamSesh tool result | Simulated | Codex has no hooks; an agent that makes no JamSesh calls hears nothing until its person prompts it. |
| Tiles: "Done: <summary>", repo card moves repository, platform and focus; open task age; nudge at 20 minutes, Reassign offer 10 minutes later; workstream pauses when its owner goes offline | Simulated | Time-travelled in tests; tile checked in a screenshot of the agent rows. Thresholds not yet tuned in a real room. |
| Observers (`role: "observer"`): no repository, no product tasks, can skip broadcasts | Simulated | The brain's own handling (it never targets an observer) is covered by code paths, not by a live-gateway scenario. |
| An agent starting work nobody asked for is announced | Simulated | Claude Code agents only; Codex reports no prompts, so it can't be told apart. |
| Tasks board: overheard tasks and context, and agents' decisions, wait as cards; things said to JamSesh go straight out (4.1) | Simulated | Scripted brain decisions in an offline hub and live-model checks on the gateway (overheard request becomes a card, the same request typed to JamSesh is sent, "send that one" sends the card). Every card action through the real HTTP routes and the client's `api()`; agents and strangers refused; repeats grouped; replace detection; the spoken-mention cooldown with a fake clock. |
| Tasks view: Triage, Waiting, Working, Done; edit in place, merge, replace, sheet with sources and what a task made (4.1) | Simulated | Seeded cards in every column, looked at in headless Chromium at 1600 px (host), 1280 px and 390 px (columns become tabs); clicked through send, keyboard dismiss and replace against a throwaway hub. Not tried in a real room. |
| Banter judged by topic with a project card; reactions saved on the item; doubtful lines kept (4.2) | Tested live | 50-line commerce-room set on the gateway: lines about the project labeled banter 8 → 0, product jokes included; reactions saved 0/9 → 9/9; a fresh 19-line set 3 → 0 and 0/4 → 4/4. Offline tests cover the rules, reactions and rescue. The set is synthetic plus four quoted lines; not yet heard in a real room. |
| Curation updates, retires and cites sources; ship notes and JamSesh's own trouble stay out (4.3) | Tested live | Six-batch set of restated specs: active facts 13 → 9, restated topics 3 → 1 (rail) and 2 → 1 (badge), commit notes in facts 2 → 0. The model was already good on JamSesh's own trouble (0 → 0); the regex backstop is covered offline. |
| Session brief with fixed sections and a 600-character excerpt (4.4) | Tested live | The digest returned goal, decisions, questions and glossary from a few lines; owners, repositories, live links and progress come from state. Not yet read by a real agent joining. |
| Items filed under their workstream; titles and groups tidied; versioned titles stay (4.5) | Simulated | Covered by offline tests against a real hub. Not yet seen on a real session's artifacts. |
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
| A real room with real microphones | Not tested | |

## Agent briefing and live builds

| Capability | Status | Notes |
|---|---|---|
| Short `jam_join` briefing (about 1,000 tokens on a seeded busy session, was 8,000) | Simulated | Test with 4 agents, 14 facts, 30 decisions, 12 directives. Not run with a real agent. |
| Long notes stored once with a pointer in other agents' inboxes | Simulated | `jam_artifacts` with `id` returns the full text. |
| Localhost mention gets the "share it" step | Simulated | Via `jam_update` and `jam_message` results. Needs a real agent to see if it acts on it. |
| A stopped build's tile says why, tells its agent, clears after 5 minutes | Simulated | Throwaway local server started and stopped; tile screenshot checked in headless Chromium. |

## Project wiki (phase 7.1, store and API)

| Capability | Status | Notes |
|---|---|---|
| The project folder as a vault (WIKI.md, index, log, raw, wiki; git history when `git` is there) | Simulated | Files and git checked in a temp folder; with git missing it still works. Not opened in Obsidian itself. |
| Ingest from transcript, documents, agent reports and edits into one board card with diffs | Tested live | Scripted decider in tests; one run with the real router model on a short synthetic transcript produced 8 cited pages, and an injected instruction in a document stayed data. Not run on a real room's hour of talk. |
| Accepting a card page by page; people's edits win over a stale proposal | Simulated | |
| People's page edits (direct, logged as sources) and Add to wiki (text, link, text file) | Simulated | Through the real routes. |
| Add to wiki from a PDF | Not tested | Read by the router model; needs a real PDF and the key. |
| Query, filing an answer, lint (orphans, broken links, stale, unread sources, contradictions) | Tested live | Query and lint ran once with the live model; the contradiction check has only seen a clean wiki. |
| `jam_wiki_read` / `search` / `query` / `jam_source_add`; join briefing carries index and workstream pages under 1,500 tokens | Simulated | Scripted agent over the tool path. A real Claude Code chat hasn't used them. |
| Fact list folded into pages on first use | Simulated | From a context.json and session facts; not from a real project's history. |
| Wiki tab, graph and the Work tab links | Not tested | Built by the UI worker against the API. |

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
