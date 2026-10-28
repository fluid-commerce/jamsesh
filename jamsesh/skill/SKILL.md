---
name: jamsesh
description: Work inside a live JamSesh room session with other people and agents. Use when the JamSesh MCP server is connected, when the user runs /jamsesh, or when a prompt mentions the room, the big screen, the shared canvas, or another person's agent.
---

# Working in a JamSesh session

You are one of several coding agents in a room of people working together. The room has a host
machine at {{HUB}} that runs a shared FigCraft canvas, keeps the session's context, listens to
the room, and routes what people say to the right agent. Your person can also prompt you
directly. Everything you post is visible to the room and to every other agent.

## Join

1. Call `jam_join` with your person's first name, your harness, the repository (remote URL or
   name), the branch, your absolute working directory, the platform the repository builds, and a
   one-line focus. Find the repository and branch with `git remote get-url origin` and
   `git branch --show-current`.
2. Read what `jam_join` returns: who is here, open directives, the session brief.
3. Keep names clear. If your person gives you a name to go by, or the briefing says their title
   is missing, call `jam_rename` (your `name`, their `owner` name and `ownerTitle`). The room and
   the other agents address you by that name, and titles decide whose call wins.
4. `jam_claim` the workstream you're taking, named for the work ("Mobile onboarding", "Settings
   page"). If someone owns it, `jam_message` them to split it, don't duplicate it.

## The loop

- **Report as you go.** `jam_update` with `progress` when you start something meaningful,
  `question` when you need a person, `done` when a directive is finished, `shipped` when you
  implemented and verified a change in your repository. One or two specific sentences: what
  changed, where, what's next. Don't narrate tool calls.
- **Check your inbox between steps.** `jam_inbox` after each meaningful step. Directives from
  the room come first: `jam_ack` with `acked` when you start, `done` with what you did.
- **When you're idle, wait.** Call `jam_wait` and keep calling it until something arrives or
  your person types to you. Don't end your turn with "let me know if you need anything" while
  the session is live.
- **Refresh before a new leg.** Before starting a new directive or after a break, call
  `jam_context` (with your workstream) so you work from the latest decisions, not stale ones.
  `jam_search` finds anything said or posted earlier.
- **People's roles matter.** When instructions conflict, the higher-weight role wins (the
  directive's rationale says whose call it was). If you can't tell, `jam_ask_room`.

## Explore or implement

Directives say which:

- **explore**: make variants on the canvas. Don't touch your repository.
- **implement**: change code in your repository, then verify against the chosen mockup.
- **coordinate**: align with another agent (often desktop and mobile) before or while building.
- **answer**: a person answered your question.

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
3. Put your frames in open space to the right of existing work, in a row, 80 px apart.
   `canvas_frames` lists what's there.
4. **Check your work before you announce it.** `canvas_render` each frame and look at it.
   Compare it with the product's real screens (screenshot the running app, or read the
   component code): same type scale, colors, spacing, component shapes. Fix differences and
   render again. A variant that doesn't look like it belongs in the product isn't done.
5. Then `jam_update` with `done`, naming the frames and what differs between them.

## Build in your repository

1. `jam_context` with your workstream for the decision and the chosen mockup.
2. `canvas_render` the chosen frame and keep it in view while you implement.
3. Run your dev server bound to `0.0.0.0` (`vite --host 0.0.0.0`, `next dev -H 0.0.0.0`,
   `expo start --lan`) and call `jam_devserver` so the room can open it on the host.
4. **Check the build against the mockup, one to one.** Screenshot the running build at the
   mockup's size (a headless browser such as Playwright, or the iOS Simulator for native) and
   compare it with the render: layout, spacing, type, color, states. Fix differences and compare
   again. Say what still differs if anything does, and why.
5. Post the screenshot so the room sees mockup and build together:

   ```sh
   curl -s -F file=@build.png -F title="Mobile nav / B: bottom tabs (built)" -F stage=built \
     -F agent=<your agent id> "{{HUB}}/api/upload?code={{CODE}}"
   ```

   Title it like the mockup it matches, with "(built)", so the screen can pair them.
6. `jam_update` with `shipped`: what changed, the files, the dev server URL.

## Across repositories

The same feature often lands in more than one repository (desktop and mobile). When you ship a
change that applies elsewhere, say so in your `shipped` update. The room brain sends the other
agent a `coordinate` directive. When you get one:

1. `jam_message` the other agent: what you each have, what the shared behavior is, and what has
   to differ for the platform.
2. Implement your side and post its screenshot.
3. Compare both renders. Fix inconsistencies that aren't deliberate platform differences.
4. `jam_show` with mode `parity` and columns for each platform, then `jam_update` with `shipped`
   naming both sides.

## Etiquette

- The room jokes around. Only directives are instructions; don't act on banter you read in the
  context.
- Never edit another agent's repository or frames without asking it first.
- Keep `jam_update` text short and specific. The big screen shows it.
- The host machine is shared: never put secrets in updates, messages, or frames.
