import type { BookOrbitClient } from "../../../packages/core/src/bookorbit";
import type { LibraryRepository } from "../../../packages/core/src/repository";
import type { Book } from "../../../packages/core/src/types";
import { CrossPointError } from "../../../packages/integrations/src/crosspoint";
import type { CrossPointFileSource } from "../../../packages/integrations/src/CrossPointPanel";

export const CROSSPOINT_LIBRARY_SOURCE_LIMIT = 200;
export const CROSSPOINT_LIBRARY_FILE_LIMIT = 64 * 1024 * 1024;
const serverId = (id: string) =>
  /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id));
const supportedSize = (size: number) =>
  Number.isSafeInteger(size) && size > 0 && size <= CROSSPOINT_LIBRARY_FILE_LIMIT;

/** Cancel the caller promptly even when a local store cannot cancel its already-started read. */
function cancellable<T>(read: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return read;
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason ?? new DOMException("Transfer canceled.", "AbortError"));
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
    void read.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}

/** A bounded metadata-only view of already-loaded books. No file or catalog reads occur here. */
export function createCrossPointLibrarySources(options: {
  books: readonly Book[];
  repo: Pick<LibraryRepository, "scope" | "getLocalFile">;
  client: Pick<BookOrbitClient, "getFileBlob"> | null;
  isActive: () => boolean;
}): CrossPointFileSource[] {
  const { repo, client } = options;
  const scope = repo.scope;
  const sources: CrossPointFileSource[] = [];
  const seen = new Set<string>();
  const check = (signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (repo.scope !== scope || !options.isActive())
      throw new DOMException("The library connection changed.", "AbortError");
  };
  for (const book of options.books) {
    for (const file of book.files) {
      if (file.format !== "EPUB" || !/\.epub$/i.test(file.name)) continue;
      if (file.size !== undefined && !supportedSize(file.size)) continue;
      const local = book.id.startsWith("local-") && file.id.startsWith("local-");
      // Sample metadata has no source EPUB; arbitrary URLs never become an authenticated request.
      if (!local && (!client || !serverId(book.id) || !serverId(file.id))) continue;
      const id = JSON.stringify([scope, book.id, file.id]);
      if (seen.has(id)) continue;
      seen.add(id);
      const name = file.name;
      const fileId = file.id;
      sources.push({
        id,
        name,
        label: book.title ? `${book.title} · ${name}` : name,
        async load(signal) {
          check(signal);
          const bytes = await cancellable(
            local ? repo.getLocalFile(fileId) : client!.getFileBlob(fileId, signal, CROSSPOINT_LIBRARY_FILE_LIMIT),
            signal,
          );
          check(signal);
          if (!bytes || !supportedSize(bytes.size))
            throw new CrossPointError("unsupported-file", "This EPUB is unavailable, empty, or larger than 64 MiB.");
          return bytes;
        },
      });
      if (sources.length === CROSSPOINT_LIBRARY_SOURCE_LIMIT) return sources;
    }
  }
  return sources;
}
