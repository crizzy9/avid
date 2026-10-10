import { assertStandaloneAlignment, alignmentSha256, createStandaloneAlignment, verifyAudioResource, type AlignmentEdition, type VerifiedAudioAlignment, type StandaloneAlignedSegment } from '../../playback/src/standalone-alignment';
import type { MediaOverlayPlaylist } from '../../core/src/media-overlay';
import { mediaOverlayPath } from '../../core/src/media-overlay';
import type { AudioManifest } from '../../core/src/bookorbit';

export interface ReaderAlignmentHandle {
  /** Stop embedded narration and speech before switching to another playback owner. */
  pauseNarration(): void;
  /** Resolve the actual DOM point, never estimate the nearest passage from reading percentage. */
  currentPassage(map: VerifiedAudioAlignment, edition: AlignmentEdition): Promise<StandaloneAlignedSegment | null>;
  /** Verify user-selected, already available assets against the currently parsed EPUB. */
  verifyAudiobook(playlist: MediaOverlayPlaylist, manifest: AudioManifest, audioFileId: string, assets: readonly CandidateAudioAsset[]): Promise<VerifiedAudioAlignment>;
}
export interface CandidateAudioAsset { assetId: string; fileId: string; audioHref: string; bytes: ArrayBuffer }
export interface AlignmentPublication {
  sections: Array<{ id: string; mediaOverlay?: { href: string } | null }>;
  loadText(href: string): Promise<string>;
  loadBlob(href: string): Promise<Blob>;
}
function xml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('The EPUB alignment document is invalid.');
  return doc;
}
function clock(value: string | null): number | null {
  if (!value?.trim()) return null;
  const raw = value.trim().replace(/^npt=/i, '');
  const units = raw.match(/^(\d+(?:\.\d+)?)(ms|s|min|h)$/i);
  if (units) return Number(units[1]) * ({ ms: 0.001, s: 1, min: 60, h: 3600 }[units[2]!.toLowerCase()]!);
  if (!/^\d+(?:\.\d+)?(?::\d+(?:\.\d+)?){0,2}$/.test(raw)) return null;
  return raw.split(':').reduce((result, part) => result * 60 + Number(part), 0);
}
function resolve(href: string, base: string) {
  const url = new URL(href, new URL(base, 'https://epub.invalid/'));
  if (url.origin !== 'https://epub.invalid' || url.search) throw new Error('External EPUB alignment resources are unsupported.');
  return { path: mediaOverlayPath(decodeURIComponent(url.pathname.slice(1))), fragment: url.hash ? decodeURIComponent(url.hash.slice(1)) : null };
}
/** Check server timing against the *same archive bytes* parsed by the open reader. */
export async function verifyPublicationPlaylist(publication: AlignmentPublication, playlist: MediaOverlayPlaylist): Promise<void> {
  let count = 0;
  const documents = new Map<string, Document>();
  for (const [sectionIndex, section] of publication.sections.entries()) {
    if (!section.mediaOverlay) continue;
    const smilHref = section.mediaOverlay.href;
    const doc = xml(await publication.loadText(smilHref));
    const pars = Array.from(doc.getElementsByTagNameNS('*', 'par'));
    for (const par of pars) {
      const children = Array.from(par.children);
      const text = children.find(child => child.localName === 'text');
      const audio = children.find(child => child.localName === 'audio');
      if (!text || !audio) continue;
      const textSrc = text.getAttribute('src'), audioSrc = audio.getAttribute('src');
      if (!textSrc || !audioSrc) throw new Error('A narration passage has no source.');
      const textTarget = resolve(textSrc, smilHref), audioTarget = resolve(audioSrc, smilHref);
      const item = playlist.items[count++];
      const beginValue = audio.getAttribute('clipBegin'), parsedBegin = clock(beginValue);
      if (beginValue !== null && parsedBegin === null) throw new Error('The narration start time is invalid.');
      if (audioTarget.fragment) throw new Error('Audio resource fragments are not supported by exact handoff.');
      const begin = parsedBegin ?? 0, end = clock(audio.getAttribute('clipEnd'));
      if (!item || item.index !== count - 1 || item.sectionIndex !== sectionIndex || item.smilHref !== smilHref || item.textHref !== textTarget.path ||
        item.textFragment !== textTarget.fragment || item.audioHref !== audioTarget.path || item.clipBeginSeconds !== begin || item.clipEndSeconds !== end || end === null ||
        item.durationSeconds !== end - begin) throw new Error('The server narration timing does not match the open EPUB edition.');
      if (section.id !== textTarget.path || !textTarget.fragment) throw new Error('Narration is not bound to this exact EPUB spine passage.');
      if (!documents.has(textTarget.path)) documents.set(textTarget.path, xml(await publication.loadText(textTarget.path)));
      if (!documents.get(textTarget.path)!.getElementById(textTarget.fragment)) throw new Error('The narration passage is absent from the open EPUB.');
    }
  }
  if (count === 0 || count !== playlist.items.length) throw new Error('The server narration playlist does not match the open EPUB.');
}
export async function verifyPublicationAudiobook(source: Blob, publication: AlignmentPublication, binding: Pick<AlignmentEdition, 'accountScope' | 'bookId' | 'textFileId' | 'audioFileId'>,
  playlist: MediaOverlayPlaylist, manifest: AudioManifest, candidates: readonly CandidateAudioAsset[]): Promise<VerifiedAudioAlignment> {
  await verifyPublicationPlaylist(publication, playlist);
  const edition: AlignmentEdition = { ...binding, textSha256: await alignmentSha256(await source.arrayBuffer()), manifestRevision: manifest.revision };
  const verified = [];
  for (const candidate of candidates) {
    if (!playlist.resources.some(resource => resource.href === candidate.audioHref)) throw new Error('This audio resource is not in the EPUB narration playlist.');
    const resource = await publication.loadBlob(candidate.audioHref);
    if (!resource || resource.size > 64 * 1024 * 1024) throw new Error('An available complete narration resource up to 64 MiB is required.');
    verified.push(await verifyAudioResource(edition, { audioHref: candidate.audioHref, assetId: candidate.assetId, audioFileId: candidate.fileId }, await resource.arrayBuffer(), candidate.bytes));
  }
  return createStandaloneAlignment(edition, playlist, manifest, verified);
}
export function alignedPassageAtRange(map: VerifiedAudioAlignment, edition: AlignmentEdition, doc: Document, sectionIndex: number, range: Range): StandaloneAlignedSegment | null {
  assertStandaloneAlignment(map, edition);
  if (range.startContainer.ownerDocument !== doc) return null;
  const candidates = map.segments.filter(segment => segment.sectionIndex === sectionIndex && doc.getElementById(segment.textFragment)?.contains(range.startContainer));
  // Nested/repeated passage markers can be ambiguous. Do not silently pick an edition point.
  if (candidates.length) return candidates.length === 1 ? candidates[0]! : null;
  if (range.collapsed) return null;
  // A displayed page may start with a heading that has no narration. The first actual
  // mapped element within its visible DOM range is a valid source clip; nothing outside
  // that range is inferred. DOM order, not audio timing or percentage, chooses the point.
  const visible = map.segments.filter(segment => segment.sectionIndex === sectionIndex && (() => {
    const element = doc.getElementById(segment.textFragment); return element && range.intersectsNode(element);
  })());
  visible.sort((a, b) => doc.getElementById(a.textFragment)!.compareDocumentPosition(doc.getElementById(b.textFragment)!) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
  if (visible.length > 1 && doc.getElementById(visible[0]!.textFragment)!.contains(doc.getElementById(visible[1]!.textFragment))) return null;
  return visible[0] ?? null;
}
