import Dexie, { type Table } from "dexie";
import { sha256 } from "@noble/hashes/sha2.js";
import { sha256Blob } from "./blobHash";
export { sha256Blob } from "./blobHash";
import { z } from "zod";
import type { AudioManifest, PlaybackSource } from "./bookorbit";
import type { Book } from "./types";
import { OfflineReadAlongStore } from "./offlineReadAlong";
import { mediaOverlayPath } from "./media-overlay";
import {
  validateGeneratedAlignment,
  type GeneratedAlignmentSnapshot,
} from "../../playback/src/generated-alignment";

export interface PreparedReadListenGuard {
  signal?: AbortSignal;
  isActive?: () => boolean;
}
export const PREPARED_READ_LISTEN_LIMITS = Object.freeze({
  epubBytes: 64 * 1024 ** 2,
  assetBytes: 512 * 1024 ** 2,
  totalBytes: 2 * 1024 ** 3,
});
export class PreparedReadListenError extends Error {
  constructor(
    readonly code: "invalid" | "corrupt" | "limit" | "stale" | "storage",
    message: string,
  ) {
    super(message);
    this.name = "PreparedReadListenError";
  }
}
export function assertPreparedActive(guard: PreparedReadListenGuard = {}) {
  guard.signal?.throwIfAborted();
  if (guard.isActive && !guard.isActive())
    throw new PreparedReadListenError(
      "stale",
      "The account or selected edition changed. Preparation was not saved.",
    );
}
function hashJson(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (bytes.byteLength > 32 * 1024 ** 2)
    throw new PreparedReadListenError(
      "limit",
      "Prepared Read & Listen metadata exceeds 32 MiB.",
    );
  return Array.from(sha256(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
function invalid(message: string): never {
  throw new PreparedReadListenError("invalid", message);
}
function scopeIdentity(scope: string) {
  try {
    const value = JSON.parse(scope);
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      !value.every(
        (item) =>
          typeof item === "string" && item.length > 0 && item.length <= 2048,
      ) ||
      JSON.stringify(value) !== scope
    )
      throw new Error();
    const url = new URL(value[0]);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error();
  } catch {
    invalid("An exact server/account scope without credentials is required.");
  }
}
const id = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => !/[\u0000-\u001f]/.test(value));
const number = z.number().finite().nonnegative();
const clean = (value: string) =>
  value
    .replace(/<[^>]*>/g, "")
    .replace(/https?:\/\/[^\s<>]+/gi, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
const text = z.string().max(100_000).transform(clean);
const format = z.enum(["EPUB", "MOBI", "PDF", "CBZ", "CBR", "CB7", "AUDIO"]);
const bookSchema = z.object({
  id,
  title: text,
  authors: z.array(text).max(100),
  description: text,
  format,
  color: z
    .string()
    .max(100)
    .transform((value) => (/^#[a-f\d]{3,8}$/i.test(value) ? value : "#66736d")),
  progress: number.max(1),
  status: z.enum(["unread", "reading", "finished"]),
  genres: z.array(text).max(1000),
  addedAt: z.string().max(100),
  files: z
    .array(z.object({ id, name: text, format, size: number.optional() }))
    .max(1000),
  series: text.optional(),
  seriesId: id.optional(),
  seriesIndex: number.optional(),
});
const manifestSchema = z.object({
  schema: z.literal("bookorbit.audiobook-manifest"),
  schemaVersion: z.literal(2),
  revision: id,
  assets: z
    .array(
      z.object({
        assetId: id,
        fileId: z.number().int().positive(),
        sequence: z.number().int().nonnegative(),
        format: id,
        durationMs: number.positive(),
        sizeBytes: z.number().int().positive(),
        etag: z.string().max(2048),
      }),
    )
    .min(1)
    .max(1000),
  chapters: z
    .array(
      z.object({
        id,
        title: text,
        assetId: id,
        sequence: z.number().int().nonnegative(),
        startMs: number,
        endMs: number,
        assetOffsetMs: number,
      }),
    )
    .max(10000),
  totalDurationMs: number.positive(),
});
function parse<T>(schema: z.ZodType<T>, value: unknown, name: string): T {
  const result = schema.safeParse(value);
  if (!result.success) invalid(`Invalid prepared ${name}.`);
  return result.data;
}
export function preparedManifest(value: AudioManifest): AudioManifest {
  const manifest = parse(manifestSchema, value, "audiobook manifest");
  manifest.assets.sort((a, b) => a.sequence - b.sequence);
  manifest.chapters.sort((a, b) => a.sequence - b.sequence);
  const ids = new Set<string>(),
    files = new Set<number>(),
    sequences = new Set<number>();
  const offsets = new Map<string, number>();
  let duration = 0;
  for (const asset of manifest.assets) {
    if (
      ids.has(asset.assetId) ||
      files.has(asset.fileId) ||
      sequences.has(asset.sequence)
    )
      invalid("The audiobook has duplicate assets, files or sequences.");
    ids.add(asset.assetId);
    files.add(asset.fileId);
    sequences.add(asset.sequence);
    offsets.set(asset.assetId, duration);
    duration += asset.durationMs! / 1000;
  }
  if (Math.abs(duration - manifest.totalDurationMs / 1000) > 0.001)
    invalid("The audiobook source durations do not match its total duration.");
  let previousEnd = 0;
  const chapterIds = new Set<string>(),
    chapterSequences = new Set<number>();
  for (const chapter of manifest.chapters) {
    if (
      chapterIds.has(chapter.id) ||
      chapterSequences.has(chapter.sequence) ||
      !ids.has(chapter.assetId) ||
      chapter.endMs <= chapter.startMs ||
      chapter.startMs < previousEnd ||
      chapter.endMs > manifest.totalDurationMs ||
      Math.abs(
        (chapter.startMs - chapter.assetOffsetMs) / 1000 -
          offsets.get(chapter.assetId)!,
      ) > 0.001
    )
      invalid("The audiobook chapter timeline is invalid.");
    chapterIds.add(chapter.id);
    chapterSequences.add(chapter.sequence);
    previousEnd = chapter.endMs;
  }
  return manifest;
}
export interface PreparedReadListenInput {
  scope: string;
  scopeLabel: string;
  book: Book;
  textFileId: string;
  epub: Blob;
  manifest: AudioManifest;
  alignment: GeneratedAlignmentSnapshot;
  sources: readonly { assetId: string; blob: Blob }[];
  /** Derived text is reconstructed from the verified snapshot on reopen. */
  timedText?: readonly unknown[];
}
export interface PreparedReadListenDescriptor {
  kind: "prepared-read-listen";
  version: 1;
  id: string;
  scope: string;
  scopeLabel: string;
  book: Book;
  textFileId: string;
  textSha256: string;
  epubSize: number;
  totalBytes: number;
  createdAt: string;
  manifest: AudioManifest;
  alignmentSnapshot: GeneratedAlignmentSnapshot;
  assets: { assetId: string; fileId: string; sha256: string; size: number }[];
  integritySha256: string;
}
export interface PreparedReadListenPackage extends PreparedReadListenDescriptor {
  epub: Blob;
  sources: { assetId: string; blob: Blob }[];
}
export interface PreparedReadListenIssue {
  key: string;
  code: "corrupt-metadata";
}
type DescriptorRow = PreparedReadListenDescriptor & { key: string };
type PayloadRow = {
  key: string;
  scope: string;
  id: string;
  epub: Blob;
  sources: { assetId: string; blob: Blob }[];
};
const key = (scope: string, id: string) => JSON.stringify([scope, id]);
function sized(blob: Blob, max: number, label: string) {
  if (
    !blob ||
    typeof blob.arrayBuffer !== "function" ||
    !Number.isSafeInteger(blob.size) ||
    blob.size < 1
  )
    invalid(`${label} is missing or empty.`);
  if (blob.size > max)
    throw new PreparedReadListenError(
      "limit",
      `${label} exceeds the supported preparation size.`,
    );
}
async function prepare(
  input: PreparedReadListenInput,
  guard: PreparedReadListenGuard,
  createdAt = new Date().toISOString(),
): Promise<PreparedReadListenPackage> {
  // Capture metadata before the first await; caller-owned objects cannot change account or edition mid-write.
  const captured = JSON.parse(
    JSON.stringify({
      scope: input.scope,
      scopeLabel: input.scopeLabel,
      book: input.book,
      textFileId: input.textFileId,
      manifest: input.manifest,
      alignment: input.alignment,
    }),
  );
  const epub = input.epub,
    sources = input.sources.map((source) => ({
      assetId: source.assetId,
      blob: source.blob,
    }));
  assertPreparedActive(guard);
  scopeIdentity(captured.scope);
  const book = parse(bookSchema, captured.book, "book"),
    textFileId = parse(id, captured.textFileId, "EPUB file");
  if (
    !book.files.some((file) => file.id === textFileId && file.format === "EPUB")
  )
    invalid("The selected EPUB is absent from this book.");
  const manifest = preparedManifest(captured.manifest);
  const alignment: GeneratedAlignmentSnapshot = captured.alignment;
  validateGeneratedAlignment(alignment);
  const edition = alignment.edition;
  if (
    edition.accountScope !== captured.scope ||
    edition.bookId !== book.id ||
    edition.textFileId !== textFileId ||
    edition.manifestRevision !== manifest.revision ||
    !manifest.assets.some(
      (asset) => String(asset.fileId) === edition.audioFileId,
    ) ||
    !book.files.some(
      (file) => file.id === edition.audioFileId && file.format === "AUDIO",
    )
  )
    invalid(
      "The prepared alignment belongs to a different account or source edition.",
    );
  sized(epub, PREPARED_READ_LISTEN_LIMITS.epubBytes, "The EPUB");
  if (
    sources.length !== manifest.assets.length ||
    new Set(sources.map((item) => item.assetId)).size !== sources.length
  )
    invalid("Every ordered audiobook asset is required exactly once.");
  let totalBytes = epub.size;
  for (const asset of manifest.assets) {
    const source = sources.find((item) => item.assetId === asset.assetId);
    if (!source) invalid("An audiobook asset is missing.");
    sized(
      source.blob,
      PREPARED_READ_LISTEN_LIMITS.assetBytes,
      "An audio asset",
    );
    if (source.blob.size !== asset.sizeBytes)
      invalid("An audio asset is partial or changed size.");
    totalBytes += source.blob.size;
  }
  if (totalBytes > PREPARED_READ_LISTEN_LIMITS.totalBytes)
    throw new PreparedReadListenError(
      "limit",
      "Prepared Read & Listen supports at most 2 GiB per book.",
    );
  const textSha256 = await sha256Blob(epub, guard);
  if (textSha256 !== edition.textSha256)
    invalid("The EPUB does not match the compared text edition.");
  const assets: PreparedReadListenDescriptor["assets"] = [];
  if (alignment.tracks.length !== manifest.assets.length)
    invalid("The comparison does not contain the complete audio timeline.");
  for (const [index, asset] of manifest.assets.entries()) {
    const source = sources.find((item) => item.assetId === asset.assetId)!,
      track = alignment.tracks[index]!;
    const sha = await sha256Blob(source.blob, guard);
    if (
      track.assetId !== asset.assetId ||
      track.fileId !== String(asset.fileId) ||
      track.sizeBytes !== asset.sizeBytes ||
      track.duration !== asset.durationMs! / 1000 ||
      track.sha256 !== sha
    )
      invalid(
        "The audio bytes or source timeline differ from the compared edition.",
      );
    assets.push({
      assetId: asset.assetId,
      fileId: String(asset.fileId),
      sha256: sha,
      size: source.blob.size,
    });
  }
  // Persist only the validated snapshot fields, never a transport URL or session object.
  const alignmentSnapshot: GeneratedAlignmentSnapshot = {
    version: 1,
    source: "generated",
    algorithm: alignment.algorithm,
    edition: {
      accountScope: edition.accountScope,
      bookId: edition.bookId,
      textFileId: edition.textFileId,
      textSha256: edition.textSha256,
      audioFileId: edition.audioFileId,
      manifestRevision: edition.manifestRevision,
    },
    model: { id: alignment.model.id, revision: alignment.model.revision },
    ...(typeof alignment.language === "string"
      ? { language: alignment.language }
      : {}),
    tracks: alignment.tracks.map((track) => ({
      assetId: track.assetId,
      fileId: track.fileId,
      sha256: track.sha256,
      sizeBytes: track.sizeBytes,
      duration: track.duration,
    })),
    passages: alignment.passages.map((p) => ({
      id: p.id,
      text: p.text,
      textLocator: p.textLocator,
      sectionIndex: p.sectionIndex,
      textHref: p.textHref,
      elementPath: [...p.elementPath],
    })),
    segments: alignment.segments.map((p) => ({
      id: p.id,
      textFileId: p.textFileId,
      textLocator: p.textLocator,
      audioFileId: p.audioFileId,
      start: p.start,
      end: p.end,
      trackId: p.trackId,
      trackTime: p.trackTime,
      sectionIndex: p.sectionIndex,
      textHref: p.textHref,
      textFragment: p.textFragment,
      textElementPath: [...p.textElementPath],
      confidence: p.confidence,
    })),
    coverage: {
      matchedPassages: alignment.coverage.matchedPassages,
      totalPassages: alignment.coverage.totalPassages,
      matchedWords: alignment.coverage.matchedWords,
      totalWords: alignment.coverage.totalWords,
    },
  };
  for (const passage of alignmentSnapshot.passages)
    mediaOverlayPath(passage.textHref);
  const idValue = hashJson({
    scope: captured.scope,
    bookId: book.id,
    textFileId,
    textSha256,
    manifest,
    assets,
    alignment: alignmentSnapshot,
  });
  const descriptor = {
    kind: "prepared-read-listen" as const,
    version: 1 as const,
    id: idValue,
    scope: captured.scope,
    scopeLabel: clean(
      parse(z.string().min(1).max(200), captured.scopeLabel, "account label"),
    ),
    book,
    textFileId,
    textSha256,
    epubSize: epub.size,
    totalBytes,
    createdAt,
    manifest,
    alignmentSnapshot,
    assets,
  };
  assertPreparedActive(guard);
  return {
    ...descriptor,
    integritySha256: hashJson(descriptor),
    epub,
    sources: manifest.assets.map((asset) =>
      sources.find((source) => source.assetId === asset.assetId)!,
    ),
  };
}

/** Immutable prepared bytes only. This DB never stores checkpoints, annotations, credentials or remote URLs. */
export class PreparedReadListenStore {
  readonly database: Dexie;
  private descriptors: Table<DescriptorRow, string>;
  private payloads: Table<PayloadRow, string>;
  constructor(name = "avid-prepared-read-listen-v1") {
    this.database = new Dexie(name);
    this.database
      .version(1)
      .stores({ packages: "&key,scope,id", payloads: "&key,scope" });
    this.descriptors = this.database.table("packages");
    this.payloads = this.database.table("payloads");
  }
  async put(
    input: PreparedReadListenInput,
    guard: PreparedReadListenGuard = {},
  ): Promise<PreparedReadListenDescriptor> {
    const pkg = await prepare(input, guard),
      { epub, sources, ...descriptor } = pkg,
      identity = key(pkg.scope, pkg.id);
    try {
      await this.database.transaction(
        "rw",
        this.descriptors,
        this.payloads,
        async () => {
          assertPreparedActive(guard);
          await this.payloads.put({
            key: identity,
            scope: pkg.scope,
            id: pkg.id,
            epub,
            sources,
          });
          assertPreparedActive(guard);
          await this.descriptors.put({ key: identity, ...descriptor });
          assertPreparedActive(guard);
        },
      );
    } catch (error) {
      if (
        error instanceof PreparedReadListenError ||
        (error instanceof Error && error.name === "AbortError")
      )
        throw error;
      throw new PreparedReadListenError(
        "storage",
        "Preparation could not be saved. Existing prepared books were preserved.",
      );
    }
    return descriptor;
  }
  private descriptor(row: DescriptorRow): PreparedReadListenDescriptor {
    const { key: storedKey, integritySha256, ...data } = row;
    scopeIdentity(data.scope);
    if (
      data.kind !== "prepared-read-listen" ||
      data.version !== 1 ||
      !/^[a-f0-9]{64}$/.test(data.id) ||
      storedKey !== key(data.scope, data.id) ||
      hashJson(data) !== integritySha256
    )
      throw new PreparedReadListenError(
        "corrupt",
        "Saved preparation metadata failed verification.",
      );
    return { ...data, integritySha256 };
  }
  async list(scope?: string): Promise<PreparedReadListenDescriptor[]> {
    if (scope !== undefined) scopeIdentity(scope);
    const rows =
      scope === undefined
        ? await this.descriptors.toArray()
        : await this.descriptors.where("scope").equals(scope).toArray();
    const result: PreparedReadListenDescriptor[] = [];
    for (const row of rows) {
      try {
        result.push(this.descriptor(row));
      } catch (error) {
        if (!(error instanceof PreparedReadListenError)) throw error;
      }
    }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async listIssues(): Promise<PreparedReadListenIssue[]> {
    const issues: PreparedReadListenIssue[] = [];
    for (const row of await this.descriptors.toArray()) {
      try {
        this.descriptor(row);
      } catch (error) {
        if (!(error instanceof PreparedReadListenError)) throw error;
        issues.push({ key: row.key, code: "corrupt-metadata" });
      }
    }
    return issues;
  }
  async get(
    scope: string,
    id: string,
    guard: PreparedReadListenGuard = {},
  ): Promise<PreparedReadListenPackage | undefined> {
    scopeIdentity(scope);
    assertPreparedActive(guard);
    const identity = key(scope, id);
    const [row, payload] = await this.database.transaction(
      "r",
      this.descriptors,
      this.payloads,
      () =>
        Promise.all([
          this.descriptors.get(identity),
          this.payloads.get(identity),
        ]),
    );
    assertPreparedActive(guard);
    if (!row && !payload) return undefined;
    if (
      !row ||
      !payload ||
      payload.scope !== scope ||
      payload.id !== id ||
      payload.key !== identity
    )
      throw new PreparedReadListenError(
        "corrupt",
        "The saved preparation is incomplete.",
      );
    const descriptor = this.descriptor(row);
    try {
      const verified = await prepare(
        {
          scope,
          scopeLabel: descriptor.scopeLabel,
          book: descriptor.book,
          textFileId: descriptor.textFileId,
          epub: payload.epub,
          manifest: descriptor.manifest,
          alignment: descriptor.alignmentSnapshot,
          sources: payload.sources,
        },
        guard,
        descriptor.createdAt,
      );
      if (
        verified.id !== id ||
        verified.integritySha256 !== descriptor.integritySha256
      )
        throw new Error("Digest mismatch");
      return verified;
    } catch (error) {
      if (
        (error instanceof Error && error.name === "AbortError") ||
        (error instanceof PreparedReadListenError && error.code === "stale")
      )
        throw error;
      throw new PreparedReadListenError(
        "corrupt",
        "Saved Read & Listen bytes no longer match their prepared edition.",
      );
    }
  }
  /** Exact source identity only; a different revision/account cannot reuse this package. No network reads. */
  async findReusable(
    input: {
      scope: string;
      bookId: string;
      textFileId: string;
      textSha256: string;
      manifest: AudioManifest;
    },
    guard: PreparedReadListenGuard = {},
  ): Promise<PreparedReadListenPackage | undefined> {
    const wanted = JSON.parse(JSON.stringify(input));
    const manifest = preparedManifest(wanted.manifest);
    assertPreparedActive(guard);
    for (const item of await this.list(wanted.scope)) {
      assertPreparedActive(guard);
      if (
        item.book.id === wanted.bookId &&
        item.textFileId === wanted.textFileId &&
        item.textSha256 === wanted.textSha256 &&
        JSON.stringify(item.manifest) === JSON.stringify(manifest)
      )
        return this.get(wanted.scope, item.id, guard);
    }
    return undefined;
  }
  /** Reuse bytes saved by either preparation or the earlier paired-SMIL workflow. */
  async findReusableSources(
    input: {
      scope: string;
      bookId: string;
      textFileId: string;
      textSha256: string;
      manifest: AudioManifest;
    },
    guard: PreparedReadListenGuard = {},
    legacy?: OfflineReadAlongStore,
  ): Promise<
    | {
        epub: Blob;
        sources: { assetId: string; blob: Blob }[];
        alignmentSnapshot?: GeneratedAlignmentSnapshot;
      }
    | undefined
  > {
    const wanted = JSON.parse(JSON.stringify(input));
    const prepared = await this.findReusable(wanted, guard);
    if (prepared)
      return {
        epub: prepared.epub,
        sources: prepared.sources,
        alignmentSnapshot: prepared.alignmentSnapshot,
      };
    const ownLegacy = !legacy,
      old = legacy ?? new OfflineReadAlongStore();
    try {
      for (const item of await old.list(wanted.scope)) {
        assertPreparedActive(guard);
        if (
          item.mode !== "paired" ||
          item.book.id !== wanted.bookId ||
          item.textFileId !== wanted.textFileId ||
          item.textSha256 !== wanted.textSha256 ||
          !item.manifest ||
          JSON.stringify(preparedManifest(item.manifest)) !==
            JSON.stringify(preparedManifest(wanted.manifest))
        )
          continue;
        const pkg = await old.get(wanted.scope, item.id, guard);
        if (pkg)
          return {
            epub: pkg.epub,
            sources: pkg.audioAssets.map((source) => ({
              assetId: source.assetId,
              blob: source.blob,
            })),
          };
      }
      return undefined;
    } finally {
      if (ownLegacy) old.close();
    }
  }
  /** Explicit user removal only. Legacy package/progress databases are never touched. */
  async remove(scope: string, id: string) {
    scopeIdentity(scope);
    await this.database.transaction(
      "rw",
      this.descriptors,
      this.payloads,
      async () => {
        await this.descriptors.delete(key(scope, id));
        await this.payloads.delete(key(scope, id));
      },
    );
  }
  close() {
    this.database.close();
  }
}
let shared: PreparedReadListenStore | undefined;
export function preparedReadListenStore() {
  return (shared ??= new PreparedReadListenStore());
}
/** In-memory URLs only. Caller must revoke after the playback owner has been destroyed. */
export function preparedPlaybackSource(pkg: PreparedReadListenPackage): {
  source: PlaybackSource;
  revoke: () => void;
} {
  const urls: string[] = [];
  try {
    const source: PlaybackSource = {
      bookId: pkg.book.id,
      fileId: pkg.alignmentSnapshot.edition.audioFileId,
      title: pkg.book.title,
      authors: [...pkg.book.authors],
      manifestRevision: pkg.manifest.revision,
      tracks: pkg.manifest.assets.map((asset) => {
        const blob = pkg.sources.find(
          (item) => item.assetId === asset.assetId,
        )?.blob;
        if (!blob) invalid("A prepared audio asset is missing.");
        const url = URL.createObjectURL(blob);
        urls.push(url);
        return {
          id: String(asset.fileId),
          url,
          duration: asset.durationMs! / 1000,
        };
      }),
      chapters: pkg.manifest.chapters.map((chapter) => ({
        id: chapter.id,
        title: chapter.title,
        start: chapter.startMs / 1000,
        duration: (chapter.endMs - chapter.startMs) / 1000,
      })),
    };
    return {
      source,
      revoke: () => urls.splice(0).forEach((url) => URL.revokeObjectURL(url)),
    };
  } catch (error) {
    urls.forEach((url) => URL.revokeObjectURL(url));
    throw error;
  }
}
