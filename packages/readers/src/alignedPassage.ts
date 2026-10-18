import {
  assertStandaloneAlignment,
  alignmentSha256,
  createStandaloneAlignment,
  createGeneratedAlignment,
  verifyAudioResource,
  type AlignmentEdition,
  type VerifiedAudioAlignment,
  type StandaloneAlignedSegment,
} from "../../playback/src/standalone-alignment";
import type { MediaOverlayPlaylist } from "../../core/src/media-overlay";
import { mediaOverlayPath } from "../../core/src/media-overlay";
import type { AudioManifest } from "../../core/src/bookorbit";
import { passageText } from "../../core/src/readAlongText";
import { validateGeneratedAlignment, type ExtractedPublicationText, type GeneratedAlignmentSnapshot } from '../../playback/src/generated-alignment';
import { passageElement } from './generatedText';
import { sha256Blob } from '../../core/src/blobHash';
export { passageText } from "../../core/src/readAlongText";

export interface ReaderAlignmentHandle {
  /** Ordinary EPUB text with exact source CFIs; no embedded narration is required. */
  extractAlignmentText?(): Promise<ExtractedPublicationText>;
  /** Rehash actual media and bind generated timing to the freshly parsed source publication. */
  restorePreparedAlignment?(
    snapshot: GeneratedAlignmentSnapshot,
    manifest: AudioManifest,
    assets: readonly PreparedAudioAsset[],
  ): Promise<VerifiedAudioAlignment>;
  /** Stop embedded narration and speech before switching to another playback owner. */
  pauseNarration(): void;
  /** Resolve the actual DOM point, never estimate the nearest passage from reading percentage. */
  currentPassage(
    map: VerifiedAudioAlignment,
    edition: AlignmentEdition,
  ): Promise<StandaloneAlignedSegment | null>;
  /** Resolve a captured checkpoint independently of later viewport movement. */
  passageAtLocator?(
    map: VerifiedAudioAlignment,
    edition: AlignmentEdition,
    locator: string,
  ): Promise<StandaloneAlignedSegment | null>;
  /** Verify user-selected, already available assets against the currently parsed EPUB. */
  verifyAudiobook(
    playlist: MediaOverlayPlaylist,
    manifest: AudioManifest,
    audioFileId: string,
    assets: readonly CandidateAudioAsset[],
  ): Promise<VerifiedAudioAlignment>;
  /** Exact source passages only. Plain text is safe to render as text, never as HTML. */
  getTimedText?(
    map: VerifiedAudioAlignment,
    edition: AlignmentEdition,
  ): Promise<readonly AlignedPassageText[]>;
  /** The unscaled source clock works while paused and after backward seeks. Gaps clear the highlight. */
  followAudio?(
    map: VerifiedAudioAlignment,
    edition: AlignmentEdition,
    sourceSeconds: number,
    options: { follow: boolean },
  ): Promise<AlignedPassageText | null>;
  clearAudioHighlight?(): void;
}
export interface PreparedAudioAsset { assetId: string; fileId: string; blob: Blob }
/** Current EPUB extraction plus streamed full-byte audio proof; no model execution on reopen. */
export async function verifyPreparedPublication(
  input: GeneratedAlignmentSnapshot,
  manifestInput: AudioManifest,
  assetInput: readonly PreparedAudioAsset[],
  publication: ExtractedPublicationText,
  binding: Pick<AlignmentEdition,'accountScope'|'bookId'|'textFileId'>,
  isActive:()=>boolean = ()=>true,
):Promise<VerifiedAudioAlignment> {
  validateGeneratedAlignment(input);
  const snapshot=structuredClone(input), manifest=structuredClone(manifestInput), assets=assetInput.map(asset=>({...asset}));
  const edition=snapshot.edition;
  if (!isActive() || edition.accountScope!==binding.accountScope || edition.bookId!==binding.bookId || edition.textFileId!==binding.textFileId ||
    manifest.schema!=='bookorbit.audiobook-manifest' || manifest.schemaVersion!==2 || manifest.revision!==edition.manifestRevision)
    throw new Error('The prepared sources belong to a different account or edition.');
  const ordered=[...manifest.assets].sort((a,b)=>a.sequence-b.sequence);
  if (assets.length!==snapshot.tracks.length || ordered.length!==assets.length ||
    new Set(assets.map(asset=>asset.assetId)).size!==assets.length || new Set(ordered.map(asset=>asset.sequence)).size!==ordered.length)
    throw new Error('Complete, unique prepared audio sources are required.');
  const actual=[];
  for (const [index,expected] of snapshot.tracks.entries()) {
    const item=ordered[index]!,asset=assets.find(value=>value.assetId===expected.assetId && value.fileId===expected.fileId);
    if (!asset || item.assetId!==expected.assetId || String(item.fileId)!==expected.fileId || item.sizeBytes!==expected.sizeBytes ||
      !Number.isSafeInteger(item.sequence) || item.sequence<0 || item.durationMs===null || item.durationMs/1000!==expected.duration ||
      asset.blob.size!==expected.sizeBytes) throw new Error('The prepared audiobook manifest or source bytes changed.');
    actual.push({...expected,sha256:await sha256Blob(asset.blob,{isActive})});
  }
  if (!Number.isFinite(manifest.totalDurationMs) || Math.abs(ordered.reduce((sum,asset)=>sum+(asset.durationMs??0),0)-manifest.totalDurationMs)>0.001)
    throw new Error('The prepared audiobook duration does not match its source tracks.');
  if (!isActive()) throw new Error('The reader closed during prepared source verification.');
  return createGeneratedAlignment(snapshot,publication,actual);
}
export interface AlignedPassageText {
  readonly segmentId: string;
  readonly text: string;
  readonly textLocator: string;
  readonly sectionIndex: number;
  readonly start: number;
  readonly end: number;
  readonly trackId: string;
  readonly trackTime: number;
}
export interface CandidateAudioAsset {
  assetId: string;
  fileId: string;
  audioHref: string;
  bytes: ArrayBuffer;
}
export interface AlignmentPublication {
  sections: Array<{ id: string; mediaOverlay?: { href: string } | null; createDocument?: () => Promise<Document> }>;
  loadText(href: string): Promise<string>;
  loadBlob(href: string): Promise<Blob>;
}
export interface PassageLocatorResolver {
  resolve(
    locator: string,
  ): {
    index: number;
    anchor?: (doc: Document) => Element | Range | null;
  } | null;
  document(index: number): Promise<Document | null>;
}
/** Resolves only a supplied exact CFI/fragment; chapter-only and percentage targets remain unmapped. */
export async function passageAtLocator(
  map: VerifiedAudioAlignment,
  edition: AlignmentEdition,
  locator: string,
  resolver: PassageLocatorResolver,
): Promise<StandaloneAlignedSegment | null> {
  assertStandaloneAlignment(map, edition);
  if (!locator.startsWith("epubcfi(") && !locator.includes("#")) return null;
  const resolved = resolver.resolve(locator);
  if (
    !resolved ||
    !Number.isSafeInteger(resolved.index) ||
    resolved.index < 0 ||
    typeof resolved.anchor !== "function"
  )
    return null;
  const doc = await resolver.document(resolved.index);
  if (!doc) return null;
  const target = resolved.anchor(doc);
  if (!target) return null;
  const range = "startContainer" in target ? target : doc.createRange();
  if (!("startContainer" in target)) range.selectNodeContents(target);
  return alignedPassageAtRange(map, edition, doc, resolved.index, range);
}
function xml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror"))
    throw new Error("The EPUB alignment document is invalid.");
  return doc;
}
const fragmentIndices = new WeakMap<Document, Map<string, Element | null>>();
function uniqueFragment(doc: Document, id: string): Element | null {
  let index = fragmentIndices.get(doc);
  if (!index) {
    index = new Map();
    for (const element of doc.querySelectorAll("[id]")) {
      const key = element.getAttribute("id")!;
      index.set(key, index.has(key) ? null : element);
    }
    fragmentIndices.set(doc, index);
  }
  return index.get(id) ?? null;
}
function clock(value: string | null): number | null {
  if (!value?.trim()) return null;
  const raw = value.trim().replace(/^npt=/i, "");
  const units = raw.match(/^(\d+(?:\.\d+)?)(ms|s|min|h)$/i);
  if (units)
    return (
      Number(units[1]) *
      { ms: 0.001, s: 1, min: 60, h: 3600 }[units[2]!.toLowerCase()]!
    );
  if (!/^\d+(?:\.\d+)?(?::\d+(?:\.\d+)?){0,2}$/.test(raw)) return null;
  return raw.split(":").reduce((result, part) => result * 60 + Number(part), 0);
}
function resolve(href: string, base: string) {
  const url = new URL(href, new URL(base, "https://epub.invalid/"));
  if (url.origin !== "https://epub.invalid" || url.search)
    throw new Error("External EPUB alignment resources are unsupported.");
  return {
    path: mediaOverlayPath(decodeURIComponent(url.pathname.slice(1))),
    fragment: url.hash ? decodeURIComponent(url.hash.slice(1)) : null,
  };
}
/** The caller must bind publication to its actual parsed Blob, as EbookView does before every use. */
export async function readPublicationTimedText(
  publication: AlignmentPublication,
  map: VerifiedAudioAlignment,
  edition: AlignmentEdition,
): Promise<readonly AlignedPassageText[]> {
  assertStandaloneAlignment(map, edition);
  const documents = new Map<string, Document>();
  const lines: AlignedPassageText[] = [];
  for (const segment of map.segments) {
    if (publication.sections[segment.sectionIndex]?.id !== segment.textHref)
      throw new Error(
        "The timed passage does not belong to this EPUB section.",
      );
    let doc = documents.get(segment.textHref);
    if (!doc) {
      doc = segment.textElementPath && publication.sections[segment.sectionIndex]?.createDocument
        ? await publication.sections[segment.sectionIndex]!.createDocument!()
        : xml(await publication.loadText(segment.textHref));
      documents.set(segment.textHref, doc);
    }
    const element = segment.textElementPath ? passageElement(doc,segment) : uniqueFragment(doc, segment.textFragment);
    if (!element)
      throw new Error(
        "The timed passage is missing or ambiguous in this EPUB.",
      );
    const text = passageText(element);
    if (!text) continue;
    lines.push(
      Object.freeze({
        segmentId: segment.id,
        text,
        textLocator: segment.textLocator,
        sectionIndex: segment.sectionIndex,
        start: segment.start,
        end: segment.end,
        trackId: segment.trackId,
        trackTime: segment.trackTime,
      }),
    );
  }
  return Object.freeze(lines);
}
/** Check server timing against the *same archive bytes* parsed by the open reader. */
export async function verifyPublicationPlaylist(
  publication: AlignmentPublication,
  playlist: MediaOverlayPlaylist,
): Promise<void> {
  let count = 0;
  const documents = new Map<string, Document>();
  for (const [sectionIndex, section] of publication.sections.entries()) {
    if (!section.mediaOverlay) continue;
    const smilHref = section.mediaOverlay.href;
    const doc = xml(await publication.loadText(smilHref));
    const pars = Array.from(doc.getElementsByTagNameNS("*", "par"));
    for (const par of pars) {
      const children = Array.from(par.children);
      const text = children.find((child) => child.localName === "text");
      const audio = children.find((child) => child.localName === "audio");
      if (!text || !audio) continue;
      const textSrc = text.getAttribute("src"),
        audioSrc = audio.getAttribute("src");
      if (!textSrc || !audioSrc)
        throw new Error("A narration passage has no source.");
      const textTarget = resolve(textSrc, smilHref),
        audioTarget = resolve(audioSrc, smilHref);
      const item = playlist.items[count++];
      const beginValue = audio.getAttribute("clipBegin"),
        parsedBegin = clock(beginValue);
      if (beginValue !== null && parsedBegin === null)
        throw new Error("The narration start time is invalid.");
      if (audioTarget.fragment)
        throw new Error(
          "Audio resource fragments are not supported by exact handoff.",
        );
      const begin = parsedBegin ?? 0,
        end = clock(audio.getAttribute("clipEnd"));
      if (
        !item ||
        item.index !== count - 1 ||
        item.sectionIndex !== sectionIndex ||
        item.smilHref !== smilHref ||
        item.textHref !== textTarget.path ||
        item.textFragment !== textTarget.fragment ||
        item.audioHref !== audioTarget.path ||
        item.clipBeginSeconds !== begin ||
        item.clipEndSeconds !== end ||
        end === null ||
        item.durationSeconds !== end - begin
      )
        throw new Error(
          "The server narration timing does not match the open EPUB edition.",
        );
      if (section.id !== textTarget.path || !textTarget.fragment)
        throw new Error(
          "Narration is not bound to this exact EPUB spine passage.",
        );
      if (!documents.has(textTarget.path))
        documents.set(
          textTarget.path,
          xml(await publication.loadText(textTarget.path)),
        );
      if (!uniqueFragment(documents.get(textTarget.path)!, textTarget.fragment))
        throw new Error(
          "The narration passage is absent or ambiguous in the open EPUB.",
        );
    }
  }
  if (count === 0 || count !== playlist.items.length)
    throw new Error(
      "The server narration playlist does not match the open EPUB.",
    );
}
export async function verifyPublicationAudiobook(
  source: Blob,
  publication: AlignmentPublication,
  binding: Pick<
    AlignmentEdition,
    "accountScope" | "bookId" | "textFileId" | "audioFileId"
  >,
  playlist: MediaOverlayPlaylist,
  manifest: AudioManifest,
  candidates: readonly CandidateAudioAsset[],
): Promise<VerifiedAudioAlignment> {
  await verifyPublicationPlaylist(publication, playlist);
  const edition: AlignmentEdition = {
    ...binding,
    textSha256: await alignmentSha256(await source.arrayBuffer()),
    manifestRevision: manifest.revision,
  };
  const verified = [];
  for (const candidate of candidates) {
    if (
      !playlist.resources.some(
        (resource) => resource.href === candidate.audioHref,
      )
    )
      throw new Error(
        "This audio resource is not in the EPUB narration playlist.",
      );
    const resource = await publication.loadBlob(candidate.audioHref);
    if (!resource || resource.size > 64 * 1024 * 1024)
      throw new Error(
        "An available complete narration resource up to 64 MiB is required.",
      );
    verified.push(
      await verifyAudioResource(
        edition,
        {
          audioHref: candidate.audioHref,
          assetId: candidate.assetId,
          audioFileId: candidate.fileId,
        },
        await resource.arrayBuffer(),
        candidate.bytes,
      ),
    );
  }
  return createStandaloneAlignment(edition, playlist, manifest, verified);
}
export function alignedPassageAtRange(
  map: VerifiedAudioAlignment,
  edition: AlignmentEdition,
  doc: Document,
  sectionIndex: number,
  range: Range,
): StandaloneAlignedSegment | null {
  assertStandaloneAlignment(map, edition);
  if (range.startContainer.ownerDocument !== doc) return null;
  const candidates = map.segments.filter(
    (segment) =>
      segment.sectionIndex === sectionIndex &&
      passageElement(doc, segment)?.contains(range.startContainer),
  );
  // Nested/repeated passage markers can be ambiguous. Do not silently pick an edition point.
  if (candidates.length) return candidates.length === 1 ? candidates[0]! : null;
  if (range.collapsed) return null;
  // A displayed page may start with a heading that has no narration. The first actual
  // mapped element within its visible DOM range is a valid source clip; nothing outside
  // that range is inferred. DOM order, not audio timing or percentage, chooses the point.
  const visible = map.segments.filter(
    (segment) =>
      segment.sectionIndex === sectionIndex &&
      (() => {
        const element = passageElement(doc, segment);
        return element && range.intersectsNode(element);
      })(),
  );
  visible.sort((a, b) =>
    passageElement(doc,a)!
      .compareDocumentPosition(passageElement(doc,b)!) &
    Node.DOCUMENT_POSITION_FOLLOWING
      ? -1
      : 1,
  );
  if (
    visible.length > 1 &&
    passageElement(doc,visible[0]!)!
      .contains(passageElement(doc,visible[1]!))
  )
    return null;
  return visible[0] ?? null;
}
