# JamSesh

JamSesh is a room session for people and their coding agents. One Mac runs the host: the shared
canvas, the session's context, and a big-screen view that pilots itself. Everyone's Claude Code
or Codex joins as a named participant. What the room says becomes context, and the room brain
routes real requests to the agent that owns the work.

JamSesh is a fork of [FigCraft](https://github.com/storytold/figcraft). The FigCraft engine,
collaboration server, and MCP tools run unchanged under the hood; JamSesh adds a canvas-only mode,
the hub, the host and client views, and the agent protocol. The design is in [`SPEC.md`](SPEC.md).

## Set up the host

On the Mac mini that drives the big screen:

1. Clone the repository and run the installer. It builds FigCraft, the browser canvas, and the web
   app, and downloads the local whisper and voiceprint models (about 600 MB).

   ```bash
   git clone https://github.com/fluid-commerce/jamsesh.git ~/jamsesh && ~/jamsesh/jamsesh/install.sh
   ```

2. Start the session. The big screen opens in a full-screen window.

   ```bash
   jamsesh host
   ```

3. Open **Settings** (the gear, or press `,`) and paste your Vercel AI Gateway key. Add the people in
   the room with their roles; roles decide whose call wins when instructions conflict.
4. Click **Room mic** to let the host's microphone listen too.

The welcome screen shows the join command and the join code.

The first time, macOS asks whether `bun` and `figcraft-server` may accept incoming network
connections. Allow both, or laptops can't connect.

## Connect a laptop

On each laptop, run the command from the host screen:

```bash
curl -fsSL http://<host-address>:4747/join.sh | bash
```

It asks your name and role, then does the following:

- Adds the `jamsesh` MCP server to Claude Code and Codex.
- Installs the JamSesh skill and a `/jamsesh` command.
- Adds two Claude Code hooks: your prompts go into the room's context, and directives from the room
  reach your agent when it finishes a turn.
- Offers this laptop's whisper (if installed) for room transcription.
- Opens your JamSesh window: the live canvas, the room's conversation, and your mic.

Then, in Claude Code or Codex, in each repository you're working in:

```text
/jamsesh mobile nav refresh
```

The agent joins, claims its workstream, and shows up on the big screen.

## Join remotely, or mix the two

JamSesh works with everyone in the room, everyone remote, or a group in the room with others
joining from elsewhere.

1. Give remote people a way to reach the host. The simplest is
   [Tailscale](https://tailscale.com) on the host and on each remote laptop: the host's welcome
   screen then shows a second join command with its Tailscale address. For an `https` address
   (no browser flags needed), run `tailscale serve --bg 4747` on the host and start it with
   `JAMSESH_PUBLIC_URL=https://<host>.<tailnet>.ts.net jamsesh host`.
2. Remote people run the remote join command and pick **Remote** when their window asks where
   they are (JamSesh guesses from their address).
3. Keep your usual call (Meet, Zoom) running for voices. JamSesh doesn't carry audio between
   people; it listens to each laptop.

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

In your JamSesh window, **Share screen** or **Camera** puts your screen or camera on the big screen;
the brain finds it a place. The brain (or anyone, from Settings > People) can also ask you to
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

The host listens on the local network. The join code gates the API and the MCP endpoint. Only the
host's own brain can run commands on the host. Keep the session on a network you trust.
