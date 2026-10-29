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
| Opening the app on another Mac | Not tested | Ad-hoc signed: needs **Open Anyway** once in Privacy & Security. Permissions reset if the app is rebuilt. |

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
