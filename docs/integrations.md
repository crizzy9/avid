# Avid external integrations

## CrossPoint delivery (F48)

The repository now includes an original TypeScript CrossPoint HTTP adapter and a React transfer panel. It can inspect a user-entered reader address, list an existing destination folder, prepare an EPUB transfer with a unique destination name, send one multipart upload, and verify the resulting bytes with a read-back SHA-256 check. Contract tests use a simulated fetch transport. **No physical reader was contacted and F48 has not passed its physical-device release gate.**

The contract is pinned to upstream commit `d7fcc7cec414c1b2507d9e6da8550af089e4822b`, consulted October 9, 2026. Upstream documents device status, directory listing, multipart file delivery, download, and optional discovery. The user may enter the IP displayed on the reader when its `.local` hostname does not resolve. The adapter only tries an IP fallback the user actually supplied; it never scans the LAN. [Pinned endpoint documentation](https://github.com/crosspoint-reader/crosspoint-reader/blob/d7fcc7cec414c1b2507d9e6da8550af089e4822b/docs/webserver-endpoints.md)

There is a material docs/source discrepancy at this revision: the endpoint documentation describes same-name replacement, while `CrossPointWebServer::handleUpload` checks `Storage.exists` and rejects an existing path. Its implementation also enables CORS and removes failed/incomplete HTTP uploads in several error paths. Avid does not assume that every installed firmware has these behaviors. [Pinned server implementation](https://github.com/crosspoint-reader/crosspoint-reader/blob/d7fcc7cec414c1b2507d9e6da8550af089e4822b/src/network/CrossPointWebServer.cpp)

### User flow and capabilities

1. Open the reader's File Transfer screen and use the same local network.
2. Enter `crosspoint.local` or the displayed IP. Optionally supply a specific fallback IP and existing folder.
3. **Check reader** performs schema-checked, read-only status/list requests. It displays the observed firmware and hardware. Protocol observation is separate from firmware qualification; the qualified-version list is currently empty.
4. Choose a local EPUB, or an EPUB supplied by the host app's file-source callback. **Review transfer** computes a SHA-256 and displays the exact device/folder/unique filename. It sends no file to the reader.
5. **Send EPUB** rechecks device identity, firmware, and directory contents. It refuses case-insensitive filename collisions. The only mutating operation is one multipart POST.
6. A successful transfer requires downloading the installed copy and matching its size and SHA-256. The result is explicitly `verified`, `missing`, or `different-content`.

The browser panel uses browser fetch. Installed desktop builds inject their dedicated native CrossPoint transport; other hosts use only transports actually present. No discovery result is invented or presumed available. Browser mixed-content, local-network permissions, and origin policies can still block a reachable device. Requests omit credentials and do not copy BookOrbit authorization headers.

### Retry and replacement policy

Each plan has an independent random destination suffix. Existing filenames are checked both during review and immediately before upload. There is no replacement option, delete call, folder creation, credential-store access, or automatic mutation retry. The source and filename stay paired in an in-memory plan, so an arbitrary restored JSON receipt cannot send bytes.

After any timeout, connection failure, cancellation, or unexpected upload response, the plan is considered attempted. Sending that same plan again is refused. **Verify again** uses only read-only requests. If a matching file exists, the transfer is confirmed without resending. Missing or different bytes remain visible for review; Avid does not remove or repair them automatically. A user can explicitly prepare a fresh plan with a new unique filename.

The panel keeps only the latest attempted receipt in account-scoped local storage: device/address, filenames, source size/hash, and event time. It contains no EPUB bytes or BookOrbit credentials. On reload, only verification is available for that receipt. Denied local storage leaves the receipt available only in the current view. This recovery record is not a durable media download or Phase 2 offline feature.

The default file limit is 64 MiB, configurable by the adapter host. Hashing and verification buffer the source/read-back in memory, so large-file support needs measurements on target devices. The request timeout covers response-body consumption. An injected native transport must honor AbortSignal and fetch-compatible request/response semantics.

### Integration API

```tsx
import { CrossPointPanel } from "../../../packages/integrations/src";

<CrossPointPanel
  accountScope={library.repo.scope}
  fileSources={epubFiles.map((file) => ({
    id: file.id,
    name: file.name,
    load: () => library.client.getFileBlob(file.id),
  }))}
/>;
```

`fileSources` is optional; the panel always supports a user-selected local EPUB. `nativeFetch` may only be passed when a real platform bridge is installed and qualified.

For non-React callers:

```ts
const client = new CrossPointClient();
const readiness = await client.inspect("crosspoint.local", {
  ipFallback: "192.168.1.42",
  directory: "/Books",
});
const plan = await client.prepare(readiness, epubBlob, "My book.epub");
// Display the exact plan; call send only for an explicit transfer action.
const result = await client.send(plan);
// Recovery after an uncertain response or a persisted receipt:
const verification = await client.verify(plan);
```

No production call to this flow was executed during implementation. Tests prove URL/path constraints, manual fallback, read-only preparation, request shapes, collision refusal, device changes, one-attempt mutation semantics, recovery, and actual checksum comparison against fixture bytes.

### Remaining acceptance evidence

Record the device model, observed firmware version, source commit/build, transport/platform, target directory, test date, input hash, and output hash from a real successful transfer. Test mDNS failure with manual IP, browser/native network permissions, an existing destination name, interrupted upload, rejected/partial responses, a lost success response, device restart, and a corrupted or missing read-back. Inspect existing books afterward. Do not add a version to `qualifiedFirmwareVersions` based only on a successful GET or the unit test transport.

Desktop now supplies a dedicated Rust LAN transport through `getDesktopCrossPointFetch()`. It permits only the pinned status/list/download/upload routes, resolves and pins private/link-local/loopback addresses, bypasses proxies, strips caller credentials, and refuses redirects and transport retries. Upload cancellation reaches the native request even before response headers arrive; responses cross IPC in bounded chunks. Controlled loopback tests exercise credential stripping and redirect refusal; they are not firmware evidence. Native discovery, mobile-specific transfer qualification, and physical transfer evidence remain open. The firmware's docs/source disagreement also requires a recorded result on the tested release. The HTTP API does not supply a portable conditional-create precondition across known firmware versions; unique names and preflight reduce collisions, but must not be described as a verified cross-version atomic replacement guarantee.

## Archive of Our Own (F49)

Avid includes an opt-in AO3 account connector, a local session companion and an explicit followed-work update panel. It uses AO3's HTML pages and observed EPUB links, not an assumed JSON API. The companion contract is pinned to `otwcode/otwarchive` commit `9dd99008f52ccc726978db131181421f4eb38fe5`, consulted October 9, 2026. **Only controlled fixture accounts/pages have been tested. No live AO3 credentials, login, subscription update or download was used during implementation.** A real authorized account-based chapter update and installed-platform connection checks remain release gates.

### Run and connect

Use Node 24 on the same computer as Avid:

```sh
node scripts/ao3-companion.mjs
```

The process binds `127.0.0.1:43119` and prints a random pairing code for that run. Its default allowed Avid origins are `http://127.0.0.1:5173` and `http://localhost:5173`. Set `AVID_AO3_ORIGINS` to an explicit comma-separated origin list and `AVID_AO3_PORT` to change the loopback port. These configure the local companion, not a public proxy. Restarting generates a new pairing code and loses all sessions.

Enable the connector in Avid, enter the companion address/pairing code and AO3 username or email/password, and connect. The password field clears on submission. The companion gets the verified AO3 login form's CSRF token, submits AO3's `user[login]`, `user[password]` and `user[remember_me]=0`, and verifies the signed-in greeting before accepting the canonical account identity. Credentials and AO3 cookies remain in process memory. Neither is persisted, logged, placed in a URL, exposed to BookOrbit, or returned to the browser. The browser holds only the ephemeral companion session token and pairing code in memory. Sessions expire after two hours of inactivity; the process supports up to four separate sessions. Disconnect clears that companion session; it does not sign out other AO3 browser sessions. [Sign-in form](https://github.com/otwcode/otwarchive/blob/9dd99008f52ccc726978db131181421f4eb38fe5/app/views/users/sessions/_passwd.html.erb), [session controller](https://github.com/otwcode/otwarchive/blob/9dd99008f52ccc726978db131181421f4eb38fe5/app/controllers/users/sessions_controller.rb), [authenticated account greeting](https://github.com/otwcode/otwarchive/blob/9dd99008f52ccc726978db131181421f4eb38fe5/app/views/users/sessions/_greeting.html.erb).

The host/loopback check, explicit origin allowlist and random bearer pairing credential run before any upstream request. Only `https://archiveofourown.org` is allowed upstream; credentials are never forwarded to redirect targets outside it, and POST-preserving login redirects are rejected. There is no arbitrary upstream proxy route. AO3 requests are serial and spaced by at least 1.5 seconds, with a 30-second request timeout, 8 MiB HTML limit and 64 MiB EPUB limit. HTTP 429/503 imposes a bounded `Retry-After` delay and surfaces a manual retry message. Origin policy, browser local-network permission, hosted HTTPS and physical mobile connectivity require platform qualification; the loopback process is not claimed to be a packaged mobile connector.

### Verified routes and update semantics

| Source route                                        | Connector use                                                                                                                                          |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /users/login`, `POST /users/login`             | CSRF session sign-in, separate from BookOrbit.                                                                                                         |
| `GET /users/:login/subscriptions?type=works&page=N` | Only the authenticated account's work subscriptions; explicit pagination with stable work IDs. Unrevealed/deleted entries are reported as unavailable. |
| `GET /works/:id/navigate`                           | Ordered stable chapter IDs from the chapter index.                                                                                                     |
| `GET /works/:id?view_full_work=true`                | Title, author, exact chapter order, chapter content revisions and the observed EPUB link. This normal AO3 page view can update AO3 reading history.    |
| Observed `/downloads/:id/:title.epub?updated_at=…`  | Explicit EPUB download only after its link appeared in the authenticated work page.                                                                    |

The source verifies subscription ownership/filtering and pagination, work/chapter rendering and download URL generation. No create/delete-subscription route is exposed. Access restrictions, adult-content preferences, anti-bot challenges or changed markup produce a recoverable error; the connector does not bypass them. Parsed page nodes remain in an inert HTML template and are never attached to Avid's document or executed. Only plain metadata is rendered. [Subscription controller](https://github.com/otwcode/otwarchive/blob/9dd99008f52ccc726978db131181421f4eb38fe5/app/controllers/subscriptions_controller.rb), [subscription page](https://github.com/otwcode/otwarchive/blob/9dd99008f52ccc726978db131181421f4eb38fe5/app/views/subscriptions/index.html.erb), [chapter index](https://github.com/otwcode/otwarchive/blob/9dd99008f52ccc726978db131181421f4eb38fe5/app/views/works/navigate.html.erb), [work rendering/history](https://github.com/otwcode/otwarchive/blob/9dd99008f52ccc726978db131181421f4eb38fe5/app/controllers/works_controller.rb), [download links](https://github.com/otwcode/otwarchive/blob/9dd99008f52ccc726978db131181421f4eb38fe5/app/helpers/works_helper.rb), [download controller](https://github.com/otwcode/otwarchive/blob/9dd99008f52ccc726978db131181421f4eb38fe5/app/controllers/downloads_controller.rb).

Checks are explicit user actions, without background polling. An edition revision hashes stable chapter IDs, chapter order, chapter content and displayed title/author. This detects new chapters and edits to existing chapters while ignoring changing hit/comment counts. Before importing, the connector downloads the observed EPUB and rechecks the work; a changed revision aborts the import. Subscriptions and imported-revision receipts are isolated by both Avid account scope and canonical AO3 account. At most 1,000 works, 2,000 chapters per work and 200 imported revision receipts per work are tracked. Credentials, cookies and story content are not stored in this metadata record.

`AO3Panel` calls the host only for an explicit import:

```tsx
<AO3Panel
  key={library.repo.scope}
  accountScope={library.repo.scope}
  onImport={async ({
    accountId,
    workId,
    title,
    author,
    revision,
    file,
    chapterIds,
  }) => {
    // Keep one local book per Avid account + AO3 account + work ID.
    // Use a distinct, deterministic file identity per revision and deduplicate retries.
    // Keep previous edition files, anchors and notes; open the new edition explicitly.
  }}
/>
```

The host must deduplicate the same revision even if an earlier import succeeded before the panel could persist its receipt. Changing an edition never justifies assigning an old CFI to the new file. Avid retains previous source files and reader positions; **exact CFI/chapter-text migration across edited editions is not implemented or claimed**. A canceled request or account change cannot invoke the panel's late import callback. No AO3 flow uploads to the supplied BookOrbit test server.

Controlled tests cover login form fields and CSRF/cookie isolation, origin/pairing rejection, disallowed routes and redirects, session identity changes, rate limiting, subscription pagination, chapter addition/edit detection, edition deduplication, account-scoped receipts, and a work changing during download. Panel tests exercise explicit opt-in/import and cancellation during an account switch. Both panels now use a complete keyed seven-language catalog (en, fi, fr, de, pl, zh-Hans, es), including setup instructions, pending operations, typed errors, and verified/uncertain outcomes. Tests switch all seven languages during live forms and transfer states, check every interpolation variable, and retain original filenames/publication text. They are not live AO3 service certification. Remaining acceptance includes a real authorized subscription and one new-chapter import, download cache consistency, account-expiry recovery, challenges/content restrictions, representative long works, fluent-speaker/layout review and deployed/native companion packaging.
