import Dexie, { type Table } from "dexie";
import type {
  Annotation,
  Book,
  Collection,
  ReadingAnchor,
  ReadingSession,
} from "./types";
import type { AvidDatabase, OutboxOperation } from "./repository";
import type { LibraryStorageTable, StorageWireQuery } from "./storageProtocol";
export type { LibraryStorageTable } from "./storageProtocol";
export interface RecordRow<T> {
  key: string;
  scope: string;
  id: string;
  value: T;
}
export interface LibraryRows {
  books: RecordRow<Book>;
  anchors: RecordRow<ReadingAnchor>;
  annotations: RecordRow<Annotation>;
  collections: RecordRow<Collection>;
  sessions: RecordRow<ReadingSession> & { fileId?: string; endedAt?: string };
  preferences: RecordRow<Record<string, unknown>>;
  outbox: OutboxOperation;
  localFiles: RecordRow<{ name: string; blob: Blob }>;
  nativeReceipts: RecordRow<{ fingerprint: string }>;
}
export interface StorageTransaction {
  /** Await bounded Blob/WebCrypto work without ending an IndexedDB transaction. No database or network calls inside. */
  waitForLocal<T>(work: () => Promise<T>): Promise<T>;
  read<T extends LibraryStorageTable>(
    table: T,
    query?: StorageWireQuery,
  ): Promise<LibraryRows[T][]>;
  put<T extends LibraryStorageTable>(
    table: T,
    row: LibraryRows[T],
  ): Promise<void>;
  delete(table: LibraryStorageTable, id: string): Promise<void>;
  clear(table: LibraryStorageTable): Promise<void>;
}
export interface LibraryStorage {
  /** Stable database identity used to coordinate one in-process sync worker. */
  readonly name: string;
  read<T extends LibraryStorageTable>(
    scope: string,
    table: T,
    query?: StorageWireQuery,
  ): Promise<LibraryRows[T][]>;
  /** Callback may be replayed by CAS backends. It must contain only local storage work. */
  atomic<T>(
    scope: string,
    tables: LibraryStorageTable[],
    work: (transaction: StorageTransaction) => Promise<T>,
  ): Promise<T>;
}
export const storageKey = (scope: string, id: string) =>
  JSON.stringify([scope, id]);
export function assertStorageRow(
  scope: string,
  row: { key: string; scope: string; id: string },
): void {
  if (
    row.scope !== scope ||
    typeof row.id !== "string" ||
    row.key !== storageKey(scope, row.id)
  )
    throw new Error("Storage row account or identity does not match.");
}
/** Existing versioned IndexedDB schema is retained; no migration or cache deletion is required. */
export class DexieLibraryStorage implements LibraryStorage {
  readonly name: string;
  constructor(readonly database: AvidDatabase) {
    this.name = database.name;
  }
  private table<T extends LibraryStorageTable>(
    name: T,
  ): Table<LibraryRows[T], string> {
    return this.database[name] as Table<LibraryRows[T], string>;
  }
  async read<T extends LibraryStorageTable>(
    scope: string,
    name: T,
    query: StorageWireQuery = {},
  ): Promise<LibraryRows[T][]> {
    const table = this.table(name);
    if (query.entityKey !== undefined && name !== "outbox")
      throw new Error("Entity queries require the outbox table.");
    if (query.keysOnly) {
      const keys = query.ids
        ? query.ids.map((id) => storageKey(scope, id))
        : await table.where("scope").equals(scope).primaryKeys();
      if (query.entityKey !== undefined)
        return (
          await this.read(scope, name, { ...query, keysOnly: false })
        ).map(({ key, scope, id }) => ({ key, scope, id }) as LibraryRows[T]);
      const found = query.ids
        ? await Promise.all(
            keys.map(async (key) =>
              (await table.where("key").equals(key).count()) ? key : undefined,
            ),
          )
        : keys;
      return found
        .filter((key): key is string => key !== undefined)
        .map(
          (key) =>
            ({
              key,
              scope,
              id: JSON.parse(key)[1] as string,
            }) as LibraryRows[T],
        );
    }
    const rows = query.ids
      ? (
          await table.bulkGet(query.ids.map((id) => storageKey(scope, id)))
        ).filter((row): row is LibraryRows[T] => row !== undefined)
      : await table.where("scope").equals(scope).toArray();
    return rows.filter(
      (row) =>
        query.entityKey === undefined ||
        ("entityKey" in row && row.entityKey === query.entityKey),
    );
  }
  async atomic<T>(
    scope: string,
    names: LibraryStorageTable[],
    work: (transaction: StorageTransaction) => Promise<T>,
  ): Promise<T> {
    const allowed = new Set(names);
    const check = (name: LibraryStorageTable) => {
      if (!allowed.has(name))
        throw new Error(`Table ${name} is outside this transaction.`);
    };
    return this.database.transaction(
      "rw",
      names.map((name) => this.database[name]),
      async () => {
        const pending = work({
          waitForLocal: (work) =>
            Dexie.waitFor(Dexie.ignoreTransaction(work), 300_000),
          read: (name, query) => {
            check(name);
            return this.read(scope, name, query);
          },
          put: async (name, row) => {
            check(name);
            assertStorageRow(scope, row);
            await this.table(name).put(row);
          },
          delete: async (name, id) => {
            check(name);
            await this.table(name).delete(storageKey(scope, id));
          },
          clear: async (name) => {
            check(name);
            await this.table(name).where("scope").equals(scope).delete();
          },
        });
        return await pending;
      },
    );
  }
}
