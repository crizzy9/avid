# BookOrbit 3.4 requests and online voices

The additional contracts were inspected at [BookOrbit v3.4.0](https://github.com/bookorbit/bookorbit/releases/tag/v3.4.0), commit `2cc0906ddf13b5b4c70250d27736ecc1eef742cb`. They supplement the [3.3 adapter baseline](bookorbit-contract.md). Their tests use controlled fetch/audio fixtures; no requests were submitted and no speech was synthesized on the supplied server.

## Format requests

`GET app-info` must advertise `book-request-pairs` before Avid enables either `targetBookId` on `POST book-requests` or the atomic `POST book-requests/pairs` route. A version string alone does not enable these operations. Older supported servers retain ordinary single ebook/audiobook requests. Readable comic files count as the ebook side, as specified by the current server contract. Avid does not offer retired comic requests.

The interface first checks availability through the read-only `POST book-requests/availability`. A separate explicit submission creates the request or joins its existing server request. Pair submission uses the single pair route; it never approximates an atomic pair with two independent writes. The request list uses one-based `page`/`limit`, bounded to 20 grouped entries in the interface, with explicit paging and refresh. The server owns approval, fulfilment, permissions and duplicate resolution.

Read-only connections can inspect availability and their request status but cannot submit. The adapter rejects request mutations before network I/O. Missing support and forbidden access are displayed as unavailable; unexpected service errors remain errors. Account replacement/unmount cancels interface reads and ignores stale results. Cancelling a submission cannot undo a request that the server already accepted; Avid does not automatically retry an uncertain submission.

The development proxy applies the same distinction when `AVID_PROXY_READ_ONLY` is enabled: its exact POST allowlist includes `book-requests/availability` and the explicitly selected `tts/synthesize/captioned` operation. Creating requests or pairs, changing speech preferences, and writing library/progress data remain blocked. This does not enable arbitrary TTS or book-request POST routes, and requires no environment change.

Primary source: [request controller](https://github.com/bookorbit/bookorbit/blob/2cc0906ddf13b5b4c70250d27736ecc1eef742cb/server/src/modules/book-request/book-request.controller.ts), [request types and feature semantics](https://github.com/bookorbit/bookorbit/blob/2cc0906ddf13b5b4c70250d27736ecc1eef742cb/packages/types/src/book-request.ts).

## Explicit online voices

Avid reads public provider/voice metadata from `GET tts/providers` and `GET tts/voices`. Provider names appear beside named voices. Selecting an online voice and pressing Speak sends text to the connected BookOrbit server and its configured voice provider. The installed voice remains the default. No provider credentials are stored in the library, and online voices are not offered as offline voices.

`POST tts/synthesize/captioned` returns MP3 audio and optional word timings. Avid sends at most 4,000 UTF-16 units per chunk and prepares at most one chunk ahead of the playing chunk. Synthesis speed is applied by the server; playback uses the returned audio clock. The response is bounded to 24 MiB of JSON and 16 MiB of decoded audio per chunk. Empty captions or caption words that cannot be matched literally to the source produce no invented highlights. Audio and captions are ephemeral, and object URLs are revoked on completion, cancellation and account disposal. Synthesis is permitted on a read-only library connection because it does not write progress, notes or library metadata; it can still invoke the server's configured external voice service.

The browser/native host must support audio playback and the configured authenticated transport. Deployment testing should cover autoplay policy, unavailable providers, network stalls, token refresh and interruption on physical devices. The inspected captioned route does not pass the raw synthesis route's client-disconnect abort signal upstream: Avid cancels its own request/audio and ignores late results, but cannot promise cancellation stops the upstream computation or billing. Offline synthesized speech, resumable speech downloads and durable offline reading edits remain Phase 3 work.

Primary source: [TTS controller](https://github.com/bookorbit/bookorbit/blob/2cc0906ddf13b5b4c70250d27736ecc1eef742cb/server/src/modules/tts/tts.controller.ts), [public voice and caption types](https://github.com/bookorbit/bookorbit/blob/2cc0906ddf13b5b4c70250d27736ecc1eef742cb/packages/types/src/tts.ts).

Run the focused checks with:

```sh
pnpm exec vitest run packages/core/tests/bookRequests.test.ts packages/core/tests/serverSpeech.test.ts apps/web/src/BookFormatRequests.test.tsx apps/web/src/serverSpeechProvider.test.ts
pnpm exec tsc --noEmit
```
