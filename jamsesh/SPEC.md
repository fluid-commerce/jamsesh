# JamSesh spec

JamSesh turns a room of people and their coding agents into one working session. A host machine
(a Mac mini on the big screen) runs the session. Everyone's Claude Code or Codex joins it as a
named participant, the room's conversation becomes shared context, and a host brain routes what
people say to the agent that owns that work.

JamSesh is a fork of FigCraft. The FigCraft canvas, collaboration server, and MCP engine stay as
they are under the hood. JamSesh adds a Mac app, a hub, a host view, a client view, and an agent
protocol.

## Apps and roles

JamSesh is **one Mac app** that either hosts a session or joins one. The same client also runs in
any browser, including phones, so guests never have to install anything.

| Where | Who it's for | How they get it |
|---|---|---|
| **JamSesh for Mac** | Everyone with a Mac: the host and regular participants | Download from the host's connect page, or the release page |
| **Browser** | Guests, people on Windows or Linux | Open the host's address and type the code |
| **Phone browser** | Anyone in the room or remote with a phone | Scan the QR code on the big screen |

### First launch

The Mac app asks one question:

- **Host a session on this Mac.** The app starts the hub, opens the big screen on the display you
  choose, and stays in the menu bar while it hosts.
- **Join a session.** The app lists JamSesh hosts it finds on the local network (Bonjour). Pick one,
  or type an address, then type the 4-character code from the big screen. The app remembers the
  host and reconnects on its own after that.

The app is always either hosting or joined. There's no offline, single-person mode.

### Host mode

- Starts the hub, `figcraft-server`, and local speech-to-text as child processes, and stops them
  when you quit.
- Opens the **big screen** window, full screen on a chosen display.
- Opens your own **client window** too, because the person at the host is usually a participant.
- Keeps hosting from the menu bar when its windows are closed. The menu shows who's connected, the
  current join code, and **Stop hosting**.
- Downloads large models (speech-to-text, voiceprints) on first use, not with the app.
- Advertises itself on the local network so other Macs find it without an address.
- Carries the whole host runtime: the hub compiled to one program, the web app, the canvas,
  FigCraft's server and agent tools, and the voiceprint library. The host Mac needs nothing else.
- Walks the host through macOS permissions on first launch (**Set up this Mac**): Microphone,
  Accessibility, Automation (System Events), Screen Recording, and optionally Camera and Xcode.
  Everything the hub runs is a child process of the app, so the same grants cover it.
- Shows the big screen in a same-Space full screen, so app windows the brain arranges can sit on
  top of it.

### Join mode

- Shows the host's client view in a native window.
- Records the microphone without needing HTTPS. The app serves the client through a private
  local address on the Mac (a secure origin), so browser microphone rules don't apply, and
  relays to the host.
- Keeps the device token in the macOS Keychain.
- Runs a local relay at `http://127.0.0.1:4790` in both modes. Claude Code and Codex on the Mac are
  registered once, from the menu (**Connect my agents**), to that address; the app forwards to
  whichever host it's connected to and adds the Mac's credentials. After that, "connect to jamsesh"
  is all a person says to an agent.
- Has a menu bar item with mute, the session's status, and **Leave session**.

### Browser and phone

The browser client is the same interface as the Mac app's window. On phones it's laid out for
touch and focuses on what a phone does well:

- An extra room microphone.
- A live mirror of the big screen.
- Pinning comments on the canvas or a shared screen.
- Speaking or typing a prompt to the room brain.
- Your profile and voice sample.

Full canvas editing stays on laptops. Browsers only allow the microphone over HTTPS, so phones and
browser laptops use the host's HTTPS address (see Remote access). Over plain `http` the browser
client works but can't listen.

### What's built in what

| Part | Language | Why |
|---|---|---|
| Canvas engine, collaboration server, agent canvas tools, canvas (native and WebAssembly) | Rust (FigCraft) | Inherited from FigCraft |
| Mac app shell: windows, menu bar, local relay, Keychain, discovery, process control | Rust (Tauri) | Native capabilities the browser lacks; uses the system web view, so the app stays small |
| Hub: brain, agent endpoint, pairing, networking, audio sorting, storage | TypeScript (Bun) | The AI SDK and MCP SDK are most mature in TypeScript; runs as a child process of the app |
| Interface: big screen, client, connect, setup | TypeScript (React) | One interface for the Mac app, browsers, and phones |
| Speech-to-text, voiceprints | C++ (whisper.cpp, sherpa-onnx) | Local inference |

## Goals

- One shared canvas of artboards that people and agents edit live.
- Everything said in the room, every prompt typed to an agent, and every agent update lands in
  one context store that every agent can read and search.
- A host brain that tells banter from work, decides whether a request is a canvas exploration or
  a real implementation, and routes it to the right agent.
- A self-piloted big screen that shows new work as it lands and responds to "bring that up".
- Agents that check their mockups against the real design system, and check their built code
  against their mockups.
- Install the Mac app on the host and connect people in minutes, with no scripts.
- A Mac app for hosts and participants, and a browser client that works well on phones.

## Non-goals for version one

- Accounts and per-person permissions. Every paired device can do everything except change the
  host's settings.
- Native Windows and Linux apps. Those people use the browser client.
- Signed and notarized distribution. Version one is signed ad hoc, so macOS asks once before
  opening it on other Macs.
- Running client repositories on the host. Dev servers run on each client and the host proxies
  them.

## System overview

```text
            ┌───────────── Host machine (Mac mini): JamSesh for Mac in host mode ──────┐
            │  jamsesh hub (Bun, child process of the app)                              │
            │   ├─ HTTP + WebSocket API ─── host view (big screen), client views        │
            │   ├─ MCP endpoint /mcp  ───── every agent's Claude Code / Codex           │
            │   ├─ context store (SQLite + FTS5)                                        │
            │   ├─ brain (Vercel AI Gateway): intent, routing, presenter, digests, TTS  │
            │   ├─ audio pipeline: cross-device alignment, whisper.cpp, speaker ID      │
            │   ├─ canvas bridge: figcraft-cli mcp per participant, frame renders       │
            │   ├─ dev-server proxy: one host port per client dev server                │
            │   └─ host control: shell, apps, iOS Simulator, window layout, speech      │
            │  figcraft-server (the live canvas file)                                   │
            └──────────────────────────────────────────────────────────────────────────┘
                 ▲ LAN or internet (HTTPS)                 ▲
   ┌─────────────┴──────────┐                  ┌───────────┴────────────┐
   │ JamSesh for Mac (join) │                  │ Browser or phone       │
   │  client view (mic,     │                  │  client view           │
   │  canvas, context)      │                  │                        │
   │  Claude Code / Codex   │                  │                        │
   │  ─ /jamsesh skill      │                  │                        │
   │  ─ hooks: prompts in,  │                  │                        │
   │    directives out      │                  │                        │
   └────────────────────────┘                  └────────────────────────┘
```

## Components

### Hub

A Bun process on the host. It owns all session state and serves everything on one port
(default `4747`). It starts `figcraft-server` on `47900` and publishes the session canvas file.

### Canvas

The FigCraft canvas in **canvas-only mode**: no layers panel, no Design panel, no menus. Artboards,
connections, cursors, and presence stay. Canvas-only mode is a flag in the shared UI crate, so it
works in the desktop app (`figcraft --jamsesh <link>`) and in the browser build that the client
and host views embed.

### Agents on the canvas

Agents never install FigCraft. The hub's MCP endpoint exposes the FigCraft tools with a `canvas_`
prefix. On an agent's first canvas call, the hub starts a headless `figcraft-cli mcp` for it on
the host, sets its name (for example "Chey's Claude"), joins the live file, and forwards calls.
The hub sees every canvas action, so it logs what each agent made without the agent reporting it.

### Context store

SQLite with FTS5, in the hub's data directory. Every record is an **event**:

| Kind | Source |
|---|---|
| `speech` | A transcribed room line, with speaker, role, confidence, and source device |
| `prompt` | A prompt a person typed to their own agent (captured by a hook) |
| `update` | An agent's progress note, decision, question, or handoff |
| `directive` | A routed instruction, with target agents and status |
| `decision` | A recorded team decision (for example "direction A for the nav") |
| `artifact` | A canvas frame, variant set, screenshot, or dev server that landed |
| `canvas` | A canvas action an agent made through the bridge |
| `system` | Joins, leaves, and settings changes |

The brain maintains **digests**: a rolling session brief and one brief per workstream
(for example "mobile nav", "desktop settings"). An agent starting a new leg of work calls
`jam_context` and gets the session brief, its workstream brief, open directives, recent
decisions, and the last few minutes of the room, sized to a token budget. `jam_search` covers
everything else.

### Agents and workstreams

An agent registers with its owner, harness (Claude Code or Codex), repository, branch, platform
(desktop, mobile, web, design), and a one-line focus. Agents **claim** workstreams, so the router
knows who owns what and no two agents duplicate work. Agents post updates as they go.

Directives reach agents three ways:

1. The `Stop` hook. When a Claude Code turn ends, the hook asks the hub for pending directives and
   keeps the agent working on them.
2. `jam_wait`. An idle agent blocks on this tool for up to ten minutes and wakes on a directive.
3. `jam_inbox`. Agents check it between steps.

### Cross-platform parity

When an agent ships a change in one repository, the brain checks whether the change applies to
another registered repository (for example desktop and mobile). If it does, it sends a **parity
directive** to that agent with the source agent's notes and screenshots. The two agents exchange
messages through `jam_message`, post side-by-side renders, and the host view presents a
**parity board**: desktop on the left, mobile on the right, with the differences they found.

### Room audio

Every client view and the host view can capture audio. Each device runs voice activity
detection in the browser and sends speech segments with a clock-synced timestamp and signal level.

1. The hub groups segments from different devices that overlap in time into one **utterance**.
2. It picks the cleanest copy: highest speech level and signal-to-noise ratio.
3. It transcribes that copy once, with local whisper.cpp first, a client inference worker
   second, and the gateway (`openai/gpt-transcribe`) last.
4. It identifies the speaker by combining two signals: which device heard it loudest (each
   device has an owner) and a voiceprint match (a local speaker-embedding model).
5. When someone labels a line ("that was Felipe"), the hub adds that segment to Felipe's
   voiceprint, so identification improves through the session.

People have a name, a role, and a weight. The brain uses role weight when instructions
conflict, and says so ("going with the CPO's call on the nav").

### Brain

Runs on the Vercel AI Gateway with a key set in the host's Settings. Each job uses the model that
fits it:

| Job | Default model | Why |
|---|---|---|
| Triage each utterance (banter, discussion, directive, decision, question, presentation) | `google/gemini-3.5-flash-lite` | Fast and cheap; runs on every line |
| Route a directive: canvas exploration versus repository implementation, target agents | `anthropic/claude-sonnet-5.5` | Judgment and tool use |
| Present: choose what the big screen shows, build custom views | `anthropic/claude-sonnet-5.5` | Layout judgment, HTML generation |
| Digests and parity checks | `google/gemini-3.5-flash` | Long context, low cost |
| Speech back to the room | `openai/tts-1`, falling back to macOS `say` | Natural voice; works offline |
| Transcription fallback | `openai/gpt-transcribe` | When no local whisper is available |

Every model is a setting.

The triage step is deliberately conservative. The team jokes around, so a line becomes a
directive only when it is phrased as a request, aimed at work in the session, and not obviously a
joke. Banter is stored but never routed. The router separates **explore** ("what if we tried",
"show me options") from **implement** ("let's do this", "ship direction A"): explorations become
canvas variants, implementations go to the agent that owns the repository.

### Host view

The big screen. It is self-piloted:

- **Live board**: a bento grid of the newest work. Canvas renders, agent screenshots, and dev
  servers, each badged **Mockup** or **Built**.
- **Spotlight**: one item full screen, triggered by "bring up the nav variants".
- **Compare**: variants side by side, labeled A, B, C, so the room can say "I like B".
- **Parity**: desktop beside mobile.
- **Agents**: a split of every agent's live activity.
- **Custom**: a view the brain builds on request ("four-way split of what everyone is doing").
- A transcript ribbon, an agent status strip, and a "heard you" toast when a directive is routed.

The presenter can also drive the host machine: open apps, place windows on any display, list the
open windows, boot an iOS Simulator and open a build, build an agent's pushed branch on the host
and open it (in the background), run shell commands, and speak. The brain knows the big screen
window's size and every display's resolution, aspect ratio, density, and usable area, and plans
in-app and out-of-app layouts for them. A **Join** view puts the QR code, address, code, and steps
for phones, laptops, and agents on the big screen when someone asks how to join.

### Client view

Each person's window, in the Mac app or a browser: the canvas, a mic toggle, the live transcript with speaker labels (click a
line to reassign it), agent and workstream status, a directive feed, and a box to address the room
brain directly.

### Dev servers

Agents bind their dev servers to `0.0.0.0` and call `jam_devserver`. The hub opens a port on the
host (from `5100`) that forwards to the client's address, WebSockets included, so hot reload works
and the server reads as built work on the host.

### Agent guidance

The hub serves the JamSesh skill. It tells agents how to join, claim, report, wait, and verify:

- **Mockups mirror the design system.** Before drawing, read the repository's tokens and
  components. Use real values. After drawing, export the frame and compare it to the real
  product's screens.
- **Builds mirror the mockups.** After implementing, screenshot the running dev server at the
  frame's size and compare it to the canvas render. Fix differences before reporting done.
- **Report as you go, never duplicate.** Check claims before starting. Post handoffs.

## Install

On the host:

1. Install JamSesh for Mac and open it.
2. Choose **Host a session on this Mac**.
3. Paste your Vercel AI Gateway key in **Settings**.
4. Optional: set up **Remote access** (DuckDNS and HTTPS) so remote people and phones can connect.

For people joining:

- **Mac:** download the app from the host's connect page, open it, choose **Join**, pick the host,
  and type the code.
- **Browser or phone:** scan the QR code, or open the address and type the code.
- **Agents:** in the Mac app, choose **Set up my agents**. Without the app, type the line under the
  QR code into Claude Code or Codex. Then `/jamsesh` in each repository.

Developers can still run the host from a checkout with `./jamsesh/install.sh` and `jamsesh host`.

## Remote access

The host is the only server; there's no JamSesh service on the internet. Setup on the host:

- Gives the host a free DuckDNS name and keeps it pointed at the network.
- Gets a Let's Encrypt certificate for that name through DuckDNS's DNS challenge, and renews it.
- Maps one port on the router with NAT-PMP or UPnP, or explains how to do it by hand.
- Checks the address from outside the network, and detects carrier-grade NAT. Behind carrier-grade
  NAT, Tailscale Funnel on the host is the fallback.

## Security model

- Every request needs a paired device's token, except the connect page. Pairing takes the
  4-character code on the big screen, which changes every 30 seconds. Wrong codes are rate-limited
  per address and across everyone.
- Tokens are random and stored on the host only as hashes. Browsers keep them in an HttpOnly
  cookie and the Mac app in the Keychain. The host can disconnect any device.
- From outside the network, the host is reachable only over HTTPS. The canvas server and dev
  servers listen on the host only; the hub relays them to paired devices.
- Host control (shell, apps) is available only to the host brain, not to client agents. The
  gateway key, models, and host control can only be changed on the host. Keys never leave the host.
