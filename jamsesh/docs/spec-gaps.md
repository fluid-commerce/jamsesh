# JamSesh spec gaps

This lists every requirement that [`SPEC.md`](../SPEC.md) marks **Partial** or **Missing**, and
every place the code disagrees with the spec or with the other docs. Each gap has its evidence (file
and line, as of October 27, 2026) and what would close it.

Gaps are ranked by how much they would hurt a first session with coworkers tomorrow: an in-room
session on the LAN, a Mac mini host running the Mac app, people on Mac laptops with Claude Code and
some Codex, and maybe a phone or two. Paths are under `jamsesh/` unless noted.

## Tier 1: fix before the session

These break the core loop (the room is heard, the brain acts sensibly, nothing is lost) or open
the host to something nobody intended.

### 1. Resolved in the release candidate

The mic now defaults to on unless the person muted it (`web/src/client/ClientView.tsx`, `web/src/host/HostView.tsx` check `!== "off"`).

### 2. Resolved in the release candidate

`addressesBrain` (`hub/src/brain/brain.ts`) matches the name only as a form of address, whole words, and prompts typed to agents are never direct addresses.

### 3. Resolved in the release candidate

A failed gateway call is caught, the brain says so (`gatewayTrouble`) and the batch is judged by the rules (`ruleTriage`, `ruleRoute`) instead of being dropped (`hub/src/brain/brain.ts`).

### 4. Resolved in the release candidate

A brain-started shell command waits for a person's approval (`requestShell`, then a decision) in `hub/src/hostctl.ts`; builds go through the same request queue as `jam_host_preview`.

### 5. Resolved in the release candidate

Deciding a build request is a person's act: the route is human-only, and the host role needs the host window's own key (loopback alone grants nothing), `hub/src/http.ts`.

### 6. Resolved in the release candidate

Dev-server proxies check the caller's token (`hub/src/devproxy.ts`), so they are not open to the whole network. Automatic expiry with the agent is not checked here.

### 7. Resolved in the release candidate

`GET /api/paired`, `DELETE /api/paired/:id` and the allow route exist in `hub/src/http.ts`; Disconnect revokes the device's token. Closing that device's open sockets at once is not checked here.

### 8. Titles set after joining don't change whose call wins [B37, A15]

- **Spec:** the weight follows the title unless set by hand; changing a title updates it (SPEC 8.7).
- **Code:** `upsertPerson` computes `weightForRole` only for a new person; an existing person keeps
  the old weight (`hub/src/session.ts:227`). Titles set later through the profile, `jam_rename`, or
  an introduction leave the weight at 1. Conflict resolution is prompt-only
  (`hub/src/brain/brain.ts:267`, `:899`).
- **Effect tomorrow:** anyone who joins with a name and adds "CPO" later is weighted like everyone
  else, while the skill tells agents titles decide.
- **Close it:** recompute the weight when the role changes and the weight wasn't set by hand (store
  a `weightManual` flag); add a test.

### 9. Codex agents don't capture prompts or get turn-end directives [B16, B24]

- **Spec:** Codex gets prompt-capture and turn-end hooks equivalent to Claude Code's (SPEC 4.5).
- **Code:** `joinScript` installs hooks only for Claude Code (`hub/src/install-scripts.ts:125-140`);
  Codex gets the MCP server, a prompt file, and an AGENTS.md block (`:146-182`). Codex prompts never
  reach the context store, and Codex picks up directives only through `jam_wait` and `jam_inbox`.
  STATUS lists Codex "connect to jamsesh" as simulated only.
- **Close it:** use Codex's notify and hook mechanisms where available; otherwise have the Codex
  prompt require `jam_wait` at the end of every turn and post its own prompts with `jam_update`.

### 10. Resolved in the release candidate

The app bundles whisper.cpp's server (`app/bundle-hub.sh`, `app/build-whisper.sh`), the hub downloads and verifies the model on the first host session (`hub/src/audio/whisper.ts`), and whisper runs with automatic language detection (`-l auto`). The language is not yet a setting, and the big screen does not show which engine is in use.

## Tier 2: will be noticed in the session

### 11. Automation may never prompt, so window arranging may fail [A29d, A29c]

- **Spec:** the app declares the entitlement and the purpose string for every permission,
  including Automation (SPEC 13.5).
- **Code:** work in progress (uncommitted while this was written) adds the hardened runtime with
  `app/src-tauri/Entitlements.plist` (audio input, camera, Apple Events) and wires it in
  `tauri.conf.json`. `app/src-tauri/Info.plist` still has microphone, camera, and local network
  strings but no `NSAppleEventsUsageDescription`. Under the hardened runtime, macOS refuses Apple
  Events to System Events without a prompt when the purpose string is missing, which would break
  `arrange` and `windows` (`hub/src/hostctl.ts:177-216`). STATUS: the prompts were never clicked
  through.
- **Close it:** add `NSAppleEventsUsageDescription`, rebuild, and click through **Set up this Mac**
  on the Mac mini before the session.

### 12. A recorded prompt that's never stopped mutes that device's lines [A8b]

- **Spec:** a window that's never stopped ends on its own after 2 minutes (SPEC 11.3).
- **Code:** `promptMode` is cleared only in `promptWindow` (`hub/src/hub.ts:157-166`, `:228`). If a
  device calls `/prompt-window/start` and never `/prompt-window` (tab closed, network drop, reload),
  every later line from that device is held for the brain and never triaged (`:169-176`).
- **Close it:** expire prompt mode after 2 minutes and on socket close; add a test.

### 13. Pins don't exist on most big-screen views [A7b, A7c]

- **Spec:** every tile in every view takes pins, including dev servers (SPEC 10.3, 11.5).
- **Code:** only brain-made layout tiles get a pin layer (`web/src/host/Stage.tsx:229-232`, `:245`,
  `:291-294`); Board, Spotlight, Compare, Parity, Agents, and Custom have none. The desktop Screen
  tab has none outside layout tiles. Dev-server pins exist only inside layout tiles and the phone
  mirror (`web/src/client/ClientView.tsx:429-448`).
- **Close it:** give `ArtifactTile` and the dev-server frame a pin slot in every stage mode.

### 14. Remote screen and camera shares don't connect across networks [A4c, A18b]

- **Spec:** shares work on the LAN and across the internet, through STUN and a relay on the host
  (SPEC 11.6).
- **Code:** `iceServers` is empty and `configureRtc` is never called (`web/src/shared/rtc.ts:19-22`,
  `:147`, `:264`). Only host candidates are gathered, so shares between a remote laptop and the host
  will usually fail. No doc mentions it.
- **Close it:** configure a public STUN server, and run a TURN relay on the host (port mapped with
  the HTTPS port) for symmetric NAT.

### 15. Annotation bundles and recorded prompts are handled as voice [A7d, A20]

- **Spec:** **Send to <name>** gets a typed answer, not a spoken one (SPEC 11.5).
- **Code:** `sendAnnotations` stores the bundle with `direct: true` and no `typed` flag
  (`hub/src/hub.ts:253-271`), so `speechSource` returns "voice" (`hub/src/brain/brain.ts:807-814`):
  a chime and a possible spoken reply for a button press. Separately, recorded prompts carry no
  `deviceId`, so the recording laptop doesn't get its own chime.
- **Close it:** mark bundles `typed: true`; put the recording device's id on recorded prompts.

### 16. The build announcement can be dropped to text [A33b]

- **Spec:** the build announcement is spoken, bypassing the 4-second gap (SPEC 8.11).
- **Code:** it goes through `speechDecision`, so within 4 seconds of another reply, or with voice
  replies off, it becomes a toast (`hub/src/hub.ts:332`, `hub/src/brain/speech.ts:25-39`). With
  nobody at the host, the request then expires unheard after 10 minutes.
- **Close it:** speak build announcements as their own kind that ignores the gap (still respects
  voice replies off, and repeats once after a minute).

### 17. Voice approval offline fails when the line names the brain [A33b]

- **Spec:** a short approve or deny line works whether or not it names the brain (SPEC 8.11).
- **Code:** a line containing the brain's name goes straight to `direct()`
  (`hub/src/brain/brain.ts:81-84`); the `buildVerdict` fast path runs only in `flush()`
  (`:100-105`). With a model, the router handles it; without one, "JamSesh, build it" isn't
  approved. The unit test calls `buildVerdict` directly (`hub/test/build-requests.test.ts:11`).
- **Close it:** run `buildVerdict` before the direct-address branch in `hear()`; test both paths.

### 18. The skill doesn't mention host previews or approvals [B8, A33a]

- **Spec:** the skill tells agents to push and call `jam_host_preview`, and that a person approves
  (SPEC 6.7).
- **Code:** `skill/SKILL.md` has no mention of `jam_host_preview` or approval; only the tool
  description does (`hub/src/mcp.ts:167-179`).
- **Close it:** add a "Show your build on the host" section to the skill.

### 19. Join view needs a gateway key; no key for it [A31]

- **Spec:** join phrases show the Join view with or without a model; `J` shows it (SPEC 8.13,
  10.4).
- **Code:** offline, `ruleTriage` tags join phrases as `present`, but `ruleRoute` has no join case
  and falls through to the board (`hub/src/brain/brain.ts:623-629`, `:871`). `HostView.tsx:88-103`
  has no `J` key.
- **Close it:** add a join case to `ruleRoute` and a `J` shortcut.

### 20. The Mac menu bar has no mute and no list of who's connected [A12]

- **Spec:** the host menu shows who's connected and **Mute the room mic**; the joined menu has
  **Mute** (SPEC 3.2, 3.3, 9.1).
- **Code:** `app/src-tauri/src/main.rs:295-342` builds neither item.
- **Close it:** add a mute item that toggles the window's mic over IPC, and a people submenu from
  `/api/state`.

### 21. Renaming an agent doesn't rename its cursor [A13]

- **Spec:** a new name shows everywhere, including the canvas cursor (SPEC 6.1).
- **Code:** the canvas participant's `pref.userName` is set once at spawn
  (`hub/src/canvas/canvas.ts:325`); `jam_rename` doesn't update it (`hub/src/mcp.ts:348-370`).
- **Close it:** set the participant's user name on rename.

### 22. Pointing at dev servers isn't captured while recording [A9]

- **Spec:** pointer context covers every tile, including dev servers and shared screens (SPEC 11.3).
- **Code:** `web/src/shared/pointer.ts:193-195` skips cross-origin iframes, which includes dev
  servers proxied from another origin. Pins still work there through the overlay.
- **Close it:** put a transparent capture overlay over cross-origin tiles while recording (as the
  pin layer does) and record positions from it.

### 23. Reference sites that refuse framing don't show [A4b]

- **Spec:** a `web` tile is a browser; sites that refuse framing open in a host browser window the
  brain places beside the big screen (SPEC 10.3).
- **Code:** `web` tiles are plain iframes (`web/src/host/Stage.tsx:241-249`); many reference sites
  send `X-Frame-Options` or `frame-ancestors` and render blank.
- **Close it:** detect blocked frames (load timeout or `securitypolicyviolation`) and fall back to
  `host_action open_url` plus `arrange`.

### 24. Keyword rules are weak when there's no key [A16a, B14]

- **Spec:** offline, decisions are recorded and sent to the owning agent (SPEC 8.13).
- **Code:** offline decisions only record an event; nothing is built
  (`hub/src/brain/brain.ts:631-634`, `hub/test/brain.offline.test.ts:74-80`). In `ruleTriage` the
  `present` match is overridden by the directive match, so "show me options for the nav" becomes a
  directive (`:870-873`). Platform substring matching routes "another" to `other` and "website" to
  `web`. `ruleRoute` has no duplicate check.
- **Close it:** send an implement directive for offline decisions with a matched artifact; fix the
  intent precedence and use whole-word platform matches.

### 25. "Exactly once" has a millisecond gap on a crash [A26d]

- **Spec:** the host remembers idempotency keys across restarts; queued changes merge field by
  field, and changes to deleted items are dropped and reported (SPEC 5.2).
- **Code:** keys and replies are stored in SQLite for seven days (`hub/src/store.ts`, `idempotent()` in
  `hub/src/http.ts`), so a restart replays the first answer. The reply is saved right after the change, in a separate write,
  so a hard crash between the two lets a retry repeat that one change. There's no field-by-field merge: queued calls replay as
  last writer wins. `x-jam-queued-at` is sent but never read.
- **Close it:** make each replayable change and its key one transaction (handlers are async, so this
  means restructuring them); compare `x-jam-queued-at` with the record's update time and merge fields;
  return 410 for deleted targets and surface it in the banner.

## Tier 3: matters later, or polish

### 26. No snapshot restore [A17a]

- **Spec:** **Settings > Saved** restores a snapshot (SPEC 8.12).
- **Code:** snapshots are listed and downloaded; nothing loads one back (`hub/src/autosave.ts`).
  Picking up again means opening `canvas.figcraft` by hand.
- **Close it:** a host-only restore that imports the canvas copy into the live file and reloads
  facts, layouts, and the brief.

### 27. The QR code doesn't set up agents; agents without the app run a script [A25a, A25b]

- **Spec:** the QR link, fed to an agent, sets it up and connects it without a script for the
  person to run (SPEC 4.3, 4.5).
- **Code:** the QR encodes `/connect?c=` for browsers (`web/src/host/JoinCard.tsx:53`,
  `web/src/host/Stage.tsx:386`). An agent given that link gets an HTML page. The agent line works
  only because a non-browser fetch of the root returns the intro, and the setup it leads to is a
  `curl … | bash` line the agent runs (`hub/src/install-scripts.ts:49-64`). No skill or hook parses
  "join jamsesh at X, code K". The app path ("Connect my agents") has no script.
- **Close it:** have `/connect` answer non-HTML clients with the agent guide, so the QR link works
  for agents too; keep the setup inside the agent's own tool calls.

### 28. `jamsesh join` is broken and `cli/` is empty [A25a]

- **Spec:** `jamsesh join <host>` connects this computer's agents (SPEC 3.5).
- **Code:** it runs `curl $target/join.sh | bash` (`bin/jamsesh:44-49`); there's no `/join.sh`
  route, and setup needs a token. `cli/` has no files.
- **Close it:** prompt for the code, fetch `/agent?c=`, and run the returned setup; remove `cli/`.

### 29. Parity directives carry text only; the parity view isn't automatic [B21, B23]

- **Spec:** parity directives carry the shipping agent's notes and its built and mockup artifacts;
  the parity view appears when both platforms have built artifacts (SPEC 6.5).
- **Code:** `shippedBatch` passes only the shipped update's text to the router
  (`hub/src/brain/brain.ts:665-681`); the parity view appears only if the model calls
  `show_on_screen parity`. Parity uses the router model, not the digest model the old spec named.
  Comparison is left entirely to the agents.
- **Close it:** attach the agent's recent artifacts to the note; show parity automatically when
  each coordinating agent has posted a built artifact.

### 30. The brain never creates workstreams or pages [A19b]

- **Spec:** when routed work doesn't fit an existing workstream, the brain names a new one, and
  with it a page (SPEC 12.3).
- **Code:** pages come only from agent claims (`hub/src/session.ts:379-399`,
  `hub/src/canvas/canvas.ts:423-446`); `create_directive.workstream` matches existing workstreams
  only.
- **Close it:** let `create_directive` create a workstream (and page) by name when none matches.

### 31. No piloting of the Simulator or apps [B44, B45b, B42]

- **Spec:** the brain taps, swipes, and types in the Simulator and in apps it opened (SPEC 13.2).
- **Code:** host control opens, installs, launches, arranges, lists, and runs shell; there's no
  input control (`hub/src/hostctl.ts:13-22`). "Install what it needs" is possible only through
  `shell`.
- **Close it:** add `tap`, `swipe`, `type`, and `screenshot` actions (for the Simulator through
  `simctl io` plus an input tool such as `idb`; for apps through System Events or CGEvent), gated by
  the same approval.

### 32. No local inference on clients [B28b]

- **Spec:** Mac clients offer whisper.cpp to the host as transcription workers (SPEC 9.3, 15).
- **Code:** only the hub side exists: `POST /api/workers` and `Transcriber.addWorker`
  (`hub/src/http.ts:370-375`, `hub/src/audio/transcribe.ts:62-68`). Nothing in `web/`, `app/`, or
  `bin/` starts a worker or registers one. Settings' help text implies laptops offer theirs
  (`web/src/shared/Settings.tsx:134`).
- **Close it:** have the Mac app start `whisper-server` when present and register it through the
  relay.

### 33. Tunnel traffic may be trusted as the host [A22c, security]

- **Spec:** tunneled traffic must still pair (SPEC 4.6, 14).
- **Code:** loopback callers skip auth (`hub/src/http.ts:20-22`, `:70-71`). `tailscale funnel --bg
  4747` (README `:111-113`) proxies from the local `tailscaled`, so Funnel traffic likely arrives
  as loopback, exposing host-only routes (pairing code, network setup) to the internet.
  `x-forwarded-for` isn't considered. Not verified.
- **Close it:** treat requests with `Tailscale-*` or forwarding headers as remote; document a Funnel
  setup that targets the HTTPS port; test it.

### 34. DuckDNS and Let's Encrypt are untested live; a real remote join is untested [A22c, A18b]

- **Code:** the flow is built and unit-tested (`hub/src/net/`, `hub/test/net.test.ts`); STATUS says
  the certificate and a real remote join are not tested. No ACME contact email is set
  (`hub/src/net/acme.ts`), so expiry notices go nowhere.
- **Close it:** run the wizard with staging, then production, on the Mac mini; join from a phone on
  cellular; add an optional contact email.

### 35. Audio tests use studio voices with simulated damage [A1a, A1c, A1d, B26]

- **Spec:** the suite also runs on real poor recordings in a real room; walk-away identification is
  correct for enrolled speakers (SPEC 16).
- **Code:** all clips are LibriSpeech audiobook reads degraded by ffmpeg
  (`hub/test/audio-fetch.py:8-12`, `hub/test/audio.sim.ts:244-342`). The walk-away scenario asserts
  a 50 percent floor (`hub/test/audio.bench.test.ts:144-186`; STATUS: about 50 percent without a
  voice sample). No bench results are checked in. The hybrid test uses synthetic signals and a stub
  transcriber.
- **Close it:** record a short real-room set (laptop, phone, and Bluetooth mics, people moving)
  with consent, add it to the bench, check in results, and raise the walk-away bar for enrolled
  speakers.

### 36. Visual polish isn't verified [A21]

- **Code:** nowrap, ellipsis, and progressive header collapse rules exist
  (`web/src/styles.css:109`, `:164`, `:216`, `:343`, `:773`, `:826-870`, `:931`). Rough spots: native
  `confirm()` and `alert()` in Settings (`web/src/shared/Settings.tsx:211`, `:219`, `:265`), an emoji
  in the voice-sample chip (`:209`), text ✕ glyphs, a forced two-column model grid (`:100`), and a
  duplicated Ask box in the phone's Room sheet. No screenshot pass at common widths.
- **Close it:** a screenshot pass at 1440, 1280, 1100, 900, 720, and 390 px on host, client, and
  phone; replace native dialogs with app dialogs.

### 37. Mic indicator and voice playback controls [A20]

- **Spec:** remote laptops fade the voice when their mic hears someone; each person can turn the
  voice off (SPEC 8.8).
- **Code:** barge-in exists only on the host (`web/src/host/HostView.tsx:82-86`). The `hearBrain`
  preference is read but has no UI (`web/src/client/ClientView.tsx:40`, `:46`). The quiet-room
  check is a narrow regex over notes (`hub/src/brain/speech.ts:43`); "only speak when asked" doesn't
  match.
- **Close it:** add barge-in to remote clients, a "Hear <name>" toggle, and let the router set a
  `quiet` flag through `remember_feedback`.

### 38. Resolved in the release candidate

The digest cursor moves only after curation succeeds (a failed pass is retried with a growing wait), and a failed
workstream brief is retried on the same backoff even in a quiet room (`hub/src/brain/brain.ts`, `briefsRun`).

### 39. Smaller security and hygiene items [security]

- `?token=` is accepted on any route (`hub/src/http.ts:27-28`); spec says only the one-time
  dev-server sign-in. Limit it to that.
- `/api/pair/info` returns the session and brain names without a token. Acceptable, but say so.
- Pairing lockouts are keyed on the socket address, not forwarded addresses; behind a tunnel
  everyone shares one.
- `brainEnabled` can be changed by any paired device (`hub/src/session.ts:110`), though the UI
  shows the switch only on the host. Make it host-only.
- The gateway key is stored in plain text in the team database. Consider the macOS Keychain on the
  host.
- `/collab` relays to the canvas server without a JamSesh token; the canvas link token is the only
  check.

## Where the docs disagree with the code

These aren't requirement gaps but will mislead someone tomorrow.

| Doc | Says | Code | Fix |
|---|---|---|---|
| `STATUS.md:32` | "Agents asking the host to build their branch: Not built" | Built in commit 219f0745: `jam_host_preview`, `HostControl.request/decide`, `BuildRequests.tsx`, voice approval | Update STATUS |
| `README.md:185` | "Send to JamSesh" | Button reads "Send N to <brain name>" (`web/src/shared/annotate.tsx:703`) | Match the label |
| `README.md:178` | Feedback notes last "for the session" | Notes are team-level and persist across sessions (`hub/src/store.ts:42-55`); the tool text also says "rest of the session" (`hub/src/brain/brain.ts:530`) | README and tool text now match the spec: team-level |
| `README.md` key table | Omits `M` and `A` | Both work on the big screen | Add them |
| `README.md:85` | Changes sent "in order and exactly once" | Exactly once only within one hub run (gap 25) | Fix code or soften |
| `README.md:111-113` | Tailscale Funnel as a fallback | Possible loopback trust (gap 33) | Verify before recommending |
| `README.md:290-291` | Dev servers listen on the host only | Proxies listen on all interfaces (gap 6) | Fix code |
| Old spec | Transcript ribbon, agent status strip, "heard you" toast | A right-hand room feed, an Agents panel, a spoken caption, and a chime | New spec describes the code |
| Old spec | Big screen on "the display you choose" | First non-main display, with **Move to the next display** | New spec describes the code |
| Old spec | App starts the hub, `figcraft-server`, and speech-to-text | The app starts the hub; the hub starts the others | New spec describes the code |
| Old spec | "Set up my agents" | **Connect my agents** | New spec uses the menu label |
| Old spec | `jam_wait` up to ten minutes | Default 4 minutes, at most 9 (`hub/src/mcp.ts:395`) | New spec describes the code |
| Old spec | Platforms: desktop, mobile, web, design | Also `backend`, `other` (`hub/src/mcp.ts:23`) | New spec describes the code |
| Old spec | Context "sized to a token budget" | Count and time limits, no token budget (`hub/src/mcp.ts:570-596`) | New spec describes the code |
| Old spec | Cleanest copy is "highest speech level and SNR" | `0.7 × SNR + 0.3 × level` (`hub/src/audio/pipeline.ts:461-463`) | New spec describes the code |
| Old spec | A client inference worker is the second engine | Hub side only (gap 32) | Spec keeps it as the requirement |
| Old spec | Presenter model builds custom views; parity uses the digest model | Both use the router model; presenter only places shares (`hub/src/session.ts:26-33`) | New spec describes the code |
| Old spec | The desktop canvas runs `figcraft --jamsesh` | JamSesh windows embed the WebAssembly canvas (`web/src/shared/ui.tsx:500`); the flag exists in FigCraft but JamSesh doesn't launch it | New spec says both exist and which JamSesh uses |
| Skill | Place frames 80 px apart | The hub moves colliding frames 120 px right of everything (`hub/src/canvas/canvas.ts:372-391`) | Align the skill with the hub |
| Hub | `Canvas.noteActivity` counts `args.steps[].tool === "create_node"` for batches | `place()` reads `args.commands[].command === "node.create"` (`hub/src/canvas/canvas.ts:376`, `:399`); one is likely wrong | Check FigCraft's batch shape and fix |
| Hub | Directive `priority` (1 to 3) | Stored, never used (`hub/src/brain/brain.ts:311-346`) | Use it or drop it |
