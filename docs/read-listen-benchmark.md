# Read & Listen matching evidence

Updated 2026-10-18. These checks measure a bounded implementation, not arbitrary-book accuracy or feature parity with another reader.

The default **Balanced** profile uses quantized `Xenova/whisper-base.en` at `95bf40a508535962c6483ead40270b2e32267508`. **Compact** retains `Xenova/whisper-tiny.en` at `79fb389fc764e7c395bd330e9531d9d32ada7049`. Their ONNX model files are approximately 75 MiB and 40 MiB respectively, plus tokenizer/configuration data and runtime memory. Both process English audio locally. The model choice is explicit in preparation; neither sends book/audio content to a recognition service.

## Fixed human-audio benchmark

Source: [Mini LibriSpeech, OpenSLR 31](https://openslr.org/31/), `dev-clean-2`, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Attribution: LibriSpeech authors Vassil Panayotov, Guoguo Chen, Daniel Povey and Sanjeev Khudanpur; original recordings from LibriVox volunteers. The archive remains outside the repository. A separately attributed short excerpt is included in the development reader fixture.

Selection was fixed before recognition: first four numeric speaker IDs, first numeric chapter for each, first three sorted utterance IDs per chapter. That yields twelve excerpts from speakers 84, 174, 251 and 777. We did not select examples based on whether they matched. Source passage tests use the supplied transcripts; the reflow test deliberately divides longer transcripts into two ten-word anchors surrounding short paragraphs. These are controlled layout changes, not the original publisher's paragraph boundaries.

| Recognizer / matcher | Source excerpts linked | Reflowed passages linked | Unrelated-book passages linked |
| --- | ---: | ---: | ---: |
| Compact + previous matcher | 5/12 | 6/21 | 0/12 |
| Compact + current matcher | 5/12 | 7/21 | 0/12 |
| Balanced + previous matcher | 10/12 | 12/21 | 0/12 |
| Balanced + current matcher | 10/12 | 19/21 | 0/12 |

The Balanced results were also reproduced with the actual ONNX **web WebAssembly backend hosted in Node**, using one WASM thread. This CLI run is distinct from browser-worker and installed-device testing. Final sanitized reports are checked in for [Compact CPU](evidence/read-listen-compact-2026-10-18.json), [Balanced CPU](evidence/read-listen-balanced-2026-10-18.json), and [Balanced WASM](evidence/read-listen-balanced-wasm-2026-10-18.json). They contain aggregate and per-excerpt counts, audio/reference/PCM hashes, model revisions, matcher and baseline hashes, and exact runtime versions. No audio, transcript text, or inference caches are included.

Both CPU profiles were recognized again for these final reports; the WASM comparison was rerun against its measured, identity-checked WASM transcripts. All three use Node 24.20.0 and Transformers.js 4.3.1. CPU uses ONNX Runtime 1.30.0; WASM uses ONNX Runtime Web 1.31.0-dev.20260914-8d85527a0 with one thread. No final report relies on legacy transcripts with unrecorded runtime metadata. The final matcher SHA-256 is `c4a46968307d681e7a117a3edf71ecca038d37b198e79f3d1e170b6513756486`; the previous matcher from `c6ad269` is `779c9347ecac913d5a1b933a1cbeeac5745afcd76439552c6efb3065c6b7bbce`.

This small clean-English set does not measure word-boundary accuracy, long-book completion, mismatched/abridged editions, noisy recordings, every accent, another language, or iOS memory/background behavior. Several phrases remain unmapped. A 10/12 result is **not** a claim of 83% accuracy on users' books.

## Matcher behavior

`avid-word-match-v2` retains the 88% token-agreement floor. It checks distinctive text against observed recognizer words, independent of audio/ebook chapter names. It handles conservative English spelling variants (0–99, Mr./Mrs./Dr., punctuation) without fuzzy name substitutions. Unique long paragraphs are checked in bounded pieces up to 4,096 words. Missing middle sections fail rather than stretching a partial match across them.

Short dialogue and repeated paragraphs need independently matched text on both sides. The contextual pass checks occurrence counts and competing observed spans inside that interval. Extra or omitted repeated replies, overlapping repeated phrases and equally plausible recordings remain gaps. A word that has no valid observed interval is not assigned an invented timestamp. The displayed confidence is agreement with the ebook, not a calibrated probability.

Prepared source identity remains unchanged: full EPUB/audio hashes, source CFIs, manifest revision, account and file identity are checked again on reopen. Previous v1 preparations remain readable. Starting preparation with an old matcher or a different model reuses verified complete source media, recomputes the comparison, and publishes a new result only on success. The existing saved package is retained. No offline progress, note, highlight or synchronization system is enabled by this change.

## Server duration provenance and bounded compatibility

BookOrbit's scanned per-file durations are **rounded whole seconds**. In the inspected v3.3.0 source, [`parseAudioDuration` reads ffprobe's format duration and `parseDurationSeconds` applies `Math.round`](https://github.com/bookorbit/bookorbit/blob/e767358443419253eeed782518d6fc4f675d69fd/server/src/modules/metadata/extractors/audio.extractor.ts#L142); the [database column is an integer](https://github.com/bookorbit/bookorbit/blob/e767358443419253eeed782518d6fc4f675d69fd/server/src/db/schema/books.ts#L89). The [manifest multiplies that stored value by 1,000](https://github.com/bookorbit/bookorbit/blob/e767358443419253eeed782518d6fc4f675d69fd/server/src/modules/audiobook/audiobook.service.ts#L218). The inspected [v3.4.0 extractor](https://github.com/bookorbit/bookorbit/blob/2cc0906/server/src/modules/metadata/extractors/audio.extractor.ts#L271) retains this behavior. The server itself documents the possible half-second rounded tail and permits a bounded overrun when saving playback positions. Refreshing metadata cannot recover precision deliberately discarded by that schema.

A local check used the included 15.86-second human WAV and ordinary `ffmpeg 9.0.1` conversions (`libmp3lame -q:a 4` and `aac -b:a 64k`, preserving the 16 kHz sample rate). `ffprobe` and the actual Mediabunny 1.61.6 demuxer reported:

| Source | ffprobe format duration | Mediabunny packet end (`computeDuration`) | BookOrbit rounded manifest | Old 2 ms check |
| --- | ---: | ---: | ---: | --- |
| PCM WAV | 15.860 s | 15.860 s | 16.000 s | rejected, 140 ms |
| AAC in M4A | 15.860 s | 15.860 s | 16.000 s | rejected, 140 ms |
| LAME MP3 | 15.860 s | 15.948 s | 16.000 s | rejected, 52 ms |

This establishes a real rejection of valid source bytes; it is not an inference from file extensions. Mediabunny's `computeDuration` is the final packet timestamp plus its duration, not a browser playback-clock measurement. The MP3's ffprobe stream start was 0.069062 s while Mediabunny began at zero; the extra 88 ms packet span exposes a separate priming/padding question. The M4A's first packet began at −0.064 s and its presentation end remained 15.86 s.

For **generated** alignment only, Avid now accepts a difference of at most **0.502 s when the canonical manifest duration is a whole second**: the documented half-second rounding plus the existing 2 ms precision allowance. Fractional manifest values retain the 2 ms check. Preparation decodes only the overlap `min(packetEnd, canonicalDuration)`; it does not extend a short recording with recognition silence, transcribe beyond the next canonical track boundary, scale timestamps, or change cumulative manifest offsets. Complete source hashes and manifest identity checks remain required. Player compatibility uses the same rule. Authored SMIL timing retains the strict 2 ms check.

A longer decoded tail remains audible but is unaligned: follow and handoff check the active track's half-open canonical interval before interpreting the global position, so a tail cannot select the next track's text prematurely. Regression tests cover rounded WAV values, both shorter and longer observations, unmodified source sample times, incompatible durations, cancellation, generated handoff offsets, and unchanged strict SMIL behavior.

This does **not** correct codec priming or prove that every browser decoder and playback engine share an MP3 clock. No extra codec-padding allowance is added. Some whole-second MP3 tracks can still be rejected when padding pushes their packet end beyond the 0.502 s band; matching total duration alone does not resolve a start-time offset. MP3/M4A encoding variations, gapless metadata, long multi-file narration, and installed-device timing still need qualification. The public WAV fixture and synthetic tests do not establish that coverage.

## Reproduce

Use Node 24, the repository dependencies and `ffmpeg` on PATH. Network access is needed for the public corpus and uncached model data. The included fixture smoke needs no corpus download.

```sh
# Actual included human narration, current pinned model, real timestamps:
node --experimental-strip-types scripts/verify-read-listen.mjs --wasm

# Optional larger, fixed public sample (about 126 MB download):
curl -L --fail https://openslr.trmal.net/resources/31/dev-clean-2.tar.gz -o /tmp/avid-dev-clean-2.tar.gz
mkdir -p /tmp/avid-real-speech
tar -xzf /tmp/avid-dev-clean-2.tar.gz -C /tmp/avid-real-speech
# c6ad269 is the previous preparation implementation, not an imported reference app.
git show c6ad269:packages/playback/src/generated-alignment.ts > /tmp/avid-generated-alignment-baseline.ts
node --experimental-strip-types scripts/benchmark-read-listen.mjs \
  --corpus /tmp/avid-real-speech/LibriSpeech/dev-clean-2 \
  --output /tmp/avid-benchmark-base-wasm.json \
  --baseline /tmp/avid-generated-alignment-baseline.ts --wasm
```

The benchmark saves a local `.transcripts.json` cache beside its report. Cache reuse checks model, runtime, source audio identity, timestamp filtering and decoder identity. Reference text is always read again from the corpus and its current hash recorded. A matcher-source change during execution invalidates the final report. Keep the transcript cache outside the repository; the checked-in evidence retains only the sanitized fields described above.
