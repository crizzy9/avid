# Phase 2 — full-book Read & Listen validation

Planning baseline: **2026-10-18**, Avid source `654db63`. This document defines proposed work for milestones **A, E and H** of the [Phase 2 audiobook plan](phase-2-audiobook-plan.md), principally P2-23–28. **The full-book runs, quality targets and device gates below are planned and unrun.** This planning change does not implement a benchmark runner or establish a passing result.

## Evidence and limits at the baseline

The [existing benchmark](read-listen-benchmark.md) covers twelve short clean-English human recordings. Balanced recognition plus the current matcher linked 10/12 source excerpts and 19/21 deliberately reflowed passages, with 0/12 unrelated-book passages linked. Its WebAssembly result ran in Node. The [browser preparation fixture](phase-2-3-read-along.md) covers 15.86 seconds of real narration, two EPUB paragraphs, actual worker preparation, rendered highlighting and warm saved-package playback with fixture audio downloads blocked.

Those results do not measure complete-book completion, independent timestamp accuracy, cold production reopening, original MP3/M4B playback clocks, memory over a long job, or signed-device behavior. The 1,027 tests recorded at the baseline are regression evidence, not substitutes for these gates.

Current implementation constraints to measure rather than silently increase:

- Preparation accepts an EPUB up to 64 MiB, each audio asset up to 512 MiB and total sources up to 2 GiB. Prepared metadata has a 32 MiB limit. Text extraction permits 100,000 passages and 16 million characters; matching permits one million tokens and paragraphs up to 4,096 words.
- Decoding uses bounded 30-second PCM windows, advancing 26 seconds with overlapping recognition context. Blob hashing uses 1 MiB slices. These avoid whole-book PCM allocation, but do not prove bounded overall memory.
- All recognized words remain in memory until matching. Matching input is structured-cloned into another worker, and complete source Blobs remain referenced through verification/storage. The speech model is released before that matching worker starts.
- Completed preparations and verified complete media can be reused. Partial recognition work has no persisted checkpoint and must start again after interruption.
- Recognition is local, English and foreground-only. Current matches are paragraph intervals; a passage cannot span two audio tracks. Paragraph highlighting is not evidence of word-level timing.
- Generated alignment allows the documented whole-second server duration rounding. It does not reconcile MP3 priming, gapless metadata or every decoder's presentation clock.

The baseline must be allowed to fail these tests. Preserve that result, exact failure stage and logs before implementing a fix.

## Fixed corpus and division of work

Use the following public sources. LibriVox identifies its recordings as public domain in the USA; each linked Gutenberg page provides its ebook and rights information. Record the rights and attribution applicable to each fetched artifact. Keep the source license notices with local corpus data.

| Corpus ID | Recording and catalog duration | Independent ebook | Planned role |
| --- | --- | --- | --- |
| `alice-yearsley-v3` | [Alice's Adventures in Wonderland v3, Peter Yearsley — 2:43:00](https://librivox.org/alices-adventures-in-wonderland-by-lewis-carroll-3/) | [Gutenberg #11](https://www.gutenberg.org/ebooks/11) | First complete baseline; development material with repeated dialogue and verse |
| `pride-savage-v3` | [Pride and Prejudice v3, Karen Savage — 10:23:00](https://librivox.org/pride-and-prejudice-by-jane-austen-2/) | [Gutenberg #1342](https://www.gutenberg.org/ebooks/1342) | Long single-narrator validation, many short dialogue paragraphs and chapter boundaries |
| `jane-eyre-volunteers` | [Jane Eyre, LibriVox volunteers — 20:36:36](https://librivox.org/jane-eyre-by-charlotte-bront/) | [Gutenberg #1260](https://www.gutenberg.org/ebooks/1260) | Primary held-out long book; narrator/recording changes and multiple large files |
| `alice-abridged-chenevert-v3` | [Alice, abridged v3, Phil Chenevert — 1:08:01](https://librivox.org/alices-adventures-in-wonderland-abridged-version-3-by-lewis-carroll/) | Full Gutenberg #11 | Edition/omission control; shared passages may align, omitted passages must remain gaps |
| `alice-dramatic` | [Alice, dramatic reading — 2:39:14](https://librivox.org/alices-adventures-in-wonderland-dramatic-reading-by-lewis-carroll/) | Gutenberg #11 | Secondary held-out narration of the same work; multiple voices |

The three primary recordings total **33:42:36 according to their catalogs**. Use measured source durations in reports; do not substitute the catalog totals. Follow each catalog's actual audio links and record the resolved artifact URLs. Acquire a real Gutenberg EPUB, not an EPUB built from recognition output or a prealigned transcript. Catalog title, language and chapter names do not prove that its text is the spoken edition.

Before any recognition, freeze a corpus manifest containing source URLs, fetch date, byte counts, SHA-256 values, recording/version/narrator identity, selected EPUB and spine metadata, and ordered audio assets. Keep original front/back matter, announcements, pauses and recording imperfections. Document edition differences separately; do not remove difficult material to improve a score.

### Baseline first and held-out evaluation

1. Run the unchanged `654db63` implementation on all complete primary inputs. The initial run may expose a decoder or resource failure before matching. That is a baseline failure to record, not a reason to replace the input with an easier excerpt.
2. Use Alice for diagnosis/tuning and Pride and Prejudice for development validation. Keep a preselected deterministic subset of their chapters out of tuning; record its IDs before changes.
3. Archive Jane Eyre and dramatic Alice baseline outputs, but do not inspect their detailed alignment results while tuning. A separate evaluator may inspect operational completion/resource failures. Freeze a candidate matcher/model before unsealing their quality results.
4. If a holdout finding is used to change the implementation, label that material development data from then on. Select and freeze replacement held-out narration before making a generalization claim; do not repeatedly tune against a nominal holdout.
5. Keep the existing twelve-excerpt regression and wrong-book controls. Add cross-pairs between the complete, unrelated primary books. Wrong-book controls do not need repeated ASR when recognition caches have verified, identical source/runtime identities.

This English public-domain set is a first qualification set. It does not represent contemporary fantasy names, every accent, commercial studio production, noisy/nonfiction titles or other languages. Extend the corpus through explicitly licensed or user-owned material after this baseline; never publish private books/transcripts as test fixtures.

## Original encodings, derivatives and source clocks

Test original downloaded chapter MP3s and catalog-provided M4B editions as separate source manifests where available. Do not assume that two containers with the same title contain byte-identical narration, the same cuts or the same timestamps. Check their content and record their independent identity.

Controlled derivatives are a separate diagnostic matrix: PCM reference, CBR/VBR MP3, AAC/M4A, M4B with embedded chapters, altered sample rate/channel count, and a recording split inside a paragraph. Store the exact encoder/version/options and input/output hashes. A successful transcoded WAV does not qualify the failing original MP3; show both results, including unsupported decoding.

Measure ffprobe metadata, production demuxer packet timestamps, decoded sample presentation times and the actual browser/native playback clock at independent audible anchors. Include negative starts/edit lists, MP3 encoder delay/padding, rounded manifest durations, file boundaries, silence, truncated files and missing/reordered/duplicate assets. Preserve original source seconds for chapters, handoff and annotations. Do not enlarge a generic duration tolerance, time-stretch recognized intervals or convert percentages to text locations to conceal a clock discrepancy.

The evaluator may know chapter boundaries or reference text for scoring. Those labels must not become a shortcut used by the production matcher to prove alignment.

## Production-path harness and implementation dependencies

The existing `scripts/benchmark-read-listen.mjs` is an excerpt benchmark, not the full-book runner. Milestone A must add an opt-in full-book harness outside the ordinary unit-test suite. Its implementation/reproduction contract is:

| Layer | Required path and observation |
| --- | --- |
| Corpus adapter | Serve the pinned complete EPUB/audio and a fixture BookOrbit manifest from a disposable local fixture origin. Supply precise and separately rounded canonical-duration variants. Never point mutation-capable testing at the supplied read-only server. |
| EPUB | Open the actual EPUB through the production reader and `extractPublicationText`; retain real spine locations, CFIs and structural paths. Do not substitute regular-expression text extraction or synthetic paragraph locations. |
| Recognition | Use `decodeSpeechWindows`, `LocalTranscriber`, `transcription.worker.ts`, the pinned model/profile and `recognizedWords`. Process every window of every track. Record cache hits separately from fresh recognition. |
| Matching | Use the production matching worker and current algorithm, with the same cancellation and source checks as the app. A separate CPU/CLI investigation is diagnostic and must have its own runtime label. |
| Publication | Exercise `prepareReadListen`, restoration and `PreparedReadListenStore` validation/atomic publication. A computed JSON map alone is not a completed preparation. |
| Interaction | Use the actual transcript panel, rendered EPUB and prepared viewer. Capture the selected passage/DOM text, player source time, chapter/file ID and saved-progress side effects for each action. |
| Native | Repeat source-clock, handoff and playback scenarios in signed physical builds. Browser success and an unsigned native build are not installed-device evidence. |

The first baseline may use the existing foreground workflow without resumability. Milestone E then needs:

- A versioned preparation job with explicit checking/download/model/recognition/match/save stages, visible elapsed/remaining work, pause/cancel/retry, and source/model/runtime identities.
- Durable **processing** checkpoints at completed recognition windows or an equivalently bounded unit, preserving timestamps and overlap acceptance. No partly recognized package is advertised as ready. Revalidate source identities before resuming and before publishing.
- Bounded intermediate transcript/index storage or another measured solution to all-word retention and matching-worker copies. Keep old complete packages intact on cancellation, failed upgrades, quota failures and source changes.
- Clock-specific fixes justified by measured evidence; track-spanning paragraph representation if needed; explicit mismatched-edition/low-coverage diagnosis. Manual repairs must be deliberate, reversible and bound to the exact edition.
- Native lifecycle/resource handling appropriate to each host. A mobile background task is not an unlimited overnight compute guarantee. Unsupported scheduling remains an explicit limitation.

Do not require every dependency to be implemented before recording the baseline. Measure the actual failure first, then use the same frozen corpus to evaluate the fix.

## Metrics and proposed acceptance gates

**Every gate in this section is proposed and unrun.** Freeze definitions, exclusions, sample selection and hardware-specific budgets before scoring the release candidate. Coverage is not correctness; the current token-agreement score is not a calibrated probability.

| ID | Proposed gate | Measurement/report requirement |
| --- | --- | --- |
| P2-FB-01 | All three primary complete pairs finish and reopen, with every required track processed and no unreported failure | Per-window/track completion counts; final package source inventory; elapsed stage times; retain failure records for unsuccessful runs |
| P2-FB-02 | At least 99% correct paragraph identity in an independently reviewed sample; zero catastrophic cross-chapter/wrong-occurrence jumps | At least 600 accepted paragraphs, at least 200 per primary book, deterministically stratified across all chapters and positions; actual counts and uncertainty, never a population-accuracy claim |
| P2-FB-03 | Paragraph boundary p95 absolute error no greater than 1.0 second on each qualified codec/platform path | At least 300 independently labeled start/end boundary pairs overall, at least 100 per primary book; each reported path must include the same labeled material. Report median/p95/max and systematic offset separately for start and end. |
| P2-FB-04 | At least 90% eligible narrated-body-word coverage per matching primary book, and at least 80% in each eligible chapter | Eligibility/exclusions recorded before candidate scoring; separately report all-ebook word coverage, passage coverage, audio-time coverage and longest unmapped narrated interval |
| P2-FB-05 | No usable linked playback from unrelated books; no fabricated intervals for omitted/ambiguous material | Cross-book controls, abridged Alice, repeated phrases, silence, announcements, wrong/missing/reordered tracks and changed EPUB editions; shared abridged passages may legitimately map |
| P2-FB-06 | Actual transcript and EPUB follow the correct passage through seeks/handoffs; unmatched gaps clear highlights | Deterministic actions at beginning/middle/end of every chapter, all asset boundaries and sampled gaps, including backward seek, undo, preview, explicit handoff and speed changes |
| P2-FB-07 | Cancel acknowledges and stops scheduled recognition/matching within two seconds; safe resume repeats at most one unfinished recognition window | Timestamped cancellation/job lifecycle log; separately expose any platform operation that cannot be interrupted; repeat after termination at each processing stage |
| P2-FB-08 | No partial package becomes ready, no prior ready package is lost, and no account/edition crosses a job boundary | Inject quota/write/corruption failures, change sources under reused IDs, switch accounts, restart and retry; inspect exact artifact identities |
| P2-FB-09 | Prepared package cold-opens and plays without network or repeat recognition | Production build/service worker or installed app; terminate before reopen; block all network; use retained package only; verify text, audio, forward/backward handoff and zero new ASR jobs |
| P2-FB-10 | Preparation stays within a measured, predeclared budget on every supported preparation host, and playback remains responsive | Peak memory by process/worker, stage/time series, storage peak/steady state, throughput, UI latency, battery/thermal data where available; no crash/OS termination or unexplained duration-proportional memory growth |

For P2-FB-02, preselect candidate passage IDs by a published seed/hash rule independent of confidence or success. Review all selected accepted matches and report selected gaps separately; additional acceptance-only samples may bring the reviewed accepted total to 600, but cannot replace failed selected examples. Include first/last chapter passages, short dialogue, repeated phrases, long paragraphs and file-crossing passages as an additional risk set. A reviewer listens to the real recording and checks the actual ebook; ASR output is not ground truth.

For P2-FB-03, annotate actual speech start/end in source presentation time before inspecting candidate timing. Establish annotation tolerance and adjudicate ambiguous boundaries. An audio-only reference/decode path may help label, but the browser/native player must still be checked against those audible anchors. Report unsupported clocks rather than deleting them from an aggregate. These are paragraph targets; sentence/word mode needs its own independently labeled gate under P2-24.

For P2-FB-04, label narration omissions, front matter, indexes, notes, illustrations and material absent from one edition. Publish the exclusion inventory and both denominators. Do not remove misrecognitions, hard names, poetry or short dialogue just because they lower coverage. Below-target chapters may remain available as explicitly partial preparations, but they do not pass the full-book qualification gate. Do not reduce safety thresholds to meet coverage.

For P2-FB-10, milestone A records a baseline and proposes numeric budgets for the named desktop and minimum supported physical iPhone/Android device. Freeze those budgets before candidate acceptance; record any later scope/budget change as such. Browser heap alone excludes WASM/native/decoder allocations, so label each measurement source and missing visibility. Sample before model load, after model load, during each book quartile, matching, verification/save and reopened playback. Include cold/warm model loads, elapsed processing seconds per audio hour, peak/retained memory, package/scratch bytes, storage headroom, responsiveness and cool-down/resource release. A bounded PCM buffer is not by itself a pass.

## Interaction and lifecycle matrix

Run the full primary corpus through production preparation on the designated desktop browser. Qualify physical-device preparation on complete inputs appropriate to the declared supported limits, including a long input that exercises the highest required resource load; do not substitute only the short browser fixture. Keep per-device unsupported/failed rows visible. Native prepared playback must exercise the long-book source and all track boundaries even where recognition ran elsewhere through an explicitly implemented transfer mechanism; do not assume such a transfer exists today.

For each supported player/decoder path, cover:

- Normal speed plus representative slow/high speed, repeated seek, chapter transitions, file transitions, terminal tails and known gaps. Capture original-source time separately from wall time and any DSP-adjusted elapsed time.
- A continuous two-hour locked/background mobile listening session, route changes, calls/alarms/audio focus, headphone disconnect and UI recreation, in coordination with milestones B/G/H. Test the whole-book timeline and end-of-book behavior separately; a two-hour soak does not establish completion of a 20-hour recording.
- Termination at model load, recognition, matching, save and prepared playback. Resume job work only where implemented; never claim audio survives all OS process kills. Online native playback checkpoints retain their existing behavior.
- Forward and backward read/listen handoff, deliberate reading preview, return to narration and undo. Inspect the actual DOM highlight and selected transcript passage, not only internal map state.
- Source replaced under the same file ID, manifest changed, same title/different edition, stale correction, account switch, corrupt/missing media, denied persistent storage and low disk space.
- Cold prepared-only reopening with all network blocked and caches/model downloads unavailable. The package must have everything playback needs, but it must not turn on generalized offline editing or progress writes.

## Reproduction and report deliverables

These are deliverables for milestone A/E, not files already present. Do not publish commands that invoke an unimplemented runner as if they work. The runner's implementation commit must include an executable reproduction guide with the exact command lines, prerequisites and output paths below, followed by recorded command/result evidence.

1. **Corpus manifest**: immutable IDs/roles, all source URLs and hashes, EPUB version/spine identity, ordered original audio assets, codec/probe details, declared and measured durations, licenses and optional derivative recipes. No passwords or private remote URLs.
2. **Runner and versioned schema**: an opt-in full-book entry point taking explicit corpus manifest, local corpus directory, profile/model revision, runtime/host, baseline/candidate commit and output directory. Validate hashes before reuse; stop or mark invalid if code/input identities change during a run. Record all stages, including early failure.
3. **Reference labels and split manifest**: sampling seed/rule, development/validation/holdout IDs, eligible-text/exclusion labels, reviewed paragraph identity and source-time boundary labels, reviewer/adjudication method and annotation version. Preserve labels independently of recognition caches.
4. **Raw local run directory**: one directory per run ID containing environment/build metadata, recognition/checkpoint cache, stage timing/resource samples, full diagnostic logs and evaluation details. Keep full source media, private data, full transcripts and model caches outside Git.
5. **Sanitized checked-in evidence**: `docs/evidence/read-listen-full-book-<date>-<run-id>.json` with schema version, baseline/candidate status, source/model/code/runtime/decoder hashes, per-book/per-chapter counts, independently reviewed correctness/timing, coverage denominators, gap statistics, resource measurements and all failures. This is a proposed naming convention; no such report is created by this plan.
6. **Browser/native report**: exact app commit/build, OS/device/browser/runtime versions, preparation and playback origins, storage/network state, action log, expected/actual DOM/source position, screenshots or recordings where useful, results for every applicable P2-FB gate and explicit blocked/unsupported rows.
7. **Comparison and reproduction guide**: baseline versus candidate on the same corpus, fresh-recognition versus cache use, original versus derivative encoding, CPU diagnostic versus browser worker, and desktop versus native results. Include exact frozen dependency/model setup, download/verify commands, runner invocation, scoring invocation and playback/cold-start procedure from the implemented harness.

The existing commands remain useful regression checks after implementation:

```sh
pnpm test
pnpm typecheck
pnpm build
```

The optional `node --experimental-strip-types scripts/verify-read-listen.mjs --wasm` and existing excerpt benchmark remain **short smoke tests**. See their current [reproduction instructions](read-listen-benchmark.md#reproduce); neither command is a full-book run. Network/model downloads are opt-in and must not become part of routine unit tests.

For a final candidate, regenerate evidence after code/model/decoder changes that affect the tested path. Reusing verified recognition for a matcher-only change is valid only when declared in the report; it does not certify a new decoder/model/runtime. Never silently merge passing stages from different source revisions into one end-to-end pass.

## Phase boundary and completion

Preparation scratch checkpoints, source validation, bounded processing, native playback ownership and cold reopening of the complete prepared Read & Listen package are Phase 2. Resuming processing of already verified media is distinct from implementing a general byte-range media download manager.

The prepared viewer retains its current **session-only listening/reading positions**. It must not gain offline notes/highlights, durable progress/activity writes or conflict reconciliation through this work. Preserve existing online native checkpoints, account-scoped journals and ordinary audiobook settings/queue persistence; these are not removed or reclassified as Phase 3.

General resumable/batch downloads, offline library/search, storage eviction policies, downloaded wearable libraries, retained server-voice libraries, offline notes/highlights and durable offline progress synchronization remain **Phase 3**, as specified in the [master plan](phase-2-audiobook-plan.md#scope-and-phase-boundary).

Milestone A closes when complete-input baseline evidence and reproducible measurements exist, including failures. Milestone E closes only when the applicable proposed gates have been finalized and passed, with held-out results and actual rendered/native evidence. A partial preparation can be useful without qualifying a claim that arbitrary real books match reliably. Phase 2 completion additionally requires the rest of the audiobook ledger and platform gates; this validation plan covers Read & Listen rather than the entire audio product.
