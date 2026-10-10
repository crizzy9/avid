import { useEffect, useRef, useState } from 'react';
import type { BookOrbitClient, AudioManifest } from '../../../packages/core/src/bookorbit';
import type { MediaOverlayPlaylist } from '../../../packages/core/src/media-overlay';
import type { Book } from '../../../packages/core/src/types';
import { accountScope } from '../../../packages/core/src/repository';
import type { ReaderAlignmentHandle, CandidateAudioAsset } from '../../../packages/readers/src/alignedPassage';
import { assertStandaloneAlignment, type VerifiedAudioAlignment } from '../../../packages/playback/src/standalone-alignment';
import { useAlignmentI18n, AlignmentControlsError } from './alignmentMessages';

export interface AlignmentControlsProps {
  client: BookOrbitClient;
  book: Book;
  fileId: string;
  handle: ReaderAlignmentHandle | null;
  alignment: VerifiedAudioAlignment | null;
  onVerified: (map: VerifiedAudioAlignment) => void;
  onListen: (map: VerifiedAudioAlignment, handle: ReaderAlignmentHandle) => void | Promise<void>;
}
type Status = 'closed' | 'loading' | 'selecting' | 'verifying' | 'handoff';
const PER_ASSET = 64 * 1024 * 1024, TOTAL = 128 * 1024 * 1024;
const manifestIdentity = (manifest: AudioManifest) => JSON.stringify({ revision: manifest.revision, total: manifest.totalDurationMs,
  assets: [...manifest.assets].sort((a, b) => a.sequence - b.sequence).map(({ assetId, fileId, sequence, durationMs, sizeBytes, etag }) => ({ assetId, fileId, sequence, durationMs, sizeBytes, etag })) });
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Explicit, bounded verification UI. Normal playback never downloads assets through this component. */
export function AlignmentControls(props: AlignmentControlsProps) {
  const { t } = useAlignmentI18n();
  const { client, book, fileId, handle, alignment } = props;
  const scope = accountScope(client.session);
  const [status, setStatus] = useState<Status>('closed');
  const [playlist, setPlaylist] = useState<MediaOverlayPlaylist | null>(null);
  const [manifest, setManifest] = useState<AudioManifest | null>(null);
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [success, setSuccess] = useState(false);
  const [invalidRevision, setInvalidRevision] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const latest = useRef({ ...props, scope }); latest.current = { ...props, scope };
  useEffect(() => {
    mounted.current = true;
    setStatus('closed'); setPlaylist(null); setManifest(null); setSelections({}); setError(null); setSuccess(false); setInvalidRevision(null);
    return () => { mounted.current = false; request.current?.abort(); request.current = null; };
  }, [client, scope, book.id, fileId, handle]);
  const begin = () => { request.current?.abort(); const controller = new AbortController(); request.current = controller; return controller; };
  const current = (controller: AbortController) => mounted.current && request.current === controller && !controller.signal.aborted &&
    latest.current.client === client && latest.current.scope === scope && accountScope(client.session) === scope && latest.current.book.id === book.id && latest.current.fileId === fileId && latest.current.handle === handle;
  const cancel = () => { request.current?.abort(); request.current = null; setStatus('closed'); setPlaylist(null); setManifest(null); setSelections({}); setError(null); setSuccess(false); };
  let verified: VerifiedAudioAlignment | null = null;
  if (alignment && handle && alignment.edition.manifestRevision !== invalidRevision && (!manifest || manifest.revision === alignment.edition.manifestRevision) && book.files.some(file => file.id === alignment.edition.audioFileId && file.format === 'AUDIO')) {
    try {
      assertStandaloneAlignment(alignment, { ...alignment.edition, accountScope: scope, bookId: book.id, textFileId: fileId });
      verified = alignment;
    } catch { /* A previous account/source map does not advertise handoff. */ }
  }
  const load = async () => {
    if (!handle) return;
    const controller = begin(); setStatus('loading'); setError(null); setSuccess(false);
    try {
      const [nextPlaylist, nextManifest] = await Promise.all([client.getMediaOverlayPlaylist(book.id, fileId), client.getAudioManifest(book.id)]);
      if (!current(controller)) return;
      if (!nextPlaylist.items.length || !nextPlaylist.resources.length) throw new AlignmentControlsError('noNarration');
      if (!nextManifest.assets.length || nextManifest.assets.some(asset => asset.durationMs === null || !Number.isFinite(asset.durationMs) || asset.durationMs <= 0)) throw new AlignmentControlsError('durations');
      if (nextPlaylist.items.some(item => item.clipEndSeconds === null || item.durationSeconds === null || item.clipEndSeconds <= item.clipBeginSeconds || !item.textFragment)) throw new AlignmentControlsError('incompleteTiming');
      setPlaylist(nextPlaylist); setManifest(nextManifest); setSelections({}); setStatus('selecting');
    } catch (failure) { if (current(controller)) { setError(failure); setStatus('closed'); } }
  };
  const resources = playlist?.resources.filter(resource => playlist.items.some(item => item.audioHref === resource.href)) ?? [];
  const verify = async () => {
    if (!handle || !playlist || !manifest || !resources.length || resources.some(resource => !selections[resource.href])) return;
    const controller = begin(); setStatus('verifying'); setError(null); setSuccess(false);
    try {
      const selected = new Map<string, AudioManifest['assets'][number]>();
      for (const resource of resources) {
        const asset = manifest.assets.find(candidate => candidate.assetId === selections[resource.href]);
        if (!asset) throw new AlignmentControlsError('chooseAll');
        if (!Number.isSafeInteger(asset.sizeBytes) || asset.sizeBytes === null || asset.sizeBytes <= 0 || asset.sizeBytes > PER_ASSET || resource.size <= 0 || resource.size > PER_ASSET) throw new AlignmentControlsError('sizeLimit');
        selected.set(asset.assetId, asset);
      }
      if ([...selected.values()].reduce((sum, asset) => sum + asset.sizeBytes!, 0) > TOTAL) throw new AlignmentControlsError('totalLimit');
      const audioFileId = book.files.find(file => file.format === 'AUDIO' && manifest.assets.some(asset => String(asset.fileId) === file.id))?.id;
      if (!audioFileId) throw new AlignmentControlsError('noAudioFile');
      const bytes = new Map<string, ArrayBuffer>(); let downloaded = 0;
      for (const asset of selected.values()) {
        if (!current(controller)) return;
        const blob = await client.getAudioAssetBlob(book.id, asset.assetId, { signal: controller.signal, maxBytes: Math.min(PER_ASSET, TOTAL - downloaded) });
        if (!current(controller)) return;
        if (blob.size !== asset.sizeBytes) throw new AlignmentControlsError('sizeChanged');
        downloaded += blob.size;
        if (downloaded > TOTAL) throw new AlignmentControlsError('totalLimit');
        bytes.set(asset.assetId, await blob.arrayBuffer());
      }
      if (!current(controller)) return;
      const latestManifest = await client.getAudioManifest(book.id);
      if (!current(controller)) return;
      if (manifestIdentity(latestManifest) !== manifestIdentity(manifest)) { setInvalidRevision(manifest.revision); throw new AlignmentControlsError('editionChanged'); }
      const candidates: CandidateAudioAsset[] = resources.map(resource => {
        const asset = selected.get(selections[resource.href]!)!;
        return { audioHref: resource.href, assetId: asset.assetId, fileId: String(asset.fileId), bytes: bytes.get(asset.assetId)! };
      });
      const map = await handle.verifyAudiobook(playlist, latestManifest, audioFileId, candidates);
      if (!current(controller)) return;
      assertStandaloneAlignment(map, { ...map.edition, accountScope: scope, bookId: book.id, textFileId: fileId, audioFileId, manifestRevision: latestManifest.revision });
      latest.current.onVerified(map); setInvalidRevision(null); setStatus('closed'); setSuccess(true);
    } catch (failure) { if (current(controller)) { setError(failure); setStatus('selecting'); } }
  };
  const listen = async () => {
    if (!verified || !handle) return;
    const controller = begin(); setStatus('handoff'); setError(null);
    if (!current(controller)) { setStatus('closed'); setError(new AlignmentControlsError('accountChanged')); return; }
    try { await latest.current.onListen(verified, handle); if (current(controller)) setStatus('closed'); }
    catch (failure) { if (current(controller)) { setError(failure); setStatus('closed'); } }
  };
  const busy = status === 'loading' || status === 'verifying' || status === 'handoff';
  return <section className="alignment-controls" aria-label={t('region')}>
    <div className="alignment-actions">
      {status === 'closed' && <button type="button" className="reader-secondary" disabled={!handle} onClick={() => void load()}>{t('link')}</button>}
      {verified && <button type="button" className="reader-primary" disabled={busy} onClick={() => void listen()}>{t('listen')}</button>}
      {status !== 'closed' && status !== 'handoff' && <button type="button" className="reader-secondary" onClick={cancel}>{t('cancel')}</button>}
    </div>
    {status === 'loading' && <p role="status">{t('loading')}</p>}
    {(status === 'selecting' || status === 'verifying') && playlist && manifest && <div className="alignment-pairings">
      <p>{t('explanation')}</p>
      {resources.map(resource => <label key={resource.href}>{t('assetFor', { href: resource.href })}<select value={selections[resource.href] ?? ''} disabled={busy} onChange={event => setSelections(previous => ({ ...previous, [resource.href]: event.target.value }))}>
        <option value="">{t('choose')}</option>
        {[...manifest.assets].sort((a, b) => a.sequence - b.sequence).map(asset => <option key={asset.assetId} value={asset.assetId}>{book.files.find(file => file.id === String(asset.fileId))?.name ?? t('file', { id: String(asset.fileId) })} · {asset.assetId}</option>)}
      </select></label>)}
      <button type="button" className="reader-primary" disabled={busy || resources.some(resource => !selections[resource.href])} onClick={() => void verify()}>{t('verify')}</button>
    </div>}
    {status === 'verifying' && <p role="status">{t('verifying')}</p>}
    {status === 'handoff' && <p role="status">{t('opening')}</p>}
    {Boolean(error) && <p role="alert">{error instanceof AlignmentControlsError ? t(error.key) : `${t('failed')} ${message(error)}`}</p>}
    {success && <p role="status">{t('verified')}</p>}
  </section>;
}
