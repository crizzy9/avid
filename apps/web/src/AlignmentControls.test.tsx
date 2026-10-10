// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Blob as NodeBlob } from 'node:buffer';
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AlignmentControls, type AlignmentControlsProps } from './AlignmentControls';
import { BookOrbitClient, type AudioManifest } from '../../../packages/core/src/bookorbit';
import { accountScope } from '../../../packages/core/src/repository';
import type { MediaOverlayPlaylist } from '../../../packages/core/src/media-overlay';
import type { Book } from '../../../packages/core/src/types';
import { createStandaloneAlignment, verifyAudioResource } from '../../../packages/playback/src/standalone-alignment';
import { LOCALES, setLocale } from '../../../packages/i18n/src';
import { alignmentMessages, alignmentTranslate, type AlignmentMessageKey } from './alignmentMessages';

const book: Book = { id: '12', title: 'Original fixture', authors: [], description: '', format: 'EPUB', color: '', progress: 0, status: 'unread', genres: [], addedAt: '', files: [{ id: '31', name: 'book.epub', format: 'EPUB' }, { id: '41', name: 'narration.wav', format: 'AUDIO' }] };
const manifest: AudioManifest = { schema: 'bookorbit.audiobook-manifest', schemaVersion: 2, revision: 'one', chapters: [], totalDurationMs: 10_000,
  assets: [{ assetId: 'audio-one', fileId: 41, sequence: 0, format: 'wav', durationMs: 10_000, sizeBytes: 3, etag: 'one' }] };
const playlist: MediaOverlayPlaylist = { bookId: 12, fileId: 31, durationSeconds: 5, sections: [], resources: [{ href: 'narration.wav', mediaType: 'audio/wav', size: 3 }], items: [
  { index: 0, sectionIndex: 0, smilHref: 'timing.smil', textHref: 'chapter.xhtml', textFragment: 'p1', audioHref: 'narration.wav', audioMimeType: 'audio/wav', clipBeginSeconds: 2, clipEndSeconds: 7, durationSeconds: 5, label: null },
] };
const bytes = new TextEncoder().encode('abc').buffer;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
let root: Root | null, element: HTMLDivElement;
beforeEach(() => { setLocale('en'); vi.stubGlobal('crypto', webcrypto); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); element = document.createElement('div'); document.body.append(element); root = createRoot(element); });
afterEach(async () => { if (root) await act(async () => root?.unmount()); root = null; setLocale('en'); document.body.replaceChildren(); vi.unstubAllGlobals(); });
async function fixture() {
  const session = { profile: { id: 'server', url: 'https://books.test', name: 'Books' }, userId: '7', accessToken: 'offline' };
  const client = new BookOrbitClient(session, { readOnly: true, fetch: vi.fn() });
  const getPlaylist = vi.spyOn(client, 'getMediaOverlayPlaylist').mockResolvedValue(structuredClone(playlist));
  const getManifest = vi.spyOn(client, 'getAudioManifest').mockResolvedValue(structuredClone(manifest));
  const getBlob = vi.spyOn(client, 'getAudioAssetBlob').mockResolvedValue(new NodeBlob([bytes]) as unknown as Blob);
  const edition = { accountScope: accountScope(session), bookId: '12', textFileId: '31', textSha256: 'a'.repeat(64), audioFileId: '41', manifestRevision: 'one' };
  const proof = await verifyAudioResource(edition, { audioHref: 'narration.wav', audioFileId: '41', assetId: 'audio-one' }, bytes, bytes);
  const map = createStandaloneAlignment(edition, playlist, manifest, [proof]);
  const handle = { verifyAudiobook: vi.fn().mockResolvedValue(map), currentPassage: vi.fn(), pauseNarration: vi.fn() };
  const props: AlignmentControlsProps = { client, book, fileId: '31', handle, alignment: null, onVerified: vi.fn(), onListen: vi.fn() };
  await render(props);
  return { props, client, handle, map, getPlaylist, getManifest, getBlob };
}
async function render(props: AlignmentControlsProps) { await act(async () => root!.render(<AlignmentControls {...props} />)); }
const button = (name: string) => [...element.querySelectorAll('button')].find(item => item.textContent === name)!;
async function click(name: string) { await act(async () => button(name).click()); }
async function choose(asset = 'audio-one', index = 0) {
  const select = element.querySelectorAll('select')[index]!;
  await act(async () => { select.value = asset; select.dispatchEvent(new Event('change', { bubbles: true })); });
}
describe('explicit standalone alignment controls', () => {
  it('provides all labels and matching placeholders in seven locales', () => {
    for (const [key, values] of Object.entries(alignmentMessages)) {
      expect(values, key).toHaveLength(7);
      const placeholders = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
      values.forEach(value => { expect(value.length).toBeGreaterThan(0); expect(placeholders(value)).toEqual(placeholders(values[0])); });
      for (const { code } of LOCALES) expect(alignmentTranslate(key as AlignmentMessageKey, { href: 'Original.wav', id: '41' }, code)).not.toMatch(/\{\w+\}/);
    }
  });
  it('updates visible pairing controls and errors in every locale without restarting requests', async () => {
    const f = await fixture(); await click('Link audiobook');
    for (const { code } of LOCALES) {
      await act(async () => setLocale(code));
      expect(element.querySelector('section')?.getAttribute('aria-label')).toBe(alignmentTranslate('region', {}, code));
      expect(element.textContent).toContain(alignmentTranslate('explanation', {}, code));
      expect(element.querySelector('label')?.textContent).toContain(alignmentTranslate('assetFor', { href: 'narration.wav' }, code));
      expect(element.querySelector('select option')?.textContent).toBe(alignmentTranslate('choose', {}, code));
      expect(button(alignmentTranslate('verify', {}, code))).toBeDefined();
    }
    expect(f.getPlaylist).toHaveBeenCalledOnce(); expect(f.getManifest).toHaveBeenCalledOnce();
    await act(async () => setLocale('en')); f.getManifest.mockResolvedValue({ ...manifest, revision: 'changed' });
    await choose(); await click('Verify selected audio');
    for (const { code } of LOCALES) {
      await act(async () => setLocale(code));
      expect(element.querySelector('[role="alert"]')?.textContent).toBe(alignmentTranslate('editionChanged', {}, code));
    }
  });
  it('does no network work on mount and never guesses an asset pairing', async () => {
    const f = await fixture();
    expect(f.getPlaylist).not.toHaveBeenCalled(); expect(f.getManifest).not.toHaveBeenCalled(); expect(f.getBlob).not.toHaveBeenCalled();
    await click('Link audiobook');
    expect(f.getPlaylist).toHaveBeenCalledWith('12', '31'); expect(f.getManifest).toHaveBeenCalledWith('12');
    expect(element.querySelector('select')?.value).toBe(''); expect(button('Verify selected audio').disabled).toBe(true);
    expect(element.textContent).toContain('64 MiB per asset and 128 MiB total');
    await click('Cancel linking'); expect(element.querySelector('select')).toBeNull(); expect(f.getBlob).not.toHaveBeenCalled();
  });
  it('downloads only after explicit mapping/verification and rechecks the manifest before enabling handoff', async () => {
    const f = await fixture(); await click('Link audiobook'); await choose();
    expect(f.getBlob).not.toHaveBeenCalled(); await click('Verify selected audio');
    expect(f.getBlob).toHaveBeenCalledWith('12', 'audio-one', expect.objectContaining({ maxBytes: 64 * 1024 * 1024, signal: expect.any(AbortSignal) }));
    expect(f.getManifest).toHaveBeenCalledTimes(2);
    expect(f.handle.verifyAudiobook).toHaveBeenCalledWith(playlist, manifest, '41', [{ assetId: 'audio-one', fileId: '41', audioHref: 'narration.wav', bytes }]);
    expect(f.props.onVerified).toHaveBeenCalledWith(f.map);
    await render({ ...f.props, alignment: f.map }); await click('Listen from here');
    expect(f.props.onListen).toHaveBeenCalledWith(f.map, f.handle);
  });
  it('rejects a changed revision after download without calling the reader verifier or enabling linking', async () => {
    const f = await fixture(); f.getManifest.mockResolvedValueOnce(manifest).mockResolvedValueOnce({ ...manifest, revision: 'changed' });
    await click('Link audiobook'); await choose(); await click('Verify selected audio');
    expect(element.querySelector('[role="alert"]')?.textContent).toContain('edition changed');
    expect(f.handle.verifyAudiobook).not.toHaveBeenCalled(); expect(f.props.onVerified).not.toHaveBeenCalled();
  });
  it('cancels a pending verification and discards a late download response', async () => {
    const f = await fixture(), download = deferred<Blob>(); f.getBlob.mockReturnValue(download.promise);
    await click('Link audiobook'); await choose(); await click('Verify selected audio');
    const signal = f.getBlob.mock.calls[0]![2]!.signal!;
    await click('Cancel linking'); expect(signal.aborted).toBe(true);
    await act(async () => download.resolve(new NodeBlob([bytes]) as unknown as Blob));
    expect(f.props.onVerified).not.toHaveBeenCalled(); expect(f.handle.verifyAudiobook).not.toHaveBeenCalled(); expect(button('Link audiobook')).toBeDefined();
  });
  it('aborts on account change and refuses to display an old account map', async () => {
    const f = await fixture(), download = deferred<Blob>(); f.getBlob.mockReturnValue(download.promise);
    await click('Link audiobook'); await choose(); await click('Verify selected audio');
    const signal = f.getBlob.mock.calls[0]![2]!.signal!;
    f.client.session = { ...f.client.session, userId: 'other' };
    await render({ ...f.props, alignment: f.map }); expect(signal.aborted).toBe(true);
    await act(async () => download.resolve(new NodeBlob([bytes]) as unknown as Blob));
    expect(f.props.onVerified).not.toHaveBeenCalled(); expect(button('Listen from here')).toBeUndefined();
  });
  it('aborts on reader unmount and suppresses late verification results', async () => {
    const f = await fixture(), download = deferred<Blob>(); f.getBlob.mockReturnValue(download.promise);
    await click('Link audiobook'); await choose(); await click('Verify selected audio');
    const signal = f.getBlob.mock.calls[0]![2]!.signal!;
    await act(async () => root!.unmount()); root = null; expect(signal.aborted).toBe(true);
    await act(async () => download.resolve(new NodeBlob([bytes]) as unknown as Blob)); expect(f.props.onVerified).not.toHaveBeenCalled();
  });
  it('rejects more than 128 MiB total before requesting any audio bytes', async () => {
    const f = await fixture(); const size = 60 * 1024 * 1024;
    f.getManifest.mockResolvedValue({ ...manifest, assets: [0, 1, 2].map(index => ({ ...manifest.assets[0]!, assetId: `asset-${index}`, fileId: 41 + index, sequence: index, sizeBytes: size })) });
    f.getPlaylist.mockResolvedValue({ ...playlist,
      resources: [0, 1, 2].map(index => ({ ...playlist.resources[0]!, href: `${index}.wav`, size })),
      items: [0, 1, 2].map(index => ({ ...playlist.items[0]!, index, audioHref: `${index}.wav` })),
    });
    await click('Link audiobook'); for (let index = 0; index < 3; index++) await choose(`asset-${index}`, index);
    await click('Verify selected audio'); expect(element.querySelector('[role="alert"]')?.textContent).toContain('128 MiB'); expect(f.getBlob).not.toHaveBeenCalled();
  });
  it('refuses an oversized individual asset before download', async () => {
    const f = await fixture(); f.getManifest.mockResolvedValue({ ...manifest, assets: [{ ...manifest.assets[0]!, sizeBytes: 64 * 1024 * 1024 + 1 }] });
    await click('Link audiobook'); await choose(); await click('Verify selected audio');
    expect(element.querySelector('[role="alert"]')?.textContent).toContain('64 MiB'); expect(f.getBlob).not.toHaveBeenCalled();
  });
});
