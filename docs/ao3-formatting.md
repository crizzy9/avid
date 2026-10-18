# AO3 formatting recovery — 2026-10-18

Avid's existing explicit AO3 import/update workflow can restore a bounded subset
of missing work-skin formatting into a new local EPUB edition. It uses the
authenticated full-work HTML and observed EPUB download already retrieved by the
paired companion. No new endpoint, background fetch, stylesheet fetch, server
upload or update to an existing file is involved.

## Verified source contract

At pinned `otwcode/otwarchive` commit
`9dd99008f52ccc726978db131181421f4eb38fe5`, the
[work page](https://github.com/otwcode/otwarchive/blob/9dd99008f52ccc726978db131181421f4eb38fe5/app/views/works/show.html.erb)
renders a work's
[style block](https://github.com/otwcode/otwarchive/blob/9dd99008f52ccc726978db131181421f4eb38fe5/app/views/works/_work_skin.html.erb)
directly inside `#work-skin`, surrounding `#workskin`. The
[work-skin model](https://github.com/otwcode/otwarchive/blob/9dd99008f52ccc726978db131181421f4eb38fe5/app/models/work_skin.rb)
prefixes its selectors with `#workskin`. The
[download writer](https://github.com/otwcode/otwarchive/blob/9dd99008f52ccc726978db131181421f4eb38fe5/app/models/download_writer.rb)
uses separate download templates and Calibre conversion; that path does not
include the work-skin style block. These source files explain the available
recovery input; they do not establish the structure of every live download.

## Import behavior

The parser accepts only the work's direct inline style block. Site skins and
arbitrary linked resources are not fetched. A disabled or absent work skin
leaves the previous no-skin revision algorithm and import behavior unchanged.
The authenticated page is still subject to the account's AO3 content preferences.

The safe CSS, restoration version and chapter-container classes join the content
revision. A previously imported unstyled work is therefore eligible for an
explicit new-edition import. CSS-only and class-only changes produce a new
revision. The connector downloads the observed EPUB and rechecks the work before
restoring anything, so a changed revision aborts the operation.

For each chapter, exactly one EPUB container must match the authenticated
source's normalized text and recursive element order/tags. The restorer merges
source classes and permitted inline styles while retaining converter classes,
text, links, image references and existing resources. Conflicting IDs, ambiguous
matches, missing chapters, malformed archives and configured size limits reject
the entire restoration. No partially restored edition reaches the import host.
The OPF, original stylesheets, images and other unmodified resources retain their
original bytes; the XHTML is serialized into a new EPUB container.

The host keeps the original edition, annotations and reading anchors. It does
not migrate a CFI from an older edition to the new file. The follow record stores
revision receipts, not the captured HTML or stylesheet. The import panel explains
the recovery in all seven supported locales. **Use publication formatting** in
reader settings permits the restored publication typography and colors to show.

## Isolation and limits

Restored selectors are scoped to the publication body's `.avid-ao3-workskin`
class. Only flat rules and an explicit set of presentation declarations survive.
Imports, font loading, at-rule blocks, URLs, custom properties, executable values
and fixed/sticky positioning are discarded. Literal generated-text labels are
allowed; external style resources are not fetched. The EPUB still opens through
the existing script-disabled publication sanitizer and network-blocking CSP.

Calibre can split or rewrite a chapter's structure. Such files deliberately fail
the exact-match requirement instead of applying formatting to guessed elements.
Advanced selectors, nested/media rules, skin-provided external images/fonts and
all possible messaging layouts are outside this bounded implementation.

Parsing uses an inert template's declaration CSSOM and selector parser. It never
attaches raw styles to a document and does not require constructable stylesheets
(added in [Safari 16.4](https://webkit.org/blog/13966/webkit-features-in-safari-16-4/)),
so the iOS 15 deployment target is not newly excluded. Selectors unsupported by
the current browser are omitted. Physical WKWebView and Android behavior,
representative real Calibre output, long works, and visual comparison with Apogee
remain qualification gates.

## Evidence

The controlled fixture suite covers safe formatting, dangerous CSS removal,
unchanged no-skin revision identity, old-import eligibility, CSS/container/child
class revisions, resource preservation, exact matching, conflicting IDs,
cancellation, malformed input, unavailable CSS construction and existing-route
import/recheck behavior. The EPUB fixture is original synthetic converter-shaped
XHTML with renamed classes, split spine documents and binary resources, not a
captured live AO3 or Calibre corpus. No live AO3 account, work, download or supplied
BookOrbit server was used for this work.
