# JamSesh

JamSesh is a room session for people and their coding agents. One Mac runs the host: the shared
canvas, the session's context, and a big-screen view that pilots itself. Everyone's Claude Code
or Codex joins as a named participant. What the room says becomes context, and the room brain
routes real requests to the agent that owns the work.

JamSesh is a fork of [FigCraft](https://github.com/storytold/figcraft). The FigCraft engine,
collaboration server, and MCP tools run unchanged under the hood; JamSesh adds a canvas-only mode,
the hub, the host and client views, and the agent protocol. The design is in [`SPEC.md`](SPEC.md).

## Set up the host

JamSesh is one Mac app that either hosts a session or joins one. The Mac that drives the big
screen (usually a Mac mini) hosts; everyone else joins.

1. Download
   [JamSesh.dmg](https://github.com/fluid-commerce/jamsesh/releases/latest/download/JamSesh.dmg)
   (Macs with Apple Silicon), open it, and drag JamSesh to Applications. Every change to `main`
   rebuilds it, so the same link always has the newest version; to update, quit JamSesh and
   replace it. The app isn't notarized yet, so the first time macOS refuses to open it: open
   **System Settings > Privacy & Security**, click **Open Anyway** next to JamSesh, and confirm.
2. Choose **Host a session on this Mac**. The big screen opens full screen on the display that
   isn't the Mac's main one (when there is one), your own window opens beside it, and JamSesh stays
   in the menu bar while it hosts.
3. In **Set up this Mac**, click **Allow** for each permission. The room brain needs them to run
   the Mac for the room:
   - **Microphone:** the room mic.
   - **Accessibility** and **Automation:** arranging app windows on the displays.
   - **Screen Recording:** sharing this screen. JamSesh reopens once to turn it on.
   - Optional: **Camera** for photos, and **Xcode** for building previews and the iPhone Simulator.

   Open the same list later from the menu bar: **Set up this Mac…**
4. Choose **Connect my agents** when JamSesh offers it, so Claude Code and Codex on this Mac can
   join too.
5. In your JamSesh window, open **Settings** (the gear, or press `,`) and paste your Vercel AI
   Gateway key. Add the people in the room with their titles; titles decide whose call wins when
   instructions conflict.

The app carries everything the host needs, so the host Mac doesn't need this repository. Speech
is transcribed through the gateway, or on the Mac when whisper.cpp is installed
(`brew install whisper-cpp`). The Mac stays awake while people or agents are connected, and
JamSesh never turns off a keep-awake you set yourself.

There's no JamSesh server on the internet: everyone connects to the host. To develop JamSesh, run
the host from a checkout with `./jamsesh/install.sh` and `jamsesh host`, and rebuild the app with
`jamsesh/app/bundle-hub.sh` then `cargo tauri build` in `jamsesh/app/src-tauri`. On a Mac you
rebuild often, sign each build with `jamsesh/app/sign-local.sh <path to JamSesh.app>` before
installing it: a build signed the default (ad-hoc) way is a new app to macOS, so it loses the
microphone, screen recording and accessibility permissions until someone at the Mac allows them
again. The first run sets up the signing identity and prints one command to trust it, which asks
for your password once.

## Join a session

- **On a Mac:** open JamSesh and choose the session under **Join a session**; JamSesh finds hosts on
  the same network. Type the 4-character code from the big screen once. After that the Mac
  reconnects on its own. Get the app from the link on the host's connect page, or from whoever
  hosts.
- **On a phone:** point the camera at the QR code on the big screen and tap the link. Phones get a
  layout for touch: a mic for the room, the big screen mirrored, pins, prompts, and your profile.
  Phones can only use their microphone over HTTPS, so set up remote access (below) if phones should
  listen.
- **In any browser:** open the address on the big screen and type the code.

If someone asks "how do I join?", "what's the code?", or "how do I get on with my phone?", the
room brain puts a full-screen join guide on the big screen: the QR code, the address, the code,
and steps for phones, laptops, and agents.

## Bring your agents

On a Mac with the JamSesh app, after **Connect my agents** (once per Mac), tell Claude Code or
Codex in any repository:

```text
connect to jamsesh
```

The agent joins as yours, works out its repository and branch, posts a card describing the
repository, claims its workstream, and shows up on the big screen. There's no address or code to
pass: agents reach the session through the app on the same Mac (`http://127.0.0.1:4790`), which
forwards to whichever host the Mac is connected to. If the app isn't open, the agent asks you to
open it.

Without the app, type the line under the QR code into the agent instead, for example
`join jamsesh at jam.example.duckdns.org, code K7M2`. The agent pairs and sets itself up.

Every paired Mac, browser, and agent is listed in **Settings > Connected devices**, where the host
can disconnect any of them.

## If the connection drops

- Your window shows **Reconnecting** and keeps working. Changes you make and lines your mic hears
  are saved on your laptop and sent, in order, when the host is back. Each carries a key so the host applies a resend once, and a change made for one host is kept until that host is back instead of landing on another.
- Your name, profile, and settings are remembered for each host you've connected to.
- If the host disconnects your device, your window asks you to connect again with a fresh code.

## Join remotely, or mix the two

JamSesh works with everyone in the room, everyone remote, or a group in the room with others
joining from elsewhere.

1. On the host, open **Settings > Remote access** and follow the steps. They do the following:
   - Give the host a free [DuckDNS](https://www.duckdns.org) name, such as `jam.duckdns.org`, kept
     pointed at your network.
   - Get an HTTPS certificate from Let's Encrypt for that name, renewed automatically.
   - Open one port on your router (automatically when the router allows it, or with instructions).
   - Check that the address works from outside your network.
2. Remote people connect the same way as people in the room, with the QR code or the address and
   the code. They pick **Remote** when their window asks where they are (JamSesh guesses from
   their address).
3. Keep your usual call (Meet, Zoom) running for voices. JamSesh doesn't carry audio between
   people; it listens to each laptop.

Microphones in browsers need HTTPS, so set up remote access even if everyone is in the room. Over
plain `http`, laptop windows still work but can't listen.

If your internet provider doesn't give you a public address (the setup detects this), use
[Tailscale Funnel](https://tailscale.com/kb/1223/funnel) on the host instead: run
`tailscale funnel --bg 4747` and start the host with `JAMSESH_PUBLIC_URL=<funnel address>`. Only
the host needs Tailscale.

What changes for remote people:

- Their laptop's mic is treated as its own room, so their lines are never merged with the room's.
  When the room's speakers play a remote voice into the room mics (or a remote laptop hears the
  room through the call), JamSesh keeps the clearest copy and drops the echo.
- The **Screen** tab in their window mirrors the big screen live.
- The brain's voice and chime play on their laptop.
- Links to the canvas and to dev servers use the address they connected through.

Headphones on remote laptops keep the transcript cleanest.

## How a session flows

1. People talk. Every laptop's mic and the room mic send speech to the host, which keeps the
   clearest copy of each line and works out who said it.
2. The brain sorts each line: banter, discussion, or work. Work becomes a **directive** for the
   right agent: **Explore** (variants on the canvas) or **Build** (real code in the repository).
3. Agents design on the shared canvas. Frames land on the big screen as they settle, badged
   **Mockup**. Variant sets named `Workstream / A: …`, `/ B: …` appear side by side.
4. Someone says "I like B". The brain records the decision, sends B to the owning agent as a build,
   and spotlights it.
5. The agent builds it, puts its dev server on the host (**Live build**), and checks the build
   against the mockup before it reports **shipped**.
6. If the change belongs on another platform too, the brain asks both agents to coordinate, and
   they present desktop beside mobile.

Agents also talk to each other through the host. An agent asks another agent a question (how its
repository does something, which tokens it uses) and waits for the answer. Each agent posts a card
describing its repository, so the others know what it has. The brain pairs agents up to compare
their work, and sends similar work to the agent already doing it.

## Save and pick up again

Everything saves as it happens: the canvas, the room's context, and the screen layouts. On top of
that, JamSesh keeps a snapshot every five minutes while things change, one when the host stops,
and one whenever someone says "JamSesh, save this as …". Each snapshot holds the canvas as a
`.figcraft` file you can open in FigCraft, the session's decisions and context as JSON, and
readable session notes. **Settings > Saved** lists them with download links. The brain can also
save a screen layout by name ("save this as the review layout") and bring it back later.

`jamsesh new` starts the next day fresh; the previous session is archived, not deleted.

## Canvas pages

Each workstream gets its own canvas page, named after it, and an agent that claims a workstream
draws on that page. Variants of one idea stay side by side on their workstream's page. Use the page
menu at the top left of the canvas to switch pages, or to add one for something new.

## Talk to the brain

The brain is called JamSesh until you rename it in **Settings > Room brain**. There are three ways
to address it directly instead of just talking in the room:

- Say its name: "JamSesh, put the mobile build next to the mockup."
- In your JamSesh window, type in the **Ask JamSesh** box.
- Press **Record prompt** (or `R`), talk while pointing at things on screen, then stop. Your words
  and where you pointed (frames you hovered or clicked, while saying "this one") go to the brain as
  one prompt.

It doesn't talk back to everything. A soft chime means it heard you. It speaks only to answer a
question or to tell you it can't do something; anything it does on the big screen speaks for
itself, typed requests get typed answers, and it stops talking when someone talks over it.

The brain learns how the room wants it to behave. Tell it ("JamSesh, keep it short and only talk
when someone asks you something"), and it keeps that note for the session. The notes are listed in
Settings, where you can remove them.

## Annotate

Press **Annotate** (or `A`) and click anywhere on the canvas, a mockup, a dev server, or a shared
screen to drop a pin with a note. Pins are shared across the room. **Send to JamSesh** bundles every
open pin into one prompt, and the brain sends each group to the agent that owns that work. Pins on
the canvas also become FigCraft comments, so agents see them in the file.

## Share a screen or camera

In your JamSesh window, **Share screen** or **Camera** puts your screen or camera on the big screen,
full screen, straight away (unless someone pinned the screen). One share of each kind per person: a
new one from another of your windows replaces the first. The brain (or anyone, from Settings > People) can also ask you to
share, and your window asks you first.

## Your profile

Click your name in your JamSesh window to set your photo (from your camera), your title, and to
teach JamSesh your voice by reading one sentence. Titles decide whose call wins when people
disagree. Agents can set their own name and their person's name and title with `jam_rename`.

## Mute

Press `M` (or click the mic button) to mute or unmute your laptop at any time. On the host, `M`
mutes the room mic.

## Use the big screen

| Key | View |
| --- | --- |
| `1` | Board: the newest work as a bento grid |
| `2` | Canvas: the live canvas with everyone's cursors |
| `3` | Agents: what every agent is doing |
| `Esc` | Back to the board |
| `F` | Full screen |
| `,` | Settings |

Out loud also works: "bring up the nav options", "show me what everyone's doing", "put desktop and
mobile side by side". The brain designs its own layouts from any mix of tiles: mockups and builds,
the live canvas following a person or agent, a browser on any dev server or reference site, shared
screens and cameras, an agent's activity, and the room feed. For anything else, ask for it
("build us a four-way split…"), and the brain builds a custom view.

## Let the brain run the host Mac

With host control on (**Settings**) and the permissions from **Set up this Mac**, the room brain
can do the following on the host:

- Arrange app windows on any display. It knows each display's resolution, shape, and usable area,
  and the big screen window's own size, and plans layouts for them.
- Open apps and URLs, boot the iPhone Simulator, and open a build in it.
- Build an agent's pushed branch on the host and open it: a desktop app, or an iPhone build in the
  Simulator. Builds run in the background and the room gets a note when they open.
- Bring the big screen back to the front.

Ask out loud, for example "put the desktop build next to the Simulator on the TV".

## Teach it who's talking

Speaker recognition combines two signals: which laptop heard a line loudest (each laptop has an
owner) and a voiceprint. Voiceprints build themselves while people talk at their own laptops.
To correct a line, click the speaker's name in your JamSesh window and pick the right person, or
say it out loud ("that was Felipe"). JamSesh learns that voice from the correction.

## Pause or leave

```bash
jamsesh off
```

`jamsesh on` turns the hooks back on. `jamsesh status` shows what's connected.

## Test it

```bash
cd ~/jamsesh/jamsesh/hub
bun test test/brain.offline.test.ts
bun test test/brain.scenarios.test.ts --timeout 120000
bun test test/audio.bench.test.ts --timeout 600000
```

The brain scenarios call the gateway (about four minutes). The audio bench uses real recorded
voices and simulated devices; see the file header for its data source.

To fill a running host with a realistic demo session (three agents, variants, a dev server):

```bash
cd ~/jamsesh/jamsesh/hub && bun ../scripts/demo.ts http://127.0.0.1:4747
```

## Where things live

| Path | What |
| --- | --- |
| `~/.jamsesh/host/` | The session: SQLite context store, canvas server data, renders |
| `~/.jamsesh/host/snapshots/` | Versioned snapshots: `canvas.figcraft`, `context.json`, `notes.md` |
| `~/.jamsesh/bin/` | FigCraft binaries the host runs |
| `~/.jamsesh/.env` | Gateway key fallback (`jamsesh key` sets it) |
| `jamsesh/hub/` | The hub (Bun): API, MCP endpoint, brain, audio, canvas bridge |
| `jamsesh/web/` | Host and client views (React) |
| `jamsesh/skill/SKILL.md` | What every agent is told when it joins |
| `crates/ui-egui/src/canvas_only.rs` | FigCraft's canvas-only mode |

## Security

- Every request needs a paired device's token, except the connect page. The 4-character code only
  works for 30 seconds (plus the previous code, for someone mid-typing). Wrong codes lock out the
  address after 8 tries and pause pairing for everyone after 60 in 5 minutes.
- Tokens are long random keys, stored on the host only as hashes. Browsers keep theirs in an
  HttpOnly cookie. Disconnect a device in **Settings > Connected devices** to revoke it.
- From outside the network, the host is reachable only over HTTPS. The canvas server and dev
  servers listen on the host only; JamSesh relays them to paired devices.
- Only the host itself can change the gateway key, models, and host control, or run commands on
  the host.
