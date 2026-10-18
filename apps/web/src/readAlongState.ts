import type { ReadingAnchor } from "../../../packages/core/src/types";
import type { PlaybackBook } from "../../../packages/playback/src/types";
import { generatedDurationCompatible } from "../../../packages/playback/src/audioDuration";
import {
  ALIGNMENT_DURATION_PRECISION_SECONDS,
  type VerifiedAudioAlignment,
} from "../../../packages/playback/src/standalone-alignment";

export interface ReaderPositionOwner {
  ownerScope: string;
  book: { id: string };
  file: { id: string; format: string };
}
/** A preview belongs to the exact mounted source, not just a title with the same ID. */
export function validReaderPosition(
  owner: ReaderPositionOwner | null,
  scope: string,
  anchor: ReadingAnchor,
): boolean {
  const kind =
    owner?.file.format === "PDF"
      ? "pdf"
      : ["CBZ", "CBR", "CB7"].includes(owner?.file.format ?? "")
        ? "comic"
        : "epub";
  return (
    !!owner &&
    owner.ownerScope === scope &&
    owner.book.id === anchor.bookId &&
    owner.file.id === anchor.fileId &&
    anchor.kind === kind
  );
}
/** The same canonical source and decoder precision checks used by an explicit handoff. */
export function matchingAlignedPlayback(
  map: VerifiedAudioAlignment | null,
  source: PlaybackBook | null,
  scope: string,
): boolean {
  return (
    !!map &&
    !!source &&
    map.edition.accountScope === scope &&
    map.edition.bookId === source.bookId &&
    map.edition.audioFileId === source.fileId &&
    map.edition.manifestRevision === source.manifestRevision &&
    source.tracks.length === map.tracks.length &&
    source.tracks.every((track, index) => {
      const expected = map.tracks[index]!;
      return (
        track.id === expected.id &&
        track.duration === expected.duration &&
        (track.decodedDuration === undefined ||
          (map.source === "generated"
            ? generatedDurationCompatible(
                expected.duration,
                track.decodedDuration,
              )
            : Number.isFinite(track.decodedDuration) &&
              Math.abs(track.decodedDuration - expected.duration) <=
                ALIGNMENT_DURATION_PRECISION_SECONDS))
      );
    })
  );
}

export type HandoffPolicy = "manual" | "latest" | "separate";
export interface ConfirmedLinkedPosition {
  source: "reading" | "listening";
  seconds: number;
  updatedAt: string;
  textAnchor?: ReadingAnchor;
}
export function latestConfirmedPosition(
  positions: readonly ConfirmedLinkedPosition[],
): ConfirmedLinkedPosition | undefined {
  return positions
    .filter(
      (position) =>
        Number.isFinite(position.seconds) &&
        position.seconds >= 0 &&
        Number.isFinite(Date.parse(position.updatedAt)),
    )
    .reduce<ConfirmedLinkedPosition | undefined>(
      (latest, position) =>
        !latest || Date.parse(position.updatedAt) > Date.parse(latest.updatedAt)
          ? position
          : latest,
      undefined,
    );
}
export const handoffPolicyKey = (scope: string, bookId: string) =>
  `avid.handoff.v1.${encodeURIComponent(scope)}.${encodeURIComponent(bookId)}`;
export function readHandoffPolicy(
  scope: string,
  bookId: string,
): HandoffPolicy {
  try {
    const value = localStorage.getItem(handoffPolicyKey(scope, bookId));
    return value === "latest" || value === "separate" ? value : "manual";
  } catch {
    return "manual";
  }
}
