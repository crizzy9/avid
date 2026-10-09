# Avid interface languages

`useI18n()` exposes `t(key, parameters)`, `locale`, and `setLocale`. All catalog keys have explicit English, Finnish, French, German, Polish, Simplified Chinese and Spanish values. Interpolation uses locale-aware numbers. The language preference is stored under `avid.language`, reacts across tabs and updates the document language without modifying book content or the DOM text of rendered controls.

The integrated surfaces are navigation, library/search, collection controls, series browsing, connection, book details, player, notebook, reading activity and primary settings. Reader controls, settings and notices use a separate typed seven-language reader catalog that observes the same preference. UI components render message keys directly. Book titles, authors, genres, annotations and server-supplied error text remain source content.

This does not certify complete Phase 1 localization: native platform surfaces, technical capability descriptions and long help/integration guidance still require integration and language QA. The catalogs are authored translations; fluent-speaker review and visual testing in all seven languages remain release gates.

Catalog tests enforce seven entries for every key and identical interpolation parameters, and check live preference updates, storage, locale-aware formatting and unchanged book content.
