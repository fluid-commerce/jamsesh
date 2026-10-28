Findings A2, A3, A4 (in `mic.ts`), A7, A8, A10, A11, A12, A14, A15 (partly) and A16 are fixed. A5 is only partly done: `mic.ts` is ready, but the UI change isn't. A9 is a partial improvement. A6 and A7 are partly done, and A1, A13, A17 and A18 are left for others.

Checks: both `tsc --noEmit` runs and `vite build` are clean. The audio bench, hybrid, speech and prompt-window hub tests pass, and so do all web tests. I did not verify the UI visually: the Profile voice card only shows in the client view, which I couldn't reach on the loopback test hub (it renders the host view). The Profile change is text-only, and nothing was tried with a real mic.

I ran a `git stash` / `pop` once while bisecting a bench failure, which briefly removed other workers' uncommitted edits. The pop succeeded and `git status` showed everything back, but anyone who saw a file revert for a moment should know why.

## Per finding

- **A1:** Skipped, since the wake word lives in `brain.ts`. I did put the brain's name, "JamSesh" and "Jam Sesh" into the whisper hint (`pipeline.ts hint()`). See "Needed from the lead" for the `addressesBrain` change.
- **A2:** A recorded prompt now holds only the recorder's own lines. A line counts as theirs if it was attributed to them, or the recording laptop was loudest and the voice is unknown or theirs. Everyone else keeps flowing through normal triage.
  - Files: `hub.ts` (`fromRecorder`, `inPrompt`, `promptWindow`).
- **A11:** Held lines no longer create a feed event, so a recorded prompt shows once. The prompt event carries `utteranceId` and the embedding when it came from a single line, so it can still be relabelled. A late update to that line no longer overwrites the prompt text.
- **A12:** `promptWindow` now waits while any line from the recording device is still settling or being transcribed (new `pipeline.pendingFor`), up to 15s. The window expiry is now 2 minutes, as in SPEC 11.3.
  - The `mic.ts` half is a new `Mic.flush()`, which ends the sentence in progress and resolves once it's uploaded. Stop should call it before posting `/prompt-window`; that is a UI change in `annotate.tsx`.
- **A3:** The enrollment sentence no longer contains the brain's name. A new `holdMic()` in `mic.ts` mutes this laptop's always-on mic while enrolling, and Profile calls it. Enrollment is now about 20 seconds with a longer sentence, which gives about 6 samples.
- **A4:** In `mic.ts`, sustained loudness 22 dB above the room noise (160ms) during playback counts as a barge-in. It cancels the suppression and fires `mic.onBargeIn`. Echo-sized segments are still dropped; louder ones are kept. `playbackEnded()` ends suppression early.
  - This works even if the person was already mid-sentence when playback started. `HostView` still needs to wire it up (below).
- **A5:** `mic.ts` now has `Mic.ensureOn()`, which turns the mic on and returns false with the reason on `status.error` if it can't. Record in `annotate.tsx` should call it and show the warning.
- **A6:** The settle window is now 250ms when only one microphone could have heard the line, instead of 0.7s plus 1.25 × the worst lag. This saves about 1 second. I did not touch the chime path or add a "hearing…" indicator.
  - Not done: transcribing the first copy at once and chiming on the first transcription containing the wake word. That is a `brain.ts` change.
- **A7:**
  - Language: new setting `language` ("en" by default, "auto" or an ISO code); it is read from the store and passed to whisper and the gateway. The server no longer forces `-l en`.
  - Failure is now visible: with no engine and no gateway, or when the gateway fails, the room gets a "JamSesh can't hear the room" toast and a system event, at most every 5 minutes. `Transcriber.problem()` returns the reason. The hub also warns at startup.
  - Model download is not done; the spec should say so.
- **A8:** `mic.ts` now calls `ctx.resume()`, and resumes the context if it gets suspended. Track `ended` events and a 2-second watchdog (no frames for 3.5s) trigger a restart with backoff, with the reason shown in `status.error` and `on:false` meanwhile. Concurrent `start()` calls are de-duplicated.
  - Not done: testing WKWebView capture in the Mac app, which still has to be done by hand.
- **A9:** Partly done. A voice that clearly stands out from the other enrolled voices now gets up to 0.12 more weight (cap stays 0.75), and enrollment is longer. I tried 0.2 with a 0.8 cap and it broke bench tests 1 and 2, so I went back to the small bonus. The bench is synthetic, so the walk-away gain is modest and unproven on real recordings. The spec's "expected to be correct" still overstates it.
- **A10:** `quietRoom` now recognises "only talk when someone asks you something", "only speak when asked", "talk only when asked", "only respond when addressed" and similar. Tested.
- **A14:** Lag is now tracked per location. Outliers over 10s (offline flushes) are ignored, and devices idle for more than 90s are expired. A copy so late that its group is gone is matched against stored utterances and dropped instead of creating a duplicate line.
- **A15, A17, A18:** Not done; they live in `session.ts` and `http.ts`. See below.
- **A16:** Relabelling now removes the embedding from the previous person's voiceprint when the line was auto-assigned (`Voiceprints.remove`). Recorded lines keep their embedding on the prompt event, as above.

## Tests added
- `hub/test/prompt-window.test.ts`, 6 tests:
  - two-speaker recorded prompt, and a line heard on the recorder's laptop but spoken by someone else
  - quiet-room phrasings
  - solo versus two-microphone settle
  - the no-engine warning
  - transcript cleaning
- `web/test/mic.echo.test.ts` covers echo versus barge-in and `holdMic`.
- Still no tests for `Mic` restart or the record-while-muted flow.

## Needed from the lead
- **`brain.ts` (A1):** match the name phonetically with an alias list ("jam session", "jam sesh", "jamsey", plus the brain's own name). Don't treat the name followed by "is/was/seems/just" as an address.
- **`brain.ts` (A6):** chime on the first transcription containing the wake word.
- **`session.ts` (A15):** make `personByName` match exactly first, and disambiguate when a first-name or prefix match hits more than one person.
- **`session.ts` (A17):** narrow the "product" role weight to "product manager" or "head of product".
- **`session.ts` (A7):** add `"language"` to the allowed settings list in `updateSettings`.
- **`http.ts`:** add `problem: hub.transcriber.problem()` to the `/api/engines` response (line ~379). Raise the `/audio` dedupe from 4s to 60s (A18).

## Needed from the UI worker
- **`HostView.tsx`:**
  - Replace the `speaking`-flip fade logic (lines 79-82) with `mic.onBargeIn.add(() => voice.fadeOut())`.
  - Call `mic.playbackEnded()` when playback finishes or is faded.
  - Show `status.error` ("Reconnecting…") instead of "Listening" whenever `on` is false.
  - Show a "hearing…" state while `status.speaking`.
- **`annotate.tsx`:**
  - Record should call `await mic.ensureOn()` and warn if it returns false.
  - Stop should `await mic.flush()` before posting `/prompt-window`.
- **`ClientView.tsx` (A13):** subscribe to `onBargeIn` and fade the voice. Add a "Hear the brain" toggle that writes `hearBrain`.
- **Feed:** nothing to hide any more. Held recorded lines no longer create events.

## Spec statements to change
- 9.3: language defaults to English and is a setting; there is no model download, and the app warns when no engine is available.
- 8.9: the quiet-room examples now work.
- 11.3: the prompt window lasts 2 minutes. Add that other people's speech during a recording flows as normal room speech.
- 9.1: gesture start, mic starts without a message (A18).
- 16: soften "walk-away is expected to be correct" to the real figure of about 50% to 85%.
- Add: what happens to a copy arriving more than 15s late (dropped as a duplicate), and a new line on mic recovery ("Reconnecting…").
- 8.8: remote barge-in and the "Hear brain" switch are not built yet.