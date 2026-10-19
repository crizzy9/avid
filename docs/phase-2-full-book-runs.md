# Full-book baseline runs — October 19, 2026

Milestone A is **in progress**. The complete three-book corpus and browser runner are implemented; full-input baseline completion, independent accuracy/timing review, cold prepared-only reopening and native acceptance are not yet established. The matcher/model/decoder remain unchanged from `654db63`. [The acceptance plan](phase-2-full-book-validation.md) still governs the later qualification work.

## Frozen corpus

The [checked-in manifest](evidence/read-listen-full-book-corpus-2026-10-19.json) identifies **112 original MP3s and three independently downloaded Gutenberg EPUBs**, 1,992,081,598 bytes in total. All files passed size/SHA-256 verification; original MP3s also match Archive’s published SHA-1 values. Source snapshots, rights notices, probes and download receipts remain beside the local corpus, outside Git.

| Book | Tracks | Measured original duration | Role |
| --- | ---: | ---: | --- |
| Alice, Peter Yearsley v3 | 12 | 2:42:38.406 | Development baseline |
| Pride and Prejudice, Karen Savage v3 | 61 | 10:46:03.223 | Development validation |
| Jane Eyre, volunteers | 39 | 20:36:55.839 | Held-out quality evaluation |

Total: **34:05:37.468**. Pride’s catalog headline differs from its chapter list; the downloaded original set is preserved without trimming. Jane’s detailed alignment quality must remain uninspected during development. The manifest freezes development/withheld chapter selections; independently annotated scoring samples and the two additional control recordings remain pending.

## What the runner measures

The fixture opens the real EPUB through `Reader`, then calls the unchanged `prepareReadListen`, audio decoder, speech worker, matcher worker and `PreparedReadListenStore`. It downloads and verifies every original audio track. Manifest durations are rounded to whole seconds to exercise the existing server-duration policy. Precise-duration variants and additional codecs are later experiments.

The local server builds a production bundle with configuration/environment loading disabled. It has no BookOrbit proxy or user credentials. The fixture adapter rejects external server requests, progress writes and annotation writes. Source hashes are compared with the baseline before bundling and rechecked afterwards; corpus, harness and built-asset hashes accompany the reports. A frozen Git snapshot prevents subsequent application edits from changing a running experiment. There is no HMR.

Each attempt uses a fresh prepared-package database; each browser run has an isolated profile. Existing output reservations cannot be reused. A cached ready package is not accepted as fresh recognition. Speech-model files may be seeded from an explicitly provided local cache only after their hashes are recorded; the unmodified worker still uses its pinned model revision. Missing assets use its ordinary public model download. This is not a cold-model-download measurement.

Outputs include ordered progress samples, extracted passage count, track recognition time/word count, source inventory, model/runtime identity and either an explicit failure or completed preparation. Raw publication text, recognized words and alignment diagnostics remain local. Chromium process RSS/CPU are sampled separately from JS heap. RSS sums may double-count shared pages and do not establish private memory; samples can miss peaks. Total instrumented wall time includes diagnostic serialization/I/O. A harness evidence-write failure is labeled separately from a preparation failure.

**“Prepared” is operational completion, not correct alignment.** No coverage value establishes accuracy, and no browser run establishes native source-clock correctness. The current runner does not automate the final rendered transcript/highlight interactions, independent scoring, cold offline reopen or mobile lifecycle matrix.

## Recorded exploratory attempt

The [sanitized exploratory evidence](evidence/read-listen-full-book-2026-10-19-alice-exploratory.json) records a deliberately cancelled Alice run before the bundled, supervised restart:

- Actual production extraction: **875 passages**.
- First original track processed: declared 787 source seconds, 1,051 recognized words, 335.586 seconds of recognition. No accuracy review was performed.
- Run cancelled during recognition after **519 seconds** of instrumented preparation; no package completion claimed.
- Chromium 155.0.8059.39 on Linux; no recorded browser exceptions. Peak sampled sum of process RSS: **2,873,335,808 bytes**, with the limitations above.

A separate 45-second bundled-production smoke reached recognition and ended with the expected watchdog failure; its partial report was retained locally. This validates startup/error reporting, not full-book preparation.

This exploratory run used the earlier development fixture. Its report retains the actual source proof and runtime; it is not silently combined with the bundled run into one pass. It establishes neither a full-book throughput budget nor a mobile memory target.

## Reproduce

Use the repository’s Nix dev shell (or Node 24, installed locked dependencies, Chromium, Python 3, curl and FFmpeg/ffprobe). Corpus/model downloads are opt-in. Allow approximately 2 GB for original sources plus model files, browser profiles, prepared packages and diagnostics. Recognition may run for many hours; suspend, logout or host shutdown may interrupt it. Partial recognition is not resumable in the unchanged baseline.

```sh
nix develop
pnpm install --frozen-lockfile
node scripts/full-book-corpus.mjs --fetch --concurrency 6 \
  --root /tmp/avid-full-books
node scripts/full-book-corpus.mjs --verify \
  --root /tmp/avid-full-books \
  --manifest docs/evidence/read-listen-full-book-corpus-2026-10-19.json
```

The separate verification step checks the downloaded bytes against the checked-in source identities. A mutable upstream source change must be investigated; do not overwrite the manifest merely to make verification pass. The fetcher's `--evidence <new-file>` option is for an intentional, separately reviewed corpus revision.

For a foreground run from the checked-out implementation:

```sh
node scripts/run-full-book-suite.mjs \
  --corpus /tmp/avid-full-books \
  --output /tmp/avid-full-book-baseline-NEW-RUN \
  --port 5185 --book-timeout-ms 86400000
```

Always choose a new output directory. Set `AVID_CHROMIUM` to the Chromium executable if needed. `AVID_MODEL_CACHE` optionally names a local tree containing the exact `Xenova/whisper-base.en/95bf40a508535962c6483ead40270b2e32267508/` files; no model or book files belong in Git. The `balanced` profile is fixed for this baseline; changing it requires a separately labeled comparison.

For a durable Linux run, archive the tested implementation commit to a separate directory, make the installed dependencies available there, and run the suite under a transient user service. Set `AVID_BASELINE_REPOSITORY` to the original repository for read-only `git show` comparisons, and `AVID_SOURCE_COMMIT` to the archived commit. The service survives this terminal/chat but is not a recurring job, does not alter the test server and does not automatically publish results. It depends on the host remaining awake and its user service manager staying active.

```sh
systemctl --user status avid-full-book-baseline
journalctl --user -u avid-full-book-baseline -f
systemctl --user stop avid-full-book-baseline
```

Stopping preserves partial evidence and terminates owned browser/server children. Retrying requires a new output directory and repeats recognition. Inspect the suite summary, each book’s terminal report and browser-runtime samples together; absence of a terminal report is not success. A failed book must remain visible even if later books complete.

## Remaining work

Finish the three unchanged complete-input baselines and publish sanitized terminal results. Use those measured failures to set Milestone E’s next implementation targets. Then add independently labeled quality/timing evaluation, unrelated/abridged controls, original-codec clock comparisons, rendered interactions and cold prepared reopening. Physical iOS/Android and packaged desktop evidence remain separate requirements.

Broader offline downloads, offline library/search, durable offline progress/notes/highlights and reconciliation stay in **Phase 3**. This runner adds no such functionality.
