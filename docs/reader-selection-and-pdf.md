# Reader selection and PDF updates — 2026-10-18

Apogee's public [App Store release notes](https://apps.apple.com/us/app/apogee-reader/id6779567734)
describe a richer selection card, PDF width/selection improvements, and AO3
formatting changes in 1.1.1. Those developer statements establish the feature
targets; they do not establish visual parity or reveal the original implementation.

## Implemented reader actions

EPUB and PDF selections now open a shared card with five highlight colors, an
inline note editor, copy, lookup, translation and sharing. Highlight and note
creation retain the exact captured CFI or PDF page rectangles while controls
take focus. Closing the card or changing account/source clears the captured
selection. Prepared Read & Listen permits copy/lookup/translation/share while
keeping annotation creation and the notebook unavailable.

Lookup opens the selected UI language's Wiktionary. Translation opens Google
Translate with an explicit target language. Both use fixed HTTPS destinations,
encoded selected text, `noopener noreferrer` and a no-referrer policy. The card
names those services; no provider request is made when the card opens. Lookup
accepts up to 160 code points, translation up to 2,000; larger selections disable
that online action rather than sending a silently truncated passage.

Sharing uses the browser/device share sheet when available, following the
[Web Share specification](https://w3c.github.io/web-share/). Only selected text,
title and author attribution enter the payload; no library/server URL or
credential is added. Dismissal is cancellation, with no automatic copy or
alternate send. Without a share sheet, the explicit action copies the attributed
passage. Clipboard denial exposes selectable text for the device's Copy command.
Native share-sheet and external-provider behavior still require physical-device
qualification.

Every new control, status and explanation has English, Finnish, French, German,
Polish, Simplified Chinese and Spanish translations. Explicit BookOrbit online
voices also show a translated explanation that starting narration sends spoken
text through the user's server to its configured provider, requires network and
server access, and does not download that voice for offline use. Browser voices
are not classified as BookOrbit voices merely because `localService` is false.

## PDF layout and word coordinates

The default PDF layout fits the actual available content width, without the old
1,050-pixel cap. Fit page also uses the available height. Trimming margins refits
the visible region inside a clipping container. Canvas, selectable text and
saved highlights share the complete page's CSS coordinate system; trimming
does not shift only one layer.

The installed PDF.js 5 text layer emits `--font-height`, `--scale-x` and rotation
properties. Its layout needs `--total-scale-factor`, including the PDF UserUnit.
Avid now uses the relevant scoped upstream CSS rules with their license notice,
and supplies that scale independently of canvas pixel density. It does not import
the full PDF viewer stylesheet and its application-level color-scheme rules.

Selection rectangles are normalized against the displayed full canvas, retain
separate text lines, deduplicate duplicates, and reject empty/out-of-page or
nonfinite data. Saved rectangles must belong to the displayed page and remain
within normalized bounds. Page rendering is serialized and cancelable so a resize
cannot render twice into one canvas. Selection is unavailable while a different
page is rendering, and resize/crop alone does not emit a new reading checkpoint.
Backing canvas pixels are bounded separately from CSS width.

## Publication formatting and limits

The per-account, per-file **Use publication formatting** setting removes Avid's
font/color/heading overrides while retaining selection/narration highlights.
EPUB classes, safe stylesheets, inline formatting and semantic elements survive
the publication sanitizer. The same script/network CSP remains in force.
Switching the setting off reapplies reader typography and colors.

This setting displays formatting already present in the file and makes no network
request. The separate explicit AO3 import/update workflow now performs bounded
[work-skin recovery](ao3-formatting.md) from authenticated source HTML, producing
a new edition only after exact chapter matching. Existing editions remain intact;
advanced skins and live Calibre/native comparison remain qualification gates.

## Evidence and remaining checks

The focused suite passes 50 tests across selection actions/card, PDF geometry and
component behavior, publication styles, reader preferences/chrome, page motion,
seven-locale reader controls and online-voice disclosure. Checks include clipboard
denial and late failures, share cancellation, exact selected locator retention,
per-account/file formatting isolation, UserUnit versus DPR, crop refitting,
backward page rendering and stale source loads. TypeScript passes.

The in-app browser also rendered the two-page PDF fixture, selected a real word,
saved its exact highlight, switched Fit width/Fit page settings, and changed
the left crop. The highlight stayed on the selected word after refitting. The
selection card displayed the color/note/copy/lookup/translation/share actions.
No external lookup, translation or share was sent during this check.

These source/unit checks do not certify physical-device selection handles,
rotated/font-substituted PDFs, dictionary/translation provider UI, native share
sheets, or visual 1:1 parity. The existing PDF fixture and the new human-narrated
preparation fixture are available for separate browser/device checks; see
[Reader fixtures](../packages/readers/fixtures/README.md).
