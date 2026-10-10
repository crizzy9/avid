# Avid roadmap

Updated: 2026-10-10. This is the current delivery order, superseding the phase numbers in the [historical research baseline](research-baseline.md). Requirement IDs stay stable: F01–F66 belong to Phase 1; F67–F71 now belong to Phase 3.

| Phase | Outcome | Current state |
| --- | --- | --- |
| 1 | Core online library, readers, listening, sync and native integrations | Working development preview; implementation and acceptance gates remain open. |
| 2 | Complete online audiobook experience and advanced audio features | Next feature phase; moved ahead of offline support. |
| 3 | Full offline reading and listening | Former Phase 2; F67–F71 remain unimplemented as a complete offline system. |
| 4 | Apple Pencil and reader enhancements | Planned. |
| 5 | UI enhancements | Planned. |
| 6 | Remove Apogee references, cleanup, README/docs and launch | Planned. |

Phase 2 engineering may proceed alongside Phase 1 checks that require hardware or external accounts. That does not close Phase 1 or waive its release gates. Fix correctness and accessibility defects when discovered rather than waiting for a later enhancement phase. The [Phase 1 checklist](phase-1-status.md) records evidence; the [validation guide](phase-1-validation.md) explains how to finish pending items.

## Phase 1 — core online product

Deliver the existing 66 requirements across applicable web, iOS, Android, macOS, Windows and Linux surfaces: connected libraries, ebook/PDF/comic readers, audio and existing aligned read-along, notes, collections, progress/activity, recovery, native controls and integrations.

The validated source checkpoint `430b8b6` passed 657 shared tests, TypeScript, the web build and all five native CI jobs. Unsigned compilation is not installed-device acceptance. Outstanding work includes:

- Signed development installs and real background playback, interruption, account switching, storage/recovery, widget, shortcut and car tests.
- Remaining behavior gaps, including JavaScript-dependent speech continuation, limited desktop speech boundaries, prepared-audio-only car catalogs and AO3 changed-edition location handling. Phase 2 audio work can close related Phase 1 gaps, but the corresponding Phase 1 rows stay open until verified.
- Live provider login, writable multi-client synchronization, physical CrossPoint and KOReader qualification, and an authorized AO3 update workflow. Native OIDC currently uses the documented custom callback scheme; HTTPS Universal/App Links are not implemented.
- A representative format/codec corpus, assistive-technology and seven-language acceptance, the remaining reference-layout audit, and native-specific guides.

**Exit:** every applicable F01–F66 acceptance check has recorded evidence, and unsupported platform behavior is explicitly resolved or agreed as a scope change. The supplied BookOrbit instance stays read-only; mutation testing uses a separate disposable instance.

## Phase 2 — complete audiobook experience

Finish the online audiobook product before building full offline downloads. Existing streaming playback, chapters, speed, sleep timer, notes and verified EPUB media overlays/alignment are the starting point, not evidence that this phase is complete.

1. **Reliable playback on every supported host.** Qualify declared MP3/M4A/M4B and multi-track combinations, chapter transitions, buffering, expired credentials, interruptions, Bluetooth/remote commands, precise resume and process recovery. Record codec support per platform rather than assuming all encodings work everywhere.
2. **Complete library and car browsing.** Browse and start eligible server audiobooks from cold native/car sessions without first preparing each book in the foreground. Add a persistent queue, useful history, bookmarks and predictable next-book behavior. Qualify CarPlay and Android Auto on their real hosts.
3. **Listening controls.** Add configurable smart rewind, per-book playback preferences, speed presets, skip intervals and richer sleep behavior. Preserve source positions, original event times and accurate listening activity through every mode.
4. **Optional audio processing.** Add silence skipping, voice boost and normalization with explicit capability reporting. Preserve a mapping from processed playback time to the original publication timeline so notes, chapters and synchronization stay correct.
5. **Transcripts.** Add versioned background transcription jobs, progress, cancellation, retries, transcript search and tap-to-seek. Define processing location, storage, privacy, resource limits and model licensing before exposing jobs.
6. **Generated alignment.** Align exact verified ebook/audio editions, report confidence and quality, support cancellation/retry and retain original inputs. Evaluate a compatible Storyteller bridge against its actual contract. Existing verified media overlays continue to work independently; matching titles alone never establish alignment.
7. **Chapter and annotation tools.** Support chapter correction/import/export and transcript/audio note export without rewriting source identities or invalidating existing anchors. Review replacements before applying changed timing maps.
8. **Speech and native surfaces.** Remove JavaScript scheduling dependencies before claiming uninterrupted locked-screen whole-book speech. Qualify word highlighting only where real boundaries exist; finish media controls, widgets, recovery and account isolation on installed builds.
9. **Extended audio integrations.** Carry forward casting, phone-free wearable playback, e-ink companions and optional local/self-hosted voices from the original audio backlog. Define each platform contract, licensing and privacy boundary, then implement and test supported routes. External entitlement or hardware dependencies stay explicitly open; they are not silently dropped from a “full” claim.

**Exit:** the supported-platform audio capability matrix and representative end-to-end tests pass, including recovery and source-time correctness. Dependent integrations have recorded qualification or an explicit scope decision. **Downloaded audiobooks, an offline audio catalog and offline reconciliation ship in Phase 3**, alongside other offline formats.

## Phase 3 — full offline reading and listening

Implement F67–F71 from the baseline under their new phase number:

- Resumable, checksum-verified downloads for every supported publication type and all required resources, including covers, narration, alignment maps and chapter metadata.
- Download manifests, content versions, network policies and clear queued, partial, ready, stale, failed and needs-sync states.
- An offline catalog, covers, search indexes, notes and progress that work from a cold launch without a network connection.
- Durable edit queues and reconciliation for progress, annotations, collections and activity, preserving original event times and surfacing conflicting edits for review.
- Storage inspection, pinning, quotas, eviction, cancellation, disk-full recovery, changed editions and safe account isolation/removal.

**Exit:** airplane-mode cold starts and reading/listening pass; interrupted downloads resume correctly; kill/restart and low-space scenarios preserve data; two devices can edit offline and reconnect in either order without silent data loss. Opening a local file or caching a checkpoint does not satisfy these checks.

## Phase 4 — Apple Pencil and reader enhancements

- Prototype a native iPad ink surface, evaluating PencilKit and the bridge to the shared React reader. Qualify pressure/tilt, palm rejection, pen/eraser selection, undo/redo and supported Pencil gestures on actual hardware.
- Anchor PDF and fixed-layout marks to publication coordinates so zoom, crop and rotation do not move annotations away from their content.
- Define reflowable EPUB ink as stable passage-linked or margin notes; do not attach permanent marks solely to screen coordinates that change with font size.
- Persist ink by account and exact edition, provide export and accessible text alternatives, and build synchronization only against a verified server contract or an explicitly scoped companion extension. Do not invent BookOrbit endpoints.
- Improve selection, footnotes, contents/search, annotation organization, fonts, keyboard navigation and tablet layouts. Provide appropriate viewing/export behavior on devices without Pencil input.

**Exit:** ink and reader annotations survive restart, reflow, zoom, offline use, account changes and edition replacement with documented behavior. Pencil gestures and ordinary reading/navigation do not interfere; accessibility and non-Pencil fallbacks are tested.

## Phase 5 — UI enhancements

- Establish Avid's own visual identity and consistent design tokens across library, reader, player, dialogs and native surfaces.
- Refine navigation, discovery, queues, notebooks, responsive phone/tablet/desktop layouts and the onboarding/connection flow.
- Complete purposeful loading, empty, error, recovery and download states with clear action labels.
- Audit keyboard/focus behavior, VoiceOver/TalkBack, larger text, contrast, reduced motion and all seven locales, plus interaction and rendering performance on real devices.

**Exit:** the approved Avid designs and the full interaction/accessibility matrix pass at supported sizes and input methods. This enhancement phase does not defer earlier correctness or accessibility fixes.

## Phase 6 — cleanup, documentation and launch

- Remove all Apogee mentions and replica/comparison language from the release tree: source comments and user-facing strings, filenames and asset metadata, README, guides, historical research/reference material, screenshots, website/store copy and generated bundles. Convert retained historical requirements into Avid-owned specifications while preserving requirement IDs and useful acceptance evidence.
- Remove dead code, unused dependencies and obsolete fixtures; review migrations, diagnostics, privacy, security, licenses and third-party notices. Preserve legally required attribution. Normal cleanup does not authorize rewriting shared Git history.
- Rewrite the README and user/developer documentation around the shipping Avid product, with verified installation, connection, integration, offline, audio, Pencil, backup/recovery and troubleshooting instructions.
- Prepare signed mobile and desktop releases, applicable notarization, beta distribution, upgrade/recovery tests, production web hosting, store metadata/screenshots, release notes and support information.
- Run the release checklist, verify artifact contents and publish through the configured release channels with the required owner accounts and approvals.

**Exit:** release artifacts and documentation contain no obsolete comparison branding, all claimed features have acceptance evidence, production configuration and upgrade paths are verified, and the launch checklist is complete. This roadmap schedules cleanup and launch; it does not itself publish a release or remove historical evidence today.
