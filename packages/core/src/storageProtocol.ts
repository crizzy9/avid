/** Version 1 desktop repository bridge. Every command is restricted to the Avid main window. */
export const LIBRARY_STORAGE_TABLES = [
  "books",
  "anchors",
  "annotations",
  "collections",
  "sessions",
  "preferences",
  "outbox",
  "localFiles",
  "nativeReceipts",
] as const;
export type LibraryStorageTable = (typeof LIBRARY_STORAGE_TABLES)[number];
export interface StorageWireRow {
  /** Exactly JSON.stringify([scope,id]); implementations must validate this. */
  key: string;
  scope: string;
  id: string;
  [field: string]: unknown;
}
export interface StorageWireQuery {
  /** Omit for all rows belonging to scope. An empty array means no rows. */
  ids?: string[];
  /** Valid for outbox only. Applied in addition to ids when both are provided. */
  entityKey?: string;
  /** Return only {key,scope,id}; never load or serialize local file bytes. */
  keysOnly?: boolean;
}
export interface StorageReadRequest {
  scope: string;
  table: LibraryStorageTable;
  query?: StorageWireQuery;
}
export interface StorageReadResult {
  /** Monotonic revision for the entire (scope,table), encoded as a decimal string. */
  revision: string;
  rows: StorageWireRow[];
}
export type StorageWireMutation =
  | { type: "put"; table: LibraryStorageTable; row: StorageWireRow }
  | { type: "delete"; table: LibraryStorageTable; id: string }
  | { type: "clear"; table: LibraryStorageTable };
export interface StorageCommitRequest {
  scope: string;
  /** All read and mutated tables must have an expected revision, including absent tables ('0'). */
  expected: Partial<Record<LibraryStorageTable, string>>;
  mutations: StorageWireMutation[];
}
export interface StorageCommitResult {
  committed: boolean;
}
export interface NativeLibraryStorageBridge {
  read(request: StorageReadRequest): Promise<StorageReadResult>;
  /** BEGIN IMMEDIATE; compare every revision; apply ordered mutations; increment each changed table; COMMIT.
   * A mismatch must roll back and return false without applying any mutation. An empty mutation list
   * still checks revisions, providing a consistent read snapshot. Revisions survive account clearing.
   */
  commit(request: StorageCommitRequest): Promise<StorageCommitResult>;
  beginBlob(request: {
    scope: string;
    size: number;
    mime: string;
    name: string;
  }): Promise<{ id: string }>;
  appendBlob(request: {
    scope: string;
    id: string;
    offset: number;
    dataBase64: string;
  }): Promise<void>;
  finishBlob(request: {
    scope: string;
    id: string;
  }): Promise<StorageBlobReference>;
  readBlob(request: {
    scope: string;
    blobId: string;
    offset: number;
    length: number;
  }): Promise<{ dataBase64: string; done: boolean }>;
  cancelBlob(request: { scope: string; id: string }): Promise<void>;
}
export interface StorageBlobReference {
  blobId: string;
  size: number;
  mime: string;
  name: string;
}
/**
 * localFiles value.blob is StorageBlobReference, never a full base64 file. Binary append/read calls
 * carry at most 256KiB decoded bytes. Appends require the exact next offset; finish verifies size.
 * Commit validates each blob reference belongs to scope and has the exact size/mime/name. Finished
 * files are immutable; commit publishes references atomically. Native private staging expires
 * safely when unreferenced. keysOnly must avoid reading binary contents.
 * All other fields are plain JSON. Credentials and authentication cookies are never stored here.
 * Native commands use `library_storage_read`, `library_storage_commit`, and
 * `library_storage_blob_begin|append|finish|read|cancel`, each with {request}.
 */
