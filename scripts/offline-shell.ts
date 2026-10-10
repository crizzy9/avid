import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";

/** Cache only public build artifacts. Never cache API responses, authentication or book requests. */
export function offlineShell(): Plugin {
  return {
    name: "avid-offline-shell",
    apply: "build",
    generateBundle(_, bundle) {
      const publicRoot = resolve("apps/web/public");
      const publicFiles = readdirSync(publicRoot, {
        recursive: true,
        withFileTypes: true,
      })
        .filter((entry) => entry.isFile())
        .map((entry) =>
          `${entry.parentPath}/${entry.name}`.slice(publicRoot.length),
        );
      const paths = [
        "/",
        "/index.html",
        ...Object.keys(bundle)
          .filter((name) => !name.endsWith(".map"))
          .map((name) => `/${name}`),
        ...publicFiles,
      ];
      const hash = createHash("sha256")
        .update("public-shell-v2")
        .update(JSON.stringify(paths));
      for (const name of publicFiles)
        hash.update(readFileSync(`${publicRoot}${name}`));
      for (const output of Object.values(bundle))
        hash.update(output.type === "chunk" ? output.code : output.source);
      const version = hash.digest("hex").slice(0, 16);
      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source: `
const CACHE = 'avid-shell-${version}';
const FILES = ${JSON.stringify([...new Set(paths)])};
const ALLOWED = new Set(FILES);
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES))));
self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const name of await caches.keys()) if (name.startsWith('avid-shell-') && name !== CACHE) await caches.delete(name);
  await self.clients.claim();
})()));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !ALLOWED.has(url.pathname)) return;
  const navigation = event.request.mode === 'navigate' && url.pathname === '/';
  if (url.search && !navigation) return;
  // Public assets have no credential/content negotiation. Preview servers can
  // add Vary: Origin, although module loads and precache requests use different
  // Origin headers; matching those variants would break a cold offline launch.
  event.respondWith(caches.open(CACHE).then(async cache => (await cache.match(navigation ? '/' : url.pathname, { ignoreVary: true })) || fetch(event.request)));
});
`,
      });
    },
  };
}
