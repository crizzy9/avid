# Vendored Foliate.js

Source: https://github.com/johnfactotum/foliate-js
Commit: `78914aef4466eb960965702401634c2cb348e9b1`
License: MIT; see LICENSE. The vendored ZIP and fflate bundles retain their upstream notices.

Avid changes:

- Publication iframe sandbox omits `allow-scripts` in paginator.js and fixed-layout.js. This prioritizes isolation over the upstream WebKit event workaround.
- Both renderers fetch the isolated document into iframe `srcdoc` instead of navigating directly to its Blob URL. This makes embedded-browser rendering work while keeping the script-free sandbox. Only Avid-sanitized publication URLs are supplied to these renderers.
- view.js routes PDF to Avid's separate PDF.js adapter rather than Foliate's experimental adapter.
- mobi.js rejects encrypted PalmDOC/MOBI records explicitly before parsing publication content. Avid supports DRM-free files only.

EPUB/MOBI sections are sanitized and receive a restrictive CSP before navigation in Avid's adapter. CSP blocks scripts, network connections, nested frames, and forms; resource loads are limited to archive-local blob/data URLs. Rendered publications never receive a native bridge. Actual WebKit-device qualification is required before claiming native parity.

Media-overlay additions: corrected the upstream visible-section comparison from assignment to equality; added a follow-text toggle; exposed source-audio currentTime and lifecycle events for Avid's controls and activity reporting. Playback still follows existing EPUB SMIL clip boundaries and text fragments. No alignment is inferred from percentages, titles, or durations.

Lifecycle additions: custom-element registrations are idempotent during development HMR; the paginator tolerates teardown before its first frame and ignores queued layout/style work after disposal. These guards also protect fast close/reopen actions.

Media-overlay passage skips also advance correctly across separate audio resources within one section, preserving paused state. Playback state reports loading separately until an actual audio playing event.

Read-along corrections: media-overlay source intervals are half-open and resolve paused/backward positions as well as forward playback; silent gaps clear the active text. Late audio loads/events after stop cannot create a new owner. Overlay DOM navigation is serialized, superseded highlights are discarded, and the adapter can identify automatic narration navigation to keep it separate from reading checkpoints. The shared reader's external standalone read-along highlighter is implemented outside the vendor code.
