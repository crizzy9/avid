import { AvidDatabase, LibraryRepository, accountScope } from "./repository";
import { DexieLibraryStorage, type StorageTransaction } from "./storage";
import type { LibraryStorageTable } from "./storageProtocol";
import type { OfflineReadAlongDescriptor } from "./offlineReadAlong";
import type { ReadingAnchor, Session } from "./types";

const DATABASE_PREFIX = "avid-offline-readalong-progress-v1-";
const SHA256 = /^[0-9a-f]{64}$/;
const POSITION_PRECISION = 0.002;

/**
 * This partition is intentionally never a source of server sync work. Enforce
 * that policy below Repository.atomic as well, including nested mutations and
 * callers which omit (or explicitly disable) the readOnly option.
 */
class OfflineProgressStorage extends DexieLibraryStorage {
  override atomic<T>(
    scope: string,
    tables: LibraryStorageTable[],
    work: (transaction: StorageTransaction) => Promise<T>,
  ): Promise<T> {
    return super.atomic(scope, tables, (transaction) =>
      work({
        ...transaction,
        put: (table, row) =>
          table === "outbox" ? Promise.resolve() : transaction.put(table, row),
      }),
    );
  }
}

function identity(
  pkg: OfflineReadAlongDescriptor,
): Pick<Session, "profile" | "userId"> {
  if (
    pkg.version !== 1 ||
    typeof pkg.id !== "string" ||
    pkg.id.length !== 64 ||
    !SHA256.test(pkg.id)
  )
    throw new Error("A saved offline package SHA-256 identity is required.");
  try {
    const value: unknown = JSON.parse(pkg.scope);
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      !value.every(
        (part) =>
          typeof part === "string" && part.length > 0 && part.length <= 2048,
      )
    )
      throw new Error();
    const result = {
      profile: { id: "offline", name: "Offline library", url: value[0] },
      userId: value[1],
    };
    if (accountScope(result) !== pkg.scope) throw new Error();
    return result;
  } catch {
    throw new Error(
      "The offline package needs its exact original account scope.",
    );
  }
}

/**
 * Call with a descriptor returned by OfflineReadAlongStore. Book/file IDs may
 * be reused by a changed source edition, so its package ID owns a separate
 * database; rows still retain their original server/account scope. This never
 * opens, migrates, or copies checkpoints/notes from the main library database.
 * Close repository.db when its offline workspace is closed.
 */
export function createOfflineReadAlongRepository(
  pkg: OfflineReadAlongDescriptor,
): LibraryRepository {
  const account = identity(pkg);
  const database = new AvidDatabase(`${DATABASE_PREFIX}${pkg.id}`);
  return new LibraryRepository(new OfflineProgressStorage(database), account);
}

function checkedAnchor(
  pkg: OfflineReadAlongDescriptor,
  value: ReadingAnchor,
  kind: "epub" | "audio",
): ReadingAnchor {
  if (
    value.bookId !== pkg.book.id ||
    value.kind !== kind ||
    typeof value.locator !== "string" ||
    !value.locator.trim() ||
    value.locator.length > 16_384 ||
    value.locator.includes("\0") ||
    !Number.isFinite(value.progress) ||
    value.progress < 0 ||
    value.progress > 1 ||
    typeof value.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.updatedAt))
  )
    throw new Error(
      "The offline checkpoint has an invalid book, kind, position, or timestamp.",
    );
  if (kind === "epub") {
    if (value.fileId !== pkg.textFileId)
      throw new Error("The reading checkpoint belongs to another EPUB file.");
  } else {
    const edition = pkg.alignmentSnapshot?.edition;
    const manifest = pkg.manifest;
    if (
      pkg.mode !== "paired" ||
      !edition ||
      !manifest ||
      edition.accountScope !== pkg.scope ||
      edition.bookId !== pkg.book.id ||
      edition.textFileId !== pkg.textFileId ||
      edition.textSha256 !== pkg.textSha256 ||
      edition.manifestRevision !== manifest.revision ||
      value.fileId !== edition.audioFileId
    )
      throw new Error(
        "The audio checkpoint belongs to another paired edition.",
      );
    let locator: {
      version?: unknown;
      manifestRevision?: unknown;
      time?: unknown;
      trackId?: unknown;
      trackTime?: unknown;
    };
    try {
      locator = JSON.parse(value.locator);
      if (!locator || typeof locator !== "object" || Array.isArray(locator))
        throw new Error();
    } catch {
      throw new Error("The audio checkpoint needs a revisioned JSON locator.");
    }
    if (
      (locator.version !== undefined && locator.version !== 1) ||
      locator.manifestRevision !== manifest.revision
    )
      throw new Error(
        "The audio checkpoint manifest revision does not match the saved edition.",
      );
    const seconds = (number: unknown): number | undefined =>
      typeof number === "number" && Number.isFinite(number) && number >= 0
        ? number
        : undefined;
    const time = seconds(locator.time);
    let trackPosition: number | undefined;
    let duration = 0;
    for (const asset of [...manifest.assets].sort(
      (a, b) => a.sequence - b.sequence,
    )) {
      if (
        asset.durationMs === null ||
        !Number.isFinite(asset.durationMs) ||
        asset.durationMs <= 0
      )
        throw new Error("The saved audiobook needs exact track durations.");
      if (locator.trackId === String(asset.fileId)) {
        const trackTime = seconds(locator.trackTime);
        if (
          trackTime === undefined ||
          trackTime > asset.durationMs / 1000 + POSITION_PRECISION
        )
          throw new Error("The audio checkpoint exceeds its saved track.");
        trackPosition = duration + trackTime;
      }
      duration += asset.durationMs / 1000;
    }
    if (
      duration <= 0 ||
      (locator.time !== undefined && time === undefined) ||
      (time !== undefined && time > duration + POSITION_PRECISION) ||
      (locator.trackId !== undefined && trackPosition === undefined) ||
      (locator.trackTime !== undefined && trackPosition === undefined) ||
      (time === undefined && trackPosition === undefined) ||
      (time !== undefined &&
        trackPosition !== undefined &&
        Math.abs(time - trackPosition) > POSITION_PRECISION)
    )
      throw new Error(
        "The audio checkpoint does not match the saved track timeline.",
      );
  }
  // Do not persist unrelated fields accidentally attached to a live checkpoint.
  return {
    bookId: value.bookId,
    fileId: value.fileId,
    kind: value.kind,
    locator: value.locator,
    progress: value.progress,
    updatedAt: value.updatedAt,
  };
}

/**
 * Seed only confirmed checkpoints for this exact saved edition. The caller must
 * establish the live EPUB byte identity: ReadingAnchor alone contains no hash.
 * Both seeds validate before writing; original timestamps and newer/equal local
 * checkpoints win. Notes are intentionally never imported or reconciled online.
 */
export async function seedOfflineReadAlongProgress(
  pkg: OfflineReadAlongDescriptor,
  seeds: { reading?: ReadingAnchor; audio?: ReadingAnchor },
): Promise<void> {
  identity(pkg);
  const anchors = [
    ...(seeds.reading ? [checkedAnchor(pkg, seeds.reading, "epub")] : []),
    ...(seeds.audio ? [checkedAnchor(pkg, seeds.audio, "audio")] : []),
  ];
  if (!anchors.length) return;
  const repository = createOfflineReadAlongRepository(pkg);
  try {
    await repository.atomic(["anchors"], async (transaction) => {
      for (const anchor of anchors) await transaction.importAnchor(anchor);
    });
  } finally {
    repository.db.close();
  }
}
