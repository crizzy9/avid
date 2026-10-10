import { LibraryRepository } from "../../../packages/core/src/repository";
import type { Book } from "../../../packages/core/src/types";

export interface ImportedAo3Edition {
  accountId: string;
  workId: string;
  title: string;
  author: string;
  revision: string;
  file: File;
  chapterIds: string[];
}
async function digest(value: string): Promise<string> {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  ]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
/** Stable work identity; immutable edition identities preserve old notes and reading anchors. */
export async function importAo3Edition(
  repo: LibraryRepository,
  edition: ImportedAo3Edition,
): Promise<Book> {
  if (
    !/^\d+$/.test(edition.workId) ||
    !edition.accountId ||
    !/^[a-f0-9]{64}$/i.test(edition.revision)
  )
    throw new Error("Invalid AO3 edition identity.");
  if (!edition.file.size || edition.file.size > 64 * 1024 * 1024)
    throw new Error("Choose an EPUB smaller than 64 MiB.");
  const id = `local-ao3-${await digest(JSON.stringify([edition.accountId.toLowerCase(), edition.workId]))}`;
  const fileId = `${id}-${edition.revision.toLowerCase()}`;
  const existing = await repo.getBook(id);
  if (
    existing?.files.some((file) => file.id === fileId) &&
    (await repo.hasLocalFile(fileId))
  )
    return existing;
  const date = new Date().toISOString();
  const file = {
    id: fileId,
    format: "EPUB" as const,
    name: `${edition.title} · ${edition.chapterIds.length} chapters · ${date.slice(0, 10)}.epub`,
    size: edition.file.size,
  };
  const book: Book = {
    id,
    title: edition.title,
    authors: [edition.author],
    description:
      "Imported from your AO3 followed works. Earlier editions retain their own saved positions and notes.",
    format: "EPUB",
    color: "#754945",
    progress: existing?.progress ?? 0,
    status: existing?.status ?? "unread",
    genres: ["AO3"],
    addedAt: existing?.addedAt ?? date,
    // Keep the edition already being read as the default. Opening a new edition is explicit.
    files: existing ? [...existing.files, file] : [file],
  };
  await repo.putLocalEdition(book, fileId, edition.file);
  return (await repo.getBook(id))!;
}
