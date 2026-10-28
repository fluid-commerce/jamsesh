**Verdict for audio and speech**

The spec is mostly complete and honest here. It misses a few requirement details and misstates several behaviours (see "Spec problems" below). The code fulfils the audio plumbing well: capture, VAD, clock sync, grouping, cleanest copy, echo handling, voiceprints, manual relabel, the record window and TTS. It is weakest where a first live session will test it: wake-word reliability, record-to-prompt in a multi-person room, barge-in, the always-on mic starting on the Mac app, and walk-away speaker ID. I found no outright blocker in code. A1 and A9 could stop people addressing the brain at all. I read code and ran small checks against `addressesBrain` and `quietRoom`. I did not run the audio bench or live audio.

**Findings, ranked by how much they'd hurt tomorrow**

**A1. Wake word fails on likely transcriptions of "JamSesh"** (major, bug and code-gap; A8d, A10, brief on the brain's name)
- Evidence: `hub/src/brain/brain.ts:861-877` matches the name only as an exact word, or as two words that concatenate to it. I ran it with the name "JamSesh":
  - "Hey jam session, bring up the nav" returns false.
  - "jam session can you put that up" returns false.
  - "Jamsey show me" returns false.
  - "Hey Jam Sesh" and "JamSesh bring up the nav" return true.
- `Pipeline.hint()` (`pipeline.ts:202`) hardcodes "JamSesh, FigCraft…", so a renamed brain (for example "Jarvis") is never in the whisper prompt. Whisper will write "Travis" or "service".
- "JamSesh is acting weird" (name first, then a copula) is also treated as an address.
- Fix:
  - Add the brain name and its common phonetic variants to the whisper hint.
  - Match with a phonetic or edit-distance comparison plus an alias list: "jam session", "jam sesh", "jamsey".
  - Don't treat the name followed by "is/was/seems/just" as an address.
  - Add tests for these phrasings.

**A2. Record-to-prompt swallows other people's speech and attributes it to the recorder** (major, bug; A8b)
- Evidence: `hub.ts:163-168` (`inPrompt`) and `hub.ts:224` hold any utterance heard by the recording device. Every laptop in the room hears everyone.
- Everything anyone says during the window is pulled out of normal triage. It is joined into `said` (`hub.ts:233`) with no speaker check and sent as the recorder's direct command.
- Fix: hold only lines whose speaker is the recorder or whose loudest device is the recording device. Let other speakers flow as normal room speech. Include speaker names in `said`.

**A3. The voice-enrollment sentence addresses the brain** (major, bug; brief on speaker ID, A10)
- Evidence: `Profile.tsx:63-64` has the person read "Hey {brain}, this is my voice. When I ask you to bring something up on the big screen…". The always-on mic captures it at the same time.
- `addressesBrain` returns true for that sentence. Every enrollment fires the chime, a router pass, and possibly a spoken answer or action.
- Fix: pause or ignore the main mic while enrolling, or start the sentence without the brain's name.

**A4. Barge-in loses the interrupter's words and can cut the brain off by itself** (major, bug; A20)
- Evidence: `mic.ts:248-250` sets `suppressUntil` for `max(2.5s, 75ms × chars) + 0.6s` on every `speak` message. `mic.ts:353` drops any segment that finishes before then.
  - Someone who talks over the brain ("stop, show mobile") has that line discarded. It stays discarded after `fadeOut`, because suppression is never cancelled.
  - `HostView.tsx:79-82` fades the voice whenever the host mic's `speaking` flag goes true after 0.6s of playback. Any speaker echo that gets through AEC cuts the brain off.
  - It only checks at the moment `speaking` flips, so someone already mid-sentence when playback starts never triggers it.
- Fix:
  - Cancel suppression on barge-in.
  - Suppress only segments quieter than the expected echo level.
  - Require a level well above the noise floor for barge-in.

**A5. Pressing Record while muted records nothing and says nothing** (major, ux; A8b, A12)
- Evidence: `annotate.tsx:820-830` never checks the mic. `promptWindow` waits 7s and returns "Nothing was heard in that recording."
- Fix: Record should unmute (or ask to), and show a warning if the mic is off or has an error.

**A6. Voice-to-chime takes about 3 to 4 seconds** (major, ux; A20)
- Evidence: the sequence after someone stops speaking is:
  - 0.7s end-of-speech silence (`mic.ts:16`).
  - Upload, then the settle window of 0.7s + 1.25 × the worst device lag (`pipeline.ts:87-91`), then whisper.
  - Only then `brain.hear` and the chime (`brain.ts:197`).
- The settle wait applies even when only one device has a mic on.
- Fix:
  - Skip or shorten the settle when only one mic device is active.
  - Transcribe the first copy at once and let `revisit` upgrade it.
  - Chime on the first transcription that contains the wake word.
  - Show a "hearing…" indicator.

**A7. Transcription: English only, no model download, and silent failure with no engine** (major, spec-wrong and code-gap; brief on transcription, B28a)
- Evidence:
  - `transcribe.ts:49` forces `-l en`, but SPEC 9.3 says it handles the team's languages.
  - Nothing downloads the model (SPEC 3.2, 15). `config.ts:99-106` only looks for an existing Homebrew `whisper-server` and `~/.cache/whisper-cpp/ggml-*.bin`.
  - With neither those nor a gateway key, `transcribe()` returns an empty string (`transcribe.ts:99`). Nothing is heard and no warning appears. Only Settings text says "using the gateway".
  - The default engine, `ggml-large-v3-turbo-q5_0.bin`, was found on this machine.
- Fix:
  - Language setting defaulting to auto-detect.
  - A visible banner on the big screen when no engine is available.
  - Model download, or correct the spec.

**A8. Mic capture can be dead while the UI says "Listening"** (major, bug and risk; A8c)
- Evidence: `mic.ts:274-284` creates an `AudioContext` and never calls `resume()`. A context created without a user gesture can stay suspended, and the host mic auto-starts on mount (`HostView.tsx:66`).
- Nothing handles the track's `ended` event or `ctx.onstatechange`. AirPods connecting, sleep, or a device change kill capture silently.
- STATUS says WebKit mic capture in the Mac app is not tested. Wry's permission handler defaults to Prompt, so each launch may show a WebKit permission prompt.
- `echoCancellation: true` in WKWebView may switch on Apple's voice processing, which applies its own gain control and may duck other audio. That would undermine the "AGC off, so loudness means distance" assumption.
- Fix: `await ctx.resume()`, handle `track.onended` and `onstatechange` with a restart and a visible state, and test in the Tauri app on the Mac before the session.

**A9. Walk-away speaker ID is weaker than the spec claims** (major, spec-wrong and code-gap; A1c)
- Evidence: SPEC 16 says walk-away is "expected to be correct for enrolled speakers". The bench floor is 50% (`audio.bench.test.ts:168,181`). STATUS says about 50% without a voice sample.
- In `identify` (`pipeline.ts:339`), voice weight is `0.45 + 0.05 × samples`.
  - With 1 to 2 samples, the loudest device's owner (0.9 × 0.5) beats the walker's voice.
  - With one sample, a voice score of 0.8 gives about 0.4 for the walker against about 0.5 for the device owner.
  - It needs roughly 5 or more samples. The 10-second enrollment yields only about 3 to 4.
- Voiceprints are built from owner-at-own-device lines only, so cross-channel matches stay weak.
- Fix: state the real number in the spec. Raise voice weight when the voice margin is large. Ask for a longer enrollment (about 20 seconds, 5 or more samples). Run the bench on real recordings.

**A10. "Only talk when asked" doesn't quiet the room** (minor to major, bug; A11, A20)
- Evidence: `speech.ts:46`. I tested `quietRoom`:
  - "only talk when someone asks you something" returns false. This is the exact example in SPEC 8.9.
  - "only speak when asked" returns false.
  - "be quieter" and "talk less" return true.
- Fix: widen the regex, or have `remember_feedback` set an explicit `quiet` flag.

**A11. Recorded prompts appear twice** (minor to major, ux and bug; A8b)
- Evidence: `hub.ts:175` adds a `speech` event per held line (`forBrain: true`, relevance "work"). `hub.ts:239-248` then adds the combined prompt event. Nothing filters `forBrain` (grepped across `hub/src` and `web/src`).
- The feed, the router's transcript and agent context all show the text twice.
- Fix: hide the held lines, or fold them into the prompt event.

**A12. Record Stop can cut the last sentence** (minor to major, bug; A8b)
- Evidence: `hub.ts:218-229` takes at least `t1 + 2.5s` and two stable polls (0.8s) and times out at 7s. Settle plus whisper can take longer than that. `audio.pending` exists (`pipeline.ts:94`) but nothing uses it.
- A late last line then arrives as ambient speech, outside the prompt.
- The prompt-mode expiry is 3 minutes (`hub.ts:165`), but SPEC 11.3 says 2 minutes.
- Fix: wait while `audio.pending > 0`, and fix the expiry to match the spec.

**A13. Spec statements about remote barge-in and the "Hear brain" switch aren't met** (minor, code-gap; A20)
- Evidence:
  - SPEC 8.8 says remote laptops fade the voice when their mic hears speech. `ClientView.tsx:36-52` has no such logic.
  - It also says each person can turn the voice off. `hearBrain` is read (`ClientView.tsx:40,46`) but nothing writes it. There is no UI.
- Fix: add both. Meanwhile, correct the spec.

**A14. One slow or reconnecting device slows everyone, and old copies can duplicate lines** (minor, bug; A2, A26)
- Evidence: `pipeline.ts:87-91` uses the max lag across all devices ever seen, and lag is an exponential moving average that only updates when that device sends a segment.
  - After an offline buffer flush (segments minutes old), the average stays high.
  - A device that mutes keeps its stale lag forever. Everyone's settle window stays at 3.5s.
  - Remote and room lags are also mixed.
- A copy arriving more than 15 seconds late (`KEEP_FINAL_MS`) becomes its own utterance. It duplicates the line already transcribed from another in-room device, because `echoOf` only compares across locations.
- Fix: clamp or ignore outlier lag samples, expire idle devices, and compute lag per location. Match late copies against stored utterances regardless of age.

**A15. Person matching merges people** (minor to major, bug; B35, A15)
- Evidence: `session.ts:209-218` `personByName` matches by exact name, then first-name equality, then `startsWith`.
  - Two people named "Chris" merge into one.
  - "that was Al" resolves to Alex.
  - An introduction "Dana" can update the wrong person.
  - `upsertPerson` and `relabel` both rely on it.
- Fix: exact match first. Ask or disambiguate when more than one person matches.

**A16. Relabel gaps** (minor, bug; B35, B38)
- Evidence:
  - Relabeling adds a sample to the new person but never removes it from the previous one (`pipeline.ts:394-413`, no removal path).
  - Recorded lines (the `inPrompt` branch, `hub.ts:173-178`) store no embedding. Relabeling one after the 15-second in-memory window teaches nothing.
- Fix: store the embedding on those events, and offer sample removal on relabel.

**A17. Role weights are crude** (minor, spec-wrong; B36, B37)
- Evidence: `session.ts:787-791`.
  - "product" scores 2, so "Product Designer" weighs like a manager.
  - Weight is only advice to the model: it appears in the prompt text and nothing enforces it.
- Fix: narrow the regex (use "product manager", "head of product"). Tell the model to state whose call it followed. Settings already lets weights be set by hand.

**A18. Smaller spec and UX mismatches** (minor)
- SPEC 9.1 says a window starts listening on the first click and "says so". Code starts immediately with no message (`ClientView.tsx:71-74`).
- The brain's voice can't be interrupted when the macOS `say` fallback is used.
- The chime plays on both the speaking laptop and the host speaker, so the person in the room hears two.
- `/audio` dedupe lasts only 4s (`http.ts:288`), but client retries back off longer, so a retried segment can be counted twice.

**Spec problems in this area**
- SPEC 9.1 (gesture start), 9.3 (language, model download), 8.8 (remote barge-in, voice off switch), 11.3 (2 minutes) and 16 (walk-away correctness) each state something the code doesn't do.
- B28b (client whisper workers) is correctly marked Missing. `POST /api/workers` exists, but nothing in the app or web code calls it.
- SPEC 8.2's name-matching description doesn't cover phonetic variants.
- Not stated in the spec at all:
  - What happens when a recorded prompt overlaps other people talking.
  - What happens when no transcription engine is available.
  - What a late copy does after 15 seconds.

**Test gaps:** there are no tests for wake-word variants, recorded prompts with two speakers, barge-in or suppression, record while muted, or the enrollment sentence.

**Key files:** `hub/src/audio/pipeline.ts`, `hub/src/audio/transcribe.ts`, `hub/src/brain/brain.ts`, `hub/src/brain/speech.ts`, `hub/src/hub.ts`, `hub/src/session.ts`, `web/src/shared/mic.ts`, `web/src/shared/annotate.tsx`, `web/src/host/HostView.tsx`, `web/src/client/ClientView.tsx`, `web/src/client/Profile.tsx`.