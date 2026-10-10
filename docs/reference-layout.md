# Apogee reference coverage

The requested product name is **Avid** and the requested direction is a replica of Apogee Reader. That instruction supersedes the provisional Bookish name and redesigned interface proposal retained in [the research baseline](research-baseline.md). The baseline remains a historical feature inventory, not a source of authorization to change the requested visual direction.

The public [Apogee site](https://apogeereader.app/) and [App Store listing](https://apps.apple.com/us/app/apogee-reader/id6779567734) supplied the observed phone Home, tablet Home/Library/book-detail, and phone reader screenshots. Source images were inspected locally and are not bundled as Avid assets. Original application code, navigation SVGs, cover illustrations, and sample text remain in use.

## Implemented reference states

| State | Reproduced structure | Verification |
| --- | --- | --- |
| Navigation | Home, Library, Browse, More capsule; separate Search; top-centered tablet placement and floating phone placement; account/settings controls | Phone and tablet preview navigation checked, including repeated Library navigation and access to Notebook through More |
| Home | Cover-tinted background, resume card, compact Continue/queue/recent shelves, portrait and square cover proportions | Phone and tablet visual inspection; light and dark phone previews; long-title and description wrapping checked |
| Library | Audiobooks, Books, Comics; two-row horizontal shelves; real counts and See all controls | Tablet inspection and component tests; metadata-only bounded server queries; original virtualized catalog retained for full shelves and search |
| Book details | Rounded sheet, drag indicator, cover/title/author area, More and read/listen actions, expandable description, genres, publication details, ratings when available | Phone and tablet inspection; More actions and reader launch checked; metadata and stale-response regression tests |
| Reader | Centered book/chapter label, hidden controls while reading, restrained footer, tap/Escape disclosure | Desktop and phone inspection; Escape, navigation, settings persistence and page-label tests; selection/link/drag gesture guards tested |

The supplied server was also checked through Avid in read-only mode: media shelves, actual totals, description/publication/provider-rating hydration, and disabled queue/status/membership controls worked. No library mutation was performed. Library counts and ratings come from server data. Missing rating counts, publication metadata and whole-book page totals are omitted; chapter screen counts are not presented as printed book pagination. Existing reader appearance settings are retained, so upgraded sample sessions can differ from the white/Georgia defaults for new sessions. Demo books intentionally use Avid artwork and sample text; server books use their actual covers and content.

## Remaining parity evidence

This is an implementation of observed layouts, not a verified pixel-identical replica of every Apogee state. Exact installed-app behavior, unsupplied login/player/settings/error states, native system fonts/materials, safe areas, split-screen behavior, accessibility scaling, and physical device interactions need a hands-on comparison. Browse, More and non-observed dialogs preserve implemented Avid workflows without claiming screenshot parity.

The browser inspections used a 393 × 852 phone viewport, a 768 × 1024 tablet viewport, and the normal desktop preview. Browser emulation does not establish actual iPhone/iPad acceptance. The temporary viewport override was reset after inspection. At source checkpoint `430b8b6`, 657 shared tests, TypeScript, the production build, web CI and all five native CI jobs passed. Full native, integration and release gates remain in [the Phase 1 checklist](phase-1-status.md).
