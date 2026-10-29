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

## Live app tiles (phase 6.3)

| Capability | Status | Notes |
|---|---|---|
| iPhone Simulator streamed into a tile, device frame, Home, Rotate, Light/Dark, taps and swipes from the tile | Tested live | Real Simulator (iOS 18.6, a throwaway device), real idb companion, headless Chromium: a tap on the tile turned a test app green in about 160 ms; Dark, Home and Rotate checked in screenshots. About 8 frames a second at full resolution on a busy Mac (15 to 18 on an idle one). |
| Typing into the Simulator (US layout, shift, Return, Delete) | Tested live | Through idb on a throwaway device into a text field: capitals, digits, symbols and Return arrived as typed. Mapping unit-tested. |
| Window capture of the Simulator at 30 fps, and its fallback | Simulated | Selection logic and the fallbacks (no permission, no or two windows, helper dying, turned screen) tested with fake helpers. The real capture needs Screen Recording on a host (office checklist). |
| Brain puts a live app tile on a layout | Simulated | Tested through the layout tool by id and by name. |
| Taps while the screen is turned | Not working | The companion's touches don't land in landscape; the hub refuses them with a reason. Rotating and watching work. |
| Control passing, agents refused, a person without control refused, a device that vanishes mid-stream | Simulated | `hub/test/liveapps.test.ts` with a fake `xcrun`, a fake companion and a fake Mac helper. |
| Mac and Electron apps: capture and input | Not tested | The Swift helper compiles and refuses cleanly without Screen Recording; capture and CGEvent input need those permissions on a real host (office checklist). |
| Idb companion missing | Simulated | The tile starts watch-only with the install line. Not tried on a Mac without it. |

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

## Big screen: locks, versions, history

| Capability | Status | Notes |
|---|---|---|
| A person's cast is locked; agents, the brain, the automatic compare and new shares don't replace it; agents' items wait as "ready to show" | Simulated | Fake people and agents against a test hub (`stage-lock.test.ts`); lock badge, queue and Unlock checked in headless Chromium. |
| A 5-minute-old lock makes an agent's request ask its owner on screen and out loud; button or voice answers it | Simulated | The spoken line is built and passed to the speech policy but never played in tests. The card was checked on the host and in the owner's window. Not heard in a real room. |
| Lock stays while its owner is here; lets go when they leave | Simulated | Time-travelled in tests. |
| A rebuilt screen is one item with versions; "v3 · 2 min ago" badge opens the earlier builds; the screen swaps in place | Simulated | Uploads through the same path as `jam_post_image`; badge and version viewer checked in a screenshot. |
| What each screen showed is kept; tapping the strip or "bring back what Jonathan had up" restores it | Simulated | Strip checked in the client window. The brain's tool is tested without a model; not tried with the live gateway. |

## Driving the big screen (6.1)

| Capability | Status | Notes |
|---|---|---|
| Drive, Pass control, Drive together; agents, non-owners, stale drivers refused | Simulated | Real hub, a host window and paired driver windows in headless Chromium; unit tests for every refusal. |
| Your named dart on the big screen, gliding, over a live build and over the canvas | Simulated | Seen in screenshots; geometry and tag style from FigCraft's `live.rs`. Not compared side by side with a live FigCraft cursor (the headless canvas never drew a peer's cursor). |
| Click, scroll and type in a proxied live build | Simulated | Clicks, wheel (box and page), typing, Backspace, link navigation land. Hover styles (`:hover`) don't apply to synthetic events. |
| Canvas: wheel pans, pinch zooms, drag pans, click selects | Simulated | Against a real figcraft-server; click uses FigCraft's own `ui.pointer`. Typing on the canvas isn't driven. |
| Trackpad with Pointer Lock (relative motion) | Not tested for real | Headless Chromium refuses Pointer Lock; the relative path ran against a stand-in. Needs the Mac app (WKWebView may lack Pointer Lock; it then falls back to mapping over the mirror). |
| Real trackpad feel, latency over Wi-Fi | Not tested | Loopback latency was under 1 ms; about 55 moves a second. |
## Record (6.2)

| Capability | Status | Notes |
|---|---|---|
| Record on your own screen: rainbow trail, notes pinned where you pointed, tidy list, send to owning agents | Simulated | Headless Chromium against a throwaway hub with injected, timestamped utterances (no audio played); trail frames mid-motion, the tidy list, the sent toast and the pins in the picture viewer were looked at. |
| Rainbow trail with reduced motion | Simulated | Frame checked with `prefers-reduced-motion`: shorter, thinner, fainter. Frame rate on a real Retina display not measured. |
| Record on the big screen: lock taken and given back, refused when someone else drives, each driver recorded, trail and chip on the screen | Simulated | Two headless windows (driver and big screen) with a stand-in for the dart bridge; 6.1's real dart not connected yet. |
| Note alignment (pauses, edges, splitting a long line, several drivers) | Simulated | Unit tests of the timing rules. Not tuned against real speech timing. |
| Tidy then send through the web client's own `api()` | Simulated | Real hub over HTTP; a lost reply and a repeat send checked. |
| Crop of the spot in a directive | Simulated | Made with macOS `sips` on the host; skipped elsewhere. Only for pictures, not the live canvas. |
| Option+R toggles Record while the trackpad is captured (a bare R is typed into the big screen); R alone works when nothing is captured | Simulated | Key handling checked in the driving e2e; not pressed on a real Mac keyboard. |
| Speech from a real mic into the notes | Not tested | Needs a room: real transcription timing against real pointer movement. |

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

## Canvas panels and fonts (phase 6.4, 6.5)

| Capability | Status | Notes |
|---|---|---|
| Panel buttons: layers (left) and Design (right) slide in over a person's canvas; the big screen has none (6.4) | Simulated | Real canvas build in headless Chromium against a throwaway hub: both panels closed, each open, and the big screen's canvas, screenshots looked at. The `view.canvasPanel` command and the slide are covered by FigCraft's tests. |
| The chosen panels come back after a reload | Simulated | Kept in the browser's local storage; reload checked in headless Chromium. Not tried in the Mac app's web view. |
| Open fonts from repo cards fetched for every canvas (6.5) | Tested live | Real network: Fraunces, Lora and Space Grotesk fetched from Google Fonts (files on fonts.gstatic.com), Fontsource as the fallback; all OFL 1.1. Text in them drew correctly on a second person's canvas. |
| A font only one person has, lent after their confirmation (6.5) | Simulated | The Mac app's `has_fonts`/`local_fonts` stood in by a script serving real fonts from this Mac (Zapfino); prompt, sharing, declining, a damaged file and a session ending checked in headless Chromium. The real Mac app prompt hasn't been clicked. |
| Fonts are never kept: memory only, `no-store`, not in the offline outbox, dropped when the session ends | Simulated | Tested in the hub (bytes overwritten on withdraw and end) and the page (outbox stays empty with the network down). |

## Remote access

| Capability | Status | Notes |
|---|---|---|
| Pairing, rotating code, lockout, revocation | Tested live | |
| Router port mapping (NAT-PMP, UPnP) | Tested live | On this network's router. |
| DuckDNS name and Let's Encrypt certificate | Not tested | Try with the staging certificate first. |
| A real remote join over the internet | Not tested | |

## Live apps under driving (6.3 with 6.1)

| Capability | Status | Notes |
|---|---|---|
| A live app tile on a locked screen is driven by the screen's drivers; Pass control and Drive together carry over; elsewhere take, pass and release still apply | Simulated | Tested against the fake Simulator through the real routes (driver, co-driver, non-driver, agent, stranger, replay `as`). The dart replay onto a real Simulator tile has not been run on screen. |
