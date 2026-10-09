# Reader fixtures

`reader.html` is a development-only manual harness, served by Vite at `/@fs/<absolute-repository-path>/packages/readers/fixtures/reader.html`. It is not included in the production app.

- No query: an actual EPUB generated from original Avid sample writing.
- `?format=PDF`: original two-page PDF text fixture.
- `?format=CBZ`: original three-page synthetic PNG archive.
- `?format=CB7`: the same pages in a real 7-Zip archive.

Regenerate the PNG/PDF/CBZ files with `node packages/readers/fixtures/generate.mjs`. In the fixture directory, create the CB7 with `7zz a -t7z sample.cb7 page1.png page2.png page3.png` after deleting the previous sample.cb7.

Manual EPUB checks passed in the Codex embedded browser: opening, table-of-contents navigation, full-book search, note creation, theme and font-size changes. PDF, CB7, RAR, media overlays, and actual speech/device qualification require their respective runtime corpus checks before parity claims.
