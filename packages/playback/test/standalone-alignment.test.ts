import { describe, expect, it, vi } from 'vitest';
import type { AudioManifest } from '../../core/src/bookorbit';
import type { MediaOverlayPlaylist } from '../../core/src/media-overlay';
import { createStandaloneAlignment, verifyAudioResource, alignedAudioAnchor, alignedTextTarget, handoffToAudio, handoffToText, type AlignmentEdition, type VerifiedAudioResource } from '../src/standalone-alignment';
import type { PlaybackBook, PlaybackSnapshot } from '../src/types';

const edition: AlignmentEdition = { accountScope: 'server/user', bookId: '12', textFileId: '31', textSha256: 'a'.repeat(64), audioFileId: '41', manifestRevision: 'revision-one' };
const bytes = (text: string) => new TextEncoder().encode(text).buffer;
function fixture() {
  const manifest: AudioManifest = { schema: 'bookorbit.audiobook-manifest', schemaVersion: 2, revision: 'revision-one', totalDurationMs: 50_000, chapters: [], assets: [
    { assetId: 'one', fileId: 41, sequence: 0, format: 'wav', durationMs: 20_000, sizeBytes: 3, etag: 'not-a-hash' },
    { assetId: 'two', fileId: 42, sequence: 1, format: 'wav', durationMs: 30_000, sizeBytes: 3, etag: 'not-a-hash' },
  ] };
  const playlist: MediaOverlayPlaylist = { bookId: 12, fileId: 31, durationSeconds: 12, sections: [],
    resources: [{ href: 'audio/one.wav', mediaType: 'audio/wav', size: 3 }, { href: 'audio/two.wav', mediaType: 'audio/wav', size: 3 }],
    items: [
      { index: 0, sectionIndex: 0, smilHref: 'text/timing.smil', textHref: 'text/chapter.xhtml', textFragment: 'p1', audioHref: 'audio/one.wav', audioMimeType: 'audio/wav', clipBeginSeconds: 2, clipEndSeconds: 8, durationSeconds: 6, label: null },
      { index: 1, sectionIndex: 0, smilHref: 'text/timing.smil', textHref: 'text/chapter.xhtml', textFragment: 'p2', audioHref: 'audio/two.wav', audioMimeType: 'audio/wav', clipBeginSeconds: 3, clipEndSeconds: 9, durationSeconds: 6, label: null },
    ],
  };
  return { manifest, playlist };
}
async function verified() {
  return Promise.all(['one', 'two'].map((name, i) => verifyAudioResource(edition, { audioHref: `audio/${name}.wav`, assetId: name, audioFileId: String(41 + i) }, bytes(name), bytes(name))));
}
async function map() { const f = fixture(); return createStandaloneAlignment(edition, f.playlist, f.manifest, await verified()); }
const source: PlaybackBook = { bookId: '12', fileId: '41', title: 'Unimportant title', authors: [], manifestRevision: edition.manifestRevision, tracks: [{ id: '41', url: '/one', duration: 20 }, { id: '42', url: '/two', duration: 30 }] };
describe('exact standalone audiobook bridge', () => {
  it('uses source clips and complete-track offsets, never compressed overlay duration or playback speed', async () => {
    const alignment = await map();
    expect(alignment.segments.map(segment => [segment.start, segment.end])).toEqual([[2, 8], [23, 29]]);
    const anchor = alignedAudioAnchor(alignment, edition, 'text/chapter.xhtml#p2')!;
    expect(JSON.parse(anchor.locator)).toEqual({ version: 1, trackId: '42', trackTime: 3, time: 23, manifestRevision: 'revision-one' });
    expect(anchor.progress).toBe(23 / 50);
    expect(alignedTextTarget(alignment, edition, 23)?.locator).toBe('text/chapter.xhtml#p2');
  });
  it('keeps half-open ranges and unaligned silence/intro/end gaps unmapped', async () => {
    const alignment = await map();
    for (const seconds of [-1, 0, 8, 20, 22.999, 29, 50, Number.NaN]) expect(alignedTextTarget(alignment, edition, seconds)).toBeNull();
    expect(alignedTextTarget(alignment, edition, 2)?.segmentId).toBe('0');
    expect(alignedTextTarget(alignment, edition, 28.999)?.segmentId).toBe('1');
    expect(alignedAudioAnchor(alignment, edition, 'epubcfi(/6/2!/4/2/1:0)')).toBeNull();
  });
  it('rejects equal-length but different audio and forged/persisted proof objects', async () => {
    await expect(verifyAudioResource(edition, { audioHref: 'audio/one.wav', assetId: 'one', audioFileId: '41' }, bytes('one'), bytes('NEW'))).rejects.toThrow('different audio bytes');
    const f = fixture(), proof = await verified();
    expect(() => createStandaloneAlignment(edition, f.playlist, f.manifest, JSON.parse(JSON.stringify(proof)) as VerifiedAudioResource[])).toThrow('Fresh full-byte');
    const alignment = await map();
    expect(() => alignedTextTarget(structuredClone(alignment), edition, 3)).toThrow('Fresh verified');
  });
  it.each(['accountScope', 'bookId', 'textFileId', 'textSha256', 'audioFileId', 'manifestRevision'] as const)('rejects another %s before any handoff', async key => {
    const alignment = await map();
    expect(() => alignedAudioAnchor(alignment, { ...edition, [key]: key === 'textSha256' ? 'b'.repeat(64) : 'other' }, 'text/chapter.xhtml#p1')).toThrow('different account or source edition');
  });
  it.each(['unknown-duration', 'missing-proof', 'wrong-size', 'wrong-revision', 'wrong-file', 'past-end', 'overlap', 'repeated-text', 'bad-total', 'duplicate-track'])( 'rejects %s metadata instead of enabling estimated linking', async defect => {
    const f = fixture(), proofs = await verified();
    if (defect === 'unknown-duration') f.playlist.items[0]!.clipEndSeconds = null;
    if (defect === 'missing-proof') proofs.pop();
    if (defect === 'wrong-size') f.manifest.assets[0]!.sizeBytes = 4;
    if (defect === 'wrong-revision') f.manifest.revision = 'new';
    if (defect === 'wrong-file') f.playlist.fileId = 99;
    if (defect === 'past-end') { f.playlist.items[0]!.clipEndSeconds = 21; f.playlist.items[0]!.durationSeconds = 19; }
    if (defect === 'overlap') { f.playlist.items[1]!.audioHref = 'audio/one.wav'; }
    if (defect === 'repeated-text') f.playlist.items[1]!.textFragment = 'p1';
    if (defect === 'bad-total') f.manifest.totalDurationMs = 55_000;
    if (defect === 'duplicate-track') f.manifest.assets[1]!.fileId = 41;
    expect(() => createStandaloneAlignment(edition, f.playlist, f.manifest, proofs)).toThrow();
  });
  it('validates the source before pausing, then hands off to exact track time without autoplay', async () => {
    const alignment = await map();
    const transport = { getBook: () => source, getSnapshot: () => ({}) as PlaybackSnapshot, pause: vi.fn(), load: vi.fn() };
    expect(() => handoffToAudio(alignment, edition, 'text/chapter.xhtml#p2', transport, { ...source, manifestRevision: 'changed' })).toThrow('active player source');
    expect(transport.pause).not.toHaveBeenCalled();
    handoffToAudio(alignment, edition, 'text/chapter.xhtml#p2', transport, source);
    expect(transport.pause).toHaveBeenCalledOnce(); expect(transport.load).toHaveBeenCalledWith(source, 23);
  });
  it('keeps authored SMIL timing strict even when its duration is a whole second', async () => {
    const alignment = await map();
    const rounded = { ...source, tracks: source.tracks.map(track => ({ ...track, decodedDuration: track.duration! - 0.14 })) };
    const transport = { getBook: () => rounded, getSnapshot: () => ({}) as PlaybackSnapshot, pause: vi.fn(), load: vi.fn() };
    expect(() => handoffToAudio(alignment, edition, 'text/chapter.xhtml#p1', transport, rounded)).toThrow('decoded audio duration');
    expect(transport.pause).not.toHaveBeenCalled();
  });
  it('uses the final paused source time for text handoff and does not stop for unaligned gaps', async () => {
    const alignment = await map(); let time = 24;
    const transport = { getBook: () => source, getSnapshot: () => ({ bookId: '12', fileId: '41', currentTime: time, trackIndex: 1, rate: 2 }) as PlaybackSnapshot,
      pause: vi.fn(() => { time = 25; }), load: vi.fn() };
    expect(handoffToText(alignment, edition, transport)?.locator).toBe('text/chapter.xhtml#p2');
    expect(transport.pause).toHaveBeenCalledOnce();
    time = 30; transport.pause.mockClear();
    expect(handoffToText(alignment, edition, transport)).toBeNull(); expect(transport.pause).not.toHaveBeenCalled();
  });
});
