# Transcription bake-off (5.1)

Which engine transcribes the room on the host. Run 2026-10-29 on one Mac (macOS 26.5, Apple
silicon), apart from any room; nothing was uploaded. **Synthetic clips only**: the office reruns
this with 30 to 60 clips recorded in a real room before the numbers are trusted. No audio is in the
repo.

## The proxy set

- 50 clips (157 s), 16 kHz mono: room lines read by 14 macOS voices with `say -o` at 150 to 235
  words a minute, plus 3 clips of pure noise or silence.
- The room's words: Chey (spoken "Shay", as people say it), Britt, Felipe, Jonathan, JamSesh,
  Passport (and one real "password"), FigCraft, Fluid, Mist, bento, parity, left-hand nav: 74
  scored occurrences.
- 22 clean clips, 10 with pink noise, 9 with a second voice 18 dB down, 9 with room echo.

## Results

Word error rate (WER), names and terms found, and latency per clip (median; model loaded).
"+ fix" is after the correction pass with the vocabulary and two "heard as" lines
("Chey: Shay, Shea, Shae", "Britt: Brit, Britton").

| Engine | WER | Names | WER + fix | Names + fix | Median | Memory |
|---|---|---|---|---|---|---|
| whisper.cpp large-v3-turbo q5, prompt "JamSesh." (today) | 9.0% | 73% | 6.3% | 88% | 296 ms | 876 MB |
| whisper.cpp large-v3-turbo q5, vocabulary prompt | 6.1% | 89% | **4.7%** | 96% | 307 ms | 876 MB |
| Parakeet TDT 0.6B v2 int8, greedy | 12.6% | 66% | 7.0% | 85% | 93 ms | 2.0 GB |
| **Parakeet TDT 0.6B v2 int8, hotwords (score 2)** | 7.4% | 85% | 5.2% | **97%** | 104 ms | 2.0 GB |
| Parakeet TDT 0.6B v3 int8, hotwords | 17.7% | 69% | 14.3% | 81% | 89 ms | 2.0 GB |
| Apple SpeechTranscriber (contextual strings: no effect) | 26.9% | 46% | 21.5% | 62% | 93 ms | system service |
| Apple DictationTranscriber, contextual strings | 33.4% | 45% | 31.8% | 49% | 371 ms | system service |

On an 18-second clip both whisper (Metal) and Parakeet (CPU, 4 threads) take 0.5 to 0.7 s.

## What it showed

- Parakeet v2 with hotwords and whisper with a vocabulary prompt tie once corrected (about two
  words apart in 470). Both are far ahead of today's hub.
- The vocabulary is the biggest lever for both engines; the correction pass helps every engine, and
  "Chey" is only reachable through a "heard as" line, since every engine writes "Shay".
- Parakeet v3 is worse than v2 in English. Apple's `SpeechTranscriber` ignores contextual strings;
  `DictationTranscriber` uses them but is worse overall. Apple's transcribers ran headless with no
  prompt, but their assets were already installed on this Mac.
- With hotwords, Parakeet invents the room's words on pure noise or silence ("Passport, passport.").
  Speech with a noisy tail was fine. The hub's speech gate keeps such clips from engines, and a line
  made only of the room's words is dropped.
- A second voice about 11 dB down took over one clip's transcript for every engine. Real rooms
  should test overlapping talk.

## Decision

**whisper.cpp with the vocabulary prompt and the correction pass is the default host engine**
(SPEC 9.3). The Mac app bundles `whisper-server` (whisper.cpp, MIT, arm64 with Metal) and
downloads the model on a Mac's first host session, pinned by SHA-256, while the gateway covers the room. It had the lowest word error here, uses under half Parakeet's memory (876 MB against
about 2 GB), needs no 482 MB download, works in any language, and doesn't invent the room's words on
silence.

**Parakeet TDT 0.6B v2 with hotwords is an opt-in**: Settings > Transcription > "Faster engine
(English only, downloads 482 MB, uses about 2 GB memory)". It's three times faster on typical lines
and runs on sherpa-onnx, which the app already ships. The model (CC-BY-4.0, from sherpa-onnx's
GitHub release with a pinned SHA-256) downloads only when the host turns it on, and once it's ready
it goes first. The gateway is the fallback, and the correction pass and the room-words-only drop
apply to every engine.

**The office's bake-off with real voices decides whether the default flips to Parakeet.** Run it on
30 to 60 clips recorded in a real room, including the names that fail, before changing it.

Parakeet's hotwords in sherpa-onnx need `modelingUnit: "bpe"` with a `bpeVocab` file; the model
package has none, so the hub writes one from `tokens.txt`.

## Rerun: Parakeet v3 on the GPU (2026-11-13)

Parakeet TDT 0.6B v3 (Q8_0 GGUF) through transcribe.cpp on Metal, with Hex's fork rescoring the
room's single-word terms, against whisper.cpp large-v3-turbo q5 with the vocabulary prompt, both
through the path a room line takes (`Transcriber.transcribe`: the brain's hint, the clip's SNR, the
room's names, then the correction pass with "Chey: Shay, Shea, Shae" and "Britt: Brit, Britton").
The harness is `hub/test/transcription-bakeoff.bench.ts`; the 5.1 clips weren't kept, so it speaks a
new synthetic set the same way (14 English voices, seeded noise): 22 clean room lines, 10 with pink
noise 10 dB down, 9 with a second voice 18 dB down, 9 with room echo, 9 with look-alike words and
none of the room's (Brett, Britain, shade, fig jam, password, parody, fluent, jam session,
Philippe), 5 with repeated words, 10 in German, French, Spanish, Italian, Dutch, Portuguese, Polish
and Swedish, and 3 with no speech. "Terms" counts the room's words said and written; a false
insertion is one written that wasn't said.

| Group | Clips | whisper WER | v3 WER | whisper terms | v3 terms | whisper false ins. | v3 false ins. |
|---|---|---|---|---|---|---|---|
| clean | 22 | 4.5% | 6.3% | 53/54 | 48/54 | 0 | 0 |
| noise | 10 | 18.3% | 23.1% | 20/25 | 19/25 | 0 | 0 |
| second voice | 9 | 0.0% | 11.4% | 22/22 | 19/22 | 0 | 0 |
| echo | 9 | 12.2% | 23.3% | 22/25 | 15/25 | 0 | 0 |
| look-alikes | 9 | 1.1% | 1.1% | - | - | 1 | 1 |
| repeated words | 5 | 0.0% | 0.0% | 2/2 | 2/2 | 0 | 0 |
| other languages | 10 | 4.6% | 5.7% | 10/10 | 9/10 | 1 | 1 |
| no speech | 3 | 0 words | 0 words | - | - | 0 | 0 |
| **all** | 77 | 6.2% | 10.3% | 129/138 | 112/138 | 2 | 2 |

Median time per clip: about 150 ms for Parakeet v3, about 470 ms for whisper (one Mac, heavily
loaded). Both wrote "Felipe" for "Philippe", and both scored one false insertion in Polish, where
"Jonathana" (the room's name, inflected) came out "Jonathan".

**Decision:** the rule for making Parakeet v3 the default was word error within one point of
whisper's overall, term recall at least whisper's, and no more false insertions. v3 is close on
clean speech but falls behind with noise and echo (10.3% against 6.2% overall, 81% against 93% of
terms), so **whisper stays the default** and Parakeet v3 stays the opt-in faster engine.
