import type {
  NativeLibraryStorageBridge,
  StorageBlobReference,
  StorageCommitRequest,
  StorageReadRequest,
  StorageWireRow,
} from "../../src/storageProtocol";
/** Controlled protocol fixture, not evidence that a platform SQLite implementation passed. */
export class FixtureStorageBridge implements NativeLibraryStorageBridge {
  rows = new Map<string, Map<string, StorageWireRow>>();
  revisions = new Map<string, number>();
  rejectNextCommit = false;
  commits = 0;
  reads: StorageReadRequest[] = [];
  chunks: number[] = [];
  blobReads = 0;
  blobs = new Map<
    string,
    {
      scope: string;
      ref: StorageBlobReference;
      bytes: Uint8Array;
      offset: number;
      finished: boolean;
    }
  >();
  key(scope: string, table: string) {
    return JSON.stringify([scope, table]);
  }
  async read(request: StorageReadRequest) {
    this.reads.push(structuredClone(request));
    const key = this.key(request.scope, request.table),
      query = request.query ?? {};
    const rows = [...(this.rows.get(key)?.values() ?? [])].filter(
      (row) =>
        (!query.ids || query.ids.includes(row.id)) &&
        (query.entityKey === undefined || row.entityKey === query.entityKey),
    );
    return {
      revision: String(this.revisions.get(key) ?? 0),
      rows: structuredClone(
        rows.map((row) =>
          query.keysOnly ? { key: row.key, scope: row.scope, id: row.id } : row,
        ),
      ),
    };
  }
  async commit(request: StorageCommitRequest) {
    this.commits++;
    if (this.rejectNextCommit) {
      this.rejectNextCommit = false;
      return { committed: false };
    }
    for (const [table, revision] of Object.entries(request.expected))
      if (
        String(this.revisions.get(this.key(request.scope, table)) ?? 0) !==
        revision
      )
        return { committed: false };
    const touched = new Set<string>();
    for (const operation of request.mutations) {
      if (request.expected[operation.table] === undefined)
        throw new Error("Missing revision");
      const key = this.key(request.scope, operation.table);
      let rows = this.rows.get(key);
      if (!rows) {
        rows = new Map();
        this.rows.set(key, rows);
      }
      touched.add(key);
      if (operation.type === "clear") rows.clear();
      else if (operation.type === "delete") rows.delete(operation.id);
      else {
        if (
          operation.row.scope !== request.scope ||
          operation.row.key !==
            JSON.stringify([request.scope, operation.row.id])
        )
          throw new Error("Different scope");
        rows.set(operation.row.id, structuredClone(operation.row));
      }
    }
    for (const key of touched)
      this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1);
    return { committed: true };
  }
  async beginBlob(request: {
    scope: string;
    size: number;
    mime: string;
    name: string;
  }) {
    const id = crypto.randomUUID();
    this.blobs.set(id, {
      scope: request.scope,
      ref: {
        blobId: id,
        size: request.size,
        mime: request.mime,
        name: request.name,
      },
      bytes: new Uint8Array(request.size),
      offset: 0,
      finished: false,
    });
    return { id };
  }
  async appendBlob(request: {
    scope: string;
    id: string;
    offset: number;
    dataBase64: string;
  }) {
    const blob = this.blobs.get(request.id)!;
    const bytes = Uint8Array.from(atob(request.dataBase64), (char) =>
      char.charCodeAt(0),
    );
    if (
      blob.scope !== request.scope ||
      blob.finished ||
      blob.offset !== request.offset ||
      bytes.length > 256 * 1024
    )
      throw new Error("Invalid chunk");
    this.chunks.push(bytes.length);
    blob.bytes.set(bytes, request.offset);
    blob.offset += bytes.length;
  }
  async finishBlob(request: { scope: string; id: string }) {
    const blob = this.blobs.get(request.id)!;
    if (blob.scope !== request.scope || blob.offset !== blob.ref.size)
      throw new Error("Incomplete bytes");
    blob.finished = true;
    return blob.ref;
  }
  async readBlob(request: {
    scope: string;
    blobId: string;
    offset: number;
    length: number;
  }) {
    this.blobReads++;
    const blob = this.blobs.get(request.blobId)!;
    if (
      blob.scope !== request.scope ||
      !blob.finished ||
      request.length > 256 * 1024
    )
      throw new Error("Invalid read");
    const bytes = blob.bytes.subarray(
      request.offset,
      request.offset + request.length,
    );
    let value = "";
    for (const byte of bytes) value += String.fromCharCode(byte);
    return {
      dataBase64: btoa(value),
      done: request.offset + bytes.length === blob.ref.size,
    };
  }
  async cancelBlob(request: { scope: string; id: string }) {
    if (this.blobs.get(request.id)?.scope === request.scope)
      this.blobs.delete(request.id);
  }
}
