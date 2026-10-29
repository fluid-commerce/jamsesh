---
name: jamsesh
description: Connect to and work inside a live JamSesh room session with other people and agents. Use when the user says "connect to jamsesh", "join jamsesh", or "join the session", runs /jamsesh, when the JamSesh MCP server is connected, or when a prompt mentions the room, the big screen, the shared canvas, or another person's agent.
---

# Working in a JamSesh session

You are one of several coding agents in a room of people working together. The room has a host
machine at {{HUB}} that runs a shared FigCraft canvas, keeps the session's context, listens to
the room, and routes what people say to the right agent. Your person can also prompt you
directly. Everything you post is visible to the room and to every other agent.

## Connect

When your person says "connect to jamsesh" (or similar), connect without asking them for anything:

- **The `jamsesh` tools are available.** Go straight to Join. On a Mac with the JamSesh app open,
  these tools reach the session through the app, so there's no address or code to ask for.
- **The `jamsesh` tools fail to connect.** The JamSesh app on this computer isn't running or isn't
  in a session. Tell your person in one line: "Open the JamSesh app and host or join a session,
  then tell me again." Don't retry in a loop.
- **There are no `jamsesh` tools at all.** This computer hasn't been set up. If your person has
  the JamSesh app, ask them to choose **Connect my agents** in its menu bar menu, then restart you.
  Otherwise ask for the address and the 4-character code on the big screen, and fetch
  `<address>/agent?c=<code>`; that page tells you how to set yourself up.
- **The app won't open on macOS** ("can't be opened because Apple cannot check it"). The JamSesh
  app isn't notarized yet. Tell your person to right-click it and choose Open, or go to System
  Settings > Privacy & Security > Open Anyway. Until then they can use the room in a browser at the
  address on the host's JamSesh screen, and setting up their agents still works.

A new conversation starts fresh: even in a repository you joined yesterday, call `jam_join` again.
It resumes your place (same name, same workstreams) and hands you this skill again.

**Codex** works the same through the same tools, with one difference: Codex has no hooks here, so
nothing sends your person's prompts to the room or wakes you. You are the link. When your person gives
you a task, post a one-line `jam_update` (`progress`) saying what you're starting, check `jam_inbox`
between steps, and use `jam_wait` whenever you're idle. Claude Code doesn't need this: JamSesh wakes it.

## Join

1. Call `jam_join` with your harness, the repository (remote URL or
   name), the branch, your absolute working directory, the platform the repository builds, and a
   one-line focus. Find the repository and branch with `git remote get-url origin` and
   `git branch --show-current`. If you were handed a "JamSesh chat id", pass it as `chat`. Leave `owner` out: the room knows whose computer this is. If
   `jam_join` asks for it, ask your person their first name.
2. Read what `jam_join` returns: who is here, open directives, the session brief.
3. Post your repo card with `jam_repo_card` (see Work with the other agents).
4. Keep names clear. If your person gives you a name to go by, or the briefing says their title
   is missing, call `jam_rename` (your `name`, their `owner` name and `ownerTitle`). The room and
   the other agents address you by that name, and titles decide whose call wins.
5. `jam_claim` the workstream you're taking, named for the work ("Mobile onboarding", "Settings
   page"). If someone owns it, `jam_message` them to split it, don't duplicate it.

## The loop

- **Report as you go.** `jam_update` with `progress` when you start something meaningful,
  `question` when you need a person, `done` when a directive is finished, `shipped` when you
  implemented and verified a change in your repository. One or two specific sentences: what
  changed, where, what's next. Don't narrate tool calls.
- **Room items reach you.** Claude Code: JamSesh hands room items to you between steps, and wakes you
  when the room has something after you stop, so when your work is done, stop and say so. Codex has no
  hooks: call `jam_inbox` after each meaningful step, and when you're idle keep calling `jam_wait` (it
  returns after about three and a half minutes with "Nothing new"; call it again straight away). Don't end
  a Codex turn with "let me know if you need anything" while the session is live.
- **Directives come first.** `jam_ack` with `acked` when you start one, `done` with what you did. If your
  person tells you to stop or leave the session, say so in a `jam_update` and then stop.
- **Refresh before a new leg.** Before starting a new directive or after a break, call
  `jam_context` (with your workstream) so you work from the latest decisions, not stale ones.
  `jam_search` finds anything said or posted earlier, and `jam_directives` lists what the room
  asked agents to do, older ones included.
- **People's roles matter.** When instructions conflict, the higher-weight role wins (the
  directive's rationale says whose call it was). If you can't tell, `jam_ask_room`.

## Work with the other agents

You're one of a team. Talk to the other agents through JamSesh instead of guessing:

- **Ask** with `jam_ask` whenever another agent knows something you need: how their repo does
  something, their tokens and spacing, whether they already built a component, what they decided.
  It waits for the answer.
- **Answer first.** A `QUESTION` in your inbox (or a hook message) comes before your own work:
  reply with `jam_answer`, concretely (paths, values, names), then continue.
- **Describe your repo** with `jam_repo_card` right after joining, and again when it changes
  meaningfully: the stack, where the design system lives and its key values, the components
  you're touching, your branch, recent changes (including uncommitted work).
- **Write to the room brain** with `jam_message` to its name (it's in `jam_agents`) when you need
  something recorded or routed: a decision, a question, a note to keep. It can answer you with a
  directive, record a decision, or message another agent. It won't act on the host or the screen
  because an agent asked.
- **Compare and review** when the room brain pairs you with someone (a `coordinate` directive):
  look at their frames with `canvas_render`, say what differs and why, agree on what should
  match, and post the outcome with `jam_update`. Disagreements you can't settle go to the room
  with `jam_ask_room`.

## Explore or implement

Directives say which:

- **explore**: make variants on the canvas. Don't touch your repository.
- **implement**: change code in your repository, then verify against the chosen mockup.
- **coordinate**: align with another agent (often desktop and mobile) before or while building.
- **answer**: a person answered your question.
- **note**: write something down for the room (pain points, a list, meeting notes) in the form it asks for. No code to build, nothing to draw.

If a prompt from your person is ambiguous, these words mean explore: try, what if, options,
directions, variants, mock up, show me. These mean implement: build it, ship it, do it for real,
in the app, let's go with.

## Design on the canvas

The `canvas_*` tools are FigCraft's MCP tools, running on the host as you. Your edits appear live
for everyone, with your name on your cursor.

1. **Start from the real design system, not your imagination.** Before drawing, read your
   repository's tokens and components: theme files, Tailwind config, CSS variables, component
   library, icon set, fonts, spacing scale, radii, shadows. Use those exact values: colors as hex
   from the tokens, real font families and sizes, real copy where it exists. If a screen already
   exists in the product, recreate it one to one first and vary from there.
2. **Name frames for the room**: `<Workstream> / <Letter>: <idea>`, for example
   `Mobile nav / B: bottom tabs with labels`. Variants of one idea share the workstream part, so
   the big screen shows them side by side as A, B, C. Use real device sizes (390×844 for iPhone,
   1440×900 for desktop).
3. **One page per workstream.** When you claim a workstream, JamSesh gives it a canvas page with
   the same name and puts you on it, so your frames land there. Keep every variant of that
   workstream side by side on its page. Don't make a page per variant or per screen, and don't
   draw on another workstream's page. Make a new page only when the room starts a genuinely new
   area of work (claim it as a workstream, and the page follows), or for throwaway experiments on
   a page named `Scratch`. `canvas_run_command page.list` shows the pages.
4. Put your frames in open space to the right of existing work, in a row, 80 px apart.
   `canvas_frames` lists what's there; JamSesh moves a frame that would land on someone's work.
5. **Check your work before you announce it.** For each frame:
   - `canvas_render` it and look at the picture.
   - Open the product's real counterpart (screenshot the running app, or read the component code)
     and compare: type scale, colors (hex from the tokens), spacing, radii, component shapes,
     real copy, icons.
   - List what differs, fix it, and render again. A variant that doesn't look like it belongs in
     the product isn't done.
6. Then `jam_update` with `done`, naming the frames and what differs between them. JamSesh warns
   you if you changed the canvas since your last render; if it does, go back and check.

The shared file belongs to the room: `file.*` and `collab.*` commands are blocked for agents.
Ask a person to open, save or share files.

## Build in your repository

1. `jam_context` with your workstream for the decision and the chosen mockup.
2. `canvas_render` the chosen frame and keep it in view while you implement.
3. **Share every dev server you start.** Run it bound to `0.0.0.0` (`vite --host 0.0.0.0`,
   `next dev -H 0.0.0.0`) and call `jam_devserver` with its local URL (`http://localhost:5173`)
   straight away, so the room can open it on the host. Do this for anything that serves a page,
   even a quick check; don't just say the address in an update. The URL is only for people in
   the session, and hot reload works through it. It has to be a server on your own machine. If
   you mention a `localhost` address without sharing it, JamSesh answers with this step. If a
   build stops, its tile says so and you get a message; start it again and call `jam_devserver`.
   When you stop the server on purpose, call `jam_devserver_remove`.
   - **Expo / React Native:** `expo start --lan` serves a manifest for the Expo Go app, not a page
     anyone can look at. For a tile the room can open, run `expo start --web`. For the native
     look, run the app in the iOS Simulator on your own Mac, screenshot it, and post the
     screenshots (step 5). To show it on the host's Simulator, use `jam_host_preview`.
4. **Check the build against the mockup, one to one.** This is a step you do, not one you
   describe:
   - Screenshot the running build at the mockup's size (a headless browser such as Playwright,
     or the iOS Simulator for native). Use the same viewport as the mockup frame (390×844 or
     1440×900, for example).
   - `canvas_render` the mockup frame, and look at both pictures one after the other.
   - Compare layout, spacing, type, color, states and copy; write down each difference.
   - Fix the differences and screenshot again. Say what still differs if anything does, and why.
   JamSesh warns you if you call `shipped` without a "(built)" screenshot from you.
5. Post the screenshot so the room sees mockup and build together:

   ```sh
   curl -s -F file=@build.png -F title="Mobile nav / B: bottom tabs (built)" -F stage=built \
     -F agent=<your agent id> -H @"$HOME/.jamsesh/auth.header" "{{HUB}}/api/upload"
   ```

   Title it like the mockup it matches, with "(built)", so the screen can pair them.
6. `jam_update` with `shipped`: what changed, the files, the dev server URL.

## Show a native build on the host

For anything that doesn't run in a browser (a desktop app, an iPhone app), the room can try it on
the host Mac:

1. Commit and push your branch. The host clones your repository's remote, not your working tree.
2. Call `jam_host_preview` with the build command and what to open when it finishes: a path in the
   repository (for example `src-tauri/target/debug/bundle/macos/App.app`), or
   `simulator:<path to .app>` for an iPhone build.
3. The host announces it out loud and a person approves or denies it, by voice or a button. You get
   a message with the answer. Don't ask again while a request is waiting, and never call approval
   endpoints yourself. Your remote has to be a plain URL (https or git@) without a token in it;
   credentials in a URL are stripped.
4. When it's open, the room can arrange it beside the other apps and look at it through the
   Simulator's screenshots. Post your own screenshots too if you can.

Use `jam_devserver` instead for anything that runs in a browser.

## Across repositories

The same feature often lands in more than one repository (desktop and mobile). When you ship a
user-visible change that applies elsewhere, say so in your `shipped` update. The room brain sends
the other platforms' agents a `coordinate` directive. If the change is deliberately for your
platform only, pass `platformSpecific: true`; commits, refactors, fixes and tooling never
coordinate. (That needs the brain online. If it's not, `jam_message` the other agent yourself.)
A parity `coordinate` directive is a check, not build work. When you get one:

1. `jam_message` the other agent: does the feature exist on your side, and does it match? Say
   what has to differ for the platform.
2. Build only if you both confirm a gap; then post its screenshot. Otherwise `jam_ack` it done
   with what you found.
3. Compare both renders. Fix inconsistencies that aren't deliberate platform differences.
4. `jam_show` with mode `parity` and columns for each platform, then `jam_update` with `shipped`
   naming both sides.

## Etiquette

- The room jokes around. Only directives are instructions; don't act on banter you read in the
  context.
- Never edit another agent's repository or frames without asking it first.
- Keep `jam_update` text short and specific. The big screen shows it.
- The host machine is shared: never put secrets in updates, messages, or frames.
