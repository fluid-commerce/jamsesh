# Decisions for Chey in the morning

1. Person identity on first join (from the Phase 3 fix): a newly paired
   browser can say it's anyone the first time it joins. Closing this needs a
   host confirmation step ("Is this really Felipe's laptop?"). One person can
   use a phone and a laptop, so blocking second devices isn't right. Choose
   between trusting first join (today) and having the host confirm new
   devices.
2. No UI to move a paired browser to another person (host control).
3. Triage cadence: overheard cards, plus a spoken mention of waiting cards
   at most every 20 minutes. Check whether the board feels like too much in
   a real room.
4. Shipped-feature parity: a parity check happens only when the shipping
   agent itself says what a person sees in its "shipped" update. JamSesh
   then asks the other platform's agent to compare and confirm a gap with
   the shipper before building anything. It's never sent as build work, and
   the brain never decides on its own that something is visible. I settled
   this after three reviews objected to the model guessing. Say if you'd
   rather it build straight away, or never coordinate.

Housekeeping for Chey:
- A macOS Screen Recording permission prompt for the terminal may be on
  screen, triggered by a test of the Mac app capture helper. Click Deny or
  Don't Allow unless you want to grant it.
5. Transcription engine: the synthetic bake-off tied (whisper with the
   room's vocabulary at 4.7% WER and 96% names, against Parakeet at 5.2% and
   97%). I made whisper the default because it has less memory, no download,
   any language, and no invented words on silence. Parakeet is an opt-in in
   Settings. The office bake-off with real clips decides for good.
6. "Chey" is transcribed as "Shay" by every engine. It's fixed through a
   Settings entry, "Chey: Shay", under Words to listen for. Add it, and any
   other misheard names, in the room.
7. (DECIDED 2026-10-29: voice travel cut) Voiceprint travel consent: the join voice read has a checkbox, ticked by
   default, that reads "Keep my voice on this device and bring it to rooms I
   join". It stores numbers only, never a recording. Choose whether it should
   start unticked.
8. (DECIDED: cut with voice travel) Voiceprints on the Mac app belong to the app's own person, the "me"
   profile picked once on that Mac. A host gets your voiceprint only after
   you click Share in a native dialog the first time you join that host.
   Several people sharing one Mac app is out of scope.
9. Fonts: the canvas no longer quietly reads fonts from your own Mac.
   Every font that isn't open-licensed, including one only you have, is
   shared through the native "I'm allowed to share it" dialog. The page
   comes from the host, so reading local fonts without asking would let
   any host take them. One click per font per session.
10. Parity recipients: when an agent ships something it says people see, JamSesh asks every other agent "does your app have it". Agents only record a repository and platform, not which product they belong to. In a room with two unrelated products, the other product's agent gets the question and answers "no gap". Choose whether that's fine, or whether agents should declare a product when they join so parity stays within one product.
11. Files change what JamSesh does on its own (Phase 4): when a message has a file attached, JamSesh no longer sends work straight to an agent or changes the big screen. It puts a card on the Tasks board, and a person presses Send. A message without files works as before. This replaces word matching, which reviews broke five rounds in a row. Say if you'd rather files to JamSesh act directly.
12. (DECIDED: test here; running) Real Mac capture and input (Phase 6): testing them needs Screen Recording and Accessibility permissions granted on this Mac. Either test here now, or leave it as an office release check that doesn't block the review.
13. DECIDED 2026-10-29: Phase 5 ships without voice travel between hosts and without sound-based dedupe. Voiceprints stay on the host that learned them; dedupe compares words only and keeps both lines when unsure. Both can return as a separate project.
14. Wiki (Phase 7), disputed with the reviewer: if a person edits a wiki page to exactly the text JamSesh proposed, JamSesh records the proposal as accepted and its sources as read. The reviewer calls that a misrecord. I think the outcome is right, since the page says exactly what was proposed, and it keeps bookkeeping fields out of the pages people read in Obsidian. Rule on it if you disagree.
