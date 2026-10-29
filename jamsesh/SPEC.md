# JamSesh spec

JamSesh turns a room of people and their coding agents into one working session. A host machine
(usually a Mac mini on the big screen) runs the session. Everyone's Claude Code or Codex joins it
as a named participant, the room's conversation becomes shared context, and a host brain routes
what people say to the agent that owns that work.

JamSesh is a fork of FigCraft. The FigCraft canvas engine, collaboration server, and MCP tools run
unchanged under the hood. JamSesh adds a Mac app, a hub, a big-screen view, a client view, and an
agent protocol.

This spec is checked against the owner's requirements in
[`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md). Requirement IDs appear in brackets, for example
[B13] or [A25d]: `B` IDs come from the original brief, `A` IDs from the numbered additions. The
[Requirements coverage](#18-requirements-coverage) table at the end maps every ID to the section
that specifies it, where it's implemented, and its status. Known disagreements between this spec
and the code are listed, with evidence, in [`docs/spec-gaps.md`](docs/spec-gaps.md). Where they
disagree, this spec states the intended behavior.

Numbers in this spec (thresholds, timeouts, ports) are the current defaults in the code.

## 1. Goals and non-goals

### Goals

- One shared canvas of artboards that people and agents edit live [B1–B4].
- Everything said in the room, every prompt typed to an agent, and every agent update lands in one
  context store that every agent can read and search [B7, B9, B24].
- A host brain that sorts every incoming line, tells banter from work, decides whether a request
  is a canvas exploration or a real implementation, and routes it to the agent that owns the work
  [B16, B25, B47, A16].
- A self-piloted big screen that shows new work as it lands and responds to "bring that up" [B6,
  B11–B13].
- Agents that check their mockups against the real design system, and check their built code
  against their mockups [B30, B31].
- A host that people can install and connect to in minutes, with no scripts [B29, A25a].
- A Mac app for hosts and participants, and a browser client that works well on phones [A28].
- Works with everyone in the room, everyone remote, or a mix [A18].

### Non-goals for version one

- Accounts and per-person permissions. Every paired device can do everything except change the
  host's settings and approve things only a person may approve.
- Native Windows and Linux apps. Those people use the browser client.
- Signed and notarized distribution. Version one is signed ad hoc, so macOS asks once before
  opening it on other Macs.
- Running client repositories on the host by default. Dev servers run on each client and the host
  proxies them. The host builds a pushed branch only for a preview a person approved (see
  [13.3](#133-preview-builds)).
- Carrying call audio between remote people. Remote people keep their usual call (Meet, Zoom) for
  voices.

## 2. System overview

```text
            ┌──────────── Host machine (Mac mini): JamSesh for Mac in host mode ───────────┐
            │  jamsesh hub (Bun, child process of the app)                                   │
            │   ├─ HTTP + WebSocket API (4747; HTTPS 4443 with remote access)                │
            │   │     big screen (/host), client (/client), connect, setup                   │
            │   ├─ MCP endpoint /mcp  ───── every agent's Claude Code or Codex               │
            │   ├─ context store (SQLite + FTS5), team store (people, voiceprints, settings) │
            │   ├─ brain (Vercel AI Gateway): triage, router, digests, curation, TTS         │
            │   ├─ audio pipeline: cross-device grouping, whisper.cpp, speaker ID            │
            │   ├─ canvas bridge: figcraft-server, figcraft-cli mcp per agent, frame renders │
            │   ├─ dev-server proxy: one host port per client dev server (from 5100)         │
            │   ├─ host control: shell, apps, windows, iOS Simulator, preview builds         │
            │   └─ remote access: DuckDNS, Let's Encrypt, router mapping, keep-awake, Bonjour│
            └────────────────────────────────────────────────────────────────────────────────┘
                 ▲ LAN or internet (HTTPS)                       ▲
   ┌─────────────┴──────────────────┐                ┌───────────┴────────────┐
   │ JamSesh for Mac (join)          │                │ Browser or phone       │
   │  client window via local relay  │                │  client view           │
   │  127.0.0.1:4790 (mic works)     │                │  (mic needs HTTPS)     │
   │  Claude Code / Codex ── relay   │                │                        │
   │   ─ jamsesh skill, /jamsesh     │                │                        │
   │   ─ hooks: prompts in,          │                │                        │
   │     directives out              │                │                        │
   └─────────────────────────────────┘                └────────────────────────┘
```

### What's built in what

| Part | Language | Why |
|---|---|---|
| Canvas engine, collaboration server, agent canvas tools, canvas (native and WebAssembly) | Rust (FigCraft) | Inherited from FigCraft [B1] |
| Mac app shell: windows, menu bar, local relay, Keychain, discovery, permissions | Rust (Tauri) | Native capabilities the browser lacks; uses the system web view, so the app stays small |
| Hub: brain, agent endpoint, pairing, networking, audio sorting, storage | TypeScript (Bun) | See [17.2](#172-why-the-hub-stays-typescript-inside-a-rust-tauri-app) |
| Interface: big screen, client, connect, setup | TypeScript (React) | One interface for the Mac app, browsers, and phones |
| Speech-to-text, voiceprints | C++ (whisper.cpp, sherpa-onnx) | Local inference [B28] |

## 3. Apps and roles

JamSesh is one Mac app that either hosts a session or joins one [A22a, A28a]. The same client also
runs in any browser, including phones, so guests never have to install anything [A28b, A28c].

| Where | Who it's for | How they get it |
|---|---|---|
| **JamSesh for Mac** | Everyone with a Mac: the host and regular participants | Download from the host's connect page (`/download/mac`), or the release page |
| **Browser** | Guests, people on Windows or Linux | Open the host's address and type the code |
| **Phone browser** | Anyone in the room or remote with a phone | Scan the QR code on the big screen |

There are two kinds of view [B10]:

- The **big screen** (`/host`) is self-piloted by the brain [B11]. Only the host machine opens it.
- The **client view** (`/client`) is each person's own window. People browse and edit the canvas
  freely there, and can steer the big screen [B11].

### 3.1 First launch

The Mac app's start window asks one question [A22a]:

- **Host a session on this Mac.** The app starts the hub, opens the big screen, opens your own
  client window, and stays in the menu bar while it hosts. The button is disabled, with the
  reason, if the app can't find a hub runtime.
- **Join a session.** The app lists JamSesh hosts it finds on the local network (Bonjour,
  `_jamsesh._tcp`, refreshed every second), offers a **Rejoin** row for the last host, and takes a
  typed address. Pick one, then type the 4-character code from the big screen once. The app
  remembers the role and the host in its app data and resumes on the next launch.

The app is always either hosting or joined. There's no offline, single-person mode [A26a]. In a
browser, the role is the path: `/host` is the big screen (host machine only) and anything else is
the client.

### 3.2 Host mode

- Starts the hub as a child process: the bundled `jamsesh-hub` binary, or `bun run
  hub/src/index.ts` from a checkout. It reuses a healthy hub on 4747, 4848, or 4949, otherwise it
  takes the first free one. It waits up to 60 seconds for `/healthz`. The hub in turn starts
  `figcraft-server` and, when installed, `whisper-server`. Quitting the app stops the hub
  (`SIGTERM`, then kill after 10 seconds), which stops its children.
- Opens the **big screen** window at `/host`. With two or more displays it moves to the first
  display that isn't the main one; with one it stays there. It uses same-Space full screen, so
  app windows the brain arranges can sit on top of it [A29c]. The menu item **Move the big screen
  to the next display** moves it.
- Opens your own **client window** (`/client`), because the person at the host is usually a
  participant.
- **User-less host** (**Use every display (nobody uses this Mac)** in the menu bar menu, saved with
  the app): when nobody uses the host's desktop, every connected display becomes a presentation
  surface. The app opens one big-screen window per display, each in same-Space full screen on its
  own display, and no client window. The main display gets the main screen (`/host`, with the
  header, join code, and room feed); every other display gets an extra screen
  (`/host?screen=screen-2`, `screen-3`, and so on) that shows only its stage, edge to edge, with no
  header, room mic, or side panels. Each screen has its own stage, reports its size, and reverts to
  the board after 6 minutes like the main one (unless it shows a live share). The brain sees every screen by id with its
  resolution, aspect ratio, and what it shows, and `show_on_screen`, `set_layout`, and
  `build_custom_view` take a `screen` to put things on a specific one (see
  [10.1](#101-layout)).
- Keeps hosting from the menu bar when its windows are closed. The menu shows that it's hosting,
  the current join code (refreshed every 5 seconds), who's connected, and **Open my window**,
  **Show the big screen**, **Move the big screen to the next display**, **Mute the room mic**,
  **Connect my agents**, **Set up this Mac…**, **Set up remote access…**, **Stop hosting**, and
  **Quit JamSesh**.
- If the app goes away without stopping the hub (a crash or Force Quit), the hub notices within 2
  seconds, saves a snapshot, and exits, so it never holds the port with no window.
- **Restarts a window whose page hangs.** Each window's page calls the app's `heartbeat` command
  every 3 seconds (the app takes the window from the call, not from the page). A window that is
  shown, not minimized, and at least partly on screen, and that stays silent for 15 seconds, has its
  WebKit page process stopped and the window reloaded (a plain reload does nothing to a page that is
  spinning). A process shared by two windows is never stopped; those windows are only reloaded.
  Repeats back off from 30 seconds up to 10 minutes, and the app logs each restart to
  `logs/app.log` in its data folder. A window that never beats isn't watched.
- **Web Inspector** is off unless `"devtools": true` is set in the app's `app.json` (or the app
  starts with `JAMSESH_DEVTOOLS=1`); then right-click > Inspect Element works in its windows. It's
  for finding out why a page froze.
- Carries the whole host runtime: the hub compiled to one program, the web app, the WebAssembly
  canvas, `figcraft-server` and `figcraft-cli`, the skill, the voiceprint library, and the
  speaker-embedding model, so the host Mac needs nothing else [B29]. Speech-to-text runs on the Mac
  when whisper.cpp and a model are installed (`brew install whisper-cpp`); otherwise it goes
  through the gateway, and the room sees a notice if neither is available [B28a]. The app doesn't
  download a speech model itself.
- Advertises itself on the local network with Bonjour (`dns-sd -R <ComputerName> _jamsesh._tcp`,
  TXT `session=<name>` and `https=<public URL>` when remote access is on). The record carries no
  secret.
- Opens **Set up this Mac** once after the first host start (see
  [13.5](#135-permissions-setup)) [A29d].
- Offers **Connect my agents** once, when `claude` or `codex` is installed [A30].

### 3.3 Join mode

- Shows the host's client view in a native window [A28a].
- Records the microphone without needing HTTPS. The app runs a **local relay** at
  `http://127.0.0.1:4790` (or a free port if 4790 is taken). WebKit treats `127.0.0.1` as a secure
  origin, so the microphone, camera, and audio worklets work even when the host is plain `http`
  on the LAN.
- The relay forwards HTTP and WebSocket traffic to whichever host the Mac is connected to and adds
  this Mac's device token. It captures the pairing cookie on first pairing, stores the token in
  the macOS Keychain (service `JamSesh`, account = host origin), strips cookie `Domain` and
  `Secure` attributes, rewrites redirects to the relay, and drops HSTS. It runs in host mode too,
  pointing at the local hub, so agents on the host Mac use the same address.
- Has a menu bar item with the session's status, **Open my window**, **Mute**, **Connect my
  agents**, **Leave the session**, and **Quit**.

### 3.4 Browser and phone

The browser client is the same interface as the Mac app's window [A28b]. On phones (width 720 px
or less, or a short coarse-pointer landscape screen) it's laid out for touch and focuses on what a
phone does well [A28c]:

- An extra room microphone.
- A live mirror of the big screen.
- Pinning comments on the canvas or the mirrored screen.
- Speaking, recording, or typing a prompt to the room brain.
- Your profile, photo, and voice sample.
- Sharing the camera, and the screen where the browser supports it.

Full canvas editing stays on laptops; the phone canvas is view-only. Browsers only allow the
microphone over HTTPS, so phones and browser laptops use the host's HTTPS address (see
[4.6](#46-remote-access)). Over plain `http` the browser client works but can't listen, and says
so.

### 3.5 Developer command line

Developers can run the host from a checkout without the app:

| Command | What it does |
|---|---|
| `./jamsesh/install.sh` | Builds the FigCraft binaries, the WebAssembly canvas, and the web app; installs whisper.cpp and its model and the speaker model; links `jamsesh` into `~/.local/bin`. |
| `jamsesh host [--no-open]` | Runs the hub (`JAMSESH_PORT`, default 4747) and opens the big screen in a full-screen Chrome app window, or reopens it if a hub is already running. |
| `jamsesh join <host>` | Connects this computer's agents to a host (pairs with a code, then installs the agent setup). |
| `jamsesh on` / `jamsesh off` | Turns this computer's agent hooks on or off. The MCP server stays registered. |
| `jamsesh status` | Shows the local host's health and this computer's hub, name, and hook state. |
| `jamsesh key` | Stores the gateway key in `~/.jamsesh/.env` (mode 600) after checking it against the gateway. |
| `jamsesh new` | Archives the current session (`~/.jamsesh/host` → `~/.jamsesh/host-YYYY-MM-DD-HHMM`) and starts the next one fresh. Refuses while a host is running. People, devices, voiceprints, and team settings carry over. |

Build the app with `jamsesh/app/bundle-hub.sh`, then `cargo tauri build` in
`jamsesh/app/src-tauri`.

## 4. Setup, pairing, and remote access

### 4.1 Host or client

A machine is the host because someone chose **Host a session on this Mac** on it [A22a]. There is
exactly one server per session: the host. JamSesh has no default public server and no JamSesh
service on the internet [A22b]. The only third parties the host contacts are the ones the host
chooses to use: the Vercel AI Gateway, DuckDNS, Let's Encrypt, public DNS-over-HTTPS resolvers
(to check challenge records), `api.ipify.org` (public address), and `check-host.net` (outside
reachability check).

The hub serves everything on one port (default `4747`, all interfaces). With remote access on, a
second HTTPS listener serves the same routes on `4443`, mapped to `443` on the router.

### 4.2 Pairing code

- Every device pairs with the **4-character code** shown on the big screen [A25c]. The alphabet is
  `23456789ABCDEFGHJKMNPQRSTUVWXYZ` (no 0, O, 1, I, or L). Input is case-insensitive and ignores
  spaces.
- The code rotates every 30 seconds, authenticator-style: it's derived from a host secret and the
  current 30-second window [A25d]. The previous window's code is also accepted, so someone typing
  as it changes still gets in.
- Wrong codes are rate-limited. Eight wrong codes from one address within a minute pause that
  address for 2 minutes (an office behind one address isn't locked out for long). Sixty wrong codes
  from anyone within 5 minutes pause pairing for everyone for a few minutes.
- A successful pairing issues a device token (`jst_` plus 32 random bytes). The host stores only
  its SHA-256 hash. Browsers keep it in an HttpOnly, SameSite=Lax cookie (Secure over HTTPS, and
  scoped to the DuckDNS domain so dev-server subdomains open signed in). The Mac app keeps it in
  the Keychain. Agents keep it in files under `~/.jamsesh` (mode 600) or rely on the app's relay. A
  token is never in a command's text, arguments or environment (shell history and process lists show
  those): the pairing guide has the agent write it to `~/.jamsesh/auth.header` with its file tool,
  `curl` reads that file (`-H @~/.jamsesh/auth.header`), the setup script reaches `bash` through a pipe,
  Codex's config is written from the file, and Claude Code gets it from a `headersHelper` script that
  reads `~/.jamsesh/mcp-headers.json`. The hook is downloaded to a temporary file and checked (a bash
  script that parses) before it replaces the installed one, so a failed download leaves the working
  hook in place. `claude mcp` has no replace, so the old `jamsesh` entry is read first, then removed
  and the new one added.
  The setup makes `~/.jamsesh` mode 700 and replaces each
  credential file in one step with a mode 600 one (so a looser old mode never carries over), keeps
  `~/.claude/settings.json`'s own mode, quotes the hook path (homes with spaces work), and edits
  Codex's `config.toml` only between its own marker comments (`# >>> jamsesh` / `# <<< jamsesh`), by
  lines, and then checks the result with Bun's TOML parser before writing: the edited file must parse,
  hold exactly one `mcp_servers.jamsesh` table with JamSesh's settings, and equal the original
  everywhere else. The one table an earlier JamSesh wrote (its exact two headers and keys, carrying the credential and
  host that install stored) is moved into the markers; any other `mcp_servers.jamsesh` table, a file that is not valid TOML or a broken marker
  pair leaves the file untouched with a message. The parser is the one on PATH or in the usual places,
  or the JamSesh app's own hub run as Bun (`JAMSESH_BUN`); with none, Codex is left as it is and the
  person is told what to add by hand. The file is re-read just before the write and setup aborts if
  it changed since it was read. Reinstalling
  removes only JamSesh's own hook commands (its `~/.jamsesh/hook.sh` with one of its verbs), keeping a
  person's hooks even in the same group.
- **Every file the setup writes goes through one primitive, `safe_write`.** It resolves a symlink to
  its target (one that leads nowhere too), so the link stays a link; refuses a target outside the
  person's home, a folder in the file's place, and any instruction file (`CLAUDE.md`, `AGENTS.md`, by
  name or by being the same file as `~/.claude/CLAUDE.md` or `~/.codex/AGENTS.md`), however a link
  points there; writes a new temporary file beside the target (`mktemp`, created exclusively, mode 600),
  gives it its mode and moves it into place. Downloads and generated files go first to the run's private
  saved folder and are checked there. The only other writes are that scratch folder, the lock file
  (refused if it is a link) and the one key-level edit of `~/.claude.json` below. Where a write really
  lands (every link and `..` resolved) is checked against the home folder before `~/.jamsesh` is
  chmodded or its lock opened, and the resolved `~/.claude.json` passes the same guard before the Claude
  CLI runs, since the CLI writes that file itself. After the CLI's `add-json`, the file's user-scope
  entry is read back and must hold what setup registered; an entry the CLI wrote before failing counts as
  setup's, so the rollback puts the earlier one back.
- **Setup is one transaction, kept as a journal**, and only one runs at a time: an `flock` on
  `~/.jamsesh/setup.lock` held as descriptor 9 for the whole run (the kernel drops it however the run
  ends; a second run waits `JAMSESH_LOCK_WAIT` seconds, default 10, then says another setup is
  running). Before its first write to a file, `safe_write` records the file's earlier content (or that
  it was absent) and, after each write, the hash of what it wrote. A file setup never wrote is never in
  the journal, so a rollback never touches it. On any failure before the last step, each journaled
  file is put back (or removed, if it was absent) only if it still holds exactly what setup wrote; one
  someone else changed meanwhile is left as it is and listed. The lock keeps out another setup, not an
  editor: the moment between the last hash check and the move can't be closed without an atomic
  compare-and-swap, which plain file operations don't have.
- **Claude Code's `~/.claude.json` is not a file setup owns.** Only its user-scope
  `mcpServers.jamsesh` key is read, compared and put back, key by key: the rest of the file is carried
  over as it is at that moment, and the replacement is retried if the file changed between reading and
  replacing it. The result is read back from that key in the file, never from `claude mcp get` (whose
  exit status an entry of the same name in another scope can satisfy). The entry is put back only if it
  is absent or still the one setup registered; one set by someone else meanwhile is left and reported.
  The saved entry never appears in a command's arguments. Whatever the outcome, the message says it
  plainly: put back, none registered, changed by someone else, or couldn't be put back (the saved
  copies are then kept, their folder named, and the setup exits non-zero). The MCP server's instructions say to join only when the person asks, in the launcher skill's
  words. The address in the setup script comes from `X-Forwarded-Host` only when a relay or
  tunnel on the host sent it and it is plainly a host and port; every value in the script is one
  single-quoted shell word.
- Each paired device has a kind: **browser** (a person's window, browser, or Mac app) or
  **agent**. Kinds decide what a device may approve (see [14](#14-security)).
- The big screen shows a toast when a device pairs ("A laptop connected", "An agent connected").

### 4.3 QR code and join card

The join card is on the big screen's Welcome view, in the header's join pill, and full screen in
the **Join** view [A25c, A31]. It shows:

- A QR code. Scanning it opens `<address>/connect?c=<code>` on the phone, which pairs that phone
  with no typing [A25b]. Feeding the same link to Claude Code or Codex sets up and connects the
  agent: `/connect` answers a request that isn't a browser page load with the agent's guide (the
  same as `<address>/agent?c=<code>`), which pairs it and tells it how to set itself up without a
  script for the person to run [A25a, A25b].
- An invite link for someone outside the room: **Invite someone** creates a single-use code that's
  good for ten minutes, as a link to paste into chat.
- The address (an HTTPS address when remote access is on), and other addresses (LAN, Tailscale,
  public) below it.
- The code in large type with a countdown ring.
- One line for agents: `connect to jamsesh` when the JamSesh app is open on that computer,
  otherwise `join jamsesh at <host>, code <CODE>` [A25c, A30].

### 4.4 Connect page

`/connect` is the only page a browser can open without a token. It shows "Join <session>", four
single-character boxes, and **Paste code**. A `?c=` parameter prefills the code and submits it. On
success it goes to `?next=` (default `/client`); on failure it shows the hub's reason and clears
the boxes. On a Mac browser it offers **Get the JamSesh app**.

### 4.5 Agent setup

Agents join through the MCP endpoint `/mcp` (see [6](#6-agents-mcp-tools-and-the-skill)). There
are two ways to set them up, and neither needs a script the person runs by hand [A25a]:

- **With the Mac app (preferred).** **Connect my agents** (offered once, and always in the menu)
  sets up Claude Code and Codex on that Mac to reach the session through the local relay. After
  that, a person says `connect to jamsesh` to an agent in any repository and it joins as theirs,
  with no address or code [A30]. The agent only works while the app is open, and it follows the app
  when the app switches hosts.
- **Without the app.** The person gives the agent the line under the QR code, or the QR link. The
  agent fetches `<address>/agent?c=<code>&name=<first name>`, which pairs it as an agent and
  returns a setup guide the agent carries out itself.

The setup installs, for each harness found:

| Harness | What's installed |
|---|---|
| Both | `~/.jamsesh/client.env` (hub, name, `JAMSESH_ACTIVE`; no token, which lives only in the mode-600 `auth.header`; every value one single-quoted shell word, so sourcing it runs nothing, and the hook reads it as data without sourcing it), `~/.jamsesh/auth.header` (the credential as a header file for `curl`), `~/.jamsesh/hook.sh` |
| Claude Code | User-scope MCP server `jamsesh` (HTTP; its credential comes from the `headersHelper` `~/.jamsesh/mcp-headers.sh`, so it is in neither `claude`'s arguments nor its config); a small skill at `~/.claude/skills/jamsesh/SKILL.md` (finds the running host, reads the instructions it serves, says in one line if none is running); the `/jamsesh [focus]` command; `UserPromptSubmit`, `PostToolUse`, and `Stop` hooks (15-second timeout), plus a background `Stop` listener (`asyncRewake`, 3300-second timeout; see 6.3). All of them do nothing for a chat that hasn't joined |
| Codex | `[mcp_servers.jamsesh]` in `~/.codex/config.toml` (`tool_timeout_sec = 600`, tools auto-approved, bearer header); the same small skill at `~/.codex/skills/jamsesh/SKILL.md`; the prompt `~/.codex/prompts/jamsesh.md` (the full instructions, for `/jamsesh`); no hooks (Codex has none here) |

**Only chats you connect join the room.** JamSesh never writes to `CLAUDE.md` or `AGENTS.md`, and the
setup only tells you where the `<!-- jamsesh:start -->` block an earlier install wrote is (file and
line numbers, on stderr) and never edits the file: replacing a file you may be saving in your editor
can't be made safe with plain file operations, so you delete those lines yourself. Only the exact text
of one of the two blocks earlier installs wrote counts (an edited or indented block, or anything else
between the markers, is yours and isn't mentioned). Nothing JamSesh installs joins by itself (until an earlier install's block is deleted, that block still can): an agent joins when its person says "connect to jamsesh" (or runs
`/jamsesh`) and calls `jam_join`. Each chat is its own agent: Claude Code's hooks carry its session id,
which the hook hands the agent when the person asks to connect (it goes to `jam_join` as `chat`). A
harness without hooks (Codex) has no chat id of its own and gets a new MCP session on every reconnect
or hub restart, so its chat is its folder on its machine (keyed `<harness>:<sha256 of harness:machine:cwd>`, so long paths never collide; when the store opens, records and removals under the older readable id are re-keyed once from their stored harness, machine and real folder, and only current keys are compared afterwards, with the harness taken from the client name at `initialize`, never from a tool argument, and the folder an absolute normalized path, its real path on the host's own file system; a blank or relative folder is refused and a supplied `chat` is ignored): a reconnect
resumes the same agent with its workstreams and tasks, and a removal sticks across reconnects and
restarts. Two Codex chats open in one folder at once are one agent. The hooks ask the host whether the chat has joined
(`POST /api/hooks/joined`, session id only) and do nothing, and send nothing, for a chat that hasn't;
a second chat in the same folder is not the joined agent. A chat resumes only its own record, from
the same machine: a quiet or offline record is never inherited by a different chat id or another
machine. Only a record from before chats had ids migrates to the chat that comes back. When an agent joins, the feed shows
"Jonathan's Codex joined from ~/fluid" with **Remove** (`POST /api/agents/<id>/remove`, people's windows only),
which takes the agent out and, with `purge`, deletes the feed lines it caused.

**A removed chat stays out.** Its `jam_join` is refused (by its chat id, which for Codex is its
folder on its machine, or by the MCP connection that joined) until a person lets it back in: **Allow again** under Settings ▸
Removed chats (`GET /api/removed-chats`, `POST /api/removed-chats/<id>/allow`, people only), or its
own person saying "connect to jamsesh" in that chat, which its hook reports from the same machine
(`/api/hooks/joined` with `connect: true`). Removals are kept in the session, so a hub restart doesn't
undo them, and they never expire on their own. A join that doesn't name its chat (a Claude Code
`jam_join` without `chat`, say on a fresh MCP session) can't show it isn't the removed chat, so it
is also refused from the machine, folder and harness of a removed chat until someone lets that chat
back in.

**Hooks belong to one machine.** The hook routes (`/api/hooks/*`) take only an agent's credential (a
person's window is refused), or the host's own loopback, which stands for the host's agents (the
app's relay hands any process there that credential anyway; relayed requests never count as
loopback). A hook reaches only a chat that joined from the machine its credential stands for, found
by Claude Code's session id; another device naming that session id, or an agent id, reaches nothing,
so it can't read or drain the chat's inbox or post prompts as its person. MCP sessions are bound the
same way: a request for an existing session from another machine's credential, or from a different
kind of credential, is answered "Session not found", and a chat id in `jam_join` only resumes a record
from the same machine. Transport ids (`chatId`: a Claude Code session id, `mcp:<session>`) never
appear in `/api/state` or its live patches.

**The trust boundary is the machine, not the chat.** Every chat on one computer runs as the same
person, shares that computer's agents credential (or the app's relay), and can read `~/.jamsesh`, so
a per-chat secret would sit in a file every other chat can read. JamSesh therefore separates
machines, not chats on one machine: a process on Chey's Mac can name another of Chey's chats' session
ids and read or acknowledge that chat's room items, post a prompt as Chey for it, or claim
"connect to jamsesh" for a chat Chey's Mac had removed. It cannot do any of that for a chat on another
Mac, and it cannot act as a person (person-only routes need a person's window). Chats on one machine
are told apart for routing (each its own agent and inbox), not as a security boundary. A removed
chat is let back in by its person's words only through its own machine's joined check (the hook
sends `connect: true` only when the prompt starts by asking to connect, so "don't connect to jamsesh"
doesn't count), or by a person choosing Allow again.

**Removing an agent ends everything waiting on it.** Its listener, any `jam_wait`, and any `jam_ask` it is waiting on end at once
with nothing (a wait that ends checks the agent is still in the room), handovers it hadn't
acknowledged are dropped, and its share of each open task is cancelled, with one feed line naming the
tasks so the room can hand them to someone else; other targets of a shared task carry on.

`hook.sh` does nothing unless `client.env` exists and `JAMSESH_ACTIVE=1`. Before it sends anything it
asks the host whether the chat has joined, every time (the question carries the session id only),
so a chat the room removed, or a host this Mac has switched away from, gets nothing more. Hook calls
have a 4-second limit (the joined question 3). Each prompt carries an id (`x-jam-prompt-id`), and the
hub records a prompt once per id, so a prompt whose answer was lost and is then replayed shows once.
The hub keeps the ids it has seen for 20 minutes, longer than a queued prompt lives (ten), however
many prompts arrive in between.

**Prompts queued while the host is away belong to one room.** The joined answer carries the room's
id (`room`, one per session), and the chat's marker (`~/.jamsesh/chats/<session id>`) keeps the room
it last joined. When the host is unreachable, that chat's prompts are queued in
`~/.jamsesh/outbox/`, one file each (written whole, then moved in, so hooks running at once never
wait on each other or lose a prompt; the newest 50 are kept), named for when, the prompt id and the
room. If a prompt can't be queued at all, the hook says so and fails. A later hook replays the
outbox in the background, after printing its own answer, so a slow host never keeps a hook past
its time limit: one replay at a time (a lock folder, cleared after a minute if a replay was killed;
queueing never takes it), at most 45 seconds per run, each entry after a fresh joined check. An entry
goes only to the room it was queued for: if the host's room is a different one (this Mac switched
hosts), it isn't sent. Every hook call carries the room it is meant for (`x-jam-room`), and the hub
refuses one meant for another room with 409 before recording, reading or acknowledging anything,
so a switch between the room check and the send leaves the prompt queued. It is removed once the host has it, when it is ten minutes old, or when its
chat is no longer in its room. An older `outbox.jsonl` (no room) is dropped.

### 4.6 Remote access

Remote access makes the host reachable from anywhere over HTTPS with a DuckDNS name [A22c]. It's
also what lets phones and browser laptops use their microphones. On the host, open it from the menu
bar (**Set up remote access…**) or **Settings > Remote access**; it opens in its own window, never
on the big screen, and **Skip, room only** closes it. The setup routes are available only on the
host machine.

The **Open your host to the internet** wizard has four steps that advance on their own:

1. **Name your host.** Enter a DuckDNS name (bare name, full domain, or URL) and token. The hub
   validates them with a DuckDNS update and stores them in `net.json` (mode 600). The token is
   never returned to any page or log.
2. **Secure it.** The hub gets two Let's Encrypt certificates through the DNS-01 challenge using
   DuckDNS TXT records: one for the name and one wildcard (`*.name.duckdns.org`) for dev-server
   subdomains. DuckDNS holds one TXT value per name, so the orders run one after the other. Each
   waits up to 180 seconds for the TXT record to appear on Cloudflare and Google DNS-over-HTTPS. A
   **staging** option uses Let's Encrypt staging (browsers warn) for a first try. Certificates
   renew when fewer than 30 days remain (checked at start and daily); a renewal restarts the HTTPS
   listener and the Bonjour record.
3. **Open it.** The hub maps external port 443 to internal 4443 on the router with NAT-PMP, or
   UPnP IGD when NAT-PMP isn't available. The lease is one hour, renewed every 30 minutes, and
   removed when the host stops. If mapping fails, the wizard shows the exact manual rule.
4. **Check.** The hub fetches `https://<name>/healthz` itself, then asks `check-host.net` to fetch
   it from outside. A QR code lets someone check from a phone on cellular. A local timeout is
   reported as "unknown" (routers that don't loop back), not as a failure.

The DuckDNS record is refreshed at start and every 5 minutes. The wizard detects carrier-grade NAT
(the router's WAN address is private or in `100.64.0.0/10`, or differs from the public address)
and recommends Tailscale Funnel or Cloudflare Tunnel. With either fallback, set
`JAMSESH_PUBLIC_URL` to the tunnel's address. Tunneled traffic must still pair: the hub never
treats traffic that arrives through a tunnel as the host machine.

Links the hub hands out (canvas, dev servers, skill, agent setup) use the address the caller
connected through. Over HTTPS, dev servers are reached at `dev-<port>.<name>.duckdns.org`.

### 4.7 Keep-awake

While people or agents are connected, the host stays awake [A24a]. The hub runs `caffeinate -d -i
-s -w <hub pid>` when at least one window is connected (the host's own big screen counts) or an
agent was active in the last 10 minutes, and keeps it for 5 minutes after the last activity. macOS power assertions stack, so
JamSesh never undoes a keep-awake someone else set, and ending its own assertion never puts the Mac
to sleep while another holds [A24b]. The assertion ends with the hub.

## 5. Connection resilience and identity

Using JamSesh without a connection isn't a goal [A26a], but losing one must not lose work [A26b,
A26c].

### 5.1 Reconnecting

- The client's WebSocket reconnects with jittered backoff (400 ms doubling, at most 10 seconds),
  sends a heartbeat every 15 seconds, and treats two missed heartbeats as a dead connection. It
  rechecks after the computer wakes, the network comes back, or the window regains focus.
- After 1 second of trouble, a banner shows **Reconnecting… your work is saved on this laptop**,
  the number of changes waiting, seconds of voice saved, and when the host was last heard from.
  When the connection returns it shows **Back online, synced N changes** for about 4 seconds.
- On every reconnect the client resyncs its clock, flushes its outbox, and takes a fresh copy of
  the session state from the host.
- If the host says the device isn't paired (or was disconnected), the client stops retrying and
  shows **This laptop isn't connected. Your work is saved here. Reconnect this laptop**, which goes
  to `/connect`.
- Agents: an MCP session the hub no longer knows returns an error that makes the client start a
  new one; `jam_join` resumes the same agent (see [6.1](#61-joining-and-identity)).

### 5.2 Saved state and merge

- **Outbox.** Every change the client makes (POST, PATCH, DELETE) goes into a durable outbox in
  IndexedDB when the host can't take it. Calls replay in order, one at a time, with an idempotency
  key, so the host applies each exactly once even if it saw the first attempt. Caps: 500 changes
  and 7 days. Pairing, audio, hooks, share requests, and debug calls are never queued.
- **Voice buffer.** Speech segments recorded while disconnected (or before the clock is synced)
  are kept in IndexedDB, up to 60 segments or 180 seconds, and uploaded oldest first with their
  original host-clock timestamps, so they slot into the transcript where they were said.
- **Merge.** The canvas merges through FigCraft's collaboration engine. For session state (pins,
  people, layouts, directives), queued changes replay on top of the host's current state. A queued
  change to something that changed on the host while you were away is merged field by field, and
  a change to something that was deleted is dropped and reported in the banner rather than
  recreating it [A26d].
- The host remembers idempotency keys across restarts for 24 hours.

### 5.3 Identity memory

Each client remembers, per host: who you are (person id, name), where you are (in the room or
remote), your device ids, your preferences (mic, hearing the brain), and the sessions you've been
in on that host [A26e]. Opening the same host again picks up where you left off. The Mac app also
remembers the last host and its token.

Hosts are told apart by a permanent id each hub generates (`hostId` in `/api/pair/info`), not by
address: the Mac app reaches every host at the same local address (its relay), so the window learns
the host's id before it reads anything saved, and keeps identity and the offline queue under it.
Offline at startup, it uses the last id it saw at that address. The first time, the identity saved
under the plain address moves to the host it belongs to.

## 6. Agents, MCP tools, and the skill

Agents never install FigCraft. Each person's Claude Code or Codex joins the hub's MCP endpoint
(`/mcp`, streamable HTTP, server name `jamsesh`) as a separate headless participant tied to that
person [B4, B50].

### 6.1 Joining and identity

- `jam_join` registers the agent with its harness (`claude-code`, `codex`, or `other`),
  repository (remote URL or name), branch, working directory, platform (`desktop`, `mobile`,
  `web`, `design`, `backend`, or `other`), and a one-line focus [B15].
- The owner is the person tied to the device that paired, or the host's person for agents on the
  host. If the hub can't tell, `jam_join` asks the agent to ask its person for their first name.
- An agent that joins again from the same machine, working directory (or repository), and harness
  resumes the same identity: the same id, name, history, and canvas participant.
- Default names are `<Owner>'s Claude`, `<Owner>'s Codex`, or `<Owner>'s Agent`, with the short
  repository name added when one person has two agents on the same harness.
- `jam_rename` sets the agent's own name (40 characters or fewer, unique in the session), its
  person's name, and its person's title [A13, A15]. The new name shows everywhere, including the
  agent's cursor on the canvas. The briefing asks the agent to set its person's title when it's
  missing.
- `jam_join` returns a short briefing, about 1,000 tokens on a busy session (a test holds it under
  1,500): welcome, canvas status, upload instructions, a compact roster (name, platform, repo,
  status; `jam_agents` has the stacks), a session brief clipped to 600 characters, the agent's
  workstream brief, its open directives (five, each clipped), how many inbox items wait, and the
  tools that fetch more (`jam_context`, `jam_search`, `jam_artifacts`, `jam_directives`). On first
  join it adds five working rules and where the full skill is (the `jamsesh` prompt, `/skill.md`).
  It used to carry the whole context and the skill, about 8,000 tokens.
- A message to `all`, or an update, longer than 1,200 characters is stored once as a document. The
  feed and other agents' inboxes get its opening and a pointer; `jam_artifacts` with `id` returns the
  whole text. Direct messages are never cut.
- An agent shows as offline after 20 minutes without activity.

### 6.2 Tools

Every tool except `jam_join` requires a joined agent.

| Tool | What it does |
|---|---|
| `jam_join` | Register or resume; returns the briefing. |
| `jam_rename` | Set the agent's name, its person's name, and its person's title. |
| `jam_context` | The context bundle for a new leg of work (workstream, minutes; default 10). |
| `jam_search` | Full-text search over everything in the session (limit 20, at most 60). |
| `jam_update` | Post `progress`, `done`, `shipped`, `question`, `blocked`, `handoff`, or `decision`, optionally for a workstream and a directive. Naming a workstream claims it. `done` or `shipped` with a directive marks it done for this agent. `question` and `blocked` raise a "needs the room" toast. |
| `jam_claim` | Claim a workstream. If another active agent owns it, the agent is told who, and must coordinate instead of duplicating (`force` overrides) [B20]. |
| `jam_inbox` | Pending directives, messages, questions, and answers. Marks them delivered. |
| `jam_wait` | Block until a directive, message, or question arrives (default 4 minutes, at most 9). Sends progress every 20 seconds. |
| `jam_ack` | Acknowledge, finish, or drop a directive, with a result. |
| `jam_message` | Message another agent by name or id, or `all` [A27a]. |
| `jam_ask` | Ask another agent a question and wait for the answer (default 120 seconds, 5 to 300) [A27b]. |
| `jam_answer` | Answer a question by its id. |
| `jam_repo_card` | Describe the repository: stack, design system, components, branch, recent changes, notes; optionally the repository, platform, and focus when they changed (the tile follows). |
| `jam_agents` | The roster: people (name, title, weight) and agents (platform, repo, status, card, focus, workstreams). |
| `jam_devserver` | Put a dev server on the host (see [6.6](#66-dev-servers-on-the-host)) [B18]. |
| `jam_host_preview` | Ask the host to build this agent's pushed branch and open it (see [13.3](#133-preview-builds)) [A33a]. |
| `jam_post_image` | Post a screenshot (PNG or JPEG, at most 12 MB) as a **Built** or **Mockup** artifact. |
| `jam_show` | Put a spotlight, compare, or parity view on the big screen, unless a person pinned the screen. |
| `jam_artifacts` | List artifacts (frames, screenshots, dev servers), newest first; pages with `offset` and says how many more there are. |
| `jam_directives` | List the session's directives (the context leaves the older ones out), newest first, by words or status; pages with `offset`. |
| `jam_ask_room` | Post a question to the people in the room. |
| `canvas_frames` | List the canvas's frames with who made each. |
| `canvas_render` | Render a frame on the host (default 1600 px). |
| `canvas_<tool>` | Every other FigCraft MCP tool, run as this agent's own participant on the live canvas (see [12.2](#122-agents-on-the-canvas)) [B3]. File, pointer, and keyboard tools are hidden. |

The MCP server also offers the skill as the prompt `jamsesh`.

The live state carries only the newest of long lists (60 directives, 120 artifacts, 200 utterances,
the recent events) and says how many the session holds in all. Older ones are read with
`GET /api/history/<events|utterances|directives|artifacts>?before=<cursor>&limit=50` (events also
take `kinds=speech,prompt`); people and agents may both read it. `limit` is 1 to 200 and defaults to
50 when it isn't a number.

An agent's words reach the room brain by `jam_message` to its name, and by `decision`, `question`,
`blocked`, and `shipped` updates. Because anyone's prompt can steer an agent, a brain pass started
that way only coordinates and records: it can create directives, record decisions, ask or pair
agents, and say something to the room. It can't drive the host, put HTML on a screen, ask for a
share, rename itself, or save behavior notes.

### 6.3 How directives reach agents

A **directive** is a routed instruction with target agents, a mode (`explore`, `implement`,
`coordinate`, or `answer`), text, a rationale, an optional workstream, and per-agent progress
(`pending`, `delivered`, `acked`, `done`, `cancelled`). Its overall status follows the slowest
target. Agents work and listen at the same time [B14, B16]: a busy agent hears the room between
steps, and an idle agent goes back to its person and is woken when the room has something for it.

**Claude Code** (hooks, installed by the setup; `hook.sh` is the hooks' one script):

1. **Between steps.** `PostToolUse` posts to `/api/hooks/tool`. New directives, messages, questions
   (to answer first), and room decisions come back as added context, so a busy agent folds them
   into the work it is doing. The agent's own `jam_inbox`, `jam_wait`, and `jam_ask` calls are
   skipped (they already carry their items).
2. **Each prompt.** `UserPromptSubmit` delivers the same items alongside the person's prompt, and
   ends any waiting listener (the person is talking to the agent now).
3. **Turn end.** `Stop` (`/api/hooks/stop`) keeps the agent working if work is waiting. Otherwise
   the agent goes idle and **stops, back to its person**: it is no longer told to sit in `jam_wait`
   (unless its install predates the listener, see below).
4. **Wake-up.** A second `Stop` hook, `hook.sh listen`, runs in the background (`asyncRewake`).
   It calls `/api/hooks/listen`, which the hub holds open (up to about 200 seconds, which the
   server's idle limit allows) until the room has something for that agent; the script calls again
   until about 50 minutes (3000 seconds) pass; the hook's own `timeout` is 3300 seconds, since Claude Code enforces it on async hooks too (its default is 600). With news it prints it and exits with code 2, which wakes the agent
   with that text as its next turn (the script prints the items to stderr, which is what Claude sees on a rewake). Async hooks are killed when a non-interactive `claude -p` run ends, so the wake-up works in interactive chats only. Verified on 2026-10-29 in a real interactive Claude Code 2.1.308 chat: an idle chat woke when a background `Stop` hook exited 2. The full JamSesh path (installed hooks, a hub, a real room) still needs a real room. A newer listener for the same agent, or the person's next
   prompt, ends the old one empty; an agent that is itself in `jam_wait` or `jam_ask` is left to
   get its items there.

**Codex** has no hooks. Its agent keeps the older loop: check `jam_inbox` between steps; when idle,
call `jam_wait` and call it again whenever it returns empty. To help a busy Codex agent hear the
room, every JamSesh tool result it gets (except `jam_join`, `jam_inbox`, `jam_wait`, `jam_ask`, and
the canvas tools) ends with "You have new items from the room: call jam_inbox." when something is
waiting. A Codex agent that makes no JamSesh calls and no `jam_wait` hears nothing until its person
prompts it; there is nothing else the host can do for it. The notice is not added for a Claude Code
agent whose hooks have reached the hub in the last five minutes, since the hooks hand the items
over themselves.

**Messages are read in order from a per-agent cursor.** The inbox reads forward from the last
message the agent was handed, keeps only those for it (to it, or to everyone), and hands over the
next 50; messages to other agents in between never push an unread one out, and a burst of more
than 50 arrives over successive calls without loss. When a device is disconnected, its agents'
open listener, `jam_wait` and `jam_ask` end at once and check the credential before handing anything over.

**Delivery is at least once, and never twice once acknowledged.** A hook's answer can be lost (a
timeout, a dropped connection), so what the hooks and the listener hand over carries a delivery id
(the `x-jam-delivery` header). `hook.sh` records the id under `~/.jamsesh/acks/<session>` once it has
passed the text on, and sends it back with the chat's next hook call (`x-jam-ack`); only then are the
items marked delivered (and the message and decision marks moved). While a handover waits for its
acknowledgement nothing more is handed over; after 60 seconds everything unacknowledged is offered
again under a new id, and a listener that calls again without acknowledging the last listener's
answer gets it again at once. `jam_inbox` and `jam_wait` answer the agent directly and mark what they
return, including anything a lost hook answer held. Room decisions ride the same deliveries, read
forward from the agent's decision cursor ten at a time, so a bigger burst arrives over successive
handovers and the cursor only passes what was handed over; `Stop` doesn't keep an agent working for
decisions alone. Room-wide messages (to everyone) skip the
sender and observers that opted out (6.3b).

An install made before this version has no `PostToolUse` or listener hook. The hub remembers per
agent whether either newer hook has ever reached it; until one has, `Stop` keeps the old behaviour
and tells an idle Claude Code agent to call `jam_wait` (once per stop). **Connect my agents** (or
`/agent/setup.sh`) installs the new hooks. A brand-new install's very first stop, before any tool
call, gets the old nudge once.

Each directive carries a per-mode hint: explore (variants on the canvas, render and check each),
implement (change the code, run the dev server, compare with the mockup, ship), coordinate
(compare with the other agents through `jam_message`; change code only for a gap both confirm,
then show parity), answer, or **note** (write something down or keep a
record: pain points, a list, meeting notes; no code to build and nothing to draw on the canvas).

People steer agents that misread something [B17] by prompting their own agent, by telling the
room brain, or by sending a directive from the client.

**Open tasks age.** An open `explore` or `implement` directive with no ack or report from its agent
for 20 minutes (counted from delivery) is asked about: the agent gets a message from JamSesh to
ack it, report where it is, or say it's stuck. An answer starts the clock again. If nothing moves
10 minutes after the ask, or the agent is offline, the room sees "<agent> hasn't reported on ...
Reassign it from the agent's tile" (an event and a toast), and the tile shows a **Reassign**
button. Reassigning (`POST /api/directives/<id>/reassign`, people only) cancels the task for its
agent and sends it to the best-matching free worker, saying who it came from. A named recipient
(`to`) gets it or the request is refused with why (no such agent, an observer, offline, or already
on the task); it never falls back to someone else.
The hub checks every minute (`Session.tick`), each target of a task on its own: two targets going
quiet in the same minute each get one nudge and, later, one offer.

A finished task stays finished: a late ack or report never reopens a directive that is done or
cancelled, for one agent or as a whole. A person ending a whole task (`POST /api/directives/<id>`
with `done` or `cancelled`) ends it for every target still on it. A product directive (anything but
`answer` or `note`) whose targets are all observers is refused, since nobody would do it: no task
is saved, the API answers 400, and the brain's tools (create, pair, parity) pick working agents only
and say so instead of reporting it sent.

A directive sent to an agent that's offline (or silent for 20 minutes) shows a notice that it gets
the work when it's back. If an explore or implement directive is still untouched after 45 seconds
and its agent isn't waiting for work, the room sees "<agent> hasn't picked this up yet" with what
its person can do: type anything to it, or tell it to wait for the room.

### 6.3a What an agent's tile says

- **Status text.** Working shows what the agent is on ("Working on: <the prompt>" or its latest
  update). A `blocked` or `question` report stays on the tile (status blocked) through its own tool
  hook and the end of the turn, until the agent uses another tool or reports again. When an agent finishes (a `done` or `shipped` update, or a turn that ends) the tile reads
  "Done: <summary>" until its next task starts: its person prompting it, or an ack, claim, or
  progress update.
- **Repository, platform, focus.** `jam_repo_card` takes optional `repo`, `platform`, and `focus`;
  whenever they're sent the agent's tile follows, and a changed repository posts "<agent> moved
  to <repo>". Fields left out stay as they were.
- **Open tasks** show on the tile with their age (the live state carries every open task, not only
  the newest 60 directives) ("35m Not picked up: ..." or "On it: ..."): any
  offered for reassignment first, with its Reassign button (all of them, even past the tile's room),
  then the oldest.
- **Workstreams.** A workstream pauses when its owner goes offline (20 minutes quiet): the room sees
  "<agent> went offline; <workstream> is paused", the tile shows "Paused while offline", and anyone
  may take it. It is active again, with a line in the feed, when the owner comes back.
- **Work nobody asked for.** When a Claude Code agent claims a workstream while it has no open task
  and its person hasn't prompted it in the last 30 minutes, the room sees "<agent> started
  <workstream> on its own; nobody asked for it" in the feed and as a toast. Codex agents are never
  flagged this way: no prompts reach the hub for them, so it can't tell.

### 6.3b Observers

`jam_join` takes `role: "observer"` (default `worker`) and, for observers, `broadcasts: false`.
An observer needs no repository or platform (its tile says "observer"). The brain never targets it
with product work (`explore`, `implement`, `coordinate`: it's dropped from the targets, and the
brain is told so); `answer` and `note` directives and direct messages still reach it. With
`broadcasts: false`, room-wide messages (to everyone) don't reach it. Observers are left out of
affinity routing and the brain's agent list (listed separately, as not to be given work). Joining
again without `role` leaves the role as it was. An observer can't take a workstream: `jam_claim`
refuses, and a `jam_update` with a `workstream` posts untagged. A worker's update that takes up a
workstream for the first time is announced like a claim (as work nobody asked for, when it is).

### 6.4 Prompts as context

Prompts people type to their own agents (captured by the prompt hook) are stored as `prompt`
events, up to 4000 characters, attributed to the person [B24]. Slash commands aren't stored. The
brain triages prompts like room lines, so a prompt that affects another agent's work reaches that
agent; it never re-routes a prompt to the agent it was typed to [B16]. A prompt typed to an agent
is context, not a direct address to the room brain, even when it mentions the brain's name.

### 6.5 Agents working together

- **Messages and questions** go through the hub [A27a, A27b]. An agent can ask another how its
  repository does something or which tokens it uses, and wait for the answer.
- **Repo cards** tell every agent what each repository has.
- **Pairing.** The brain tells agents to work together and compare work with `pair_agents`: one
  `coordinate` directive per agent naming the others and the goal [A27c, B22].
- **Cross-repository parity.** A `shipped` update is news first: every agent reads it in
  `jam_context`. Commits, refactors, fixes, tooling, changes the agent marks `platformSpecific`, and
  rooms with no app on another platform never go further. Otherwise the brain sends a **parity
  check** only when the shipper's own text names something a person sees (the claim is checked
  against that text) [B21]. The check is a `coordinate` directive, not build work: the other
  platform's agent compares (does this exist on our side, and does it match?), agrees with the
  shipper through `jam_message`, and builds only if both confirm a gap; then they compare renders
  for inconsistencies that aren't platform conventions [B22, B23]. When both platforms have built
  artifacts, the big screen shows a **parity** view: desktop beside mobile, labeled, with what
  differs [B23]. Shipped updates within 25 seconds of each other are considered together; the same
  feature isn't checked again with the same agent within 10 minutes, while a different feature is.
- **Routing to the agent already on it.** See [8.5](#85-affinity-and-one-agent-per-repository)
  [A3].

### 6.6 Dev servers on the host

Agents run their dev servers bound to `0.0.0.0` (`vite --host 0.0.0.0`, `next dev -H 0.0.0.0`,
`expo start --lan`) and call `jam_devserver` [B18]. The hub opens a port on the host (from `5100`,
skipping taken ports) that forwards raw TCP to the agent's machine, so HTTP, WebSockets, and hot
reload work. The dev server then reads as **Live build** on the host for the rest of the session.
Registrations survive hub restarts; an agent can remove its own.

The skill tells every agent to share each dev server it starts. When an agent's update or message
mentions a `localhost`, `127.0.0.1` or `0.0.0.0` address it hasn't shared, the tool result carries the
exact step (once per agent and port). The hub checks each target every 30 seconds. One that stops
answering shows a plain reason on its tile ("Chey's Context Gatherer stopped this build" when its
agent has gone offline, otherwise "The build at port 5173 stopped responding") with a **Stopped**
badge, and the agent gets an inbox message. If it answers again the tile recovers; after 5 minutes down
the tile clears itself and the agent is told to call `jam_devserver` again.

Dev-server ports are reachable only by paired devices and the host: requests through the host's
HTTPS address go to `dev-<port>.<name>` and need a token, and the LAN ports refuse anyone who
isn't paired.

Mockup versus built comes from what the work is [B18]: canvas frames are always **Mockup**; dev
servers are always **Built**; screenshots are **Built** unless the agent says they're a mockup. A
build titled after its mockup with "(built)" is paired with it on screen.

### 6.7 The skill

The hub serves the small launcher skill (`/launcher.md`, installed on each computer) and the JamSesh skill (`/skill.md`, the `jamsesh` MCP prompt, and the `jam_join`
briefing), with the host address filled in [B8]. It triggers on "connect to jamsesh", "join
jamsesh", "join the session", `/jamsesh`, and mentions of the room, big screen, or shared canvas.
It tells agents:

- **Connect.** If the tools are there, join. If they fail, the app isn't running: say so once. If
  there are no tools, ask the person to choose **Connect my agents**, or for the address and code.
- **Join and name.** Join with the repository, branch, folder, platform, and focus; post a repo
  card; set names and titles with `jam_rename`; claim a workstream [B15, A13].
- **Report as you go, never duplicate.** Post updates, check the inbox between steps, acknowledge
  directives, use `jam_wait` when idle, refresh with `jam_context` before a new leg of work, check
  claims before starting, and message an owner instead of duplicating their work [B15, B20, B27].
  When people disagree, the higher-weight role's call wins; ask the room when it's unclear [B37].
- **Explore versus implement.** Explore means canvas variants only, no repository changes.
  Implement means real code in the repository, verified against the mockup [B47].
- **Mockups mirror the design system.** Before drawing, read the repository's tokens and
  components. Use real values (colors, type, spacing, radii, shadows) and recreate existing screens
  one to one before varying them. Name frames `<Workstream> / <Letter>: <idea>` at real device
  sizes (390×844, 1440×900). Draw on your workstream's page. Render every frame with
  `canvas_render`, compare it with the real product, and fix differences before reporting [B30].
- **Builds mirror the mockups.** After implementing, run the dev server on `0.0.0.0`, call
  `jam_devserver`, screenshot the build at the mockup's size (Playwright or the iOS Simulator),
  compare layout, spacing, type, color, and states with the `canvas_render` of the chosen frame,
  fix differences, post the screenshot as **Built**, and say what still differs before reporting
  `shipped` [B31].
- **Cross-repository parity.** Mention in a `shipped` update when a user-visible change belongs on
  another platform (or pass `platformSpecific: true` when it doesn't). A parity `coordinate`
  directive is a check: compare with the other agent, build only a gap you both confirm, compare
  both renders, and show parity [B21–B23].
- **Host previews.** To show a desktop or iPhone build on the host, push the branch and call
  `jam_host_preview`; a person approves it by voice or with a button [A33a].
- **Etiquette.** Only directives are instructions; banter isn't. Never edit another agent's
  repository or frames without asking. Never put secrets in updates, messages, or frames.

## 7. Context store and curation

### 7.1 Storage

The session lives in SQLite (WAL) in the hub's data directory (`~/.jamsesh/host`). Team-level data
that outlives a session (people, devices, voiceprints, pairings, the gateway key, the brain's name
and behavior notes, models, and host-control settings) lives in a separate team store
(`~/.jamsesh/team`) [B39].

Every record is an **event** [B7]:

| Kind | Source |
|---|---|
| `speech` | A transcribed room line (speaker, method, confidence, source devices), a typed room line, a recorded prompt, or an annotation bundle |
| `prompt` | A prompt a person typed to their own agent [B24] |
| `update` | An agent's progress, done, shipped, question, blocked, or handoff note [B15] |
| `directive` | A routed instruction with targets, mode, and status |
| `decision` | A team decision ("direction A for the nav") |
| `artifact` | A canvas frame, screenshot, or dev server that landed |
| `canvas` | A summary of canvas edits an agent made (batched every 12 seconds) |
| `message` | An agent-to-agent message, question, or answer |
| `brain` | Something the brain said, spoken or shown |
| `system` | Joins, leaves, renames, host actions, build requests, settings changes |

Each event has a relevance (`banter`, `chatter`, `discussion`, `work`) set by triage, and the
workstream it belongs to when known. Documents (people, agents, workstreams, directives,
artifacts, dev servers, utterances, shares, annotations, facts) are stored alongside.

### 7.2 Search

`jam_search` runs a full-text (FTS5) prefix search over event text and author, ranked by
relevance.

### 7.3 Digests and curated facts

The brain keeps context current so new legs of work start informed [B27, A16d]:

- **Session brief.** At most every 75 seconds, and only after at least 6 new events (or when
  forced, for example 3 seconds after a decision), the digest model rewrites a brief of 300 words
  or fewer: goal, decisions (with who decided), in progress, open questions, people. Banter and
  canvas noise are left out.
- **Workstream briefs.** Each active workstream gets a brief of 150 words or fewer.
- **Curated facts.** The same pass maintains a list of facts, each a `decision`, `requirement`,
  `constraint`, `preference`, `question`, or `fact`, with status `active`, `resolved`, or
  `superseded`. Curation is sparse (most batches add zero to three items), never leaves two
  contradicting active facts, updates a fact when its scope changes ("A on both" becomes "A on
  mobile"), supersedes it when it's replaced, and resolves answered questions. A new fact is
  dropped as a duplicate only when it matches an active fact of the same kind with the same
  specifics; a changed decision (A to B, 16 px to 24 px, a new color) is never dropped.
- A batch that fails to curate is retried on the next pass.

### 7.4 What agents read

`jam_context` (and the `jam_join` briefing) returns, in order [B27]:

1. The session brief.
2. The workstream brief for the named workstream, or the one the agent owns.
3. Curated facts: this workstream's, session-wide ones, and up to 15 from other workstreams.
4. The last 12 decisions as said in the room.
5. Open directives for this agent, and up to 8 of other agents' as context.
6. Room speech and prompts from the last N minutes (default 10, up to 80 lines), without banter
   and chatter.
7. The last 20 updates, artifacts, and messages from other agents.

## 8. Brain

The brain runs on the host and drives the big screen, the routing, and the host machine [B25,
B44].

### 8.1 Models and the gateway key

One Vercel AI Gateway key runs everything: triage, routing, digests, layouts, text-to-speech, and
transcription fallback [B48]. The key is set in the host's **Settings > Gateway** (or
`~/.jamsesh/.env` through `jamsesh key`); a key in Settings wins. Each job uses the model that fits
it, and every model is a setting [B49]:

| Job | Default model | Used for |
|---|---|---|
| `triage` | `google/gemini-3.5-flash-lite` | Sorting every incoming line; fast and cheap |
| `router` | `anthropic/claude-sonnet-5.5` | Routing, direct requests, parity checks, every tool call |
| `presenter` | `anthropic/claude-sonnet-5.5` | Placing a new screen share on the big screen |
| `digest` | `google/gemini-3.5-flash` | Session brief, workstream briefs, fact curation |
| `speech` | `microsoft/mai-voice-2.1` (the provider's default voice) | Speaking to the room [B46] |
| `transcribe` | `openai/gpt-transcribe` | Transcription when no local engine is available |

Only the host machine can change the key, the models, and host control. The brain can be turned
off from the host. Brain status is **ready**, **thinking**, **off**, or **Add a gateway key**.

### 8.2 Name and addressing

- The brain is called **JamSesh** until someone renames it in **Settings > Room brain** [A10]. It
  listens for its name.
- A room line addresses the brain when it starts with the name (optionally after "hey", "ok",
  "okay", "yo", or "so"), or names it as the one being spoken to ("can you put that up,
  JamSesh?"): within the first two or last two words, and not right after "the", "a", "to", or
  similar ("update the jamsesh skill" isn't addressed to it). Names of fewer than three letters
  aren't matched, and the name must be a whole word [A8d]. The default name also matches how
  speech-to-text writes it: "Jam Session", "jam sesh", "jamsession".
- Saying only the name ("Hey JamSesh…") chimes, and the same person's next line within 8 seconds
  is taken as addressed to the brain, so a pause after the name works.
- Prompts typed to an agent never address the brain, whatever they say.
- Typing in **Ask <name>**, pressing **Record**, and **Send to <name>** on pins address the brain
  without saying the name [A8a, A8b, A7d].
- A direct address skips triage and goes straight to the router model with up to 8 tool steps,
  with a chime first unless it was typed. The brain always does something visible: acts, answers,
  or remembers feedback.

### 8.3 Triage

Every incoming line is triaged [A16a, B25]: transcribed room speech, typed room lines, and prompts
typed to agents. Lines are batched for 1.4 seconds. The triage model gets the waiting builds, the
online agents, the last 14 lines for context, and the new lines with each author's role, and
returns for each line:

- **Relevance:** `banter`, `chatter`, `discussion`, or `work`.
- **Intent:** `none`, `directive`, `decision`, `present`, `question`, `introduce`, or `relabel`.
- **Confidence**, and introductions (`name`, `role`) it heard.

Triage is deliberately conservative. The team jokes around, and speech-to-text is messy. Sarcasm
and jokes are never directives. Musing ("I wonder if…") is discussion unless it ends in an ask. A
request aimed at a person ("Felipe, can you grab lunch") isn't work. The batch is routed only when
a line has a directive, decision, present, question, or relabel intent with confidence above 0.55.
Banter is stored but never routed [A16b]. Introductions ("I'm Britt, I run product") add or update
people [B39].

### 8.4 Routing and intent

The router decides what to do with an actionable batch, using a full picture of the session:
people with roles, weights, and locations; agents with repository, platform, status, focus, and
work history; repo cards; workstreams; open directives; curated facts; recent updates and
artifacts; shares, dev servers, canvas pages, saved layouts, displays, waiting builds; and the
last 40 lines of the room [A16e].

**Explore versus implement** [B47]:

- **Explore** ("try", "what if", "show me options", "mock up", "let's see a few directions")
  becomes canvas variants named `<Workstream> / <Letter>: <idea>`.
- **Implement** ("let's do it", "build it", "ship B", "do it for real", "in the app") goes to the
  agent that owns the repository, which changes the code, runs its dev server, and checks it
  against the mockup.

**Target selection:**

- Work history first: a follow-up, tweak, or new variant goes to the agent that did the earlier
  work, even if another is idle [A3].
- One request is never split between two agents in the same repository; requests fan out only
  across repositories or platforms [A3].
- New work goes to the agent whose repository it belongs to, preferring the one with fewer
  unfinished directives.
- "My agent" and "Chey's" mean that person's agent.
- A request that spans desktop and mobile goes to both, with a coordinate instruction [B21].
- `ask_agent` asks an agent for facts only it knows (45-second wait).

`create_directive` skips a directive that duplicates one sent to the same agents in the last 5
minutes (overlap of stemmed terms above 0.6) [B20].

### 8.5 Affinity and one agent per repository

Each agent's **work history** is its focus, its workstreams, the directives it has taken, its
updates, artifacts, and decisions, and its frame titles. For a request, an agent's affinity is
`min(1, (shared terms + shared terms that are in its workstream titles) / max(3, request
terms))`, over stemmed words without stop words; ties go to the agent seen most recently. The
router sees the best matches with their scores [A3].

Before a directive is sent, targets in the same repository (compared as `owner/name`) are reduced
to one: the highest affinity, then the one with fewer open directives. The router is told which
agents were dropped. Three exceptions: an agent named in the request (by its name or its person's)
is never dropped, agents with an unknown repository aren't grouped, and `answer` and `coordinate`
directives go to every target.

When the room changes its mind or a higher-weight person overrules work already sent, the brain
cancels the old directive (`cancel_directive`, which tells the agent why) and sends the new one.

### 8.6 Decisions

A decision ("I like B", "go with direction A") is recorded as a `decision` event, shown as a
toast, and folded into the brief within seconds [B14]. Unless the room says otherwise, the brain
also sends an **implement** directive to the agent that owns the chosen work, naming the chosen
artifact, and spotlights it. "That one" means what's on screen, or the latest artifact.

### 8.7 Roles and weights

People have a name, a title, and a weight from 1 to 3 [B36, A15]. The weight follows the title
unless someone set it by hand in **Settings > People**: 3 for `CEO`, founder, `CPO`, `CTO`,
chief, head of, VP, or director; 2 for lead, principal, staff, manager, PM, or product; 1
otherwise. Changing a title (in the profile, by an agent's `jam_rename`, or by an introduction)
updates the weight.

When instructions conflict, the higher weight wins, and the brain says whose call it went with
and mentions the other view rather than dropping it ("going with the CPO's call on the nav") [B37].

### 8.8 Speech policy

The brain shouldn't feel unresponsive, but it isn't a voice assistant that answers everything
[A20]:

- A soft **chime** means it heard a direct request. It plays on the big screen, on the laptop that
  spoke, and on remote laptops.
- Anything it does on the big screen speaks for itself: silence plus the visible change is the
  confirmation.
- It speaks only to **answer** a question or report a **problem**, and only when the request came
  by voice or a recorded prompt. Typed requests and button presses get typed answers (a toast).
  A short confirmation ("Sent to Felipe's agent.") is spoken too, but only for a spoken request;
  nothing already visible on the screen is confirmed.
- It waits at least 4 seconds between spoken replies, and speaks at most two sentences.
- When the room has asked it to be quiet, it speaks only to answer.
- It stops talking when someone talks over it: the big screen fades the voice out when the room
  mic hears speech after 0.6 seconds of playback, and remote laptops do the same with their mic.
- Spoken replies use the gateway's text-to-speech; without it, macOS `say` [B46]. The big screen
  shows a caption of what it says. Remote laptops play the voice (each person can turn this off);
  in-room laptops don't, to avoid echo.
- Every reply is stored as a `brain` event.

### 8.9 Feedback about its behavior

People tell the brain how to behave ("JamSesh, keep it short and only talk when someone asks you
something"), directly or in passing [A11]. It stores each as a one-line rule (`remember_feedback`),
applies the rules to every later decision, and removes them on request (`forget_feedback`). Rules
are team-level, so the brain keeps behaving the way the team asked in the next session; **Settings
> Room brain** lists them and lets anyone remove one. At most 30 are kept.

### 8.10 Screen tools

The brain has complete control of the big screen through tools [A6, B40]:

| Tool | What it does |
|---|---|
| `show_on_screen` | Show a mode: `board`, `spotlight`, `compare`, `parity`, `agents`, `canvas`, or `join`, with a title, caption, artifacts, labeled columns, and an optional pin [B13, A31]. |
| `search_artifacts` | Find artifacts by title, note, agent, or platform ("bring up the nav variants") [B13]. |
| `set_layout` | Design a layout of 1 to 9 tiles in a grid (optional CSS grid areas). Tiles are described in [10.3](#103-layouts-and-tiles) [A4, A6]. |
| `build_custom_view` | Show a self-contained HTML view it writes, for example "a four-way split of what everyone's doing" [B43]. |
| `save_layout` / `show_saved_layout` | Save the current layout by name and bring it back ("the review layout") [A17b]. |
| `request_share` | Ask a person to share their screen or camera [A5a]. |
| `say_to_room` | Answer, report a problem, or confirm, under the speech policy. |
| `save_snapshot` | Save a labeled snapshot [A17b]. |
| `fix_speaker` | Reassign a line to the right person and teach their voiceprint [B35]. |
| `remember_feedback` / `forget_feedback` | See [8.9](#89-feedback-about-its-behavior). |
| `create_directive`, `record_decision`, `pair_agents`, `ask_agent` | See [8.4](#84-routing-and-intent)–[8.6](#86-decisions). |
| `host_action`, `build_preview`, `decide_host_build` | See [13](#13-host-control-and-permissions). |
| `no_action` | Explicitly do nothing. |

Screen rules:

- **Self-piloting.** When a variant group of 2 to 6 has all updated within 60 seconds, the screen
  shows a compare on its own, unless a person pinned the screen or the brain changed it in the
  last 90 seconds [B12].
- **New shares.** When someone pushes a share, the brain places it next to the most useful tile;
  without a model, the share goes first with up to three existing tiles [A5b].
- **Pinning.** A person who picks a view pins it; the brain and agents don't override a pinned
  screen (agents' requests become a toast).
- **Back to the board.** Any unpinned view other than the board returns to the board after 6
  minutes.
- **Displays.** The brain knows the big screen window's size, aspect ratio, and pixel density,
  and every display's resolution, aspect ratio, scale, and usable area, and plans in-app and
  out-of-app layouts for them [A32]. The big screen reports its size on load, on resize, every
  minute, and on reconnect; the host re-reads displays every 30 seconds.
- **Join.** "How do I join?", "what's the code?", and "put the QR up" show the Join view and
  say nothing out loud [A31].

### 8.11 Build approvals

Host builds that agents request wait for a person [A33a]. When an agent calls `jam_host_preview`:

1. The hub validates the request (a remote URL starting `https://`, `git@`, or `ssh://`, a branch,
   and a command), allows one pending request per agent, and gives it 10 minutes.
2. The room hears and sees it: "<agent> wants to build <repo> on the host. Approve or deny?" is
   spoken (it's an announcement, so it bypasses the 4-second gap) and shown as a card on the big
   screen and every client with the command, **Approve**, and **Deny**.
3. A person decides, fully by voice or with the button [A33b]:
   - With one request waiting, "approve" or "deny" (also "approved", "denied", "reject") in a
     line of 10 words or fewer decides it at any time, with or without a model.
   - A casual answer ("go ahead", "build it", "yes", "sure", "no", "not now", "don't build")
     counts only within 30 seconds of the spoken request or of its one-minute reminder, or when
     it's said to the brain by name ("JamSesh, build it"). Minutes later, "go ahead" is about
     something else.
   - A line that's only the answer (five words or fewer) is handled there; a longer one also goes
     on to the brain. A line that says both goes to the router.
   - With several waiting, the brain asks which, and the person names it.
   - Only words said after the request arrived count.
   - Only people's speech and what they type to the room count. Prompts typed to an agent never
     count, and neither do agents' lines or anything sent with an agent's credential.
   - The request is spoken again after a minute if nobody has answered.
4. The agent is told the outcome (approved and building, denied, or expired) and woken.

The approval card stays visible for a minute after the decision.

### 8.12 Autosave and snapshots

Everything saves as it happens: the context store in SQLite and the canvas in `figcraft-server`'s
own storage [A17a]. On top of that, the hub keeps **snapshots** in `<data>/snapshots/<date-time>[-
label]/`:

- Every 5 minutes while something changed (a new event or a re-rendered frame).
- When the host stops ("end of session", within 8 seconds).
- When someone presses **Save now** or tells the brain ("JamSesh, save this as the review")
  [A17b].

Each snapshot holds `canvas.figcraft` (opens in FigCraft), `context.json` (people, agents,
workstreams, facts, decisions, directives, artifacts, annotations, stage, layouts, brief), and
readable `notes.md`. The 36 newest automatic snapshots are kept; labeled ones are kept forever.
**Settings > Saved** lists them with download links and restores one: the canvas, the facts, the
layouts, and the brief come back into the current session.

### 8.13 When the gateway isn't available

Without a gateway key, or with `JAMSESH_OFFLINE=1`, the brain runs on rules: keyword triage
(asking to see or join first, then decisions, then requests for work), keyword routing (agents by
whole-word name or platform, else best affinity, skipping a request already sent in the last 10
minutes), "bring up" by matching artifact titles, the Join view for join phrases, voice approvals,
and decisions ("let's go with B") that send an implement directive to the agent that made the
chosen variant. Spoken to directly on rules, it acts, or says it's on simple rules and what it
can't do; "talk less" and similar still become a behavior note.

Every gateway call has a time limit (15 seconds for triage, 45 for everything else). When a call
fails, the brain falls back to the rules for that batch, shows a notice at most every five
minutes, and goes straight to rules for the next minute, so nothing said is lost and nobody waits
on a failing gateway.

## 9. Room audio

### 9.1 Capture

Every client window and the big screen capture audio; it's consolidated on the host [B9, B32].

- The microphone is on whenever the window is open, unless the person mutes it [A8c, A12]. A new
  window starts listening on the first click or key press (browsers need a gesture), and says so.
  The big screen's room mic starts with the host.
- Audio is captured mono at 16 kHz with echo cancellation on, and noise suppression and automatic
  gain off, so loudness still says how close a speaker is.
- Voice activity detection runs on the device (20 ms frames): a frame is speech when it's at least
  10 dB above a tracked noise floor and above -58 dB. A segment starts after 60 ms of speech, keeps
  300 ms of lead-in, ends after 700 ms of silence or at 14 seconds, and is dropped if it has less
  than 400 ms of speech.
- Each segment goes to the host as WAV with its device, host-clock start and end, level, and
  noise floor. Segments that end while the brain is speaking are dropped, so it doesn't transcribe
  itself.
- **Clock sync.** Each device measures its offset from the host clock (six pings at connect, then
  every minute; the lowest round trip wins) and stamps segments in host time [B33].
- **Mute.** `M` (or the mic button) stops the microphone entirely; the browser's indicator goes
  off [A12]. The Mac app's menu bar also has **Mute**. On the host, `M` mutes the room mic.

### 9.2 Grouping and the cleanest copy

- Segments from different devices are one **utterance** when they overlap by at least 45 percent
  of the shorter one and aren't both shifted the same way by a second or more [B32].
- The hub waits for late copies: `min(3.5 s, 0.7 s + 1.25 × the slowest device's recent lag)`.
  It learns each device's lag. A copy that arrives up to 15 seconds late still joins its
  utterance; it can improve the text (when it's clearer by more than 6 dB) and the speaker, and
  updates the same line in place [A2].
- The **cleanest copy** has the highest `0.7 × SNR + 0.3 × level` [B33]. Only it is transcribed.
- Non-speech is dropped before transcription: level below -62 dB, SNR below 4 dB, clicks and
  knocks (little sustained energy), or hum.
- Common speech-to-text hallucinations on short or noisy clips ("thank you", "bye", "[BLANK_AUDIO]")
  are dropped.
- Two people talking at once: a clear copy (SNR 12 dB or more) shifted a second or more from the
  best copy becomes its own line.

### 9.3 Transcription

Transcription mode is `auto`, `local`, or `gateway` (**Settings > Transcription**). In `auto` the
engines are tried least-busy first, local before remote [B28]:

1. **Host whisper.cpp** (`whisper-server` on `127.0.0.1:8178`), using a model already on the Mac
   (large-v3-turbo, quantized, which `install.sh` downloads; the app doesn't download one). The
   prompt carries only the brain's name: people's names in the prompt made whisper invent lines
   made of just those names in quiet stretches.
2. **Client workers.** A JamSesh for Mac client with whisper.cpp offers itself as a transcription
   worker to the host, which uses it when the host is busy [B28b].
3. **The gateway** (`openai/gpt-transcribe`).

Each request has 20 seconds. An engine that fails three times is skipped until it has a minute
without failures. Transcription handles the languages the team speaks, not only English.

### 9.4 Speaker identification

Two signals identify the speaker [B34, B38]:

- **Loudest device.** Each device has an owner (set in **Settings > Devices** or by who signed in;
  the room mic has none). The device that heard the line loudest, after removing its noise floor,
  scores higher the bigger its margin over the next device.
- **Voiceprint.** A local speaker-embedding model (WeSpeaker ResNet34 through sherpa-onnx)
  embeds lines of 0.8 seconds or more. A person's voiceprint is the average of up to 40 samples;
  matching is cosine similarity.
- The two combine, with the voice weighted more as a person's voiceprint grows (from 0.45 up to
  0.75). Below a combined score of 0.3 the speaker is "Someone". A confident voice match outweighs
  the loudest device, so a person who walks to someone else's laptop is still identified [A1c].
- Lines the hub is unsure of (confidence below 0.55) are shown as unsure.

Voiceprints build themselves [B38]: a clear line (SNR above 12 dB, not clipped) from the owner of
the loudest device, with a confident match, adds a sample. A first sample is held until a second
line from the same device agrees, so a visitor at a laptop can't become its owner's voice.
Voiceprints persist across sessions [B39].

**Teach JamSesh your voice.** In the profile, a person reads one sentence ("Hey <brain>, this is my
voice…", up to 14 seconds). The host rejects it if it's too quiet or noisy, then adds it in
3-second samples. New people are offered this on first join.

**Relabeling** [B35, B38]:

- Click a speaker's name in the transcript and pick the right person (or add someone new).
- Or say it ("that was Felipe"); the brain calls `fix_speaker`.
- Either way, the line becomes Felipe's (confidence 1), and its audio teaches Felipe's voiceprint.

### 9.5 Remote and hybrid rooms

JamSesh works with everyone in the room, everyone remote, or a mix [A18]:

- Each device is **in the room** or **remote**. The client asks ("Where are you?") and guesses from
  the address (same subnet as the host means in the room).
- In-room devices merge with each other. A remote laptop is its own room: its lines never merge
  with the room's or with another remote laptop's [A18c].
- **Echo.** When the room's speakers play a remote voice into the room mics (or a remote laptop
  hears the room through the call), a line that matches a line from the other location (start
  within 3 seconds, end within 3.5 seconds, 55 percent shared words) is kept from the clearer copy
  and the other is dropped.
- Remote people get the big screen mirrored in their **Screen** tab, hear the brain's voice and
  chime on their laptop, and get links that use the address they connected through.

## 10. Big screen

### 10.1 Layout

The big screen (`/host`) shows [B6, B10]:

- **Header:** the session name; Board, Canvas, and Agents tabs plus the current view's name with a
  close button; a "thinking" indicator; the avatars of everyone whose mic is on, glowing when they
  speak; the room mic with a level meter; Annotate; the brain's status; the join pill (live code
  and countdown, opens the join card); the clock; Settings.
- **Stage** on the left (see below), and on the right **The room** (the live transcript with
  speakers, directives with targets and rationale, decisions, the brain's replies, and agent
  questions, blockers, and ships) and **Agents** (each agent's status and activity).
- A caption of what the brain is saying.
- Toasts (Routed, Decision, Needs you, JamSesh): 9 seconds for directives and warnings, 6
  otherwise, at most four.
- An approval card for each waiting host build [A33].

### 10.2 Views

| View | What it shows |
|---|---|
| **Welcome** | Before anything exists: a headline, the join card, and who's here. |
| **Board** (default) | The five newest artifacts as a bento grid, laid out for one to five items, with wide layouts when the newest is landscape. New work is marked fresh for 45 seconds. Clicking a tile spotlights it [B6, B12]. |
| **Spotlight** | One or more items large, with a title and caption ("bring up the nav variants") [B13]. |
| **Compare** | Variants side by side, sorted and labeled A, B, C, so the room can say "I like B" [B12, B14]. |
| **Parity** | Labeled columns, desktop beside mobile [B23]. |
| **Agents** | A grid of every agent: status, latest image, last three updates. |
| **Canvas** | The live canvas with everyone's cursors. |
| **Layout** | A brain-designed grid of tiles [A6]. |
| **Custom** | A sandboxed HTML view the brain built, fed live session state [B43]. |
| **Join** | A 520-pixel QR code, the session name, the code with a ring, the address, steps for a phone, a laptop, and an agent, and "the code changes every 30 seconds" [A31]. |

Artifacts are badged **Mockup**, **Built**, or **Live build** (a dev server), with the platform and
the agent that made them.

### 10.3 Layouts and tiles

A layout is any mix of these tiles [A4, A6]:

| Tile | Shows |
|---|---|
| `artifact` | A mockup, screenshot, or dev server (a live dev server renders at 1440×900, or 390×844 for mobile, and says when it isn't answering) |
| `canvas` | The live canvas, following a person or agent by name, or showing a page [A4a] |
| `web` | A browser on a dev server hosted on the host or on a reference site [A4b] |
| `screen` | A person's shared screen or camera [A4c] |
| `agent` | An agent's live activity |
| `feed` | The room feed |
| `html` | Custom HTML |

A `web` tile on a local address must be a registered dev server. Reference sites that refuse to be
framed open in a host browser window that the brain places beside the big screen [A4b]. Every
tile, in every view, takes pins (see [11.5](#115-annotations)) [A7c].

### 10.4 Keyboard

| Key | Action |
|---|---|
| `1` | Board |
| `2` | Canvas (pinned) |
| `3` | Agents (pinned) |
| `J` | Join view |
| `Esc` | Back to the board |
| `F` | Full screen |
| `M` | Mute or unmute the room mic |
| `A` | Annotate |
| `,` | Settings |

## 11. Client

### 11.1 Desktop layout

- **Header:** the session, tabs, a **Remote** badge when remote, **On screen:** what the big screen
  shows, the mic (Hearing you, Listening, or Muted, with a meter), **Record**, **Annotate**,
  **Share screen** and **Camera**, your photo and name (the profile), and Settings. As the window
  narrows, labels give way to icons; nothing wraps or gets cut off [A21].
- **Tabs:**
  - **Canvas:** the live canvas, editable, with the page bar [A19a].
  - **Screen:** the big screen, live; clicking changes it [B11].
  - **Work:** every artifact grouped by variant set, filtered by All, Mockups, or Built, with
    **Show on big screen** per group.
  - **Pins:** every pin in the session (see [11.5](#115-annotations)).
  - **Agents:** every agent with its workstreams, what the session has settled (curated facts by
    workstream), the session brief, and the dev servers on the host.
- **Room panel** (right): your agents and their status, your agents' pending directives, the room
  feed (click a name to fix who said it), and the Ask box.

### 11.2 Talking to the brain

There are three ways to address the brain directly instead of talking in the room [A8]:

- Say its name: "JamSesh, put the mobile build next to the mockup" [A8d, A10].
- Type in the **Ask <name>** box (`Say to the room` switches it to a plain room line) [A8a].
- Press **Record** (or `R`), talk while pointing, and press **Stop** [A8b, A9].

The room can give the brain other names to answer to ("call it Computah"): the display name plus
up to 8 **aliases** (`brainAliases`, 40 characters each, kept as trimmed, unique strings). Saying
any of them addresses the brain, and the transcriber is primed with them so they're spelled right.

### 11.3 Record a prompt

The mic is already recording. **Record** marks a window of it as a prompt for the brain [A8b]:

- Start marks the time in host time and tells the host; lines from that device in the window are
  held for the prompt instead of being triaged one by one. Stop sends the window.
- The host waits up to 7 seconds for the last words to be transcribed, then sends the brain one
  prompt: the words, plus where the person pointed. A window that is never stopped (the person
  closes the window) ends on its own after 2 minutes.
- While recording, the screen edges glow, a trail follows the pointer, and a timer and level bars
  show. Afterward a toast shows what was sent and how many things were pointed at.

**Pointer context** [A9]: while recording, the client watches the pointer over every tile and the
canvas, including the canvas, artifacts, dev servers, and shared screens, and distills it into up
to 40 marks: clicks, drags, and dwells of 300 ms or more. Each mark records the tile, the position
in it, the canvas frame under the pointer (with its page coordinates), and the words said at that
moment. The brain gets "held on frame "Nav / B" at top center while saying 'make this one…'".
Each mark also becomes a pin.

### 11.4 Mute

`M` or the mic button mutes or unmutes at any time [A12]. Muted is remembered per host.

### 11.5 Annotations

Pins are app-wide [A7a, A7c]:

- Press **Annotate** (or `A`) and click anywhere on the canvas, a mockup, a build, a dev server
  hosted on the host, a shared screen, or the big screen mirror to drop a pin with a note [A7b].
  Enter saves, Shift+Enter adds a line, Esc cancels.
- Canvas pins stick to the canvas as you pan and zoom, and become FigCraft comments so agents see
  them in the file.
- Every pin is visible to everyone, in the **Pins** tab and on the tile it's on. People edit,
  resolve, and delete them there.
- **Send N to <name>** sends every open pin as one prompt to the brain [A7d]. The brain groups them
  by topic and sends each group to the agent that owns that work (one directive per agent),
  quoting each note. The answer is typed, not spoken.

### 11.6 Sharing a screen or camera

- **Share screen** or **Camera** in your window puts it on the big screen; the brain finds it a
  place [A5b, A4c]. The browser's picker is the consent. Stopping in the browser ends it for
  everyone.
- The brain (`request_share`), or anyone from **Settings > People**, can ask you to share [A5a].
  Your window asks first: "<who> would like to see your screen", **Share** or **Not now**. A
  request lasts 2 minutes.
- Shares are peer-to-peer video that works on the LAN and across the internet, through STUN and,
  when needed, a relay on the host. A screen is captured at up to 3840×2160 at 15 fps and sent to
  the host at 14 Mbps; people's own windows get a scaled-down preview (about 1 Mbps). A camera is
  1280×720.
- **One share of a kind per person's device.** Starting a new screen share ends the earlier one
  from that device and answers any request still waiting for it.
- **A share must be on a big screen.** A new share has 60 seconds for the brain to place it; the
  hub checks every 5 seconds after a stage change, and once at the end of that window if nothing
  changed. A live share that no big screen shows then stops, and its sharer is told why ("wasn't
  put on the big screen" if it never was, "left the big screen" if it was). A stage that shows a
  live share never reverts to the board on its timer; the share's end gives the screen back what
  it hid.

### 11.7 Profile and onboarding

- **Onboarding.** A new window asks who you are: pick yourself from the people already known, or
  type your first name and title. Then where you are: in the room or remote.
- **Profile** (click your name) [A14, A15]:
  - **Photo** from your camera (3-2-1 countdown, square crop) or a file. It's your picture
    everywhere in the session.
  - **Name** and **Title**. The title tells the brain whose call wins and tells the agents who you
    are.
  - **Where you are.**
  - **Teach <name> your voice** (see [9.4](#94-speaker-identification)).

### 11.8 Settings

| Section | Contents | Who can change it |
|---|---|---|
| Session | Name, addresses | Anyone |
| Room brain | Name, behavior notes (add, remove), on or off | Anyone; on or off on the host only |
| Gateway | AI Gateway key, last error, model for each job | Host only |
| Voice and host | Voice replies, voice, **Let the brain drive this Mac** | Host only |
| Saved | Snapshots with downloads, **Save now**, restore, saved layouts | Anyone |
| Transcription | Auto, local, or gateway; the engines and their health | Anyone |
| People | Name, title, weight, voice samples, ask to share, reset voice, remove | Anyone |
| Devices | Each mic, its level, and its owner | Anyone |
| Remote access | Status and the setup wizard | Host only |
| Connected devices | Every paired laptop, phone, and agent; **Disconnect** | Host only |

### 11.9 Phone

On a phone [A28c]:

- **Portrait:** a header (session, Remote badge, photo, Settings), tabs (Canvas, Screen, Work,
  Pins, Agents), and a dock with the Ask box and Mic, Record, Pin, and Room.
- **Landscape:** tabs and actions move into the header.
- **Screen** is a scaled live mirror of the big screen; tap to drop a pin.
- **Room** is a sheet with the transcript (tap a name to fix it), your agents, pending directives,
  sharing, and the Ask box.
- The canvas is view-only. The keyboard never covers the dock or a pin note. Inputs are at least
  16 px so iOS doesn't zoom.

## 12. Canvas and canvas pages

### 12.1 Canvas-only mode

The canvas is FigCraft in **canvas-only mode**: no layers panel, no Design panel, no menus, tab bar,
or home screen [B2]. Artboards, connections, cursors, comments, and presence stay. A presence pill
and a zoom chip float over it. The mode is a flag in FigCraft's UI crate, so it works in the native
app (`figcraft --jamsesh <link>`) and in the WebAssembly build (`/canvas/?canvas#join=<link>`) that
JamSesh's windows embed [B1].

The host runs `figcraft-server` on `127.0.0.1:47900` (or the next free port) and a headless host
participant named after the brain that publishes the session's file. People reach the canvas
through the hub's relay (`/collab`).

### 12.2 Agents on the canvas

- On an agent's first canvas call, the hub starts a headless `figcraft-cli mcp` participant for it
  on the host, named after the agent, joins it to the live file, and forwards its calls (one at a
  time, 120 seconds each) [B3, B4]. Participants idle for 45 minutes are stopped.
- The hub sees every canvas action, so it logs what each agent made without the agent reporting
  it, and attributes each frame to the agent that last touched it.
- **Frames land as artifacts.** The host checks the document every 2 seconds. A top-level frame
  (or a frame in a section) that stays unchanged for 2.5 seconds is rendered (up to 1600 px, six
  per check) and lands on the big screen as a **Mockup** [B6]. The platform is guessed from the
  name or the shape. Deleted frames are removed.
- **Variant sets** are frames named `<Workstream> / <Letter>: <idea>`; they're grouped and shown
  side by side [B12].
- **Placement.** A new top-level frame, section, or component that would overlap existing work (or
  a frame placed in the last 15 seconds) on the same page is moved, with the rest of its batch, to
  120 px right of everything on that page.

### 12.3 Pages

People move between canvas pages with the page bar at the top left of the canvas, which lists
every page with its frame count, and add one with **New page…** on the editable canvas [A19a].
Big-screen canvas tiles can show a named page.

When to make a new page [A19b]:

- Each workstream gets its own page, named after it. An agent that claims a workstream draws on
  that page, and the first workstream takes over an untouched starter page.
- Variants of one idea stay together on their workstream's page.
- Throwaway work goes on a `Scratch` page.
- When the brain routes work that doesn't fit an existing workstream, it names a new workstream,
  and with it a new page; follow-ups to existing work stay on that work's page.

## 13. Host control and permissions

The brain pilots the host machine as well as the big screen [B44]. Host control is on by default
and can be turned off on the host (**Settings > Voice and host > Let the brain drive this Mac**).

### 13.1 Actions

`host_action` runs these on the host (macOS):

| Action | What it does |
|---|---|
| `open_app` | Opens an app, for example an Electron desktop build [B42]. |
| `open_url` | Opens an `http(s)` or `exp(s)` URL, optionally in a named app (Expo Go) [B42]. |
| `arrange` | Places apps side by side (`left-right`), in a grid, or full on a display (the big screen's by default, `main`, or by name), inside the display's usable area [A29c, B42]. |
| `windows` | Lists visible windows with titles, sizes, positions, and displays. |
| `simulator` | Boots an iOS Simulator (a booted match, the named device, or the first iPhone) and optionally opens a URL in it [B45a, A29b]. |
| `shell` | Runs a command in `zsh -lc` (60 seconds, last 4000 characters of output), for example installing a tool it needs to show something [B41, B42]. |
| `focus_jamsesh` | Brings the big screen back to the front. |

Every action is logged as a system event. Errors from missing Accessibility or Automation
permissions tell the person to open **Set up this Mac**.

### 13.2 Piloting

The brain can drive what it shows, not only open it: tap, swipe, and type in the iOS Simulator,
and click and type in apps it opened, to walk the room through a build [B44, B45b].

### 13.3 Preview builds

`build_preview` builds a pushed branch on the host and opens it [A29a]:

- The repository is cloned (or fetched and reset to the branch) into
  `~/.jamsesh/previews/<repo>-<branch>` with the host's own git credentials. Branch names are
  restricted to `[\w./-]`.
- The command runs in the background (20 minutes at most); one build per checkout at a time.
- `open` is a path in the checkout, a URL, or `simulator:<path>.app`, which installs the app in the
  Simulator and launches it [A29b].
- The room gets a toast when the build starts and when it opens or fails (with the exit code and
  the end of the output).

A build an agent asks for goes through approval first (see [8.11](#811-build-approvals)). A build
the brain starts, and any `shell` command, also needs a person: the brain files it as a request,
says it out loud ("JamSesh wants to run … on the host. Approve or deny?"), and a person approves
the same way, by voice or button. Asking for it isn't approval: the request still waits for an
"approve" said after it was announced, so nothing someone said in passing, and nothing the model
decides, can start a command.

### 13.4 Displays

See [8.10](#810-screen-tools): the brain knows every display's resolution, aspect ratio, scale, and
usable area, and the big screen's size, and arranges windows for them [A32].

### 13.5 Permissions setup

**Set up this Mac** opens once after the first host start and from the menu bar [A29d]. It lists
each permission with what it's for, its state (checked every 1.5 seconds and on focus), and one
button:

| Permission | Required | For |
|---|---|---|
| Microphone | Yes | The room mic |
| Accessibility | Yes | Arranging windows |
| Automation (System Events) | Yes | Arranging and listing windows |
| Screen Recording | Yes | Sharing the host's screen (JamSesh reopens once to turn it on) |
| Camera | Optional | Photos and camera shares |
| Xcode | Optional | Preview builds and the iPhone Simulator |

The button says **Allow** and triggers the macOS prompt. After a try, or when denied, it becomes
**Open Settings** and opens the exact Privacy pane. The app runs with the hardened runtime, so it
declares both the entitlement and the purpose string for each permission (microphone, camera, and
Apple Events for Automation); without either, macOS refuses silently with no prompt. Everything the hub runs is a child process of the app, so the
same grants cover it. A progress bar shows the required items; **Skip for now** and **Done** close
it.

## 14. Security

- **Pairing.** Every request needs a paired device's token, except the connect page, `/healthz`,
  static assets, pairing itself, and the agent intro. Requests from the host machine itself need
  no token: loopback requests that no proxy, tunnel, or relay forwarded (a request carrying
  `X-Forwarded-*`, `Forwarded`, `CF-Connecting-IP`, or `X-Real-IP` is treated as remote). Loopback
  alone only reads, though; acting as a person on the host needs the host window key (below).
  Pairing takes the rotating code (see [4.2](#42-pairing-code)) or a single-use invite code (eight
  characters, ten minutes) that a person or the host creates for someone outside the room.
- **Host names.** The hub answers only to loopback names, IP addresses, `.local` names, its own
  DuckDNS domain and its subdomains, and `JAMSESH_PUBLIC_URL`, so a web page can't reach it through
  DNS rebinding. Browser WebSockets must come from the hub's own origin (or the Mac app's relay).
  Remote-access setup accepts JSON bodies only.
- **Tokens** are random, stored on the host only as hashes, and kept in an HttpOnly cookie, the
  Keychain, or a mode-600 file. Tokens never go in URLs except the one-time dev-server sign-in.
- **Two credentials per Mac.** The Mac app holds the person's credential for its window and a
  separate agents' credential (issued from the window, kind `agent`) for everything else that
  talks to its relay. On the host, the app's relay uses an agents' credential too, so agents on the
  host Mac aren't treated as the host. Disconnecting a window disconnects the agents' credential
  issued from it.
- **The window key.** Headers prove nothing about who is asking (any process can send `Origin`
  or `Sec-Fetch-*`), so the app's own windows are told apart by a random key made at each launch.
  A window gets it by opening a one-time link (`/__jamsesh/window?once=…` on a joined Mac's relay,
  `/host-window?once=…` on the hub) whose response sets it as an HttpOnly, `SameSite=Strict`
  `jam_window` cookie on `127.0.0.1`: no page script can read it, no other site can send it, and it
  never appears in a URL, a file, an argument or the environment. The relay gives the person's
  credential only to requests that carry the key and the agents' credential to the rest; the hub
  accepts loopback as a person (speaking, recording, approving, settings, the pairing code,
  people, remote access, disconnecting devices) only with the key. The app starts the hub with its
  key and each window's link id over the hub's stdin. A hub started from a terminal makes its own
  key and prints one host link (good once, for ten minutes); `jamsesh host` opens it as the big
  screen, and run again while that hub is running it opens a fresh one, minted with a secret in a
  mode-600 file of the hub's (`host-link.secret`, sent by curl from the file, never as an
  argument). The app never adopts a hub it didn't start: it says so and asks you to quit that one.
  The app's own native calls (the agents' credential, the code in the menu bar) send the key too.
  A browser on the host without the key sees the session but can't act as a person. Cookies ignore ports, so dev servers open in tiles as
  `localhost:<port>`, a different host name, and never receive the key; the relay and the hub also
  strip it from anything they forward. Approving from another machine needs a paired window that
  belongs to a person.
- **Revocation.** The host disconnects any device in **Settings > Connected devices**. Its token
  stops working at once and its open live-session connections close.
- **Host-only.** The gateway key, models, host control, the brain's on/off switch, remote access,
  and the pairing code can only be read or changed on the host. Keys never leave the host.
- **People versus agents.** Only people approve host builds and speak as people: agent credentials
  can't call the approval endpoint or `/api/say`, and a window can only speak as its own person.
  The brain never runs a shell command or starts a host build on its own word: each one is filed
  as a request, announced, and runs only after a person approves that request by button or by
  an "approve" said after the announcement; agents' messages never approve anything.
  An agent's owner is its credential's person: the Mac app's agents' credential belongs to the
  window's person, and `jam_join` ignores an `owner` that names someone else. A rejoin takes over
  an earlier record only from the same Mac (the same owner window) or once the record has been
  quiet long enough to show offline (20 minutes).
- **What is and isn't protected on one Mac.** Protected: agents on other machines; a page in a
  browser; a local process that just calls the hub or the relay on loopback (it acts as the
  agents, never as a person); dev content shown in a tile. Not protected: an agent running under
  your account on your Mac that sets out to get around this. It can read the app's memory or its
  webview's cookie store, drive the app's windows, or run the command it wanted approved itself.
  The window key keeps such an agent from approving or speaking for you by accident or because
  text it read told it to, not from deliberately breaking in to your own account.
- **Network.** From outside the network, the host is reachable only over HTTPS. The canvas server
  listens on the host only and the hub relays it to paired devices.
- **Host control** is available only to the host brain, never to client agents' tools.
  `open_app`, `open_url`, `arrange`, `windows`, and `simulator` run when the brain decides to;
  `shell` and preview builds need a person's request (see [13.3](#133-preview-builds)).
- **Secrets.** The DuckDNS token and certificate keys are stored with mode 600 and scrubbed from
  errors. The gateway key is stored on the host only.

## 15. Local inference

JamSesh uses the computers in the room [B28]:

- **Host:** speech-to-text (whisper.cpp) and speaker embeddings (sherpa-onnx) run locally [B28a].
  The speaker model ships with the app; the speech model comes from `brew install whisper-cpp`
  or `install.sh`, and without one speech goes through the gateway.
- **Clients:** a JamSesh for Mac client with spare capacity runs whisper.cpp and offers itself to
  the host as a transcription worker (`POST /api/workers`) [B28b].
- **Brain:** the brain's language models run on the gateway, where the best model for each job is
  available [B49]. Without a gateway, the brain runs on rules (see [8.13](#813-when-the-gateway-isnt-available)).

## 16. Testing

- **Room audio** [A1, A2] (`hub/test/audio.bench.test.ts`): real recorded human voices
  (LibriSpeech), rendered per device with different gain, noise beds, muffling, reverb, mic EQ,
  clipping, trimmed edges, clock skew, and missed copies, through the real whisper.cpp and
  speaker model. Scenarios: baseline identification, walking away from one's laptop, manual
  labels, crosstalk, lag (0 to 4.5 seconds, jitter, a consistently late device), quality (best copy
  versus worst, bad recordings, and noise-only segments). The audio suite also runs on real poor
  recordings (phone, laptop, and Bluetooth mics in a real room), and walk-away identification is
  expected to be correct for enrolled speakers [A1a, A1c].
- **Hybrid audio** (`hybrid.audio.test.ts`): echo through the room, simultaneous room and remote
  speakers, two remote people.
- **Brain** (`brain.scenarios.test.ts`, live on the gateway): routing, decisions, affinity,
  curation, speech, join requests, displays. Offline tests cover rules, speech policy, directives,
  build approvals, and canvas placement.
- **Networking and auth** (`net.test.ts`, `auth.test.ts`): DuckDNS, DNS-over-HTTPS, renewal,
  NAT-PMP, UPnP, carrier-grade NAT, reachability, pairing codes, lockouts, revocation, token
  storage.
- **Client resilience** (`web/test/offline.test.ts`): the outbox and reconnects.
- [`STATUS.md`](STATUS.md) records what has been exercised live, simulated, or not tested [A1d,
  B26].

## 17. Decision records

### 17.1 Git access for the host (A23)

**Question.** Should the host have a git OAuth connection, so the brain can pull every repository
in a session into its own environment, per project or session?

**Recommendation: not for version one.** The host doesn't hold repositories; agents do. The
current design covers what git access would buy:

- **Knowing the code.** Each agent posts a **repo card** (stack, design system, components, recent
  changes) and answers questions about its repository through `jam_ask`. The agent on that
  repository knows it better than a fresh clone the brain skims, and it's already authorized by its
  owner.
- **Showing builds on the host.** An agent pushes its branch and calls `jam_host_preview`. The host
  clones that one pushed branch, with the host's own git credentials, only after a person approves
  (see [8.11](#811-build-approvals)).

Why not OAuth now:

- **Blast radius.** GitHub OAuth app scopes are coarse: `repo` is read and write on every private
  repository the person can reach. The host runs an LLM that takes instructions from room speech
  and can run shell commands. Putting an org-wide token next to that is the wrong trade for a
  session tool.
- **It moves the work to the wrong place.** The brain would build and reason about code it doesn't
  own, duplicating the agents and their context.
- **Setup cost.** Every host would need an OAuth app or GitHub App registration, consent flows,
  and token storage, against the "no setup" goal.

**Revisit when** the room wants previews of a repository with no agent present, or the brain needs
code-level answers no agent can give. Then use a **GitHub App** with read-only Contents permission
on selected repositories, short-lived installation tokens per session, clones into a per-session
sandbox outside the brain's shell, and the same person-approval gate for builds.

### 17.2 Why the hub stays TypeScript inside a Rust Tauri app

**Decision.** The Mac app shell is Rust (Tauri). The hub stays TypeScript on Bun, compiled to one
binary and run as the app's child process. This is a deliberate exception, scoped to `jamsesh/`,
to the FigCraft rule of Rust only.

Why:

- **The libraries.** The hub's core is the AI SDK (gateway models, structured output, tool loops,
  text-to-speech, transcription) and the MCP SDK (streamable HTTP server). Both are most mature in
  TypeScript. Rewriting them in Rust would cost weeks and trail upstream.
- **One binary, fast start.** `bun build --compile` produces one program; SQLite is built in. The
  hub starts in about 1.5 seconds and needs nothing installed on the host.
- **It runs anywhere.** The same hub runs from a checkout (`jamsesh host`) for development and
  could host from Linux, where the Mac shell doesn't exist.
- **Native work stays native.** Tauri owns what the browser can't do: windows on the right
  display, the menu bar, the local relay that makes the mic work over plain `http`, the Keychain,
  Bonjour browsing, and the macOS permission prompts. The system web view keeps the app small, and
  hub children inherit the app's permission grants.
- **The interface is shared.** The React client runs in the Mac app, in browsers, and on phones,
  so one TypeScript interface talks to one TypeScript hub with shared types.

Costs accepted: two languages, a process boundary (lifecycle, logs at
`<app data>/logs/hub.log`), and a larger download than a pure-Rust app.

Rejected: rewriting the hub in Rust (slower to change, weaker AI and MCP libraries); a Node
sidecar (no single binary, slower start); running the hub inside the web view (no raw sockets,
child processes, or audio models).

## 18. Requirements coverage

Status: **Implemented** means the code does what this spec says (tested or not; see
[`STATUS.md`](STATUS.md)). **Partial** means some of it is missing or the code disagrees with this
spec. **Missing** means it isn't built. Every Partial and Missing row, and every contradiction, is
in [`docs/spec-gaps.md`](docs/spec-gaps.md). Paths are under `jamsesh/` unless they start with
`crates/` or `apps/` (FigCraft).

### Original brief

| ID | Requirement | Spec section | Implemented in | Status |
|---|---|---|---|---|
| B1 | A fork of FigCraft; the engine, collaboration, and MCP stay the same under the hood | 12.1, 2 | `crates/ui-egui/src/canvas_only.rs`, `hub/src/canvas/canvas.ts` | Implemented |
| B2 | Canvas-only interface: no side bars or manual editing panels; artboards and connections kept | 12.1 | `crates/ui-egui/src/canvas_only.rs`, `crates/ui-egui/src/app.rs`, `web/src/shared/ui.tsx` | Implemented |
| B3 | Agents build on the canvas | 6.2, 12.2 | `hub/src/mcp.ts`, `hub/src/canvas/canvas.ts` | Implemented |
| B4 | People and their agents share one file; agents join as their own headless users | 6, 12.2 | `hub/src/canvas/canvas.ts`, `hub/src/session.ts` | Implemented |
| B5 | Server on the host; everyone connects over the LAN or the internet | 3, 4.1, 4.6 | `hub/src/http.ts`, `hub/src/index.ts`, `hub/src/net/` | Implemented |
| B6 | The big screen shows everyone's work as it comes in | 10, 12.2 | `web/src/host/Stage.tsx`, `hub/src/canvas/canvas.ts` | Implemented |
| B7 | Agents put context into a store every agent can read | 7 | `hub/src/store.ts`, `hub/src/mcp.ts` | Implemented |
| B8 | Connecting agents receive a skill for working in the session and staying in contact | 6.1, 6.7 | `skill/SKILL.md`, `hub/src/mcp.ts`, `hub/src/install-scripts.ts` | Implemented |
| B9 | A room mic on the host; the room's talk is transcribed into shared context | 9 | `web/src/host/HostView.tsx`, `hub/src/audio/pipeline.ts`, `hub/src/hub.ts` | Implemented |
| B10 | Distinct host view and client views | 3, 10, 11 | `web/src/main.tsx`, `web/src/host/`, `web/src/client/` | Implemented |
| B11 | The host view pilots itself; clients browse the canvas freely | 3, 10, 11.1 | `web/src/host/HostView.tsx`, `web/src/client/ClientView.tsx` | Implemented |
| B12 | New work arrives as a bento grid or slides for quick review | 8.10, 10.2 | `web/src/host/Stage.tsx`, `hub/src/brain/brain.ts` | Implemented |
| B13 | "Bring up that" brings things up on the big screen | 8.10, 10.2 | `hub/src/brain/brain.ts`, `web/src/host/Stage.tsx` | Implemented |
| B14 | A spoken decision ("I like direction A") starts the owning agent building it for real | 8.6, 6.3 | `hub/src/brain/brain.ts`, `hub/src/hub.ts`, `hub/src/mcp.ts` | Implemented |
| B15 | Agents report what they're handling in today's session | 6.1, 6.7 | `hub/src/mcp.ts`, `skill/SKILL.md`, `hub/src/session.ts` | Implemented |
| B16 | Spoken directives and prompts typed to agents reach the right agent from the host | 6.3, 6.4, 8.4 | `hub/src/brain/brain.ts`, `hub/src/hub.ts`, `hub/src/install-scripts.ts` | Partial |
| B17 | People can steer an agent that misread something | 6.3 | `hub/src/http.ts`, `hub/src/brain/brain.ts` | Implemented |
| B18 | Dev servers are hosted on the host for the session; mockup versus built is clear | 6.6 | `hub/src/devproxy.ts`, `hub/src/mcp.ts`, `web/src/shared/ui.tsx` | Implemented |
| B19 | A slash command in Claude Code or Codex connects to the server | 4.5 | `hub/src/install-scripts.ts` | Implemented |
| B20 | No duplicated work: agents see each other and keep in contact | 6.2, 6.5, 8.4 | `hub/src/session.ts`, `hub/src/brain/affinity.ts`, `hub/src/brain/brain.ts` | Implemented |
| B21 | Work in one repository (desktop) is reasoned through and sent to the agent on another (mobile) | 6.5, 8.4 | `hub/src/brain/brain.ts`, `skill/SKILL.md` | Partial |
| B22 | Agents talk to each other and agree | 6.5 | `hub/src/mcp.ts`, `hub/src/session.ts`, `hub/src/brain/brain.ts` | Implemented |
| B23 | Desktop and mobile side by side, inconsistencies found and fixed, presented as implemented | 6.5, 10.2 | `hub/src/mcp.ts`, `web/src/host/Stage.tsx`, `skill/SKILL.md` | Partial |
| B24 | Prompts people type to their agents go into context | 6.4, 7.1 | `hub/src/hub.ts`, `hub/src/install-scripts.ts` | Partial |
| B25 | A gateway model parses directives and sends them to the agents handling that work | 8.3, 8.4 | `hub/src/brain/brain.ts` | Implemented |
| B26 | Tested thoroughly and fully working | 16 | `hub/test/`, `web/test/`, `STATUS.md` | Partial |
| B27 | Context is stored so an agent starting a new leg of work can refresh itself | 7.3, 7.4, 6.3 | `hub/src/brain/brain.ts`, `hub/src/mcp.ts`, `hub/src/hub.ts` | Implemented |
| B28a | Local inference on the host | 9.3, 15 | `hub/src/audio/transcribe.ts`, `hub/src/audio/voiceprint.ts`, `app/bundle-hub.sh` | Partial |
| B28b | Local inference on client machines | 9.3, 15 | `hub/src/http.ts` (`/api/workers` only) | Missing |
| B29 | Installs on the Mac mini; everyone connects and it works | 3.2, 4 | `app/src-tauri/src/`, `app/bundle-hub.sh` | Implemented |
| B30 | Agents check canvas mockups against the real design system, one to one | 6.7 | `skill/SKILL.md` | Implemented |
| B31 | Agents check built code visually against their canvas mockups, one to one | 6.7 | `skill/SKILL.md`, `hub/src/mcp.ts` | Implemented |
| B32 | Audio captured on every machine and consolidated into one | 9.1, 9.2 | `web/src/shared/mic.ts`, `hub/src/audio/pipeline.ts` | Implemented |
| B33 | The clearest copy wins; copies are synced on the host | 9.1, 9.2 | `hub/src/audio/pipeline.ts`, `web/src/shared/hub.ts` | Implemented |
| B34 | Speakers identified by which device hears them loudest | 9.4 | `hub/src/audio/pipeline.ts` | Implemented |
| B35 | People can say who said a line | 9.4 | `web/src/shared/ui.tsx`, `hub/src/http.ts`, `hub/src/brain/brain.ts` | Implemented |
| B36 | People have roles | 8.7, 11.7 | `hub/src/session.ts`, `web/src/client/Profile.tsx` | Implemented |
| B37 | Feedback is weighted by role (the CPO's call wins) | 8.7 | `hub/src/session.ts`, `hub/src/brain/brain.ts` | Partial |
| B38 | Assigning a line teaches the voiceprint; vocal tone is remembered | 9.4 | `hub/src/audio/pipeline.ts`, `hub/src/audio/voiceprint.ts`, `hub/src/hub.ts` | Implemented |
| B39 | It remembers who all the players are | 7.1, 9.4 | `hub/src/store.ts`, `hub/src/config.ts` | Implemented |
| B40 | The host presents flexibly in its own app | 8.10, 10 | `web/src/host/Stage.tsx`, `hub/src/brain/brain.ts` | Implemented |
| B41 | The host brain has the host's shell | 13.1 | `hub/src/hostctl.ts`, `hub/src/brain/brain.ts` | Implemented |
| B42 | It opens and places apps (an Electron app beside an Expo app) and installs what it needs | 13.1 | `hub/src/hostctl.ts` | Partial |
| B43 | It builds custom views in the app (a four-way split of the agents) | 8.10, 10.2 | `hub/src/brain/brain.ts`, `web/src/host/Stage.tsx` | Implemented |
| B44 | The brain pilots the host computer itself | 13 | `hub/src/hostctl.ts` | Partial |
| B45a | Shows an iPhone app in the iOS Simulator | 13.1, 13.3 | `hub/src/hostctl.ts` | Implemented |
| B45b | Pilots the iOS Simulator | 13.2 | (none) | Missing |
| B46 | Text-to-speech back to the room | 8.8 | `hub/src/brain/speech.ts`, `web/src/host/HostView.tsx` | Implemented |
| B47 | Intent: try it as canvas variants versus implement it in the repository | 8.4, 6.7 | `hub/src/brain/brain.ts`, `hub/src/mcp.ts`, `skill/SKILL.md` | Implemented |
| B48 | One Vercel AI Gateway key in settings runs everything | 8.1 | `hub/src/session.ts`, `hub/src/brain/llm.ts`, `web/src/shared/Settings.tsx` | Implemented |
| B49 | The best model for each job, across providers | 8.1 | `hub/src/session.ts` | Implemented |
| B50 | People are in the canvas, and each person's agents are headless workers too | 6, 12.2 | `hub/src/canvas/canvas.ts`, `hub/src/session.ts` | Implemented |

### Additions

| ID | Requirement | Spec section | Implemented in | Status |
|---|---|---|---|---|
| A1a | Tests use real voice clips and poor-quality recordings | 16 | `hub/test/audio-fetch.py`, `hub/test/audio.sim.ts` | Partial |
| A1b | Tests simulate several sources at different loudness and clarity | 16 | `hub/test/audio.sim.ts`, `hub/test/audio.bench.test.ts` | Implemented |
| A1c | A person walks away from their computer and is still identified correctly | 9.4, 16 | `hub/test/audio.bench.test.ts`, `hub/src/audio/pipeline.ts` | Partial |
| A1d | Everything is tested thoroughly | 16 | `hub/test/`, `STATUS.md` | Partial |
| A2 | Late voices from lagging connections sync properly | 9.2 | `hub/src/audio/pipeline.ts`, `hub/test/audio.bench.test.ts` | Implemented |
| A3 | Similar work goes to the agent already handling it in that repository | 8.4, 8.5 | `hub/src/brain/affinity.ts`, `hub/src/brain/brain.ts` | Implemented |
| A4a | Tiles show the canvas following a person or agent | 10.3 | `web/src/host/Stage.tsx`, `web/src/shared/ui.tsx` | Implemented |
| A4b | Tiles show a browser on reference designs or the host's dev servers | 10.3 | `web/src/host/Stage.tsx`, `hub/src/brain/brain.ts` | Partial |
| A4c | Tiles show client screen casts, with permission on the client | 10.3, 11.6 | `web/src/shared/rtc.ts`, `web/src/shared/share.tsx` | Partial |
| A5a | The brain can ask for a screen share | 11.6 | `hub/src/brain/brain.ts`, `hub/src/session.ts`, `web/src/shared/share.tsx` | Implemented |
| A5b | Someone pushes a share and the brain finds a place for it | 8.10, 11.6 | `hub/src/brain/brain.ts`, `web/src/shared/share.tsx` | Implemented |
| A6 | The brain has full tool control of arrangement and layouts | 8.10, 10.3 | `hub/src/brain/brain.ts`, `web/src/host/Stage.tsx` | Implemented |
| A7a | Premium pins on the canvas | 11.5 | `web/src/shared/annotate.tsx`, `hub/src/canvas/canvas.ts` | Implemented |
| A7b | Pins on the host-hosted dev server view | 11.5 | `web/src/shared/annotate.tsx`, `web/src/host/Stage.tsx` | Partial |
| A7c | Annotations are app-wide | 10.3, 11.5 | `web/src/shared/annotate.tsx`, `web/src/host/Stage.tsx` | Partial |
| A7d | All pins go to the brain as one prompt to divide up | 11.5 | `web/src/shared/annotate.tsx`, `hub/src/hub.ts` | Implemented |
| A8a | Type a prompt to the brain | 11.2 | `web/src/client/ClientView.tsx`, `hub/src/http.ts` | Implemented |
| A8b | Record a prompt between Record and Stop | 11.3 | `web/src/shared/annotate.tsx`, `hub/src/hub.ts` | Implemented |
| A8c | The mic is always recording unless muted | 9.1 | `web/src/client/ClientView.tsx`, `web/src/host/HostView.tsx` | Partial |
| A8d | Saying "hey JamSesh" addresses the brain | 8.2 | `hub/src/brain/brain.ts` | Partial |
| A9 | Recording watches the pointer and turns it into context | 11.3 | `web/src/shared/pointer.ts`, `hub/src/hub.ts` | Partial |
| A10 | The brain can be renamed and listens for its name | 8.2 | `hub/src/brain/brain.ts`, `web/src/shared/Settings.tsx` | Implemented |
| A11 | The brain adapts to feedback about its demeanor | 8.9 | `hub/src/brain/brain.ts`, `hub/src/brain/speech.ts` | Implemented |
| A12 | People can mute at any time | 9.1, 11.4 | `web/src/shared/mic.ts`, `web/src/client/ClientView.tsx` | Implemented |
| A13 | Agents set their person's name and their own name | 6.1 | `hub/src/mcp.ts` | Partial |
| A14 | A camera photo (or stream) as the profile picture | 11.7 | `web/src/shared/share.tsx`, `web/src/client/Profile.tsx` | Implemented |
| A15 | Title in the profile, used by the brain | 8.7, 11.7 | `web/src/client/Profile.tsx`, `hub/src/session.ts` | Partial |
| A16a | The brain sorts every piece of incoming data | 8.3, 8.13 | `hub/src/brain/brain.ts` | Partial |
| A16b | It stores what should be context | 7.1, 8.3 | `hub/src/store.ts`, `hub/src/brain/brain.ts` | Implemented |
| A16c | It takes what should be a prompt | 8.2, 11.2 | `hub/src/hub.ts`, `hub/src/http.ts` | Implemented |
| A16d | It curates context persistently | 7.3 | `hub/src/brain/brain.ts` | Implemented |
| A16e | It divides out tasks | 8.4 | `hub/src/brain/brain.ts` | Implemented |
| A17a | Good autosave of canvas, context, and layouts | 8.12 | `hub/src/autosave.ts`, `hub/src/index.ts` | Partial |
| A17b | The brain can save the work on request | 8.10, 8.12 | `hub/src/brain/brain.ts` | Implemented |
| A18a | Works with everyone in one room | 9.5 | `hub/src/audio/pipeline.ts` | Implemented |
| A18b | Works with everyone remote | 4.6, 9.5 | `hub/src/net/`, `web/src/client/ClientView.tsx` | Partial |
| A18c | Works with a mix of in-room and remote people | 9.5 | `hub/src/audio/pipeline.ts`, `hub/test/hybrid.audio.test.ts` | Implemented |
| A19a | People move between canvas pages | 12.3 | `web/src/shared/ui.tsx` | Implemented |
| A19b | Good logic for when to make a new page | 12.3 | `hub/src/session.ts`, `hub/src/canvas/canvas.ts` | Partial |
| A20 | When the brain talks out loud: responsive, not chatty | 8.8 | `hub/src/brain/speech.ts`, `hub/test/speech.test.ts` | Implemented |
| A21 | Visual polish: no wrapping buttons, nothing cut off, icons where needed | 11.1 | `web/src/styles.css` | Partial |
| A22a | It's clear how a machine becomes the host or a client | 3.1, 4.1 | `app/ui/index.html`, `app/src-tauri/src/main.rs` | Implemented |
| A22b | No default public server | 4.1 | `hub/src/net/`, `hub/src/canvas/canvas.ts` | Implemented |
| A22c | Easy, secure DuckDNS remote access | 4.6 | `hub/src/net/`, `web/src/setup/SetupView.tsx` | Partial |
| A23 | An honest opinion on git OAuth for the host | 17.1 | `SPEC.md` | Implemented |
| A24a | The host stays awake while people are connected | 4.7 | `hub/src/awake.ts` | Implemented |
| A24b | An existing keep-awake is never undone | 4.7 | `hub/src/awake.ts` | Implemented |
| A25a | No scripts for people to run | 4.5 | `app/src-tauri/src/main.rs`, `hub/src/install-scripts.ts` | Partial |
| A25b | A QR code that sets up and connects Claude Code or Codex | 4.3 | `web/src/host/JoinCard.tsx`, `hub/src/http.ts` | Partial |
| A25c | The address and a large 4-character code under the QR, usable by agents and apps | 4.3 | `web/src/host/JoinCard.tsx`, `web/src/host/Stage.tsx` | Implemented |
| A25d | The code changes about every 30 seconds | 4.2 | `hub/src/auth.ts` | Implemented |
| A26a | No unconnected local mode | 3.1 | `app/src-tauri/src/main.rs` | Implemented |
| A26b | Graceful connection recovery | 5.1 | `web/src/shared/hub.ts`, `web/src/shared/ConnectionBanner.tsx` | Implemented |
| A26c | Local saved state while disconnected | 5.2 | `web/src/shared/offline.ts`, `web/src/shared/mic.ts` | Implemented |
| A26d | Smart merge on reconnect | 5.2 | `web/src/shared/offline.ts`, `hub/src/http.ts` | Partial |
| A26e | Local memory of identity for each session | 5.3 | `web/src/shared/identity.ts` | Implemented |
| A27a | Agents communicate through the server | 6.5 | `hub/src/mcp.ts`, `hub/src/session.ts` | Implemented |
| A27b | Agents ask each other questions | 6.5 | `hub/src/mcp.ts`, `hub/src/session.ts` | Implemented |
| A27c | The brain tells agents to work together and compare | 6.5, 8.4 | `hub/src/brain/brain.ts` | Implemented |
| A28a | The client is a real Mac app | 3.3 | `app/src-tauri/src/` | Implemented |
| A28b | The browser stays an option | 3.4 | `web/src/main.tsx` | Implemented |
| A28c | A great phone browser version | 3.4, 11.9 | `web/src/client/mobile.tsx`, `web/src/client/ClientView.tsx` | Implemented |
| A29a | The host compiles a preview desktop app | 13.3 | `hub/src/hostctl.ts` | Implemented |
| A29b | The host uses the iPhone Simulator | 13.1, 13.3 | `hub/src/hostctl.ts` | Implemented |
| A29c | It arranges windows outside the app | 13.1 | `hub/src/hostctl.ts` | Implemented |
| A29d | Granting macOS permissions is friendly | 13.5 | `app/ui/setup.html`, `app/src-tauri/src/perms.rs`, `app/src-tauri/Info.plist` | Partial |
| A30 | "Connect to jamsesh" works when the app is open on the same computer | 4.5 | `app/src-tauri/src/main.rs`, `app/src-tauri/src/proxy.rs`, `hub/src/install-scripts.ts`, `skill/SKILL.md` | Implemented |
| A31 | The brain puts up the QR code, code, and phone steps on request | 8.10, 10.2 | `hub/src/brain/brain.ts`, `web/src/host/Stage.tsx` | Implemented |
| A32 | The brain knows each display's resolution and aspect ratio and plans for it | 8.10, 13.4 | `hub/src/hostctl.ts`, `web/src/host/HostView.tsx` | Implemented |
| A33a | Host builds that agents ask for are approved by a person | 8.11, 14 | `hub/src/hostctl.ts`, `hub/src/http.ts`, `hub/src/brain/brain.ts` | Partial |
| A33b | Approval is fully controllable by voice | 8.11 | `hub/src/brain/brain.ts`, `hub/src/hub.ts`, `web/src/shared/BuildRequests.tsx` | Implemented |

### Totals

| | Brief | Additions | All |
|---|---|---|---|
| Implemented | 41 | 48 | 89 |
| Partial | 9 | 23 | 32 |
| Missing | 2 | 0 | 2 |
| **Requirements** | **52** | **71** | **123** |
