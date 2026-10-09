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

The panel defaults to browser fetch. A verified native fetch-compatible transport may be injected by the host app; no native transport or discovery plugin is invented or presumed available. Browser mixed-content, local-network permissions, and origin policies can still block a reachable device. Requests omit credentials and do not copy BookOrbit authorization headers.

### Retry and replacement policy

Each plan has an independent random destination suffix. Existing filenames are checked both during review and immediately before upload. There is no replacement option, delete call, folder creation, credential-store access, or automatic mutation retry. The source and filename stay paired in an in-memory plan, so an arbitrary restored JSON receipt cannot send bytes.

After any timeout, connection failure, cancellation, or unexpected upload response, the plan is considered attempted. Sending that same plan again is refused. **Verify again** uses only read-only requests. If a matching file exists, the transfer is confirmed without resending. Missing or different bytes remain visible for review; Avid does not remove or repair them automatically. A user can explicitly prepare a fresh plan with a new unique filename.

The panel keeps only the latest attempted receipt in account-scoped local storage: device/address, filenames, source size/hash, and event time. It contains no EPUB bytes or BookOrbit credentials. On reload, only verification is available for that receipt. Denied local storage leaves the receipt available only in the current view. This recovery record is not a durable media download or Phase 2 offline feature.

The default file limit is 64 MiB, configurable by the adapter host. Hashing and verification buffer the source/read-back in memory, so large-file support needs measurements on target devices. The request timeout covers response-body consumption. An injected native transport must honor AbortSignal and fetch-compatible request/response semantics.

### Integration API

```tsx
import { CrossPointPanel } from '../../../packages/integrations/src';

<CrossPointPanel
  accountScope={library.repo.scope}
  fileSources={epubFiles.map(file => ({
    id: file.id,
    name: file.name,
    load: () => library.client.getFileBlob(file.id),
  }))}
/>
```

`fileSources` is optional; the panel always supports a user-selected local EPUB. `nativeFetch` may only be passed when a real platform bridge is installed and qualified.

For non-React callers:

```ts
const client = new CrossPointClient();
const readiness = await client.inspect('crosspoint.local', {
  ipFallback: '192.168.1.42',
  directory: '/Books',
});
const plan = await client.prepare(readiness, epubBlob, 'My book.epub');
// Display the exact plan; call send only for an explicit transfer action.
const result = await client.send(plan);
// Recovery after an uncertain response or a persisted receipt:
const verification = await client.verify(plan);
```

No production call to this flow was executed during implementation. Tests prove URL/path constraints, manual fallback, read-only preparation, request shapes, collision refusal, device changes, one-attempt mutation semantics, recovery, and actual checksum comparison against fixture bytes.

### Remaining acceptance evidence

Record the device model, observed firmware version, source commit/build, transport/platform, target directory, test date, input hash, and output hash from a real successful transfer. Test mDNS failure with manual IP, browser/native network permissions, an existing destination name, interrupted upload, rejected/partial responses, a lost success response, device restart, and a corrupted or missing read-back. Inspect existing books afterward. Do not add a version to `qualifiedFirmwareVersions` based only on a successful GET or the unit test transport.

Native discovery, a native LAN transport, and the physical transfer evidence remain open. The firmware's docs/source disagreement also requires a recorded result on the tested release. The HTTP API does not supply a portable conditional-create precondition across known firmware versions; unique names and preflight reduce collisions, but must not be described as a verified cross-version atomic replacement guarantee.

## Archive of Our Own (F49)

No AO3 scraping routes, credentials, background updates, or account connections are implemented. F49 requires an explicitly enabled connector with a verified authentication/session path, a defined followed-work model, edition identity and chapter deduplication, bounded request/rate-limit handling, expiring-session recovery, and an authorized account-based update fixture. The implementation must establish the actual supported service/connector contract before adding network routes. A public story URL or matching title is insufficient evidence of account-based followed-work support.
