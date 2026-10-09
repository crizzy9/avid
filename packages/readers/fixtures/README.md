# Reader fixtures

`reader.html` is a development-only manual harness, served by Vite at `/@fs/<absolute-repository-path>/packages/readers/fixtures/reader.html`. It is not included in the production app.

- No query: an actual EPUB generated from original Avid sample writing.
- `?format=MOBI`: original DRM-free MOBI6/PalmDB publication with two chapters and byte-offset contents links.
- `?format=PDF`: original two-page PDF text fixture.
- `?format=CBZ`: original three-page synthetic PNG archive.
- `?format=CB7`: the same pages in a real 7-Zip archive.
- `?format=CBR`: the same pages in an uncompressed RAR4 archive.
- `?format=ALIGNED`: an EPUB with two original eSpeak-narrated passages, explicit SMIL fragments, and source WAV timing.

Regenerate the PNG/PDF/CBZ/CBR/MOBI/aligned EPUB files with `node packages/readers/fixtures/generate.mjs`. In the fixture directory, create the CB7 with `7zz a -t7z sample.cb7 page1.png page2.png page3.png` after deleting the previous sample.cb7.

Manual EPUB checks passed in the Codex embedded browser: opening, table-of-contents navigation, full-book search, note creation, theme and font-size changes. Unit tests decode actual CB7 and RAR4 archives with libarchive WASM, and test SMIL fragment/timing/pause/resume behavior. Additional embedded-browser checks passed: PDF page rendering/cropping/page restoration; CBZ/CB7/CBR real image decoding and page navigation; spreads and RTL setting; webtoon scroll restoration at the exact within-page offset; actual aligned WAV playback with advancing source time, pause, speed, follow toggle, visible passage highlighting, and paused passage skips across distinct audio files. These fixtures do not certify all archive variants, voices, fixed-layout books, native devices, or production distribution builds.

The actual Foliate MOBI parser passes the original MOBI6 fixture: metadata, three reading sections, two TOC entries, and byte-offset navigation to the second chapter. A separate test rejects a protected-file flag before rendering. Selection-to-speech tests cover starting inside a paragraph, inline words split across markup, callback offsets mapped to exact text ranges, and skipping non-linear sections. These deterministic tests do not prove installed-voice playback; real voice availability, speech timing and interrupted cross-chapter playback still need a suitable browser/device runtime.

The root browser test also visibly rendered the MOBI second chapter “The long way home”, switched to continuous scroll, and retained the chapter and selected flow after close/reopen. That runtime reported no installed speech voices, so real voice playback was not certified.
