**Verdict for the big screen and people-facing UI**

The spec covers this area, with a few misstatements listed below. The code delivers most of it. At 1920, 1366 and 1100 px wide, the host board, compare, layout and Join views and the client header, Work and profile views are clean, with nothing wrapped or cut off. The phone layout was checked at 390 px: Screen tab and Room sheet. I did not check the phone header on a real phone.

The weak points are:
- Screen and camera sharing across networks.
- Sharing from the Mac app.
- A "pinned screen" trap that switches off the self-piloting.
- A share that dies silently on a network blip.
- Everything except the mic being dead over plain `http`.

Evidence comes from reading the code and from screenshots of a throwaway hub on port 4991. The pins, pointer-capture, frame-check and J-key work was in flight and is only noted, not graded. Some other agent's changes to `hub/src/http.ts` were uncommitted.

**Findings, worst first**

**V1. major, code-gap and spec-wrong [A4c, A5, A18, SPEC 11.6].** Remote shares will fail across NAT.
- Evidence: `web/src/shared/rtc.ts:20` gives only STUN servers (Google and Cloudflare). `configureRtc` is never called. There is no TURN server anywhere in `hub/src`. SPEC 11.6 and `spec-gaps.md` item 14 promise "a relay on the host".
- Effect: a remote coworker behind corporate wifi or carrier NAT sees "Connecting to X's screen…" forever. Same-LAN shares work.
- Fix: run a TURN relay on the host (port mapped with 443) and call `configureRtc` with short-lived credentials. Otherwise reword the spec to say direct, STUN-only connections work on friendly networks.

**V2. major, ux and code-gap [B11, B12, A5].** One click permanently pins the big screen.
- Evidence: `Stage.tsx:22` (board tile click), `ClientView.tsx:512-513` ("Show on big screen") and `http.ts:343` (`pinned ?? mode !== "board"`). Pinned stages never revert (`session.ts:759`). Self-piloted compare (`brain.ts:727`) and share placement (`brain.ts:228`) both stop while pinned.
- Client windows have no way back. The "On screen:" chip (`ClientView.tsx:131`) is not a button, and there is no Esc handler.
- Effect: after a coworker clicks a tile, the room stops self-piloting until someone at the Mac presses Esc. Often nobody is at the Mac.
- Fix:
  - Make clicks from the Board and Work tabs pin for about 3 minutes, or not at all.
  - Add a visible "Unpin / Back to board" control to the client's On-screen chip.
  - Show a pin indicator on the host header.

**V3. major, bug [A5, A18].** A brief connection drop ends a share for everyone, with no recovery.
- Evidence: `http.ts:162-166` ends all of a device's shares when its last socket closes. Nothing in `rtc.ts` or `share.tsx` re-registers a share on reconnect, and neither file has any reconnect handling.
- Effect: a wifi roam or a hub restart leaves the browser still capturing and showing "Sharing screen", while the big screen says "This share ended."
- Fix: on `hub.onReconnect`, re-POST `/shares` for each live publication. Optionally keep the hub-side share alive for about 20 s after a socket close.

**V4. major, unverified risk [A5, A28a].** Screen sharing from the Mac app may not work at all.
- Evidence: the desktop `ShareControls` (`share.tsx:99`) only checks `navigator.mediaDevices`. The phone sheet is the only place that checks for `getDisplayMedia` (`ClientView.tsx:397`). Tauri's WKWebView has historically lacked `getDisplayMedia`. `STATUS.md` has no row for screen sharing from the app.
- Fix: test it in the app. If missing, hide or disable the button with a clear message. Better, add a native capture path.

**V5. major, spec-wrong and ux [A28b, A14, A5].** Over plain `http`, more than the mic is dead.
- Evidence: SPEC 3.4 (lines 184-186) says "can't listen". `rtc.ts:30` shows `mediaDevices` is also absent, so screen share, camera, profile photo (`share.tsx:282`) and voice enroll (`Profile.tsx:75`) all fail too.
- The Join view (`Stage.tsx` `JoinStage`) says "Open the Camera, point it at the QR code… You're in." even when the QR is a LAN `http` address.
- Effect: browser and phone coworkers on the LAN, without DuckDNS and without the Mac app, get a joined session with almost nothing working.
- Fix:
  - Correct the spec.
  - Have the Join view prefer the HTTPS address, or say "Mac app recommended" when only `http` is available.
  - Show the plain-`http` banner on the client once, with specifics, instead of an always-red bar.

**V6. major, bug [B12, A5b].** Self-piloting can bury a live share.
- Evidence: `artifactsLanded` (`brain.ts:727`) only skips when `stage.pinned` or the brain acted in the last 90 s. A share layout placed by "JamSesh" is unpinned. When a variant set of 2–6 lands, it replaces the share layout with a compare, and nothing re-places the share.
- The same check requires only the most recent variant to be under 60 s old (`brain.ts:733`). SPEC 8.10 says all of them.
- Fix: skip auto-compare while any share is live on stage, or keep the share tile in the compare layout. Check every variant's age.

**V7. minor, code-gap [A7d].** The host window can drop pins but not list or send them.
- Evidence: `AnnotationsPanel` is mounted only in `ClientView.tsx:235`. `HostView.tsx:170` has only the Annotate toggle. The brain's context never includes open pins.
- Effect: anyone at the Mac who pins things has no "Send N". The brain also can't act on "send those pins" by voice.
- Fix: add a "Pins · N → Send" chip to the host header, and list open pins in `situation()`.

**V8. minor, bug [A4a].** Canvas follow works once and only follows people.
- Evidence: `ui.tsx:645-663` sets `done = true` after the first match and never re-checks. A reload or reconnect gives the person a new client id, and the big screen stays on a stale view. Following an agent follows a headless participant that has no viewport.
- Fix: re-assert follow every tick, following the peer by name, and only offer person-follow in the brain's tool description.

**V9. minor, code-gap [A4a, B10].** The big-screen Canvas mode has no pins, follow or page.
- Evidence: `Stage.tsx:44-50` renders a bare `CanvasFrame`, and `show_on_screen` (`brain.ts:393`) has no `follow` or `page` argument. This is one of the stage views missing pins, apart from the in-flight work. The J key is already in `HostView.tsx:90`.
- Fix: route Canvas mode through `TileView`'s canvas tile.

**V10. minor, spec-wrong.**
- SPEC 8.10 says that without a model the share goes first with up to three existing tiles.
  - Code: `brain.ts` `placeShare` fallback keeps `stage.items.slice(0,2)`, and the board has none.
  - Result: the share replaces the whole screen.
- SPEC 10.3 says refused sites "open in a host browser window that the brain places beside the big screen".
  - Code: `ui.tsx` `BlockedFrame` is a manual "Open on the host" button.
  - It also has no automatic detection. `onLoad` (`ui.tsx:249`) fires even on a refused frame in Chrome. Only the hard-coded `NO_FRAME` list works.
  - The in-flight `/frame-check` route addresses this.

**V11. minor, ux [A12, A21].** Keyboard shortcuts have several problems.
- Evidence: `HostView.tsx:85-95` has no modifier guard on `1`, `2` and `3` or on `f`. Cmd+2 pins the Canvas, and Cmd+F toggles full screen.
- `F` works only as lowercase `f`. Esc doesn't close the invite modal.
- Shortcuts check `e.target.closest("input…")`, and `ClientView.tsx:64` has the same pattern. Focus inside the canvas or a dev-server iframe swallows `M`, `J` and Esc. SPEC 11.4 says mute works "at any time".
- Fix: guard modifiers, accept both cases, and listen for focus returning from iframes. Or have the iframe forward keys.

**V12. minor, polish.**
- The auto-compare caption can read "3 directions from " with no names (`brain.ts:735`).
- The Work gallery lists variants C, B, A with the letter badge overlapping the picture.
- The QR code and typed code work for only 30–60 s (`auth.ts:80`), so a photographed QR fails later.
- The phone mirror of the Join view still says "Point your phone's camera here".

**V13. minor, security.**
- Evidence: `http.ts:518` lets any local-loopback caller approve a host build, so a local agent could approve its own build over loopback. `spec-gaps.md` item 5 covers this.
- Confirm it was actually closed.

**V14. minor.**
- Tablets wider than 720 px in portrait get the desktop layout: a 380 px side panel and an editable canvas on touch.
- There are no automated tests for the stage, client or share UI. `web/test` has only `offline.test.ts`.

**Requirement coverage, area summary**

| Requirement | Spec | Code | Note |
|---|---|---|---|
| B12/B13 board, spotlight, compare, parity, agents | complete | works | V2, V6 |
| A4 tiles (canvas/web/screen/agent/feed/html) | complete | works | V8–V10; the rest verified |
| A5 screen/camera sharing both directions | overstated | partial | V1, V3, V4 |
| A7 pins app-wide, sent as one prompt | complete | partial | V7; the in-flight work covers the rest |
| A14/A15 profile photo, title | complete | works | V5 on plain `http` |
| A19 canvas pages | complete | works | none |
| A21 polish | n/a | good in my viewport checks | none |
| A28 mobile | partly wrong on `http` | works | V5, V14 |
| A31 Join view | complete | works | V12 |
| A32 display awareness | complete | works | verified in `hostctl.ts:116` |

Screenshots are in `/tmp/vqs/`, and the throwaway hub runs on port 4991 with `/tmp/vq-home` and `/tmp/vq-data`. I never started it as the owner's app. You may want to kill it, since I didn't stop it.