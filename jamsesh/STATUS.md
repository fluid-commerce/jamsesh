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
| Join help: why no room was found, type the address, scan the big screen's QR code, and where the code is | Simulated | Reasons checked in Rust unit tests with made-up results; the QR scan checked in headless Chromium with a fake camera, in the app's start page (stubbed commands) and the browser pairing page. Not run in the real Mac app or on a network that blocks Bonjour. |
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

## Room and brain

| Capability | Status | Notes |
|---|---|---|
| Only chats you connect join the room; the install never writes CLAUDE.md or AGENTS.md; Remove on a join notice | Built, tests only | Block removal tested on temp files (CRLF, EOF, none), hooks tested with a fake host, two chats in one folder tested as two agents, Remove checked in a throwaway room. Not yet tried with real Claude Code and Codex chats. |
| A chat's hooks and MCP session answer only the machine that joined it; transport ids stay out of room state; a removed chat stays out until a person allows it (Settings ▸ Removed chats, or "connect to jamsesh" in that chat) | Simulated | Cross-device requests with real credentials over HTTP against a throwaway hub, the real `hook.sh` through a relay stand-in, and a restart. Allow again clicked in headless Chromium. Not yet tried with two real Macs. |
| At-least-once delivery: hook and listener answers are acknowledged by the next hook call and offered again after 60 seconds if not | Simulated | Lost answers simulated by dropping the acknowledgement, with the real `hook.sh` and scripted hooks. Not yet seen with a real Claude Code session. |
| Removing an agent ends its listener and `jam_wait`, and cancels its share of open tasks; queued prompts replay once each under a stable id, safely when hooks run at once | Simulated | Real `hook.sh` against fake hosts (a slow answer, a failed replay, twelve hooks queueing at once) and a throwaway hub. |
| The setup never runs room text as code and keeps tokens out of command lines | Simulated | A name with `$(…)`, backticks and quotes through the setup, the hook and a script that sources `client.env`; real Claude Code confirmed calling the `headersHelper` (a probe server saw the header). |
| Directives reach agents (Stop hook, `jam_wait`, inbox) | Tested live | Real Claude Code and Codex in two-repository scenarios, earlier in the project. |
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
| Voiceprint travels: kept per person by the Mac app, per person and host in a browser, synced by version, only your own (5.3) | Simulated | Moved between two test hubs and identified by voice only; other person, agent, nobody, malformed, Float32-overflowing and repeated pushes tested over HTTP; a full 32-sample copy round-trips losslessly. Device side tested through `api()` with a stubbed network and a stubbed Tauri bridge; the app's per-person store and person check are Rust unit tests. The real Tauri commands in a running app (and a shared Mac switching people) not yet exercised. |
| Voice matching off: the reason and the fix (5.3) | Simulated | Missing model and a broken model file checked in a child process. The live host's actual cause is still unread. |
| One line shown once across laptops with clocks 1.5 s apart, late and mis-heard copies; typed / said / overheard on every line (5.4) | Simulated | Same sim: 187 extra lines before, 2 after, across 96 lines. |
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
