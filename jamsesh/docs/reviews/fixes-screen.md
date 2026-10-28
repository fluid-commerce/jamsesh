The web work for the big screen and people-facing UI is done. Web `tsc` and `vite build` are clean and web tests pass (20 pass, including 5 new in `web/test/screen.test.ts`). Hub `tsc` is not clean: `hub/test/agents-host.test.ts:81` fails to type-check. I didn't touch that file. I checked the changes visually in headless Playwright against my test hub on 4872 (stopped), but not in the Mac app.

**Per finding**
- **V1:**
  - STUN was already in `rtc.ts`. Watchers now count connections that were offered but never carried video.
  - After two failures the tile says a network between you is blocking a direct connection and that being on the same Wi-Fi fixes it.
  - `rtc.ts` also tries `GET /api/rtc/config` on connect and reconnect and uses any `iceServers` it returns, so a TURN relay on the host can be wired in without a web change. It 404s today and is ignored.
- **V2:**
  - Tile clicks on the big screen and in the Work tab now send `pinned: false`, so they revert on their own and don't stop the brain self-piloting.
  - The client's "On screen" chip is now a "Back to board" button when the screen is off the board. It stays visible below 1380px.
  - The host header shows a pin glyph on pinned screens, and a "Pinned ✕" release chip for Canvas and Agents.
- **V3:**
  - A publication the hub no longer lists as live is re-registered automatically, checked every 8 s and 2.5 s after a reconnect, once it is more than 10 s old.
  - I tested this by deleting a live camera share on the hub. It was live again within 14 s, and the client showed "Reconnecting your share…" after 5 s.
- **V4:** The Share screen button now says plainly when `getDisplayMedia` is missing and suggests Chrome or Safari, or the camera. I could not test this in the Mac app's WebKit window, so it still needs a check there. The phone sheet and the share-request card use the same check.
- **V5:**
  - The Join stage says Camera-app joining works, and warns that phone mic needs https or the Mac app when only plain-http addresses exist.
  - The always-red error bar on the client is replaced by a one-time dismissible note about plain http (stored as `httpNotice`), with a separate "Try again" bar for a real mic error.
  - The phone mirror no longer says "Point your phone's camera here".
- **V6, V10, V12 caption:** Not done, all in `brain.ts` (see below). In V12 I fixed the Work gallery order (A, B, C) and the letter badge covering the picture.
- **V7:** The host header has a "Send N pins" chip. I tested it: both open pins went to `sent`.
- **V8:** Canvas follow now re-asserts every tick and follows a new client id after a reload.
- **V9:** The Canvas stage uses the same canvas tile as layouts, so it gets pins, follow and page support. The brain still has no `follow` or `page` argument on `show_on_screen`.
- **V11:**
  - `1`/`2`/`3`/`f`/`j`/`m` now ignore Cmd, Ctrl and Alt, and accept either case.
  - Esc closes the invite modal first.
  - The host reclaims keyboard focus from iframes when the pointer leaves them.
  - The client's canvas can still swallow `M` and Esc while it has focus, because it is an editable canvas. I left that alone.
- **V13:** Not mine, hub side.
- **V14:** Touch tablets held upright now get the phone layout. I added unit tests for the join-address logic only; there are none yet for the stage, client or share UI.
- **S3:**
  - The Join card, the big-screen Join view and the Welcome card now lead with the room's own address.
  - The https address is promoted only when `net.reachable` is `"yes"` or the address carries `reachable`.
  - When both work, two labelled QR codes appear: "In the room" and "Remote or phone mic".
  - An https address that isn't confirmed yet is mentioned in small text.
- **S4:**
  - A new "Invite" button (`client/Invite.tsx`) is in the client header, the phone Room sheet, and the host invite modal. It copies a join link and code and shows what it copied.
  - It uses `POST /api/invite` and falls back to the live code (`/pair/code`, then the plain address) on 404 or 405. My test hub already answered `/api/invite`; the copied link read "Works for about 10 minutes", so the lead's endpoint appears to be in.
- **S13, S15:**
  - The connect page has a "If macOS won't open it" hint next to the Mac download.
  - A code from a stale link now says it expired.
  - I also restricted `?next=` to same-origin paths (S16).
- **A4/A5/A8:**
  - Record while muted now calls `mic.ensureOn()`, tells you the mic was only on for the recording, and mutes again about 1.6 s after Stop.
  - If the mic won't turn on, the toast gives the reason.
  - The host mic button shows "Mic problem" with a retry bar. Both windows read `MicStatus.error`; the host pill and bar wording ("Not supported") still comes from `mic.ts`.

**Also changed:** `api()` errors now carry `.status`, and `/invite` is never queued offline.

**Spec statements to change**
- SPEC 11.6 and `spec-gaps` item 14: remote shares are STUN-only unless the host provides a relay.
- SPEC 3.4: over plain http, the camera, screen share, profile photo and voice enrolment fail as well as the mic.
- SPEC 8.10: the share-first fallback keeps up to two existing tiles, and the board has none. Also, auto-compare does not check every variant's age.
- SPEC 10.3: refused sites use a manual "Open on the host" button. Also, the join card shows one or two QR codes.
- Add the Invite button and its fallback behavior. Also add a note that pins from tile clicks revert after about 6 minutes (`stage.pinned: false`).

**Cross-file changes needed from the lead**
- **`brain.ts`, `artifactsLanded`:**
  - Skip auto-compare while a share tile is live on stage, or keep the share in the compare layout (V6).
  - Check every variant's age, not just the newest (V6).
  - Build the caption from the variant names. It currently can read "3 directions from " with no names (V12).
  - Add optional `follow` and `page` to `show_on_screen`, and offer person-follow only, since agents have no viewport (V8/V9).
  - List open pins in `situation()` (V7).
- **`session.ts` or `hub.ts`, `addresses()` / `extraAddresses`:**
  - Add `reachable: "yes" | "no" | "unknown"` to the https address entry. The UI falls back to `/api/net/status` without it.
  - Optionally add `GET /api/rtc/config` returning `{ iceServers }` if a TURN relay gets built.
  - Optionally keep a hub-side share alive about 20 s after its socket closes. The client check skips live shares, so this is safe.
- **V13 (`http.ts`):** loopback callers can approve builds, so a local agent could approve its own. I did not confirm whether this was closed.
- **`app/`, S15:** show "Allow Local Network access to see sessions near you" when the Join list stays empty.
- **`hub/test/agents-host.test.ts:81`:** the type error above should be fixed by whoever owns that test.

Everything is uncommitted.