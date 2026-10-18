import type {
  BookOrbitClient,
  AudioManifest,
} from "../../../../packages/core/src/bookorbit";
import type { Book } from "../../../../packages/core/src/types";
import { accountScope } from "../../../../packages/core/src/repository";
import { sha256Blob } from "../../../../packages/core/src/blobHash";
import {
  preparedManifest,
  PREPARED_READ_LISTEN_LIMITS,
  type PreparedReadListenDescriptor,
  type PreparedReadListenStore,
} from "../../../../packages/core/src/preparedReadListen";
import type {
  GeneratedAlignmentSnapshot,
  GeneratedAudioTrack,
  RecognizedWord,
} from "../../../../packages/playback/src/generated-alignment";
import type { VerifiedAudioAlignment } from "../../../../packages/playback/src/standalone-alignment";
import type { ReaderAlignmentHandle } from "../../../../packages/readers/src/alignedPassage";
import { decodeSpeechWindows } from "./audioWindows";
import { LocalTranscriber, SPEECH_MODEL } from "./transcription";
import { generateAlignmentInWorker, type AlignmentMatchInput } from "./match";

export type PreparationProgress = {
  stage: "checking" | "downloading" | "model" | "comparing" | "saving";
  fraction?: number;
  detail?: string;
};
export interface PreparationInput {
  client: BookOrbitClient;
  scope: string;
  scopeLabel: string;
  book: Book;
  fileId: string;
  epub: Blob;
  handle: ReaderAlignmentHandle;
  store: PreparedReadListenStore;
  signal: AbortSignal;
  isActive: () => boolean;
  onProgress: (progress: PreparationProgress) => void;
}
export interface PreparationResult {
  descriptor: PreparedReadListenDescriptor;
  map: VerifiedAudioAlignment;
  reused: boolean;
}
export interface PreparationRecognizer {
  transcribe(
    blob: Blob,
    duration: number,
    onTime: (seconds: number) => void,
  ): Promise<RecognizedWord[]>;
  dispose(): void;
}
export type RecognizerFactory = (
  signal: AbortSignal,
  onModel: (file?: string, progress?: number) => void,
) => Promise<PreparationRecognizer>;
export const createLocalRecognizer: RecognizerFactory = async (
  signal,
  onModel,
) => {
  const engine = new LocalTranscriber(signal, onModel);
  try {
    await engine.load();
  } catch (error) {
    engine.dispose();
    throw error;
  }
  return {
    async transcribe(blob, duration, onTime) {
      const words: RecognizedWord[] = [];
      for await (const window of decodeSpeechWindows(blob, duration, signal)) {
        words.push(...(await engine.transcribe(window)));
        onTime(window.acceptEnd);
      }
      return words.sort((a, b) => a.start - b.start);
    },
    dispose: () => engine.dispose(),
  };
};
const identity = (manifest: AudioManifest) =>
  JSON.stringify(preparedManifest(manifest));

/** Explicit local preparation. The server is read only; only complete verified editions are published. */
export async function prepareReadListen(
  input: PreparationInput,
  recognizerFactory: RecognizerFactory = createLocalRecognizer,
  matcher: (
    input: AlignmentMatchInput,
    signal: AbortSignal,
  ) =>
    | GeneratedAlignmentSnapshot
    | Promise<GeneratedAlignmentSnapshot> = generateAlignmentInWorker,
): Promise<PreparationResult> {
  const { client, scope, book, fileId, epub, handle, signal, store } = input;
  const active = () => {
    signal.throwIfAborted();
    if (!input.isActive() || accountScope(client.session) !== scope)
      throw new DOMException(
        "The selected account or edition changed.",
        "AbortError",
      );
  };
  const guard = { signal, isActive: input.isActive };
  const report = (progress: PreparationProgress) => {
    active();
    input.onProgress(progress);
  };
  active();
  if (!handle.extractAlignmentText || !handle.restorePreparedAlignment)
    throw new Error("Open the EPUB reader before preparing Read & Listen.");
  if (epub.size > PREPARED_READ_LISTEN_LIMITS.epubBytes)
    throw new Error("Preparation currently supports EPUBs up to 64 MiB.");
  report({ stage: "checking" });
  const [publication, rawManifest] = await Promise.all([
    handle.extractAlignmentText(),
    client.getAudioManifest(book.id),
  ]);
  active();
  const manifest = preparedManifest(rawManifest);
  if ((await sha256Blob(epub, guard)) !== publication.textSha256)
    throw new Error(
      "The open EPUB no longer matches the selected source. Reopen it before preparing.",
    );
  active();
  let total = epub.size;
  for (const asset of manifest.assets) {
    if (asset.sizeBytes! > PREPARED_READ_LISTEN_LIMITS.assetBytes)
      throw new Error(
        "Preparation currently supports up to 512 MiB per audio file.",
      );
    total += asset.sizeBytes!;
  }
  if (total > PREPARED_READ_LISTEN_LIMITS.totalBytes)
    throw new Error("This edition exceeds the 2 GiB preparation limit.");
  const reusable = await store.findReusable(
    {
      scope,
      bookId: book.id,
      textFileId: fileId,
      textSha256: publication.textSha256,
      manifest,
    },
    guard,
  );
  active();
  const restore = async (
    snapshot: Parameters<
      NonNullable<ReaderAlignmentHandle["restorePreparedAlignment"]>
    >[0],
    sources: { assetId: string; blob: Blob }[],
  ) => {
    const map = await handle.restorePreparedAlignment!(
      snapshot,
      manifest,
      sources.map((source) => ({
        ...source,
        fileId: String(
          manifest.assets.find((asset) => asset.assetId === source.assetId)!
            .fileId,
        ),
      })),
    );
    active();
    return map;
  };
  if (reusable)
    return {
      descriptor: reusable,
      map: await restore(reusable.alignmentSnapshot, reusable.sources),
      reused: true,
    };
  const estimate = await navigator.storage?.estimate?.();
  active();
  if (
    estimate?.quota !== undefined &&
    estimate.usage !== undefined &&
    estimate.quota - estimate.usage < total * 1.1
  )
    throw new Error(
      "There is not enough device storage for this prepared edition. Free space and retry.",
    );
  await navigator.storage?.persist?.().catch(() => false);
  active();
  const cached = await store.findReusableSources(
    {
      scope,
      bookId: book.id,
      textFileId: fileId,
      textSha256: publication.textSha256,
      manifest,
    },
    guard,
  );
  active();
  const sources: { assetId: string; blob: Blob }[] = cached?.sources ?? [];
  let downloaded = 0;
  for (const asset of manifest.assets) {
    if (sources.some((source) => source.assetId === asset.assetId)) {
      downloaded += asset.sizeBytes!;
      continue;
    }
    report({
      stage: "downloading",
      fraction: downloaded / (total - epub.size),
    });
    const blob = await client.getAudioAssetBlob(book.id, asset.assetId, {
      signal,
      maxBytes: PREPARED_READ_LISTEN_LIMITS.assetBytes,
      purpose: "preparation",
    });
    active();
    if (blob.size !== asset.sizeBytes)
      throw new Error(
        "The recording changed during preparation. Refresh the book and retry.",
      );
    sources.push({ assetId: asset.assetId, blob });
    downloaded += blob.size;
  }
  report({ stage: "model" });
  const recognizer = await recognizerFactory(signal, (detail, percent) =>
    report({
      stage: "model",
      detail,
      fraction: percent === undefined ? undefined : percent / 100,
    }),
  );
  try {
    active();
    const tracks: GeneratedAudioTrack[] = [];
    let processed = 0;
    for (const asset of manifest.assets) {
      const blob = sources.find(
        (source) => source.assetId === asset.assetId,
      )!.blob;
      const sha256 = await sha256Blob(blob, guard);
      active();
      report({
        stage: "comparing",
        fraction: processed / (manifest.totalDurationMs / 1000),
      });
      const words = await recognizer.transcribe(
        blob,
        asset.durationMs! / 1000,
        (seconds) =>
          report({
            stage: "comparing",
            fraction: (processed + seconds) / (manifest.totalDurationMs / 1000),
          }),
      );
      active();
      tracks.push({
        assetId: asset.assetId,
        fileId: String(asset.fileId),
        sha256,
        sizeBytes: blob.size,
        duration: asset.durationMs! / 1000,
        words,
      });
      processed += asset.durationMs! / 1000;
    }
    const snapshot = await matcher(
      {
        edition: {
          accountScope: scope,
          bookId: book.id,
          textFileId: fileId,
          textSha256: publication.textSha256,
          audioFileId: String(manifest.assets[0]!.fileId),
          manifestRevision: manifest.revision,
        },
        publication,
        tracks,
        model: SPEECH_MODEL,
        language: "en",
      },
      signal,
    );
    active();
    if (identity(await client.getAudioManifest(book.id)) !== identity(manifest))
      throw new Error(
        "The audiobook edition changed during preparation. Retry with the current edition.",
      );
    active();
    report({ stage: "saving" });
    const map = await restore(snapshot, sources);
    active();
    const descriptor = await store.put(
      {
        scope,
        scopeLabel: input.scopeLabel,
        book,
        textFileId: fileId,
        epub,
        manifest,
        alignment: snapshot,
        sources,
      },
      guard,
    );
    active();
    return { descriptor, map, reused: false };
  } finally {
    recognizer.dispose();
  }
}
