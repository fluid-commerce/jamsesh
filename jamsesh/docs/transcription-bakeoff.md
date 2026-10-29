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

Parakeet TDT 0.6B v2 with hotwords is the host engine (SPEC 9.3): it ties whisper on accuracy, is
three times faster on typical lines, and runs on sherpa-onnx, which the app already ships, so
nothing new is bundled. The model (482 MB, CC-BY-4.0, from sherpa-onnx's GitHub release with a
pinned SHA-256) is downloaded on a Mac's first host session rather than bundled, because only hosts
need it. Its cost is about 2 GB of memory in its own process while the hub runs. whisper.cpp stays
second (and takes other languages), and the gateway is the fallback. The correction pass runs after
every engine.

Parakeet's hotwords in sherpa-onnx need `modelingUnit: "bpe"` with a `bpeVocab` file; the model
package has none, so the hub writes one from `tokens.txt`.
