import { accountScope } from "./repository";
import {
  assertStorageRow,
  storageKey,
  type LibraryRows,
  type LibraryStorage,
  type StorageTransaction,
} from "./storage";
import {
  LIBRARY_STORAGE_TABLES,
  type LibraryStorageTable,
} from "./storageProtocol";
import type { Session } from "./types";
const VERSION = 1;
const CHUNK_BYTES = 256 * 1024;
const READ_BATCH = 200;
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
type AnyRow = LibraryRows[LibraryStorageTable];
interface Entry {
  table: LibraryStorageTable;
  row: AnyRow;
  fingerprint: string;
}
interface Snapshot {
  entries: Entry[];
  fingerprint: string;
  counts: Record<LibraryStorageTable, number>;
  fileBytes: number;
}
export interface StorageMigrationReceipt {
  version: 1;
  scope: string;
  source: string;
  destination: string;
  sourceFingerprint: string;
  counts: Record<LibraryStorageTable, number>;
  fileBytes: number;
  completedAt: string;
}
export class StorageMigrationConflictError extends Error {
  constructor(
    readonly table: LibraryStorageTable | undefined,
    readonly recordId: string | undefined,
    message = "The native library already contains different data. Migration stopped without replacing it.",
  ) {
    super(message);
    this.name = "StorageMigrationConflictError";
  }
}
export class StorageMigrationVerificationError extends Error {
  constructor(
    message = "The copied library could not be verified. The original library is still intact.",
  ) {
    super(message);
    this.name = "StorageMigrationVerificationError";
  }
}
export const migrationReceiptId = (sourceName: string) =>
  `storage-migration:v${VERSION}:${sourceName}`;
function active(isActive?: () => boolean) {
  if (isActive?.() === false)
    throw new DOMException("Library migration was canceled.", "AbortError");
}
function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (
    value &&
    typeof value === "object" &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  )
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => compareText(a, b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  throw new StorageMigrationVerificationError(
    "The original library contains a value that cannot be safely copied to native storage.",
  );
}
async function digest(value: string | Uint8Array<ArrayBuffer>) {
  const bytes =
    typeof value === "string" ? new TextEncoder().encode(value) : value;
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
async function rowFingerprint(
  table: LibraryStorageTable,
  row: AnyRow,
  isActive?: () => boolean,
): Promise<string> {
  active(isActive);
  if (table !== "localFiles") return digest(canonical(row));
  const file = row as LibraryRows["localFiles"];
  if (
    !file.value ||
    typeof file.value.name !== "string" ||
    !file.value.blob ||
    typeof file.value.blob.slice !== "function"
  )
    throw new StorageMigrationVerificationError(
      "The original library contains an invalid file.",
    );
  const blob = file.value.blob,
    parts: string[] = [];
  for (let offset = 0; offset < blob.size; offset += CHUNK_BYTES) {
    parts.push(
      await digest(
        new Uint8Array(
          await blob.slice(offset, offset + CHUNK_BYTES).arrayBuffer(),
        ),
      ),
    );
    active(isActive);
  }
  return digest(
    canonical({
      ...file,
      value: {
        ...file.value,
        blob: {
          size: blob.size,
          type: blob.type,
          chunkBytes: CHUNK_BYTES,
          digests: parts,
        },
      },
    }),
  );
}
async function snapshot(
  storage: LibraryStorage,
  scope: string,
  isActive?: () => boolean,
): Promise<Snapshot> {
  active(isActive);
  const rows = await storage.atomic(
    scope,
    [...LIBRARY_STORAGE_TABLES],
    async (transaction) => {
      const result: { table: LibraryStorageTable; row: AnyRow }[] = [];
      for (const table of LIBRARY_STORAGE_TABLES) {
        for (const row of await transaction.read(table)) {
          assertStorageRow(scope, row);
          result.push({ table, row });
        }
        active(isActive);
      }
      return result;
    },
  );
  rows.sort(
    (a, b) => compareText(a.table, b.table) || compareText(a.row.id, b.row.id),
  );
  const entries: Entry[] = [],
    counts = Object.fromEntries(
      LIBRARY_STORAGE_TABLES.map((table) => [table, 0]),
    ) as Record<LibraryStorageTable, number>;
  let fileBytes = 0;
  for (const entry of rows) {
    entries.push({
      ...entry,
      fingerprint: await rowFingerprint(entry.table, entry.row, isActive),
    });
    counts[entry.table]++;
    if (entry.table === "localFiles")
      fileBytes += (entry.row as LibraryRows["localFiles"]).value.blob.size;
  }
  return {
    entries,
    counts,
    fileBytes,
    fingerprint: await digest(
      canonical(
        entries.map((entry) => [entry.table, entry.row.id, entry.fingerprint]),
      ),
    ),
  };
}
function receiptValue(
  value: unknown,
  scope: string,
  source: string,
  destination: string,
): StorageMigrationReceipt {
  const record = value as Partial<StorageMigrationReceipt> | undefined;
  if (
    !record ||
    record.version !== VERSION ||
    record.scope !== scope ||
    record.source !== source ||
    record.destination !== destination ||
    !/^[a-f0-9]{64}$/.test(record.sourceFingerprint ?? "") ||
    !Number.isFinite(Date.parse(record.completedAt ?? "")) ||
    !Number.isSafeInteger(record.fileBytes) ||
    (record.fileBytes ?? -1) < 0 ||
    !record.counts ||
    !LIBRARY_STORAGE_TABLES.every(
      (table) =>
        Number.isSafeInteger(record.counts![table]) &&
        record.counts![table] >= 0,
    )
  )
    throw new StorageMigrationConflictError(
      "preferences",
      migrationReceiptId(source),
      "The native migration receipt is invalid. Migration stopped without changing either library.",
    );
  return record as StorageMigrationReceipt;
}
async function readReceipt(
  transaction: StorageTransaction,
  id: string,
  scope: string,
  source: string,
  destination: string,
) {
  const row = (await transaction.read("preferences", { ids: [id] }))[0];
  return row ? receiptValue(row.value, scope, source, destination) : undefined;
}
async function compareRows(
  transaction: StorageTransaction,
  source: Snapshot,
  copyMissing: boolean,
  isActive?: () => boolean,
) {
  for (const table of LIBRARY_STORAGE_TABLES) {
    const entries = source.entries.filter((entry) => entry.table === table);
    for (let offset = 0; offset < entries.length; offset += READ_BATCH) {
      const batch = entries.slice(offset, offset + READ_BATCH);
      const rows = new Map(
        (
          await transaction.read(table, {
            ids: batch.map((entry) => entry.row.id),
          })
        ).map((row) => [row.id, row]),
      );
      for (const entry of batch) {
        active(isActive);
        const existing = rows.get(entry.row.id);
        if (existing) {
          if (
            (await transaction.waitForLocal(() =>
              rowFingerprint(table, existing, isActive),
            )) !== entry.fingerprint
          )
            throw new StorageMigrationConflictError(table, entry.row.id);
        } else if (copyMissing) await transaction.put(table, entry.row);
        else
          throw new StorageMigrationVerificationError(
            `The copied ${table} record could not be read back.`,
          );
      }
    }
  }
}
/**
 * Copies a single legacy account before native activation. Source is never written/deleted.
 * A completed receipt makes native storage authoritative; later edits in the preserved legacy
 * database are intentionally not imported automatically. Partial failures are safe to retry.
 */
export async function migrateLibraryAccount(options: {
  source: LibraryStorage;
  target: LibraryStorage;
  session: Pick<Session, "profile" | "userId">;
  isActive?: () => boolean;
}): Promise<{
  status: "copied" | "already-complete";
  receipt: StorageMigrationReceipt;
}> {
  const { source, target, isActive } = options,
    scope = accountScope(options.session),
    id = migrationReceiptId(source.name);
  if (source === target || source.name === target.name)
    throw new Error(
      "Library migration requires distinct source and destination databases.",
    );
  active(isActive);
  const prior = await target.atomic(scope, ["preferences"], (transaction) =>
    readReceipt(transaction, id, scope, source.name, target.name),
  );
  active(isActive);
  if (prior) return { status: "already-complete", receipt: prior };
  const original = await snapshot(source, scope, isActive);
  if (
    original.entries.some(
      (entry) => entry.table === "preferences" && entry.row.id === id,
    )
  )
    throw new StorageMigrationConflictError(
      "preferences",
      id,
      "The legacy library uses a reserved migration identity.",
    );
  const concurrent = await target.atomic(
    scope,
    [...LIBRARY_STORAGE_TABLES],
    async (transaction) => {
      active(isActive);
      const completed = await readReceipt(
        transaction,
        id,
        scope,
        source.name,
        target.name,
      );
      if (completed) return completed;
      await compareRows(transaction, original, true, isActive);
      active(isActive);
      return undefined;
    },
  );
  active(isActive);
  if (concurrent) return { status: "already-complete", receipt: concurrent };
  const current = await snapshot(source, scope, isActive);
  if (current.fingerprint !== original.fingerprint)
    throw new StorageMigrationConflictError(
      undefined,
      undefined,
      "The original library changed during migration. It was preserved; review the copy before activating native storage.",
    );
  // This second transaction reads the committed records, not just buffered writes.
  const result = await target.atomic(
    scope,
    [...LIBRARY_STORAGE_TABLES],
    async (transaction) => {
      active(isActive);
      const completed = await readReceipt(
        transaction,
        id,
        scope,
        source.name,
        target.name,
      );
      if (completed)
        return { status: "already-complete" as const, receipt: completed };
      await compareRows(transaction, original, false, isActive);
      const receipt: StorageMigrationReceipt = {
        version: VERSION,
        scope,
        source: source.name,
        destination: target.name,
        sourceFingerprint: original.fingerprint,
        counts: original.counts,
        fileBytes: original.fileBytes,
        completedAt: new Date().toISOString(),
      };
      active(isActive);
      await transaction.put("preferences", {
        key: storageKey(scope, id),
        scope,
        id,
        value: receipt as unknown as Record<string, unknown>,
      });
      active(isActive);
      return { status: "copied" as const, receipt };
    },
  );
  active(isActive);
  return result;
}

/**
 * Readiness boundary for native bootstrap. Migration itself always uses raw source/target,
 * so calls cannot recurse through this wrapper. One failed attempt rejects every waiting
 * caller and is removed; a subsequent explicit library operation can retry it.
 */
export class MigratingLibraryStorage implements LibraryStorage {
  readonly name: string;
  private readonly migrations = new Map<
    string,
    Promise<{
      status: "copied" | "already-complete";
      receipt: StorageMigrationReceipt;
    }>
  >();
  constructor(
    readonly source: LibraryStorage,
    readonly target: LibraryStorage,
  ) {
    if (source === target || source.name === target.name)
      throw new Error(
        "Library migration requires distinct source and destination databases.",
      );
    this.name = target.name;
  }
  ready(scope: string): Promise<{
    status: "copied" | "already-complete";
    receipt: StorageMigrationReceipt;
  }> {
    const pending = this.migrations.get(scope);
    if (pending) return pending;
    const operation = (async () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(scope);
      } catch {
        throw new Error("A canonical account scope is required for migration.");
      }
      if (
        !Array.isArray(parsed) ||
        parsed.length !== 2 ||
        typeof parsed[0] !== "string" ||
        typeof parsed[1] !== "string"
      )
        throw new Error("A canonical account scope is required for migration.");
      const session = {
        profile: { id: "migration", name: "Avid", url: parsed[0] },
        userId: parsed[1],
      };
      if (accountScope(session) !== scope)
        throw new Error("A canonical account scope is required for migration.");
      return migrateLibraryAccount({
        source: this.source,
        target: this.target,
        session,
      });
    })();
    this.migrations.set(scope, operation);
    void operation.catch(() => {
      if (this.migrations.get(scope) === operation)
        this.migrations.delete(scope);
    });
    return operation;
  }
  async read<T extends LibraryStorageTable>(
    scope: string,
    table: T,
    query?: import("./storageProtocol").StorageWireQuery,
  ): Promise<LibraryRows[T][]> {
    await this.ready(scope);
    return this.target.read(scope, table, query);
  }
  async atomic<T>(
    scope: string,
    tables: LibraryStorageTable[],
    work: (transaction: StorageTransaction) => Promise<T>,
  ): Promise<T> {
    await this.ready(scope);
    return this.target.atomic(scope, tables, work);
  }
}
