import Dexie, { type Table } from "dexie";
import {
  DexieLibraryStorage,
  type LibraryStorage,
  type LibraryRows,
  type RecordRow,
  type StorageTransaction,
} from "./storage";
import {
  LIBRARY_STORAGE_TABLES,
  type LibraryStorageTable,
  type StorageWireQuery,
} from "./storageProtocol";
import type {
  Annotation,
  Book,
  Collection,
  ReadingAnchor,
  ReadingSession,
  Session,
} from "./types";
import { normalizeServerUrl } from "./bookorbit";

/** Server URL and authenticated identity, never a token or a display/profile name. */
export function accountScope(
  session: Pick<Session, "profile" | "userId">,
): string {
  return JSON.stringify([
    normalizeServerUrl(session.profile.url),
    session.userId,
  ]);
}
export type OutboxStatus =
  "pending" | "syncing" | "conflict" | "failed" | "uncertain";
export type SyncPayload =
  | { kind: "progress"; anchor: ReadingAnchor }
  | { kind: "annotation"; annotation: Annotation }
  | {
      kind: "preferences";
      bookId: string;
      fileId: string;
      set: Record<string, unknown>;
      unset: string[];
      localSet: Record<string, unknown>;
    }
  | {
      kind: "session";
      session: ReadingSession;
      fileId: string;
      endedAt: string;
    };
export interface OutboxOperation {
  key: string;
  scope: string;
  id: string;
  entityKey: string;
  payload: SyncPayload;
  occurredAt: string;
  status: OutboxStatus;
  attempts: number;
  error?: string;
  nextAttemptAt?: string;
  expectedRemoteUpdatedAt?: string;
  leaseUntil?: string;
}
export class AvidDatabase extends Dexie {
  books!: Table<RecordRow<Book>, string>;
  anchors!: Table<RecordRow<ReadingAnchor>, string>;
  annotations!: Table<RecordRow<Annotation>, string>;
  collections!: Table<RecordRow<Collection>, string>;
  sessions!: Table<
    RecordRow<ReadingSession> & { fileId?: string; endedAt?: string },
    string
  >;
  preferences!: Table<RecordRow<Record<string, unknown>>, string>;
  outbox!: Table<OutboxOperation, string>;
  localFiles!: Table<RecordRow<{ name: string; blob: Blob }>, string>;
  nativeReceipts!: Table<RecordRow<{ fingerprint: string }>, string>;
  constructor(name = "avid-library-v1") {
    super(name);
    this.version(1).stores({
      books: "key,scope,[scope+id]",
      anchors: "key,scope,[scope+id]",
      annotations: "key,scope,[scope+id]",
      collections: "key,scope,[scope+id]",
      sessions: "key,scope,[scope+id]",
      preferences: "key,scope,[scope+id]",
      outbox: "key,scope,[scope+entityKey],[scope+status]",
    });
    this.version(2).stores({ localFiles: "key,scope,[scope+id]" });
    this.version(3).stores({ nativeReceipts: "key,scope,[scope+id]" });
  }
}
export const anchorIdentity = (
  anchor: Pick<ReadingAnchor, "bookId" | "fileId" | "kind">,
) => JSON.stringify([anchor.bookId, anchor.fileId, anchor.kind]);
function requireTime(value: string): void {
  if (!Number.isFinite(Date.parse(value)))
    throw new Error("A source event timestamp is required.");
}
/** Each instance is permanently scoped; changing accounts creates a new instance. */
export class LibraryRepository {
  readonly scope: string;
  readonly storage: LibraryStorage;
  private readonly identity: Pick<Session, "profile" | "userId">;
  constructor(
    source: AvidDatabase | LibraryStorage,
    session: Pick<Session, "profile" | "userId">,
    private readonly transaction?: StorageTransaction,
  ) {
    this.scope = accountScope(session);
    this.identity = {
      profile: {
        ...session.profile,
        url: normalizeServerUrl(session.profile.url),
      },
      userId: session.userId,
    };
    this.storage =
      source instanceof AvidDatabase ? new DexieLibraryStorage(source) : source;
  }
  /** Compatibility for browser diagnostics/tests only. Production callers use atomic/readRecords. */
  get db(): AvidDatabase {
    if (this.storage instanceof DexieLibraryStorage)
      return this.storage.database;
    throw new Error("This repository uses native storage.");
  }
  atomic<T>(
    tables: LibraryStorageTable[],
    work: (repository: LibraryRepository) => Promise<T>,
  ): Promise<T> {
    return this.transaction
      ? work(this)
      : this.storage.atomic(this.scope, tables, (tx) =>
          work(new LibraryRepository(this.storage, this.identity, tx)),
        );
  }
  readRecords<T extends LibraryStorageTable>(
    table: T,
    query?: StorageWireQuery,
  ): Promise<LibraryRows[T][]> {
    return this.transaction
      ? this.transaction.read(table, query)
      : this.storage.read(this.scope, table, query);
  }
  async putRecord<T extends LibraryStorageTable>(
    table: T,
    row: LibraryRows[T],
  ): Promise<void> {
    if (this.transaction) return this.transaction.put(table, row);
    return this.atomic([table], (repo) => repo.putRecord(table, row));
  }
  async deleteRecord(table: LibraryStorageTable, id: string): Promise<void> {
    if (this.transaction) return this.transaction.delete(table, id);
    return this.atomic([table], (repo) => repo.deleteRecord(table, id));
  }
  async clearRecords(table: LibraryStorageTable): Promise<void> {
    if (this.transaction) return this.transaction.clear(table);
    return this.atomic([table], (repo) => repo.clearRecords(table));
  }
  private async getRecord<T extends LibraryStorageTable>(
    table: T,
    id: string,
  ): Promise<LibraryRows[T] | undefined> {
    return (await this.readRecords(table, { ids: [id] }))[0];
  }
  private key(id: string): string {
    return JSON.stringify([this.scope, id]);
  }
  private row<T>(id: string, value: T): RecordRow<T> {
    return { key: this.key(id), scope: this.scope, id, value };
  }
  async putBooks(books: Book[]): Promise<void> {
    await this.atomic(["books"], async (repo) => {
      for (const book of books)
        await repo.putRecord(
          "books",
          repo.row(book.id, {
            ...book,
            coverUrl: book.coverUrl?.startsWith("blob:")
              ? undefined
              : book.coverUrl,
          }),
        );
    });
  }
  async getBooks(): Promise<Book[]> {
    return (await this.readRecords("books")).map((row) => row.value);
  }
  async getBook(id: string): Promise<Book | undefined> {
    return (await this.getRecord("books", id))?.value;
  }
  async putLocalEdition(book: Book, fileId: string, file: File): Promise<void> {
    if (
      !book.id.startsWith("local-") ||
      !fileId.startsWith("local-") ||
      !book.files.some((f) => f.id === fileId)
    )
      throw new Error("Local editions require local book and file identities.");
    await this.atomic(["books", "localFiles"], async (repo) => {
      if (!(await repo.hasLocalFile(fileId)))
        await repo.putRecord(
          "localFiles",
          repo.row(fileId, { name: file.name, blob: file }),
        );
      const current = await repo.getBook(book.id);
      const files = [
        ...(current?.files ?? []),
        ...book.files.filter(
          (file) => !current?.files.some((previous) => previous.id === file.id),
        ),
      ];
      await repo.putBooks([
        {
          ...book,
          progress: current?.progress ?? book.progress,
          status: current?.status ?? book.status,
          files: files.map(({ url, ...metadata }) => metadata),
        },
      ]);
    });
  }
  async getLocalFile(fileId: string): Promise<File | undefined> {
    const row = await this.getRecord("localFiles", fileId);
    return row
      ? new File([row.value.blob], row.value.name, {
          type: row.value.blob.type,
        })
      : undefined;
  }
  async hasLocalFile(fileId: string): Promise<boolean> {
    return (
      (await this.readRecords("localFiles", { ids: [fileId], keysOnly: true }))
        .length > 0
    );
  }
  async getImportedBooks(): Promise<Book[]> {
    const ids = new Set(
      (await this.readRecords("localFiles", { keysOnly: true })).map(
        (row) => row.id,
      ),
    );
    return (await this.getBooks()).filter(
      (book) =>
        book.id.startsWith("local-") &&
        book.files.some((file) => ids.has(file.id)),
    );
  }
  async putCollections(collections: Collection[]): Promise<void> {
    await this.atomic(["collections"], async (repo) => {
      for (const collection of collections)
        await repo.putRecord(
          "collections",
          repo.row(collection.id, collection),
        );
    });
  }
  async getCollections(): Promise<Collection[]> {
    return (await this.readRecords("collections")).map((row) => row.value);
  }
  async getAnchor(
    identity: Pick<ReadingAnchor, "bookId" | "fileId" | "kind">,
  ): Promise<ReadingAnchor | undefined> {
    return (await this.getRecord("anchors", anchorIdentity(identity)))?.value;
  }
  async getAnchors(): Promise<ReadingAnchor[]> {
    return (await this.readRecords("anchors")).map((row) => row.value);
  }
  /** Atomic local checkpoint + durable intent. readOnly prevents ever creating server work. */
  async checkpoint(
    anchor: ReadingAnchor,
    options: { readOnly?: boolean } = {},
  ): Promise<void> {
    requireTime(anchor.updatedAt);
    const id = anchorIdentity(anchor);
    await this.atomic(["anchors", "outbox", "books"], async (repo) => {
      const existing = await repo.getRecord("anchors", id);
      if (
        existing &&
        Date.parse(existing.value.updatedAt) > Date.parse(anchor.updatedAt)
      )
        return;
      await repo.putRecord("anchors", repo.row(id, anchor));
      const book = await repo.getRecord("books", anchor.bookId);
      if (book)
        await repo.putRecord("books", {
          ...book,
          value: {
            ...book.value,
            progress: anchor.progress,
            status: anchor.progress >= 0.995 ? "finished" : "reading",
          },
        });
      if (!options.readOnly)
        await repo.enqueue(
          `progress:${id}`,
          { kind: "progress", anchor },
          anchor.updatedAt,
          true,
        );
    });
  }
  async importAnchor(anchor: ReadingAnchor): Promise<void> {
    requireTime(anchor.updatedAt);
    await this.atomic(["anchors"], async (repo) => {
      const current = await repo.getRecord("anchors", anchorIdentity(anchor));
      if (
        current &&
        Date.parse(current.value.updatedAt) >= Date.parse(anchor.updatedAt)
      )
        return;
      await repo.putRecord("anchors", repo.row(anchorIdentity(anchor), anchor));
    });
  }
  async getAnnotations(
    bookId?: string,
    includeDeleted = false,
  ): Promise<Annotation[]> {
    return (await this.readRecords("annotations"))
      .map((row) => row.value)
      .filter(
        (a) =>
          (!bookId || a.bookId === bookId) && (includeDeleted || !a.deleted),
      );
  }
  async putAnnotation(
    annotation: Annotation,
    options: { readOnly?: boolean } = {},
  ): Promise<void> {
    requireTime(annotation.updatedAt);
    await this.atomic(["annotations", "outbox"], async (repo) => {
      await repo.putRecord("annotations", repo.row(annotation.id, annotation));
      if (!options.readOnly)
        await repo.enqueue(
          `annotation:${annotation.id}`,
          { kind: "annotation", annotation },
          annotation.updatedAt,
          false,
        );
    });
  }
  async importAnnotations(annotations: Annotation[]): Promise<void> {
    await this.atomic(["annotations", "outbox"], async (repo) => {
      for (const annotation of annotations) {
        const pending = (
          await repo.readRecords("outbox", {
            entityKey: `annotation:${annotation.id}`,
          })
        ).length;
        const current = await repo.getRecord("annotations", annotation.id);
        const newerLocal =
          current &&
          Date.parse(current.value.updatedAt) >=
            Date.parse(annotation.updatedAt);
        if (!pending && !current?.value.deleted && !newerLocal)
          await repo.putRecord(
            "annotations",
            repo.row(annotation.id, annotation),
          );
      }
    });
  }
  async acknowledgeAnnotation(
    localId: string,
    remote: Annotation,
  ): Promise<void> {
    await this.atomic(["annotations", "outbox"], async (repo) => {
      const queued = await repo.readRecords("outbox", {
        entityKey: `annotation:${localId}`,
      });
      const newer = queued
        .filter(
          (o) => o.status === "pending" && o.payload.kind === "annotation",
        )
        .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))[0];
      const localValue =
        newer?.payload.kind === "annotation"
          ? { ...newer.payload.annotation, id: remote.id }
          : remote;
      if (localId !== remote.id)
        await repo.deleteRecord("annotations", localId);
      await repo.putRecord("annotations", repo.row(remote.id, localValue));
      for (const operation of queued)
        if (operation.payload.kind === "annotation")
          await repo.putRecord("outbox", {
            ...operation,
            entityKey: `annotation:${remote.id}`,
            expectedRemoteUpdatedAt: remote.updatedAt,
            payload: {
              kind: "annotation",
              annotation: { ...operation.payload.annotation, id: remote.id },
            },
          });
    });
  }
  async recordSession(
    session: ReadingSession,
    fileId: string,
    options: { readOnly?: boolean; endedAt?: string } = {},
  ): Promise<void> {
    requireTime(session.startedAt);
    if (!Number.isFinite(session.duration) || session.duration < 0)
      throw new Error(
        "Active session duration must be finite and nonnegative.",
      );
    const endedAt = options.endedAt ?? new Date().toISOString();
    requireTime(endedAt);
    if (Date.parse(endedAt) < Date.parse(session.startedAt))
      throw new Error("Session end must follow its start.");
    await this.atomic(["sessions", "outbox"], async (repo) => {
      const existing = await repo.getRecord("sessions", session.id);
      if (existing) {
        const same =
          existing.value.bookId === session.bookId &&
          existing.value.kind === session.kind &&
          existing.value.startedAt === session.startedAt &&
          existing.value.duration === session.duration &&
          (!existing.fileId || existing.fileId === fileId) &&
          (!options.endedAt ||
            !existing.endedAt ||
            existing.endedAt === options.endedAt);
        if (same) return;
        throw new Error(
          "This session ID already belongs to a different immutable activity record.",
        );
      }
      await repo.putRecord("sessions", {
        ...repo.row(session.id, session),
        fileId,
        endedAt,
      });
      if (!options.readOnly)
        await repo.enqueue(
          `session:${session.id}`,
          { kind: "session", session, fileId, endedAt },
          endedAt,
          true,
        );
    });
  }
  async getSessions(): Promise<ReadingSession[]> {
    return (await this.readRecords("sessions")).map((row) => row.value);
  }
  async getPreferences(id = "reader"): Promise<Record<string, unknown>> {
    return (await this.getRecord("preferences", id))?.value ?? {};
  }
  async patchPreferences(
    set: Record<string, unknown>,
    id = "reader",
  ): Promise<void> {
    await this.atomic(["preferences"], async (repo) => {
      await repo.putRecord(
        "preferences",
        repo.row(id, { ...(await repo.getPreferences(id)), ...set }),
      );
    });
  }
  async saveReaderPreferencePatch(
    bookId: string,
    fileId: string,
    patch: {
      deviceSet: Record<string, unknown>;
      deviceUnset: string[];
      set: Record<string, unknown>;
      unset: string[];
      localSet: Record<string, unknown>;
    },
    options: { readOnly: boolean },
  ): Promise<void> {
    await this.atomic(["preferences", "outbox"], async (repo) => {
      const id = `reader-file-overrides:${fileId}`,
        current = { ...(await repo.getPreferences(id)) };
      for (const name of patch.deviceUnset) delete current[name];
      Object.assign(current, patch.deviceSet);
      await repo.putRecord("preferences", repo.row(id, current));
      if (
        !options.readOnly &&
        (Object.keys(patch.set).length || patch.unset.length)
      ) {
        const changed = new Set([...Object.keys(patch.set), ...patch.unset]);
        const previous = await repo.readRecords("outbox", {
          entityKey: `preferences:${fileId}`,
        });
        for (const operation of previous) {
          if (
            operation.status === "syncing" ||
            operation.payload.kind !== "preferences"
          )
            continue;
          const set = Object.fromEntries(
            Object.entries(operation.payload.set).filter(
              ([name]) => !changed.has(name),
            ),
          );
          const unset = operation.payload.unset.filter(
            (name) => !changed.has(name),
          );
          const localSet = Object.fromEntries(
            Object.entries(operation.payload.localSet).filter(
              ([name]) => !Object.hasOwn(patch.localSet, name),
            ),
          );
          if (!Object.keys(set).length && !unset.length)
            await repo.deleteRecord("outbox", operation.id);
          else
            await repo.putRecord("outbox", {
              ...operation,
              payload: { ...operation.payload, set, unset, localSet },
            });
        }
        const occurredAt = new Date().toISOString();
        await repo.enqueue(
          `preferences:${fileId}`,
          {
            kind: "preferences",
            bookId,
            fileId,
            set: patch.set,
            unset: patch.unset,
            localSet: patch.localSet,
          },
          occurredAt,
          false,
        );
      }
    });
  }
  private async enqueue(
    entityKey: string,
    payload: SyncPayload,
    occurredAt: string,
    coalesce: boolean,
  ): Promise<void> {
    if (coalesce)
      for (const operation of await this.readRecords("outbox", { entityKey }))
        if (operation.status === "pending")
          await this.deleteRecord("outbox", operation.id);
    const id = crypto.randomUUID();
    await this.putRecord("outbox", {
      key: this.key(id),
      scope: this.scope,
      id,
      entityKey,
      payload,
      occurredAt,
      status: "pending",
      attempts: 0,
    });
  }
  async pendingOperations(): Promise<OutboxOperation[]> {
    return (await this.readRecords("outbox")).sort(
      (a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt),
    );
  }
  async getOperation(id: string): Promise<OutboxOperation | undefined> {
    return this.getRecord("outbox", id);
  }
  async claimOperation(id: string): Promise<OutboxOperation | undefined> {
    return this.atomic(["outbox"], async (repo) => {
      const current = await repo.getOperation(id),
        now = Date.now();
      if (!current || ["failed", "conflict"].includes(current.status))
        return undefined;
      if (current.nextAttemptAt && Date.parse(current.nextAttemptAt) > now)
        return undefined;
      if (
        current.status === "syncing" &&
        current.leaseUntil &&
        Date.parse(current.leaseUntil) > now
      )
        return undefined;
      if (
        (
          await repo.readRecords("outbox", { entityKey: current.entityKey })
        ).some(
          (operation) =>
            operation.id !== id &&
            operation.status === "syncing" &&
            Date.parse(operation.leaseUntil ?? "") > now,
        )
      )
        return undefined;
      await repo.putRecord("outbox", {
        ...current,
        status: "syncing",
        attempts: current.attempts + 1,
        leaseUntil: new Date(now + 60000).toISOString(),
      });
      return current;
    });
  }
  async updateOperation(
    id: string,
    patch: Partial<
      Pick<
        OutboxOperation,
        "status" | "attempts" | "error" | "nextAttemptAt" | "leaseUntil"
      >
    >,
  ): Promise<void> {
    await this.atomic(["outbox"], async (repo) => {
      const current = await repo.getOperation(id);
      if (current) await repo.putRecord("outbox", { ...current, ...patch });
    });
  }
  async acknowledge(id: string): Promise<void> {
    await this.deleteRecord("outbox", id);
  }
  async clearAccount(): Promise<void> {
    await this.atomic([...LIBRARY_STORAGE_TABLES], async (repo) => {
      for (const table of LIBRARY_STORAGE_TABLES)
        await repo.clearRecords(table);
    });
  }
}
