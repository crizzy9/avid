import Dexie, { type Table } from "dexie";
import { unzipSync } from "fflate";
import { z } from "zod";
import type {
  AudioManifest,
  BookOrbitClient,
  PlaybackSource,
} from "./bookorbit";
import {
  mediaOverlayPath,
  mediaOverlayPlaylistSchema,
  type MediaOverlayPlaylist,
} from "./media-overlay";
import { passageText } from "./readAlongText";
import type { Book } from "./types";
import type { VerifiedAudioAlignment } from "../../playback/src/standalone-alignment";

export interface OfflineTimedText {
  segmentId: string;
  text: string;
  textLocator: string;
  start: number;
  end: number;
  trackId: string;
  trackTime: number;
}
export interface OfflineAudioPairing {
  audioHref: string;
  assetId: string;
  fileId: string;
}
export interface OfflineReadAlongGuard {
  signal?: AbortSignal;
  isActive?: () => boolean;
}
export interface OfflineReadAlongLimits {
  epubBytes: number;
  assetBytes: number;
  totalBytes: number;
  expandedEpubBytes: number;
}
export const OFFLINE_READ_ALONG_LIMITS: Readonly<OfflineReadAlongLimits> =
  Object.freeze({
    epubBytes: 64 * 1024 ** 2,
    assetBytes: 64 * 1024 ** 2,
    totalBytes: 256 * 1024 ** 2,
    expandedEpubBytes: 256 * 1024 ** 2,
  });
export class OfflineReadAlongError extends Error {
  constructor(
    readonly code: "invalid" | "corrupt" | "limit" | "stale" | "storage",
    message: string,
  ) {
    super(message);
    this.name = "OfflineReadAlongError";
  }
}
export interface OfflineReadAlongInput {
  scope: string;
  scopeLabel: string;
  book: Book;
  textFileId: string;
  epub: Blob;
  alignment?: VerifiedAudioAlignment;
  manifest?: AudioManifest;
  playlist?: MediaOverlayPlaylist;
  pairings?: readonly OfflineAudioPairing[];
  audioAssets?: readonly { assetId: string; blob: Blob }[];
  timedText?: readonly OfflineTimedText[];
}
/** Serialized evidence only. It is NOT a session-branded VerifiedAudioAlignment. */
export type OfflineAlignmentSnapshot = Omit<
  VerifiedAudioAlignment,
  "edition"
> & { edition: VerifiedAudioAlignment["edition"] };
export interface OfflineReadAlongDescriptor {
  version: 1;
  id: string;
  scope: string;
  scopeLabel: string;
  mode: "embedded" | "paired";
  book: Book;
  textFileId: string;
  textSha256: string;
  epubSize: number;
  totalBytes: number;
  createdAt: string;
  alignmentSnapshot?: OfflineAlignmentSnapshot;
  manifest?: AudioManifest;
  playlist?: MediaOverlayPlaylist;
  pairings: OfflineAudioPairing[];
  timedText: OfflineTimedText[];
  assets: { assetId: string; fileId: string; size: number; sha256: string }[];
  integritySha256: string;
}
export interface OfflineReadAlongPackage extends OfflineReadAlongDescriptor {
  epub: Blob;
  audioAssets: { assetId: string; blob: Blob }[];
}
export interface OfflineReadAlongScope {
  scope: string;
  label: string;
  count: number;
  totalBytes: number;
}
/** Opaque recovery handles never expose damaged metadata or account/URL fields. */
export interface OfflineReadAlongIssue {
  recoveryId: string;
  code: "corrupt-metadata";
}
type DescriptorRow = OfflineReadAlongDescriptor & { key: string };
type PayloadRow = {
  key: string;
  scope: string;
  id: string;
  epub: Blob;
  audioAssets: { assetId: string; blob: Blob }[];
};
const key = (scope: string, id: string) => JSON.stringify([scope, id]);
function invalid(message: string): never {
  throw new OfflineReadAlongError("invalid", message);
}
function guard(options: OfflineReadAlongGuard) {
  options.signal?.throwIfAborted();
  if (options.isActive && !options.isActive())
    throw new OfflineReadAlongError(
      "stale",
      "The account or source changed. No offline package was published.",
    );
}
function scopeIdentity(scope: string) {
  try {
    const parsed = JSON.parse(scope);
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      !parsed.every(
        (value) =>
          typeof value === "string" && value.length > 0 && value.length <= 2048,
      )
    )
      throw new Error();
    const url = new URL(parsed[0]);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      JSON.stringify(parsed) !== scope
    )
      throw new Error();
  } catch {
    invalid("An exact server/account scope without credentials is required.");
  }
}
function boundedLimits(
  value: Partial<OfflineReadAlongLimits> = {},
): OfflineReadAlongLimits {
  const limits = { ...OFFLINE_READ_ALONG_LIMITS, ...value };
  for (const name of Object.keys(limits) as (keyof OfflineReadAlongLimits)[])
    if (
      !Number.isSafeInteger(limits[name]) ||
      limits[name] < 1 ||
      limits[name] > OFFLINE_READ_ALONG_LIMITS[name]
    )
      invalid(
        "Offline limits must be positive and cannot exceed the supported package limits.",
      );
  return limits;
}
function sized(blob: Blob, maximum: number, name: string) {
  if (
    !blob ||
    typeof blob.arrayBuffer !== "function" ||
    !Number.isSafeInteger(blob.size) ||
    blob.size < 1
  )
    invalid(`${name} is missing or empty.`);
  if (blob.size > maximum)
    throw new OfflineReadAlongError(
      "limit",
      `${name} exceeds the offline byte limit.`,
    );
}
async function hash(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const copy =
    bytes instanceof Uint8Array ? Uint8Array.from(bytes).buffer : bytes;
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", copy)),
    (value) => value.toString(16).padStart(2, "0"),
  ).join("");
}
const hashJson = (value: unknown) => {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (bytes.length > 8 * 1024 ** 2)
    throw new OfflineReadAlongError(
      "limit",
      "Offline package metadata exceeds the 8 MiB limit.",
    );
  return hash(bytes);
};
const text = z.string().max(100_000);
const id = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => !/[\u0000-\u001f]/.test(value));
const number = z.number().finite().nonnegative();
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const format = z.enum(["EPUB", "MOBI", "PDF", "CBZ", "CBR", "CB7", "AUDIO"]);
const clean = (value: string) =>
  value
    .replace(/<[^>]*>/g, "")
    .replace(/https?:\/\/[^\s<>]+/gi, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
const bookSchema = z.object({
  id,
  title: text.transform(clean),
  authors: z.array(text.transform(clean)).max(100),
  description: text.transform(clean),
  format,
  color: z
    .string()
    .max(100)
    .transform((value) => (/^#[a-f\d]{3,8}$/i.test(value) ? value : "#66736d")),
  progress: number.max(1),
  status: z.enum(["unread", "reading", "finished"]),
  genres: z.array(text.transform(clean)).max(1000),
  addedAt: z.string().max(100),
  files: z
    .array(
      z.object({
        id,
        name: text.transform(clean),
        format,
        size: number.optional(),
      }),
    )
    .max(1000),
  series: text.transform(clean).optional(),
  seriesId: id.optional(),
  seriesIndex: number.optional(),
  publisher: text.transform(clean).optional(),
  publishedYear: z.number().int().optional(),
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
        title: text.transform(clean),
        assetId: id,
        sequence: z.number().int().nonnegative(),
        startMs: number,
        endMs: number,
        assetOffsetMs: number,
      }),
    )
    .max(10_000),
  totalDurationMs: number.positive(),
});
const alignmentSchema = z.object({
  version: id,
  source: z.literal("server-bridge"),
  textFileId: id,
  audioFileId: id,
  edition: z.object({
    accountScope: id.max(5000),
    bookId: id,
    textFileId: id,
    textSha256: sha,
    audioFileId: id,
    manifestRevision: id,
  }),
  segments: z
    .array(
      z.object({
        id,
        textFileId: id,
        textLocator: id,
        audioFileId: id,
        start: number,
        end: number,
        trackId: id,
        trackTime: number,
        sectionIndex: z.number().int().nonnegative(),
        textHref: id,
        textFragment: id,
      }),
    )
    .min(1)
    .max(50_000),
  tracks: z
    .array(z.object({ id, duration: number.positive() }))
    .min(1)
    .max(1000),
  duration: number.positive(),
});
const pairingSchema = z
  .array(
    z.object({
      audioHref: id.transform(mediaOverlayPath),
      assetId: id,
      fileId: id,
    }),
  )
  .min(1)
  .max(1000);
const timedSchema = z
  .array(
    z.object({
      segmentId: id,
      text: text.min(1),
      textLocator: id,
      start: number,
      end: number,
      trackId: id,
      trackTime: number,
    }),
  )
  .max(50_000);
function parse<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) invalid(`Invalid offline ${label}.`);
  return result.data;
}

type ArchivePassage = {
  sectionIndex: number;
  smilHref: string;
  textHref: string;
  textFragment: string;
  audioHref: string;
  begin: number;
  end: number;
};
function xml(bytes: Uint8Array | undefined): Document {
  if (
    !bytes ||
    bytes.length > 8 * 1024 ** 2 ||
    typeof DOMParser === "undefined"
  )
    invalid(
      "Offline EPUB verification requires an available XML document parser and bounded publication documents.",
    );
  const result = new DOMParser().parseFromString(
    new TextDecoder().decode(bytes),
    "application/xml",
  );
  if (result.getElementsByTagName("parsererror").length)
    invalid("The EPUB contains an invalid XML document.");
  return result;
}
function elements(node: Document | Element, name: string) {
  return Array.from(node.getElementsByTagNameNS("*", name));
}
function path(href: string, base = "") {
  if (!href || /[\u0000-\u001f\\]/.test(href))
    invalid("The EPUB resource path is invalid.");
  const url = new URL(href, new URL(base, "https://epub.invalid/"));
  if (
    url.origin !== "https://epub.invalid" ||
    url.search ||
    url.username ||
    url.password
  )
    invalid("Offline narration cannot reference external resources.");
  return {
    path: mediaOverlayPath(decodeURIComponent(url.pathname.slice(1))),
    fragment: url.hash ? decodeURIComponent(url.hash.slice(1)) : "",
  };
}
function clock(value: string | null): number | undefined {
  if (!value?.trim()) return undefined;
  const raw = value.trim().replace(/^npt=/i, ""),
    units = raw.match(/^(\d+(?:\.\d+)?)(ms|s|min|h)$/i);
  if (units)
    return (
      Number(units[1]) *
      { ms: 0.001, s: 1, min: 60, h: 3600 }[units[2]!.toLowerCase()]!
    );
  return /^\d+(?:\.\d+)?(?::\d+(?:\.\d+)?){0,2}$/.test(raw)
    ? raw.split(":").reduce((sum, part) => sum * 60 + Number(part), 0)
    : undefined;
}
function inspectArchive(
  bytes: ArrayBuffer,
  limits: OfflineReadAlongLimits,
  options: OfflineReadAlongGuard,
): { files: Record<string, Uint8Array>; passages: ArchivePassage[] } {
  let expanded = 0,
    count = 0;
  const names = new Set<string>();
  const files = unzipSync(new Uint8Array(bytes), {
    filter: (entry) => {
      guard(options);
      if (++count > 10_000 || names.has(entry.name))
        invalid("The EPUB archive contains too many or duplicate entries.");
      names.add(entry.name);
      if (entry.name.endsWith("/")) return false;
      mediaOverlayPath(entry.name);
      expanded += entry.originalSize;
      if (
        entry.originalSize > limits.assetBytes ||
        expanded > limits.expandedEpubBytes
      )
        throw new OfflineReadAlongError(
          "limit",
          "The expanded EPUB exceeds the offline byte limit.",
        );
      return true;
    },
  });
  guard(options);
  if (new TextDecoder().decode(files.mimetype) !== "application/epub+zip")
    invalid("Offline read-along requires an EPUB archive.");
  const root = elements(
    xml(files["META-INF/container.xml"]),
    "rootfile",
  )[0]?.getAttribute("full-path");
  if (!root) invalid("The EPUB package document is missing.");
  const opfPath = mediaOverlayPath(root),
    opf = xml(files[opfPath]);
  const items = new Map<string, Element>();
  for (const item of elements(opf, "item")) {
    const identity = item.getAttribute("id");
    if (!identity || items.has(identity))
      invalid("The EPUB manifest has duplicate or missing identities.");
    if (
      items.size >= 10_000 ||
      !files[path(item.getAttribute("href") ?? "", opfPath).path] ||
      item.getAttribute("properties")?.split(/\s+/).includes("remote-resources")
    )
      invalid(
        "Offline EPUB packages require complete local manifest resources.",
      );
    items.set(identity, item);
  }
  const passages: ArchivePassage[] = [];
  const spine = elements(opf, "itemref");
  for (const [sectionIndex, section] of spine.entries()) {
    const item = items.get(section.getAttribute("idref") ?? "");
    if (!item) invalid("An EPUB spine section is missing.");
    const overlayId = item.getAttribute("media-overlay");
    if (!overlayId) continue;
    const overlay = items.get(overlayId);
    if (!overlay) invalid("The EPUB narration document is missing.");
    const textPath = path(item.getAttribute("href") ?? "", opfPath).path,
      smilHref = path(overlay.getAttribute("href") ?? "", opfPath).path;
    const textDoc = xml(files[textPath]);
    for (const par of elements(xml(files[smilHref]), "par")) {
      const children = Array.from(par.children),
        text = children.find((child) => child.localName === "text"),
        audio = children.find((child) => child.localName === "audio");
      if (!text || !audio) continue;
      const textTarget = path(text.getAttribute("src") ?? "", smilHref),
        audioTarget = path(audio.getAttribute("src") ?? "", smilHref);
      const start = audio.getAttribute("clipBegin"),
        begin = start === null ? 0 : clock(start),
        end = clock(audio.getAttribute("clipEnd"));
      if (
        textTarget.path !== textPath ||
        !textTarget.fragment ||
        !textDoc.getElementById(textTarget.fragment) ||
        audioTarget.fragment ||
        !files[audioTarget.path]?.length ||
        begin === undefined ||
        end === undefined ||
        end <= begin
      )
        invalid(
          "Offline narration requires exact text fragments, complete embedded audio and valid clip times.",
        );
      passages.push({
        sectionIndex,
        smilHref,
        textHref: textPath,
        textFragment: textTarget.fragment,
        audioHref: audioTarget.path,
        begin,
        end,
      });
      if (passages.length > 50_000)
        invalid("The EPUB narration exceeds the supported passage limit.");
    }
  }
  if (!passages.length)
    invalid("This EPUB has no complete embedded read-along narration.");
  return { files, passages };
}

async function prepare(
  input: OfflineReadAlongInput,
  options: OfflineReadAlongGuard,
  limits: OfflineReadAlongLimits,
  createdAt = new Date().toISOString(),
): Promise<OfflineReadAlongPackage> {
  // Capture the account/edition arguments before any await. Caller-owned objects may change.
  input = {
    ...input,
    audioAssets: input.audioAssets?.map((asset) => ({ ...asset })),
  };
  guard(options);
  scopeIdentity(input.scope);
  const book = parse(bookSchema, input.book, "book metadata");
  const textFileId = parse(id, input.textFileId, "EPUB file identity");
  if (
    !book.files.some(
      (file) => file.id === textFileId && file.format === "EPUB",
    ) ||
    new Set(book.files.map((file) => file.id)).size !== book.files.length
  )
    invalid("The EPUB file does not belong to this book edition.");
  sized(input.epub, limits.epubBytes, "EPUB");
  const declaredEpubSize = book.files.find(
    (file) => file.id === textFileId,
  )!.size;
  if (declaredEpubSize !== undefined && declaredEpubSize !== input.epub.size)
    invalid("The EPUB download does not match its declared file size.");
  const bytes = await input.epub.arrayBuffer();
  guard(options);
  const textSha256 = await hash(bytes);
  guard(options);
  const archive = inspectArchive(bytes, limits, options);
  let totalBytes = input.epub.size;
  const assets: OfflineReadAlongDescriptor["assets"] = [],
    audioAssets: OfflineReadAlongPackage["audioAssets"] = [];
  let manifest: AudioManifest | undefined,
    alignmentSnapshot: OfflineAlignmentSnapshot | undefined,
    playlist: MediaOverlayPlaylist | undefined;
  let pairings: OfflineAudioPairing[] = [],
    timedText: OfflineTimedText[] = [];
  const paired = Boolean(
    input.alignment ||
    input.manifest ||
    input.playlist ||
    input.pairings?.length ||
    input.audioAssets?.length,
  );
  if (paired) {
    manifest = parse(manifestSchema, input.manifest, "audiobook manifest");
    manifest.assets.sort((a, b) => a.sequence - b.sequence);
    manifest.chapters.sort((a, b) => a.sequence - b.sequence);
    alignmentSnapshot = parse(
      alignmentSchema,
      input.alignment,
      "alignment snapshot",
    );
    playlist = parse(
      mediaOverlayPlaylistSchema,
      input.playlist,
      "narration playlist",
    );
    if (
      playlist.items.length > 50_000 ||
      playlist.resources.length > 1000 ||
      playlist.sections.length > 10_000
    )
      invalid("The narration playlist exceeds the supported passage limit.");
    // The playlist schema strips unknown fields; labels are display data, never markup/URLs.
    playlist.items.forEach((item) => {
      if (item.label) item.label = clean(item.label);
    });
    playlist.sections.forEach((section) => {
      if (section.label) section.label = clean(section.label);
    });
    pairings = parse(pairingSchema, input.pairings, "audio pairings");
    pairings.sort((a, b) =>
      a.audioHref < b.audioHref ? -1 : a.audioHref > b.audioHref ? 1 : 0,
    );
    const edition = alignmentSnapshot.edition;
    if (
      edition.accountScope !== input.scope ||
      edition.bookId !== book.id ||
      edition.textFileId !== textFileId ||
      edition.textSha256 !== textSha256 ||
      edition.manifestRevision !== manifest.revision ||
      alignmentSnapshot.version !==
        `sha256:${textSha256}:${manifest.revision}` ||
      alignmentSnapshot.textFileId !== textFileId ||
      alignmentSnapshot.audioFileId !== edition.audioFileId ||
      String(playlist.bookId) !== book.id ||
      String(playlist.fileId) !== textFileId ||
      !book.files.some(
        (file) => file.id === edition.audioFileId && file.format === "AUDIO",
      )
    )
      invalid(
        "The offline assets belong to a different account or text/audio edition.",
      );
    const unique = <T>(values: T[]) => new Set(values).size === values.length;
    if (
      !unique(manifest.assets.map((asset) => asset.assetId)) ||
      !unique(manifest.assets.map((asset) => asset.fileId)) ||
      !unique(manifest.assets.map((asset) => asset.sequence)) ||
      !unique(manifest.chapters.map((chapter) => chapter.id))
    )
      invalid("The audiobook manifest has duplicate identities.");
    const offset = new Map<string, number>();
    let duration = 0;
    for (const asset of manifest.assets) {
      offset.set(String(asset.fileId), duration);
      duration += asset.durationMs! / 1000;
    }
    if (
      Math.abs(duration * 1000 - manifest.totalDurationMs) > 1 ||
      alignmentSnapshot.duration !== duration ||
      alignmentSnapshot.tracks.length !== manifest.assets.length ||
      alignmentSnapshot.tracks.some(
        (track, index) =>
          track.id !== String(manifest!.assets[index]!.fileId) ||
          track.duration !== manifest!.assets[index]!.durationMs! / 1000,
      )
    )
      invalid("The saved audio timeline differs from the manifest.");
    let previousChapterEnd = -1;
    const chapterSequences = new Set<number>();
    for (const chapter of manifest.chapters) {
      if (
        !manifest.assets.some((asset) => asset.assetId === chapter.assetId) ||
        chapter.endMs <= chapter.startMs ||
        chapter.endMs > manifest.totalDurationMs ||
        chapterSequences.has(chapter.sequence) ||
        chapter.startMs / 1000 < previousChapterEnd
      )
        invalid("The audiobook chapter timeline is invalid.");
      chapterSequences.add(chapter.sequence);
      previousChapterEnd =
        chapter.startMs / 1000 + (chapter.endMs - chapter.startMs) / 1000;
    }
    const blobs = input.audioAssets ?? [];
    if (
      blobs.length !== manifest.assets.length ||
      !unique(blobs.map((asset) => asset.assetId))
    )
      invalid(
        "Every audio asset must be present exactly once before publishing.",
      );
    for (const asset of manifest.assets) {
      guard(options);
      const blob = blobs.find((value) => value.assetId === asset.assetId)?.blob;
      if (!blob) invalid("An audiobook asset is missing.");
      sized(blob, limits.assetBytes, "Audio asset");
      if (blob.size !== asset.sizeBytes)
        invalid(
          "An audio asset is partial or no longer matches its manifest size.",
        );
      totalBytes += blob.size;
      if (totalBytes > limits.totalBytes)
        throw new OfflineReadAlongError(
          "limit",
          "The complete offline package exceeds the byte limit.",
        );
      const sha256 = await hash(await blob.arrayBuffer());
      guard(options);
      assets.push({
        assetId: asset.assetId,
        fileId: String(asset.fileId),
        size: blob.size,
        sha256,
      });
      audioAssets.push({ assetId: asset.assetId, blob });
    }
    if (
      !unique(pairings.map((pair) => pair.audioHref)) ||
      !unique(playlist.resources.map((resource) => resource.href)) ||
      archive.passages.length !== playlist.items.length ||
      alignmentSnapshot.segments.length !== playlist.items.length
    )
      invalid("The narration passages or resource bindings are incomplete.");
    const used = new Set(playlist.items.map((item) => item.audioHref));
    if (
      pairings.length !== used.size ||
      pairings.some((pair) => !used.has(pair.audioHref))
    )
      invalid(
        "Every embedded narration resource needs exactly one audio pairing.",
      );
    for (const pair of pairings) {
      const asset = assets.find(
          (asset) =>
            asset.assetId === pair.assetId && asset.fileId === pair.fileId,
        ),
        resource = playlist.resources.find(
          (resource) => resource.href === pair.audioHref,
        ),
        embedded = archive.files[pair.audioHref];
      if (
        !asset ||
        !resource ||
        !embedded ||
        embedded.length !== asset.size ||
        resource.size !== asset.size ||
        (await hash(embedded)) !== asset.sha256
      )
        invalid(
          "The embedded narration and saved audiobook asset do not contain the same complete bytes.",
        );
      guard(options);
    }
    const segmentsById = new Map(
      alignmentSnapshot.segments.map((segment) => [segment.id, segment]),
    );
    const pairingsByHref = new Map(
      pairings.map((pair) => [pair.audioHref, pair]),
    );
    const tracksById = new Map(
      manifest.assets.map((asset) => [String(asset.fileId), asset]),
    );
    const segmentIds = new Set<string>(),
      locators = new Set<string>();
    let previousEnd = -1;
    for (const [index, item] of playlist.items.entries()) {
      const exact = archive.passages[index]!,
        pair = pairingsByHref.get(item.audioHref)!;
      const segment = segmentsById.get(String(item.index));
      if (
        item.index !== index ||
        item.sectionIndex !== exact.sectionIndex ||
        item.smilHref !== exact.smilHref ||
        item.textHref !== exact.textHref ||
        item.textFragment !== exact.textFragment ||
        item.audioHref !== exact.audioHref ||
        item.clipBeginSeconds !== exact.begin ||
        item.clipEndSeconds !== exact.end ||
        item.durationSeconds !== exact.end - exact.begin
      )
        invalid(
          "The saved narration playlist does not match the EPUB SMIL and text.",
        );
      const start = offset.get(pair.fileId)! + exact.begin,
        end = offset.get(pair.fileId)! + exact.end;
      const track = tracksById.get(pair.fileId)!;
      if (
        !segment ||
        segment.textFileId !== textFileId ||
        segment.audioFileId !== edition.audioFileId ||
        segment.trackId !== pair.fileId ||
        segment.trackTime !== exact.begin ||
        segment.start !== start ||
        segment.end !== end ||
        segment.sectionIndex !== exact.sectionIndex ||
        segment.textHref !== exact.textHref ||
        segment.textFragment !== exact.textFragment ||
        segment.textLocator !==
          `${exact.textHref}#${encodeURIComponent(exact.textFragment)}` ||
        exact.end > track.durationMs! / 1000
      )
        invalid(
          "The alignment snapshot does not match its exact source timeline.",
        );
    }
    for (const segment of alignmentSnapshot.segments) {
      if (
        segmentIds.has(segment.id) ||
        locators.has(segment.textLocator) ||
        segment.start < previousEnd ||
        segment.end <= segment.start
      )
        invalid("The alignment contains duplicate or overlapping passages.");
      segmentIds.add(segment.id);
      locators.add(segment.textLocator);
      previousEnd = segment.end;
    }
    timedText = parse(timedSchema, input.timedText ?? [], "timed text");
    if (!unique(timedText.map((line) => line.segmentId)))
      invalid("The timed text has duplicate passage identities.");
    const textDocuments = new Map<string, Document>();
    for (const line of timedText) {
      const segment = segmentsById.get(line.segmentId);
      if (
        !segment ||
        line.textLocator !== segment.textLocator ||
        line.start !== segment.start ||
        line.end !== segment.end ||
        line.trackId !== segment.trackId ||
        line.trackTime !== segment.trackTime
      )
        invalid("The timed text does not match the saved alignment.");
      if (!textDocuments.has(segment.textHref))
        textDocuments.set(
          segment.textHref,
          xml(archive.files[segment.textHref]),
        );
      const element = textDocuments
        .get(segment.textHref)!
        .getElementById(segment.textFragment);
      const actual = element ? passageText(element) : "";
      if (line.text.replace(/\s+/g, " ").trim() !== actual)
        invalid("The timed text does not match the EPUB passage text.");
    }
    timedText.sort((a, b) => a.start - b.start);
  } else if (input.timedText?.length)
    invalid("Timed text snapshots require an exactly paired audio timeline.");
  if (totalBytes > limits.totalBytes)
    throw new OfflineReadAlongError(
      "limit",
      "The complete offline package exceeds the byte limit.",
    );
  const packageId = await hashJson({
    bookId: book.id,
    textFileId,
    textSha256,
    manifest,
    pairings,
    assets,
  });
  const descriptor = {
    version: 1 as const,
    id: packageId,
    scope: input.scope,
    scopeLabel:
      clean(
        parse(z.string().min(1).max(200), input.scopeLabel, "account label"),
      ).trim() || "Offline library",
    mode: paired ? ("paired" as const) : ("embedded" as const),
    book,
    textFileId,
    textSha256,
    epubSize: input.epub.size,
    totalBytes,
    createdAt,
    alignmentSnapshot,
    manifest,
    playlist,
    pairings,
    timedText,
    assets,
  };
  const integritySha256 = await hashJson(descriptor);
  guard(options);
  return { ...descriptor, integritySha256, epub: input.epub, audioAssets };
}

/** Browser IndexedDB durability is subject to quota, storage eviction and private-browsing rules. No auth is stored. */
export class OfflineReadAlongStore {
  readonly database: Dexie;
  private descriptors: Table<DescriptorRow, string>;
  private payloads: Table<PayloadRow, string>;
  constructor(name = "avid-offline-readalong-v1") {
    this.database = new Dexie(name);
    this.database
      .version(1)
      .stores({ packages: "&key,scope,id", payloads: "&key,scope" });
    this.descriptors = this.database.table("packages");
    this.payloads = this.database.table("payloads");
  }
  async put(
    input: OfflineReadAlongInput,
    options: OfflineReadAlongGuard & {
      limits?: Partial<OfflineReadAlongLimits>;
    } = {},
  ): Promise<OfflineReadAlongDescriptor> {
    const prepared = await prepare(
      input,
      options,
      boundedLimits(options.limits),
    );
    const { epub, audioAssets, ...descriptor } = prepared;
    const identity = key(descriptor.scope, descriptor.id);
    try {
      await this.database.transaction(
        "rw",
        this.descriptors,
        this.payloads,
        async () => {
          guard(options);
          await this.payloads.put({
            key: identity,
            scope: descriptor.scope,
            id: descriptor.id,
            epub,
            audioAssets,
          });
          guard(options);
          await this.descriptors.put({ key: identity, ...descriptor });
          guard(options);
        },
      );
    } catch (error) {
      if (
        error instanceof OfflineReadAlongError ||
        (error instanceof Error && error.name === "AbortError")
      )
        throw error;
      throw new OfflineReadAlongError(
        "storage",
        "Offline storage failed or its quota was exceeded. Existing saved editions were preserved.",
      );
    }
    return descriptor;
  }
  async list(scope: string): Promise<OfflineReadAlongDescriptor[]> {
    scopeIdentity(scope);
    const rows = await this.descriptors.where("scope").equals(scope).toArray();
    const descriptors = await Promise.all(
      rows.map((row) => this.readableDescriptor(row, scope)),
    );
    return descriptors.filter(
      (row): row is OfflineReadAlongDescriptor => row !== undefined,
    );
  }
  async listScopes(): Promise<OfflineReadAlongScope[]> {
    const rows = await this.descriptors.toArray(),
      scopes = new Map<string, OfflineReadAlongScope>();
    for (const row of rows) {
      const descriptor = await this.readableDescriptor(row, row.scope);
      if (!descriptor) continue;
      const scope = scopes.get(row.scope) ?? {
        scope: row.scope,
        label: descriptor.scopeLabel,
        count: 0,
        totalBytes: 0,
      };
      scope.count++;
      scope.totalBytes += descriptor.totalBytes;
      scopes.set(row.scope, scope);
    }
    return [...scopes.values()];
  }
  /**
   * Healthy listings skip corrupt descriptors. Recovery is explicit: callers
   * may show this count and offer removal using these opaque handles. Binary
   * corruption is checked by get(); its intact descriptor remains listable.
   */
  async listIssues(): Promise<OfflineReadAlongIssue[]> {
    const issues: OfflineReadAlongIssue[] = [];
    for (const row of await this.descriptors.toArray())
      if (!(await this.readableDescriptor(row, row.scope)))
        issues.push({
          recoveryId: await hashJson(["offline-recovery-v1", row.key]),
          code: "corrupt-metadata",
        });
    return issues;
  }
  /** Removes only a still-damaged package; a stale handle cannot delete a repaired download. */
  async removeIssue(recoveryId: string): Promise<boolean> {
    if (
      typeof recoveryId !== "string" ||
      recoveryId.length !== 64 ||
      !/^[a-f0-9]{64}$/.test(recoveryId)
    )
      invalid("A valid offline recovery handle is required.");
    for (const row of await this.descriptors.toArray()) {
      if ((await hashJson(["offline-recovery-v1", row.key])) !== recoveryId)
        continue;
      return this.database.transaction(
        "rw",
        this.descriptors,
        this.payloads,
        async () => {
          const current = await this.descriptors.get(row.key);
          if (
            !current ||
            (await Dexie.waitFor(
              this.readableDescriptor(current, current.scope),
            ))
          )
            return false;
          await this.descriptors.delete(row.key);
          await this.payloads.delete(row.key);
          return true;
        },
      );
    }
    return false;
  }
  private async readableDescriptor(
    row: DescriptorRow,
    scope: string,
  ): Promise<OfflineReadAlongDescriptor | undefined> {
    try {
      return await this.descriptor(row, scope);
    } catch (error) {
      if (
        error instanceof OfflineReadAlongError &&
        (error.code === "invalid" || error.code === "corrupt")
      )
        return undefined;
      // Storage/crypto failures remain visible rather than masquerading as an empty library.
      throw error;
    }
  }
  private async descriptor(
    row: DescriptorRow,
    scope: string,
  ): Promise<OfflineReadAlongDescriptor> {
    scopeIdentity(scope);
    const { key: storedKey, integritySha256, ...data } = row;
    let bytes: Uint8Array;
    try {
      bytes = new TextEncoder().encode(JSON.stringify(data));
      if (bytes.length > 8 * 1024 ** 2) throw new Error();
    } catch {
      throw new OfflineReadAlongError(
        "corrupt",
        "The saved offline package metadata cannot be read safely.",
      );
    }
    if (
      storedKey !== key(scope, row.id) ||
      row.scope !== scope ||
      row.version !== 1 ||
      typeof row.id !== "string" ||
      row.id.length !== 64 ||
      !/^[a-f0-9]{64}$/.test(row.id) ||
      (await hash(bytes)) !== integritySha256
    )
      throw new OfflineReadAlongError(
        "corrupt",
        "The saved offline package metadata is corrupt. Remove and download this edition again.",
      );
    return { ...data, integritySha256 };
  }
  async get(
    scope: string,
    id: string,
    options: OfflineReadAlongGuard = {},
  ): Promise<OfflineReadAlongPackage | undefined> {
    scopeIdentity(scope);
    guard(options);
    const [row, payload] = await this.database.transaction(
      "r",
      this.descriptors,
      this.payloads,
      async () =>
        Promise.all([
          this.descriptors.get(key(scope, id)),
          this.payloads.get(key(scope, id)),
        ]),
    );
    if (!row && !payload) return undefined;
    if (
      !row ||
      !payload ||
      payload.scope !== scope ||
      payload.id !== id ||
      payload.key !== key(scope, id)
    )
      throw new OfflineReadAlongError(
        "corrupt",
        "The saved offline package is incomplete. Download this edition again.",
      );
    const descriptor = await this.descriptor(row, scope);
    guard(options);
    try {
      const verified = await prepare(
        {
          scope,
          scopeLabel: descriptor.scopeLabel,
          book: descriptor.book,
          textFileId: descriptor.textFileId,
          epub: payload.epub,
          alignment: descriptor.alignmentSnapshot,
          manifest: descriptor.manifest,
          playlist: descriptor.playlist,
          pairings: descriptor.pairings,
          audioAssets: payload.audioAssets,
          timedText: descriptor.timedText,
        },
        options,
        boundedLimits(),
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
        (error instanceof OfflineReadAlongError && error.code === "stale")
      )
        throw error;
      throw new OfflineReadAlongError(
        "corrupt",
        "The saved offline package failed its source, size or SHA-256 check. Download this edition again.",
      );
    }
  }
  async remove(scope: string, id: string): Promise<void> {
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

export type OfflineDownloadClient = Pick<
  BookOrbitClient,
  | "baseUrl"
  | "session"
  | "getFileBlob"
  | "getAudioManifest"
  | "getAudioAssetBlob"
>;
export type OfflineDownloadInput = Omit<
  OfflineReadAlongInput,
  "epub" | "audioAssets"
> & { epub?: Blob };
async function abortableRead<T>(
  work: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(
        signal.reason ??
          new DOMException("Offline download canceled.", "AbortError"),
      );
    };
    signal.addEventListener("abort", abort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
/** Reads only: never changes server progress, metadata, annotations or subscriptions. */
export async function downloadOfflineReadAlong(
  client: OfflineDownloadClient,
  store: OfflineReadAlongStore,
  input: OfflineDownloadInput,
  options: OfflineReadAlongGuard & {
    limits?: Partial<OfflineReadAlongLimits>;
  } = {},
): Promise<OfflineReadAlongDescriptor> {
  input = { ...input };
  const limits = boundedLimits(options.limits);
  const checked: OfflineReadAlongGuard = {
    signal: options.signal,
    isActive: () =>
      (!options.isActive || options.isActive()) &&
      JSON.stringify([client.baseUrl, client.session.userId]) === input.scope,
  };
  guard(checked);
  const epub =
    input.epub ??
    (await client.getFileBlob(
      input.textFileId,
      options.signal,
      limits.epubBytes,
    ));
  guard(checked);
  let manifest: AudioManifest | undefined;
  const audioAssets: { assetId: string; blob: Blob }[] = [];
  if (input.alignment) {
    manifest = parse(
      manifestSchema,
      await abortableRead(
        client.getAudioManifest(input.book.id),
        options.signal,
      ),
      "audiobook manifest",
    );
    guard(checked);
    if (
      input.manifest &&
      JSON.stringify(
        parse(manifestSchema, input.manifest, "expected audiobook manifest"),
      ) !== JSON.stringify(manifest)
    )
      invalid(
        "The audiobook manifest changed since verification. Verify its alignment again before downloading.",
      );
    if (manifest.revision !== input.alignment.edition.manifestRevision)
      invalid(
        "The audiobook edition changed. Verify its alignment again before downloading.",
      );
    let total = epub.size;
    for (const asset of manifest.assets) {
      guard(checked);
      if (
        asset.sizeBytes! > limits.assetBytes ||
        total + asset.sizeBytes! > limits.totalBytes
      )
        throw new OfflineReadAlongError(
          "limit",
          "The complete audiobook exceeds the supported offline byte limit.",
        );
      const blob = await client.getAudioAssetBlob(
        input.book.id,
        asset.assetId,
        { signal: options.signal, maxBytes: limits.assetBytes },
      );
      guard(checked);
      if (blob.size !== asset.sizeBytes)
        invalid("An audio download is partial or changed size.");
      total += blob.size;
      audioAssets.push({ assetId: asset.assetId, blob });
    }
    const latest = parse(
      manifestSchema,
      await abortableRead(
        client.getAudioManifest(input.book.id),
        options.signal,
      ),
      "audiobook manifest",
    );
    guard(checked);
    if (JSON.stringify(latest) !== JSON.stringify(manifest))
      invalid(
        "The audiobook edition changed during download. Existing saved editions were preserved.",
      );
  }
  guard(checked);
  return store.put(
    { ...input, epub, manifest, audioAssets },
    { ...checked, limits },
  );
}

/** Call revoke when this source closes. URLs are generated in memory and never stored. */
export function offlinePlaybackSource(pkg: OfflineReadAlongPackage): {
  source: PlaybackSource;
  revoke: () => void;
} {
  if (pkg.mode !== "paired" || !pkg.manifest || !pkg.alignmentSnapshot)
    invalid(
      "This package uses embedded EPUB narration; open it in the reader.",
    );
  const urls: string[] = [];
  try {
    const source: PlaybackSource = {
      bookId: pkg.book.id,
      fileId: pkg.alignmentSnapshot.edition.audioFileId,
      title: pkg.book.title,
      authors: [...pkg.book.authors],
      manifestRevision: pkg.manifest.revision,
      tracks: pkg.manifest.assets.map((asset) => {
        const blob = pkg.audioAssets.find(
          (candidate) => candidate.assetId === asset.assetId,
        )?.blob;
        if (!blob) invalid("An offline audio asset is missing.");
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
      revoke: () => {
        urls.splice(0).forEach((url) => URL.revokeObjectURL(url));
      },
    };
  } catch (error) {
    urls.forEach((url) => URL.revokeObjectURL(url));
    throw error;
  }
}
