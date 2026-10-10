import {
  assertStorageRow,
  type LibraryRows,
  type LibraryStorage,
  type StorageTransaction,
} from "./storage";
import type {
  LibraryStorageTable,
  NativeLibraryStorageBridge,
  StorageBlobReference,
  StorageReadResult,
  StorageWireMutation,
  StorageWireQuery,
  StorageWireRow,
} from "./storageProtocol";
const CHUNK = 256 * 1024;
class RetryTransaction extends Error {}
const matches = (row: StorageWireRow, query: StorageWireQuery) =>
  (!query.ids || query.ids.includes(row.id)) &&
  (query.entityKey === undefined || row.entityKey === query.entityKey);
const isReference = (value: unknown): value is StorageBlobReference =>
  !!value &&
  typeof value === "object" &&
  "blobId" in value &&
  typeof value.blobId === "string" &&
  "size" in value &&
  typeof value.size === "number" &&
  Number.isSafeInteger(value.size) &&
  value.size >= 0 &&
  "mime" in value &&
  typeof value.mime === "string" &&
  "name" in value &&
  typeof value.name === "string";
function bytesFromBase64(value: string): Uint8Array<ArrayBuffer> {
  const decoded = atob(value);
  return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
}
function base64FromBytes(value: Uint8Array): string {
  let text = "";
  for (let i = 0; i < value.length; i += 8192)
    text += String.fromCharCode(...value.subarray(i, i + 8192));
  return btoa(text);
}
/** Native CAS transactions contain no ambient state; concurrent callbacks cannot borrow one another's scope. */
export class NativeLibraryStorage implements LibraryStorage {
  private prepared = new WeakMap<
    Blob,
    Map<string, Promise<StorageBlobReference>>
  >();
  constructor(
    readonly bridge: NativeLibraryStorageBridge,
    readonly name = "avid-native-library-v1",
  ) {}
  private async checkedRead(
    scope: string,
    table: LibraryStorageTable,
    query: StorageWireQuery = {},
  ): Promise<StorageReadResult> {
    if (query.entityKey !== undefined && table !== "outbox")
      throw new Error("Entity queries require the outbox table.");
    const result = await this.bridge.read({ scope, table, query });
    if (!/^\d+$/.test(result.revision) || !Array.isArray(result.rows))
      throw new Error("Invalid native storage response.");
    for (const row of result.rows) {
      assertStorageRow(scope, row);
      if (
        (query.ids !== undefined && !query.ids.includes(row.id)) ||
        (!query.keysOnly && !matches(row, query))
      )
        throw new Error("Native storage returned a different row.");
    }
    return result;
  }
  private prepareBlob(
    scope: string,
    blob: Blob,
    name: string,
  ): Promise<StorageBlobReference> {
    let entries = this.prepared.get(blob);
    if (!entries) {
      entries = new Map();
      this.prepared.set(blob, entries);
    }
    const cacheKey = JSON.stringify([scope, name]);
    const prior = entries.get(cacheKey);
    if (prior) return prior;
    const pending = (async () => {
      const { id } = await this.bridge.beginBlob({
        scope,
        size: blob.size,
        mime: blob.type,
        name,
      });
      try {
        for (let offset = 0; offset < blob.size; offset += CHUNK) {
          const bytes = new Uint8Array(
            await blob.slice(offset, offset + CHUNK).arrayBuffer(),
          );
          await this.bridge.appendBlob({
            scope,
            id,
            offset,
            dataBase64: base64FromBytes(bytes),
          });
        }
        const ref = await this.bridge.finishBlob({ scope, id });
        if (
          !isReference(ref) ||
          ref.size !== blob.size ||
          ref.mime !== blob.type ||
          ref.name !== name
        )
          throw new Error("Native file receipt does not match imported bytes.");
        return ref;
      } catch (error) {
        await this.bridge.cancelBlob({ scope, id }).catch(() => {});
        throw error;
      }
    })();
    entries.set(cacheKey, pending);
    void pending.catch(() => entries!.delete(cacheKey));
    return pending;
  }
  private async encode(
    scope: string,
    table: LibraryStorageTable,
    row: LibraryRows[LibraryStorageTable],
  ): Promise<StorageWireRow> {
    assertStorageRow(scope, row);
    if (table === "localFiles") {
      const file = row as LibraryRows["localFiles"];
      const blob = await this.prepareBlob(
        scope,
        file.value.blob,
        file.value.name,
      );
      return { ...file, value: { name: file.value.name, blob } };
    }
    // Strip undefined fields consistently with the native JSON boundary.
    return JSON.parse(JSON.stringify(row)) as StorageWireRow;
  }
  private async decode<T extends LibraryStorageTable>(
    scope: string,
    table: T,
    row: StorageWireRow,
    keysOnly = false,
  ): Promise<LibraryRows[T]> {
    if (table === "localFiles" && !keysOnly) {
      const value = row.value as { name?: unknown; blob?: unknown };
      if (
        !value ||
        typeof value.name !== "string" ||
        !isReference(value.blob) ||
        value.name !== value.blob.name
      )
        throw new Error("Invalid native file reference.");
      const ref = value.blob,
        parts: BlobPart[] = [];
      for (let offset = 0; offset < ref.size;) {
        const length = Math.min(CHUNK, ref.size - offset);
        const result = await this.bridge.readBlob({
          scope,
          blobId: ref.blobId,
          offset,
          length,
        });
        const bytes = bytesFromBase64(result.dataBase64);
        if (
          bytes.length !== length ||
          result.done !== (offset + length === ref.size)
        )
          throw new Error("Native file bytes were truncated or changed.");
        parts.push(bytes);
        offset += bytes.length;
      }
      return {
        ...row,
        value: { name: value.name, blob: new Blob(parts, { type: ref.mime }) },
      } as unknown as LibraryRows[T];
    }
    return row as unknown as LibraryRows[T];
  }
  async read<T extends LibraryStorageTable>(
    scope: string,
    table: T,
    query: StorageWireQuery = {},
  ): Promise<LibraryRows[T][]> {
    const result = await this.checkedRead(scope, table, query);
    return Promise.all(
      result.rows.map((row) => this.decode(scope, table, row, query.keysOnly)),
    );
  }
  async atomic<T>(
    scope: string,
    tables: LibraryStorageTable[],
    work: (transaction: StorageTransaction) => Promise<T>,
  ): Promise<T> {
    const allowed = new Set(tables);
    for (let attempt = 0; attempt < 16; attempt++) {
      const expected: Partial<Record<LibraryStorageTable, string>> = {};
      const mutations: StorageWireMutation[] = [];
      const check = (table: LibraryStorageTable) => {
        if (!allowed.has(table))
          throw new Error(`Table ${table} is outside this transaction.`);
      };
      const fetchRows = async (
        table: LibraryStorageTable,
        query: StorageWireQuery = {},
      ) => {
        check(table);
        const result = await this.checkedRead(scope, table, query);
        if (
          expected[table] !== undefined &&
          expected[table] !== result.revision
        )
          throw new RetryTransaction();
        expected[table] = result.revision;
        return result.rows;
      };
      const revision = async (table: LibraryStorageTable) => {
        check(table);
        if (expected[table] === undefined) await fetchRows(table, { ids: [] });
      };
      const transaction: StorageTransaction = {
        waitForLocal: (work) => work(),
        read: async (table, query = {}) => {
          const rows = new Map(
            (await fetchRows(table, query)).map((row) => [row.id, row]),
          );
          for (const mutation of mutations) {
            if (mutation.table !== table) continue;
            if (mutation.type === "clear") rows.clear();
            else if (mutation.type === "delete") rows.delete(mutation.id);
            else if (matches(mutation.row, query))
              rows.set(mutation.row.id, mutation.row);
            else rows.delete(mutation.row.id);
          }
          return Promise.all(
            [...rows.values()].map((row) =>
              this.decode(
                scope,
                table,
                query.keysOnly
                  ? { key: row.key, scope: row.scope, id: row.id }
                  : row,
                query.keysOnly,
              ),
            ),
          );
        },
        put: async (table, row) => {
          await revision(table);
          mutations.push({
            type: "put",
            table,
            row: await this.encode(scope, table, row),
          });
        },
        delete: async (table, id) => {
          await revision(table);
          mutations.push({ type: "delete", table, id });
        },
        clear: async (table) => {
          await revision(table);
          mutations.push({ type: "clear", table });
        },
      };
      try {
        const result = await work(transaction);
        if (
          (await this.bridge.commit({ scope, expected, mutations })).committed
        ) {
          if (
            mutations.some(
              (mutation) =>
                mutation.table === "localFiles" && mutation.type !== "put",
            )
          )
            this.prepared = new WeakMap();
          return result;
        }
      } catch (error) {
        if (!(error instanceof RetryTransaction)) {
          // Aborted transactions may leave temporary file receipts that expire.
          // A later retry must upload again instead of reusing an expired ref.
          this.prepared = new WeakMap();
          throw error;
        }
      }
    }
    this.prepared = new WeakMap();
    throw new Error("The local library kept changing. Retry this operation.");
  }
}
