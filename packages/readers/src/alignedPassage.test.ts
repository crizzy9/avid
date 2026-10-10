// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { Blob as NodeBlob } from 'node:buffer';
import { webcrypto } from 'node:crypto';
import { unzipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EPUB } from '../vendor/foliate/epub.js';
import { alignedPassageAtRange, verifyPublicationAudiobook, verifyPublicationPlaylist } from './alignedPassage';
import { alignedAudioAnchor, alignedTextTarget } from '../../playback/src/standalone-alignment';
import type { MediaOverlayPlaylist } from '../../core/src/media-overlay';
import type { AudioManifest } from '../../core/src/bookorbit';
const epubBytes = new Uint8Array(readFileSync('packages/readers/fixtures/sample-aligned.epub'));
const entries = unzipSync(epubBytes);
const source = new NodeBlob([epubBytes]) as unknown as Blob;
const originalText = (name: string) => new TextDecoder().decode(entries[name]);
function duration(bytes: Uint8Array): number {
  const data = Buffer.from(bytes); let offset = 12;
  while (offset + 8 < data.length) { const size = data.readUInt32LE(offset + 4); if (data.toString('ascii', offset, offset + 4) === 'data') return size / data.readUInt32LE(28); offset += 8 + size + (size % 2); }
  throw new Error('Missing WAV data');
}
async function fixture() {
  const names = ['audio1.wav', 'audio2.wav']; const durations = names.map(name => duration(entries[name]!));
  const publication = await new EPUB({ loadText: async (name: string) => originalText(name), loadBlob: async (name: string) => new NodeBlob([new Uint8Array(entries[name]!)]), getSize: (name: string) => entries[name]?.length ?? 0 }).init();
  const playlist: MediaOverlayPlaylist = { bookId: 12, fileId: 31, durationSeconds: durations[0]! + durations[1]!, sections: [],
    resources: names.map(name => ({ href: name, size: entries[name]!.length, mediaType: 'audio/wav' })),
    items: names.map((name, index) => ({ index, sectionIndex: 0, smilHref: 'timing.smil', textHref: 'chapter.xhtml', textFragment: `p${index + 1}`, audioHref: name, audioMimeType: 'audio/wav', clipBeginSeconds: 0, clipEndSeconds: durations[index]!, durationSeconds: durations[index]!, label: null })),
  };
  const manifest: AudioManifest = { schema: 'bookorbit.audiobook-manifest', schemaVersion: 2, revision: 'fixture-v1', chapters: [], totalDurationMs: playlist.durationSeconds! * 1000,
    assets: names.map((name, index) => ({ assetId: name, fileId: 41 + index, sequence: index, format: 'wav', durationMs: durations[index]! * 1000, sizeBytes: entries[name]!.length, etag: 'fixture' })) };
  const candidates = names.map((name, index) => ({ audioHref: name, assetId: name, fileId: String(41 + index), bytes: new Uint8Array(entries[name]!).buffer }));
  return { publication, playlist, manifest, candidates };
}
const binding = { accountScope: 'server/user', bookId: '12', textFileId: '31', audioFileId: '41' };
beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => vi.unstubAllGlobals());
describe('open EPUB edition verification and DOM handoff', () => {
  it('verifies the original EPUB/WAV fixture and resolves both directions at the second real passage', async () => {
    const f = await fixture();
    const map = await verifyPublicationAudiobook(source, f.publication, binding, f.playlist, f.manifest, f.candidates);
    const doc = new DOMParser().parseFromString(originalText('chapter.xhtml'), 'application/xhtml+xml');
    const range = doc.createRange(); range.setStart(doc.getElementById('p2')!.firstChild!, 8); range.collapse(true);
    const passage = alignedPassageAtRange(map, map.edition, doc, 0, range)!;
    expect(passage.textFragment).toBe('p2');
    const anchor = alignedAudioAnchor(map, map.edition, passage.textLocator)!;
    const locator = JSON.parse(anchor.locator) as { trackId: string; time: number; trackTime: number };
    expect(locator.trackId).toBe('42'); expect(locator.trackTime).toBe(0);
    expect(locator.time).toBeCloseTo(duration(entries['audio1.wav']!));
    expect(alignedTextTarget(map, map.edition, locator.time + 0.1)?.locator).toBe('chapter.xhtml#p2');
    range.selectNodeContents(doc.querySelector('body')!);
    expect(alignedPassageAtRange(map, map.edition, doc, 0, range)?.textFragment).toBe('p1');
    f.publication.destroy();
  });
  it.each(['changed-clock', 'wrong-section', 'wrong-fragment', 'missing-passage', 'changed-smil'] as const)('rejects %s before binding a standalone source', async defect => {
    const f = await fixture();
    if (defect === 'changed-clock') f.playlist.items[0]!.clipEndSeconds = 1;
    if (defect === 'wrong-section') f.playlist.items[0]!.sectionIndex = 1;
    if (defect === 'wrong-fragment') f.playlist.items[0]!.textFragment = 'absent';
    if (defect === 'missing-passage') f.playlist.items.pop();
    if (defect === 'changed-smil') f.publication.loadText = async (name: string) => originalText(name).replace('id="p2"', 'id="changed"');
    await expect(verifyPublicationPlaylist(f.publication, f.playlist)).rejects.toThrow();
    f.publication.destroy();
  });
  it('does not infer a mapped passage from chapter, percentage or a different DOM document', async () => {
    const f = await fixture();
    const map = await verifyPublicationAudiobook(source, f.publication, binding, f.playlist, f.manifest, f.candidates);
    const doc = new DOMParser().parseFromString(originalText('chapter.xhtml'), 'application/xhtml+xml');
    const range = doc.createRange(); range.selectNodeContents(doc.querySelector('h1')!); range.collapse(true);
    expect(alignedPassageAtRange(map, map.edition, doc, 0, range)).toBeNull();
    range.selectNodeContents(doc.getElementById('p1')!); range.collapse(true);
    expect(alignedPassageAtRange(map, map.edition, doc, 1, range)).toBeNull();
    expect(alignedPassageAtRange(map, map.edition, document, 0, range)).toBeNull();
    f.publication.destroy();
  });
});
