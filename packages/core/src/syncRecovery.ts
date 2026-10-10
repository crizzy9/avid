import { BookOrbitClient, ReadOnlyError } from "./bookorbit";
import {
  accountScope,
  anchorIdentity,
  LibraryRepository,
  type OutboxOperation,
  type SyncPayload,
} from "./repository";
import type { Annotation, ReadingAnchor } from "./types";

export type RecoveryAction =
  "use-local" | "use-server" | "keep-device" | "retry";
export type RecoveryRemote =
  | { kind: "progress"; value: ReadingAnchor | null }
  | { kind: "annotation"; value: Annotation | null }
  | { kind: "session" }
  | { kind: "preferences"; value: Record<string, unknown> | null }
  | { kind: "unavailable"; reason: string };
export interface SyncReview {
  scope: string;
  operation: OutboxOperation;
  operations: OutboxOperation[];
  /** Current local state, including any device-only edit made since the queued event. */
  local: SyncPayload;
  remote: RecoveryRemote;
}
export interface RecoveryReceipt {
  id: string;
  resolvedAt: string;
  action: RecoveryAction;
  review: SyncReview;
}
export class RecoveryChangedError extends Error {
  constructor() {
    super(
      "Saved changes were updated while you reviewed them. Reload the comparison before choosing.",
    );
    this.name = "RecoveryChangedError";
  }
}
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const key = (scope: string, id: string) => JSON.stringify([scope, id]);
const row = <T>(scope: string, id: string, value: T) => ({
  key: key(scope, id),
  scope,
  id,
  value,
});
const blocked = (operation: OutboxOperation) =>
  ["conflict", "failed", "uncertain"].includes(operation.status);
const liveLease = (operation: OutboxOperation) =>
  operation.status === "syncing" &&
  Date.parse(operation.leaseUntil ?? "") > Date.now();

/** Explicit recovery never silently selects the largest percentage or recreates an uncertain note. */
export class SyncRecovery {
  constructor(
    readonly repository: LibraryRepository,
    readonly client: BookOrbitClient,
    private readonly options: { isActive?: () => boolean } = {},
  ) {
    if (repository.scope !== accountScope(client.session))
      throw new Error("Repository and server account scopes do not match.");
  }
  private active() {
    if (this.options.isActive?.() === false) throw new RecoveryChangedError();
  }
  async list(): Promise<OutboxOperation[]> {
    return (await this.repository.pendingOperations()).filter(blocked);
  }
  async receipts(): Promise<RecoveryReceipt[]> {
    return (await this.repository.readRecords("preferences"))
      .filter((record) => record.id.startsWith("sync-recovery:"))
      .map((record) => record.value as unknown as RecoveryReceipt)
      .sort((a, b) => b.resolvedAt.localeCompare(a.resolvedAt));
  }
  private async local(
    operation: OutboxOperation,
    repository = this.repository,
  ): Promise<SyncPayload> {
    const payload = operation.payload;
    if (payload.kind === "preferences") {
      const queued = (await repository.pendingOperations()).flatMap(
        (operation) =>
          operation.payload.kind === "preferences" &&
          operation.payload.fileId === payload.fileId
            ? [operation.payload.localSet]
            : [],
      );
      return {
        ...payload,
        localSet: Object.assign(
          {},
          payload.localSet,
          ...queued,
          await repository.getPreferences(
            `reader-file-overrides:${payload.fileId}`,
          ),
        ),
      };
    }
    if (payload.kind === "progress")
      return {
        kind: "progress",
        anchor: (await repository.getAnchor(payload.anchor)) ?? payload.anchor,
      };
    if (payload.kind === "annotation")
      return {
        kind: "annotation",
        annotation:
          (
            await repository.getAnnotations(payload.annotation.bookId, true)
          ).find((note) => note.id === payload.annotation.id) ??
          payload.annotation,
      };
    return payload;
  }
  private async remote(operation: OutboxOperation): Promise<RecoveryRemote> {
    this.active();
    const payload = operation.payload;
    if (payload.kind === "preferences")
      return {
        kind: "preferences",
        value: (await this.client.getReaderPreferences(payload.fileId))
          .settings,
      };
    if (payload.kind === "progress") {
      const value = await this.client.getProgress(payload.anchor);
      if (
        value &&
        (value.bookId !== payload.anchor.bookId ||
          value.fileId !== payload.anchor.fileId ||
          value.kind !== payload.anchor.kind)
      )
        throw new Error("The server returned a different file identity.");
      return { kind: "progress", value };
    }
    if (payload.kind === "annotation") {
      const note = payload.annotation;
      const notes =
        note.kind === "audio"
          ? await this.client.getAudioAnnotations(note.bookId, note.fileId)
          : await this.client.getAnnotations(note.bookId, note.fileId);
      const value = notes.find((remote) => remote.id === note.id) ?? null;
      if (
        value &&
        (value.bookId !== note.bookId || value.fileId !== note.fileId)
      )
        throw new Error(
          "The server returned a different annotation file identity.",
        );
      return { kind: "annotation", value };
    }
    return { kind: "session" };
  }
  async inspect(id: string): Promise<SyncReview> {
    this.active();
    const operation = await this.repository.getOperation(id);
    if (!operation || !blocked(operation)) throw new RecoveryChangedError();
    const operations = (await this.repository.pendingOperations()).filter(
      (item) => item.entityKey === operation.entityKey,
    );
    if (operations.some(liveLease)) throw new RecoveryChangedError();
    const local = await this.local(operation);
    let remote: RecoveryRemote;
    if (this.client.readOnly)
      remote = { kind: "unavailable", reason: "read-only" };
    else {
      try {
        remote = await this.remote(operation);
      } catch (error) {
        remote = {
          kind: "unavailable",
          reason:
            error instanceof Error
              ? error.message
              : "The server comparison is unavailable.",
        };
      }
    }
    this.active();
    return {
      scope: this.repository.scope,
      operation,
      operations,
      local,
      remote,
    };
  }
  actions(review: SyncReview): RecoveryAction[] {
    const result: RecoveryAction[] = ["keep-device"];
    if (this.client.readOnly) return result;
    result.push("retry");
    if (review.local.kind === "progress" && review.remote.kind === "progress") {
      result.push("use-local");
      if (review.remote.value) result.push("use-server");
    }
    if (
      review.local.kind === "annotation" &&
      review.remote.kind === "annotation"
    ) {
      // Missing numeric IDs mean a deletion. An uncertain UUID create may already
      // exist under an unknown server ID, so it must not be recreated here.
      if (review.remote.value) result.push("use-local", "use-server");
      else if (/^\d+$/.test(review.local.annotation.id))
        result.push("use-server");
    }
    return result;
  }
  async resolve(
    review: SyncReview,
    action: RecoveryAction,
  ): Promise<RecoveryReceipt> {
    this.active();
    if (review.scope !== this.repository.scope)
      throw new RecoveryChangedError();
    if (this.client.readOnly && action !== "keep-device")
      throw new ReadOnlyError();
    if (!this.actions(review).includes(action))
      throw new Error("That resolution is not safe for this saved change.");
    if (action === "use-local" || action === "use-server") {
      const currentRemote = await this.remote(review.operation);
      this.active();
      if (!same(currentRemote, review.remote)) throw new RecoveryChangedError();
    }
    const receipt: RecoveryReceipt = {
      id: crypto.randomUUID(),
      resolvedAt: new Date().toISOString(),
      action,
      review,
    };
    const { scope } = this.repository;
    await this.repository.atomic(
      ["outbox", "anchors", "annotations", "books", "preferences"],
      async (repository) => {
        this.active();
        const operations = (await repository.pendingOperations()).filter(
          (item) => item.entityKey === review.operation.entityKey,
        );
        if (
          !same(operations, review.operations) ||
          operations.some(liveLease) ||
          !same(await this.local(review.operation, repository), review.local)
        )
          throw new RecoveryChangedError();
        await repository.putRecord(
          "preferences",
          row(
            scope,
            `sync-recovery:${receipt.id}`,
            receipt as unknown as Record<string, unknown>,
          ),
        );
        if (action === "retry") {
          const operation = review.operation;
          const uncertainCreate =
            operation.payload.kind === "annotation" &&
            operation.payload.annotation.kind !== "audio" &&
            !/^\d+$/.test(operation.payload.annotation.id) &&
            operation.attempts > 0;
          await repository.updateOperation(operation.id, {
            status: uncertainCreate ? "uncertain" : "pending",
            error: undefined,
            nextAttemptAt: undefined,
            leaseUntil: undefined,
          });
          return;
        }
        for (const operation of operations)
          await repository.deleteRecord("outbox", operation.id);
        if (action === "keep-device") {
          if (review.local.kind === "preferences") {
            const local = Object.assign(
              {},
              ...review.operations.flatMap((operation) =>
                operation.payload.kind === "preferences"
                  ? [operation.payload.localSet]
                  : [],
              ),
              review.local.localSet,
            );
            await repository.patchPreferences(
              local,
              `reader-file-overrides:${review.local.fileId}`,
            );
          }
          return;
        }
        let payload: SyncPayload;
        if (action === "use-local") {
          payload =
            review.local.kind === "progress"
              ? {
                  kind: "progress",
                  anchor: {
                    ...review.local.anchor,
                    updatedAt: receipt.resolvedAt,
                  },
                }
              : review.local.kind === "annotation"
                ? {
                    kind: "annotation",
                    annotation: {
                      ...review.local.annotation,
                      updatedAt: receipt.resolvedAt,
                    },
                  }
                : review.local;
        } else if (review.remote.kind === "progress" && review.remote.value) {
          payload = { kind: "progress", anchor: review.remote.value };
        } else if (
          review.remote.kind === "annotation" &&
          review.local.kind === "annotation"
        ) {
          payload = {
            kind: "annotation",
            annotation: review.remote.value ?? {
              ...review.local.annotation,
              deleted: true,
              updatedAt: receipt.resolvedAt,
            },
          };
        } else throw new RecoveryChangedError();
        if (payload.kind === "progress") {
          const anchor = payload.anchor;
          await repository.putRecord(
            "anchors",
            row(scope, anchorIdentity(anchor), anchor),
          );
          const book = (
            await repository.readRecords("books", { ids: [anchor.bookId] })
          )[0];
          if (book)
            await repository.putRecord("books", {
              ...book,
              value: {
                ...book.value,
                progress: anchor.progress,
                status: anchor.progress >= 0.995 ? "finished" : "reading",
              },
            });
        } else if (payload.kind === "annotation")
          await repository.putRecord(
            "annotations",
            row(scope, payload.annotation.id, payload.annotation),
          );
        if (action === "use-local") {
          const id = crypto.randomUUID();
          await repository.putRecord("outbox", {
            key: key(scope, id),
            scope,
            id,
            entityKey: review.operation.entityKey,
            payload,
            occurredAt: receipt.resolvedAt,
            status: "pending",
            attempts: 0,
            expectedRemoteUpdatedAt:
              review.remote.kind === "annotation"
                ? review.remote.value?.updatedAt
                : undefined,
          });
        }
      },
    );
    return receipt;
  }
}
