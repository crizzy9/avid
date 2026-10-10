import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlaybackController } from '../src/controller';
import { alignmentSha256, createStandaloneAlignment, handoffToAudio, handoffToText, verifyAudioResource, ALIGNMENT_DURATION_PRECISION_SECONDS } from '../src/standalone-alignment';
import type { PlaybackBook, AudioElement } from '../src/types';
import type { AudioManifest } from '../../core/src/bookorbit';
import type { MediaOverlayPlaylist } from '../../core/src/media-overlay';
class FixtureAudio extends EventTarget {
  src = ''; currentTime = 0; duration = Number.NaN; playbackRate = 1; preservesPitch = true;
  paused = true; ended = false; error = null; preload = '';
  async play() { this.paused = false; this.dispatchEvent(new Event('playing')); }
  pause = vi.fn(() => { this.paused = true; this.dispatchEvent(new Event('pause')); });
  load() {} removeAttribute() {}
  metadata(duration: number) { this.duration = duration; this.dispatchEvent(new Event('durationchange')); this.dispatchEvent(new Event('loadedmetadata')); }
}
function wavDuration(bytes: Buffer): number {
  let offset = 12;
  while (offset + 8 <= bytes.length) { const size = bytes.readUInt32LE(offset + 4); if (bytes.toString('ascii', offset, offset + 4) === 'data') return size / bytes.readUInt32LE(28); offset += 8 + size + (size % 2); }
  throw new Error('Original WAV fixture has no data.');
}
const controllers: PlaybackController[] = [];
afterEach(() => { controllers.splice(0).forEach(controller => controller.destroy()); });
async function fixture() {
  const names = ['audio1.wav', 'audio2.wav'];
  const original = names.map(name => readFileSync(`packages/readers/fixtures/${name}`));
  const durations = original.map(wavDuration);
  const edition = { accountScope: 'fixture/account', bookId: '12', textFileId: '31', textSha256: await alignmentSha256(new Uint8Array(readFileSync('packages/readers/fixtures/sample-aligned.epub')).buffer), audioFileId: '41', manifestRevision: 'wav-fixture-v1' };
  const manifest: AudioManifest = { schema: 'bookorbit.audiobook-manifest', schemaVersion: 2, revision: edition.manifestRevision, chapters: [], totalDurationMs: durations.reduce((sum, duration) => sum + duration, 0) * 1000,
    assets: names.map((name, index) => ({ assetId: name, fileId: 41 + index, sequence: index, format: 'wav', durationMs: durations[index]! * 1000, sizeBytes: original[index]!.length, etag: 'original' })) };
  const playlist: MediaOverlayPlaylist = { bookId: 12, fileId: 31, durationSeconds: manifest.totalDurationMs / 1000, sections: [],
    resources: names.map((name, index) => ({ href: name, size: original[index]!.length, mediaType: 'audio/wav' })),
    items: names.map((name, index) => ({ index, sectionIndex: 0, smilHref: 'timing.smil', textHref: 'chapter.xhtml', textFragment: `p${index + 1}`, audioHref: name, audioMimeType: 'audio/wav', clipBeginSeconds: 0, clipEndSeconds: durations[index]!, durationSeconds: durations[index]!, label: null })),
  };
  const proofs = await Promise.all(names.map((name, index) => verifyAudioResource(edition, { audioHref: name, assetId: name, audioFileId: String(41 + index) }, new Uint8Array(original[index]!).buffer, new Uint8Array(original[index]!).buffer)));
  const map = createStandaloneAlignment(edition, playlist, manifest, proofs);
  const source: PlaybackBook = { bookId: '12', fileId: '41', title: 'Original aligned WAVs', authors: [], manifestRevision: manifest.revision,
    tracks: names.map((name, index) => ({ id: String(41 + index), url: `/${name}`, duration: durations[index]! })) };
  const audio = new FixtureAudio(); const controller = new PlaybackController({ audio: audio as AudioElement, mediaSession: null }); controllers.push(controller);
  return { audio, controller, source, map, edition, durations };
}
describe('canonical manifest timeline after decoder metadata', () => {
  it('round-trips original EPUB/WAV passages after millisecond-rounded metadata on both tracks', async () => {
    const f = await fixture();
    handoffToAudio(f.map, f.edition, 'chapter.xhtml#p1', f.controller, f.source);
    f.audio.metadata(Math.round(f.durations[0]! * 1000) / 1000);
    await f.controller.play(); f.audio.currentTime = 0.5; f.audio.dispatchEvent(new Event('timeupdate'));
    expect(handoffToText(f.map, f.edition, f.controller)?.locator).toBe('chapter.xhtml#p1');
    const secondPoint = f.map.segments[1]!.start + 0.2;
    f.controller.seek(secondPoint); f.audio.metadata(Math.round(f.durations[1]! * 1000) / 1000);
    expect(f.controller.getBook()!.tracks.map(track => track.duration)).toEqual(f.durations);
    expect(f.controller.getBook()!.tracks.map(track => track.decodedDuration)).toEqual(f.durations.map(duration => Math.round(duration * 1000) / 1000));
    expect(f.controller.getSnapshot().duration).toBe(f.durations[0]! + f.durations[1]!);
    expect(f.controller.getSnapshot().currentTime).toBeCloseTo(secondPoint, 12);
    const checkpoint = JSON.parse(f.controller.checkpoint()!.locator) as { trackTime: number; time: number; trackId: string };
    expect(checkpoint.trackId).toBe('42'); expect(checkpoint.trackTime).toBeCloseTo(0.2, 12); expect(checkpoint.time).toBeCloseTo(secondPoint, 12);
    const text = handoffToText(f.map, f.edition, f.controller)!;
    expect(text.locator).toBe('chapter.xhtml#p2');
    const audioAnchor = handoffToAudio(f.map, f.edition, text.locator, f.controller, f.source)!;
    f.audio.metadata(Math.round(f.durations[1]! * 1000) / 1000);
    expect(JSON.parse(audioAnchor.locator)).toMatchObject({ trackId: '42', trackTime: 0, time: f.durations[0] });
    expect(f.controller.getSnapshot().currentTime).toBe(f.durations[0]);
    expect(handoffToText(f.map, f.edition, f.controller)?.locator).toBe('chapter.xhtml#p2');
  });
  it('does not shift offsets for a material decoder mismatch and refuses exact handoff', async () => {
    const f = await fixture();
    f.controller.load(f.source, 0.5); f.audio.metadata(f.durations[0]! + 0.25); await f.controller.play();
    expect(f.controller.getBook()!.tracks[0]!.duration).toBe(f.durations[0]);
    expect(f.controller.getSnapshot().duration).toBe(f.durations[0]! + f.durations[1]!);
    f.audio.pause.mockClear();
    expect(() => handoffToText(f.map, f.edition, f.controller)).toThrow('decoded audio duration differs');
    expect(f.audio.pause).not.toHaveBeenCalled();
    // A later corrected observation can restore compatibility; it never changes the source timeline.
    f.audio.metadata(f.durations[0]! + ALIGNMENT_DURATION_PRECISION_SECONDS / 2);
    expect(handoffToText(f.map, f.edition, f.controller)?.locator).toBe('chapter.xhtml#p1');
  });
  it('still discovers/refines an originally unknown duration and clears observations on a new load', () => {
    const audio = new FixtureAudio(); const controller = new PlaybackController({ audio: audio as AudioElement, mediaSession: null }); controllers.push(controller);
    const unknown: PlaybackBook = { bookId: 'local', fileId: 'audio', title: 'Local import', authors: [], tracks: [{ id: 'track', url: '/local.mp3' }] };
    controller.load(unknown, 5); audio.metadata(10);
    expect(controller.getSnapshot()).toMatchObject({ duration: 10, currentTime: 5 });
    audio.duration = 12; audio.dispatchEvent(new Event('durationchange'));
    expect(controller.getSnapshot().duration).toBe(12);
    controller.load({ ...unknown, tracks: [{ ...unknown.tracks[0]!, duration: 11, decodedDuration: 99 }] });
    expect(controller.getBook()!.tracks[0]!.decodedDuration).toBeUndefined();
    audio.metadata(12); expect(controller.getSnapshot().duration).toBe(11);
  });
});
