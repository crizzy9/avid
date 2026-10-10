import type { AudioManifest } from '../../core/src/bookorbit';
import { mediaOverlayPath, type MediaOverlayPlaylist } from '../../core/src/media-overlay';
import type { ReadingAnchor } from '../../core/src/types';
import { validateAlignment, textAtAudioTime, audioAtTextLocator, type AlignedSegment, type AlignmentMap } from './alignment';
import type { PlaybackBook, PlaybackSnapshot } from './types';

export interface AlignmentEdition {
  accountScope: string;
  bookId: string;
  textFileId: string;
  /** Full SHA-256 of the EPUB whose SMIL and DOM are being used. */
  textSha256: string;
  audioFileId: string;
  manifestRevision: string;
}
export interface AudioResourceIdentity {
  audioHref: string;
  assetId: string;
  audioFileId: string;
  sizeBytes: number;
  sha256: string;
}
const proofs = new WeakSet<object>();
const maps = new WeakSet<object>();
export interface VerifiedAudioResource {
  readonly edition: Readonly<AlignmentEdition>;
  readonly resource: Readonly<AudioResourceIdentity>;
}
export interface StandaloneAlignedSegment extends AlignedSegment {
  trackId: string;
  trackTime: number;
  sectionIndex: number;
  textHref: string;
  textFragment: string;
}
export interface VerifiedAudioAlignment extends AlignmentMap {
  readonly edition: Readonly<AlignmentEdition>;
  readonly segments: StandaloneAlignedSegment[];
  readonly tracks: ReadonlyArray<{ id: string; duration: number }>;
  readonly duration: number;
}
const MAX_PROOF_BYTES = 64 * 1024 * 1024;
/** Millisecond manifest rounding plus decoder timestamp quantization, never a duration ratio. */
export const ALIGNMENT_DURATION_PRECISION_SECONDS = 0.002;
const shaPattern = /^[0-9a-f]{64}$/;
function checkEdition(edition: AlignmentEdition) {
  if (!edition.accountScope || !edition.bookId || !edition.textFileId || !edition.audioFileId || !edition.manifestRevision || !shaPattern.test(edition.textSha256)) {
    throw new Error('An exact account, EPUB hash and audiobook revision are required for handoff.');
  }
}
function equalEdition(actual: AlignmentEdition, expected: AlignmentEdition) {
  checkEdition(expected);
  for (const key of ['accountScope', 'bookId', 'textFileId', 'textSha256', 'audioFileId', 'manifestRevision'] as const) {
    if (actual[key] !== expected[key]) throw new Error('Text and audio handoff belongs to a different account or source edition.');
  }
}
export async function alignmentSha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Full-byte evidence, not duration/title/ETag similarity. Call only for already available
 * user-selected assets. This helper never downloads an audiobook to discover a match.
 * Proofs are session-local and cannot be restored from untrusted persisted JSON.
 */
export async function verifyAudioResource(
  edition: AlignmentEdition,
  identity: Pick<AudioResourceIdentity, 'audioHref' | 'assetId' | 'audioFileId'>,
  overlayBytes: ArrayBuffer,
  audiobookBytes: ArrayBuffer,
): Promise<VerifiedAudioResource> {
  checkEdition(edition); mediaOverlayPath(identity.audioHref);
  if (!identity.assetId || !identity.audioFileId || overlayBytes.byteLength <= 0 || overlayBytes.byteLength !== audiobookBytes.byteLength ||
    overlayBytes.byteLength > MAX_PROOF_BYTES) throw new Error('Matching complete audio resources up to 64 MiB are required for verification.');
  const [overlayHash, audiobookHash] = await Promise.all([alignmentSha256(overlayBytes), alignmentSha256(audiobookBytes)]);
  if (overlayHash !== audiobookHash) throw new Error('The EPUB narration and audiobook asset contain different audio bytes.');
  const proof: VerifiedAudioResource = Object.freeze({ edition: Object.freeze({ ...edition }), resource: Object.freeze({ ...identity, sizeBytes: overlayBytes.byteLength, sha256: overlayHash }) });
  proofs.add(proof);
  return proof;
}

/** Build a source-timeline map. Silence and unaligned tracks remain gaps; no scaling is applied. */
export function createStandaloneAlignment(edition: AlignmentEdition, playlist: MediaOverlayPlaylist, manifest: AudioManifest, verified: readonly VerifiedAudioResource[]): VerifiedAudioAlignment {
  checkEdition(edition);
  if (String(playlist.bookId) !== edition.bookId || String(playlist.fileId) !== edition.textFileId || manifest.schema !== 'bookorbit.audiobook-manifest' ||
    manifest.schemaVersion !== 2 || manifest.revision !== edition.manifestRevision) throw new Error('Alignment manifests belong to a different source edition.');
  const assets = [...manifest.assets].sort((a, b) => a.sequence - b.sequence);
  if (!assets.length || !assets.some(asset => String(asset.fileId) === edition.audioFileId)) throw new Error('The selected audiobook file is absent from the manifest.');
  const ids = new Set<string>(), fileIds = new Set<number>(), sequences = new Set<number>();
  const offsets = new Map<string, number>();
  let duration = 0;
  for (const asset of assets) {
    if (!asset.assetId || ids.has(asset.assetId) || fileIds.has(asset.fileId) || sequences.has(asset.sequence) || !Number.isSafeInteger(asset.sequence) || asset.sequence < 0 ||
      !Number.isSafeInteger(asset.fileId) || asset.fileId < 1 || !Number.isFinite(asset.durationMs) || asset.durationMs === null || asset.durationMs <= 0) {
      throw new Error('Unique audio assets with exact durations are required for handoff.');
    }
    ids.add(asset.assetId); fileIds.add(asset.fileId); sequences.add(asset.sequence);
    offsets.set(asset.assetId, duration); duration += asset.durationMs / 1000;
  }
  if (!Number.isFinite(manifest.totalDurationMs) || Math.abs(duration - manifest.totalDurationMs / 1000) > 0.001) throw new Error('The audiobook duration does not match its source tracks.');
  const byHref = new Map<string, VerifiedAudioResource>();
  if (new Set(playlist.resources.map(resource => resource.href)).size !== playlist.resources.length) throw new Error('The narration manifest has duplicate resource identities.');
  for (const proof of verified) {
    if (!proofs.has(proof)) throw new Error('Fresh full-byte audio verification is required.');
    equalEdition(proof.edition, edition);
    if (byHref.has(proof.resource.audioHref)) throw new Error('An EPUB resource has more than one audio binding.');
    const asset = assets.find(item => item.assetId === proof.resource.assetId && String(item.fileId) === proof.resource.audioFileId);
    const resource = playlist.resources.find(item => item.href === proof.resource.audioHref);
    if (!asset || !resource || asset.sizeBytes !== proof.resource.sizeBytes || resource.size !== proof.resource.sizeBytes) throw new Error('Verified audio bytes do not match the selected manifest resource sizes.');
    byHref.set(proof.resource.audioHref, proof);
  }
  const itemIds = new Set<number>();
  const segments: StandaloneAlignedSegment[] = playlist.items.map(item => {
    if (!Number.isSafeInteger(item.index) || item.index < 0 || itemIds.has(item.index) || !Number.isSafeInteger(item.sectionIndex) || item.sectionIndex < 0) throw new Error('Narration passage identities are invalid.');
    itemIds.add(item.index);
    const proof = byHref.get(item.audioHref);
    const asset = proof && assets.find(value => value.assetId === proof.resource.assetId);
    if (!proof || !asset || !item.textFragment || /[\u0000-\u001f]/.test(item.textFragment)) throw new Error('Every linked passage needs a verified audio resource and exact text fragment.');
    mediaOverlayPath(item.textHref);
    const begin = item.clipBeginSeconds, end = item.clipEndSeconds;
    if (!Number.isFinite(begin) || begin < 0 || end === null || !Number.isFinite(end) || end <= begin || end > asset.durationMs! / 1000 ||
      item.durationSeconds === null || Math.abs(item.durationSeconds - (end - begin)) > 0.001) throw new Error('Narration clip timing is unknown or exceeds its exact audio asset.');
    const offset = offsets.get(asset.assetId)!;
    return { id: String(item.index), textFileId: edition.textFileId, textLocator: `${item.textHref}#${encodeURIComponent(item.textFragment)}`,
      audioFileId: edition.audioFileId, start: offset + begin, end: offset + end, trackId: String(asset.fileId), trackTime: begin,
      sectionIndex: item.sectionIndex, textHref: item.textHref, textFragment: item.textFragment };
  }).sort((a, b) => a.start - b.start);
  const map: VerifiedAudioAlignment = {
    version: `sha256:${edition.textSha256}:${edition.manifestRevision}`, source: 'server-bridge', textFileId: edition.textFileId, audioFileId: edition.audioFileId,
    edition: Object.freeze({ ...edition }), segments, tracks: assets.map(asset => ({ id: String(asset.fileId), duration: asset.durationMs! / 1000 })), duration,
  };
  validateAlignment(map);
  // Ambiguous repeated text markers cannot provide an exact reverse handoff.
  if (new Set(segments.map(segment => segment.textLocator)).size !== segments.length) throw new Error('Repeated text fragments have ambiguous audiobook positions.');
  segments.forEach(Object.freeze); Object.freeze(segments); map.tracks.forEach(Object.freeze); Object.freeze(map.tracks); Object.freeze(map);
  maps.add(map);
  return map;
}

export function assertStandaloneAlignment(map: VerifiedAudioAlignment, edition: AlignmentEdition): void {
  if (!maps.has(map)) throw new Error('Fresh verified text and audio alignment is required.');
  equalEdition(map.edition, edition);
}

/** Exact href only; a CFI must first be resolved against the live EPUB DOM by the reader. */
export function alignedAudioAnchor(map: VerifiedAudioAlignment, edition: AlignmentEdition, textLocator: string, updatedAt = new Date().toISOString()): ReadingAnchor | null {
  assertStandaloneAlignment(map, edition);
  const segment = audioAtTextLocator(map, edition.textFileId, textLocator) as StandaloneAlignedSegment | null;
  if (!segment) return null;
  return { bookId: edition.bookId, fileId: edition.audioFileId, kind: 'audio',
    locator: JSON.stringify({ version: 1, trackId: segment.trackId, trackTime: segment.trackTime, time: segment.start, manifestRevision: edition.manifestRevision }),
    progress: segment.start / map.duration, updatedAt };
}
export interface AlignedTextTarget { bookId: string; fileId: string; locator: string; segmentId: string }
export function alignedTextTarget(map: VerifiedAudioAlignment, edition: AlignmentEdition, seconds: number): AlignedTextTarget | null {
  assertStandaloneAlignment(map, edition);
  const segment = textAtAudioTime(map, seconds);
  return segment ? { bookId: edition.bookId, fileId: edition.textFileId, locator: segment.textLocator, segmentId: segment.id } : null;
}
type AlignmentTransport = {
  getBook(): PlaybackBook | null; getSnapshot(): PlaybackSnapshot; pause(): void;
  load(book: PlaybackBook, sourceSeconds?: number): void;
};
function assertSource(map: VerifiedAudioAlignment, source: PlaybackBook | null) {
  if (!source || source.bookId !== map.edition.bookId || source.fileId !== map.edition.audioFileId || source.manifestRevision !== map.edition.manifestRevision ||
    source.tracks.length !== map.tracks.length || source.tracks.some((track, index) => track.id !== map.tracks[index]!.id || track.duration !== map.tracks[index]!.duration)) {
    throw new Error('The active player source does not match the verified alignment.');
  }
  if (source.tracks.some((track, index) => track.decodedDuration !== undefined &&
    (!Number.isFinite(track.decodedDuration) || Math.abs(track.decodedDuration - map.tracks[index]!.duration) > ALIGNMENT_DURATION_PRECISION_SECONDS))) {
    throw new Error('The decoded audio duration differs from the verified source timeline. Exact handoff is unavailable.');
  }
}
/** Stops the previous source only after complete validation. Does not autoplay. */
export function handoffToAudio(map: VerifiedAudioAlignment, edition: AlignmentEdition, textLocator: string, transport: AlignmentTransport, source: PlaybackBook): ReadingAnchor | null {
  const anchor = alignedAudioAnchor(map, edition, textLocator);
  if (!anchor) return null;
  assertSource(map, source);
  const seconds = (JSON.parse(anchor.locator) as { time: number }).time;
  transport.pause(); transport.load(source, seconds);
  return anchor;
}
/** Pause first to capture the final source clock. Playback speed never scales this clock. */
export function handoffToText(map: VerifiedAudioAlignment, edition: AlignmentEdition, transport: AlignmentTransport): AlignedTextTarget | null {
  assertStandaloneAlignment(map, edition); assertSource(map, transport.getBook());
  const before = transport.getSnapshot();
  if (before.bookId !== edition.bookId || before.fileId !== edition.audioFileId) throw new Error('The player changed before the text handoff.');
  // An unaligned gap must not stop playback or move the text to a guessed passage.
  if (!alignedTextTarget(map, edition, before.currentTime)) return null;
  transport.pause();
  assertSource(map, transport.getBook());
  const after = transport.getSnapshot();
  if (after.bookId !== edition.bookId || after.fileId !== edition.audioFileId) throw new Error('The player changed during the text handoff.');
  return alignedTextTarget(map, edition, after.currentTime);
}
