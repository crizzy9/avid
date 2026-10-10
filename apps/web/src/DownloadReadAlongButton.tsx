import { useEffect, useRef, useState } from "react";
import { Download, Check, X } from "lucide-react";
import type { BookOrbitClient } from "../../../packages/core/src/bookorbit";
import type { Book } from "../../../packages/core/src/types";
import {
  OfflineReadAlongStore,
  downloadOfflineReadAlong,
  type OfflineReadAlongDescriptor,
} from "../../../packages/core/src/offlineReadAlong";
import type { VerifiedAudioAlignment } from "../../../packages/playback/src/standalone-alignment";
import type { ReaderAlignmentHandle } from "../../../packages/readers/src/alignedPassage";
import { useReadAlongI18n } from "./readAlongMessages";

let store: OfflineReadAlongStore | undefined;
export const offlineReadAlongStore = () =>
  (store ??= new OfflineReadAlongStore());

export function DownloadReadAlongButton({
  scope,
  scopeLabel,
  book,
  fileId,
  source,
  client,
  alignment,
  handle,
  onSaved,
}: {
  scope: string;
  scopeLabel: string;
  book: Book;
  fileId: string;
  source: Blob;
  client: BookOrbitClient | null;
  alignment?: VerifiedAudioAlignment | null;
  handle?: ReaderAlignmentHandle | null;
  onSaved?: (descriptor: OfflineReadAlongDescriptor) => Promise<void>;
}) {
  const t = useReadAlongI18n();
  const [busy, setBusy] = useState(false),
    [saved, setSaved] = useState(false),
    [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    setSaved(false);
    setError("");
    setBusy(false);
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [scope, book.id, fileId, source]);
  async function download() {
    request.current?.abort();
    const abort = new AbortController();
    request.current = abort;
    const active = () => request.current === abort && !abort.signal.aborted;
    setBusy(true);
    setError("");
    try {
      // This is a user-triggered storage request; denial does not mean the bytes cannot be saved.
      await navigator.storage?.persist?.().catch(() => false);
      const map =
        alignment?.edition.accountScope === scope &&
        alignment.edition.bookId === book.id &&
        alignment.edition.textFileId === fileId
          ? alignment
          : null;
      let descriptor: OfflineReadAlongDescriptor;
      if (map && client) {
        const [playlist, manifest] = await Promise.all([
          client.getMediaOverlayPlaylist(book.id, fileId),
          client.getAudioManifest(book.id),
        ]);
        if (!active()) return;
        if (manifest.revision !== map.edition.manifestRevision)
          throw new Error(t("downloadEditionChanged"));
        const pairings = [
          ...new Set(playlist.items.map((item) => item.audioHref)),
        ].map((audioHref) => {
          const item = playlist.items.find(
            (value) => value.audioHref === audioHref,
          )!;
          const segment = map.segments.find(
            (value) =>
              value.textHref === item.textHref &&
              value.textFragment === item.textFragment,
          );
          const asset = manifest.assets.find(
            (value) => String(value.fileId) === segment?.trackId,
          );
          if (!asset) throw new Error(t("missingPairing"));
          return {
            audioHref,
            assetId: asset.assetId,
            fileId: String(asset.fileId),
          };
        });
        const timedText = await handle?.getTimedText?.(map, map.edition);
        descriptor = await downloadOfflineReadAlong(
          client,
          offlineReadAlongStore(),
          {
            scope,
            scopeLabel,
            book,
            textFileId: fileId,
            epub: source,
            alignment: map,
            playlist,
            manifest,
            pairings,
            timedText,
          },
          { signal: abort.signal, isActive: active },
        );
      } else {
        descriptor = await offlineReadAlongStore().put(
          { scope, scopeLabel, book, textFileId: fileId, epub: source },
          { signal: abort.signal, isActive: active },
        );
      }
      if (active()) await onSaved?.(descriptor);
      if (active()) setSaved(true);
    } catch (failure) {
      if (active())
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (active()) setBusy(false);
    }
  }
  return (
    <div className="download-read-along">
      <button
        type="button"
        className="secondary-button"
        disabled={busy}
        onClick={() => void download()}
      >
        {saved ? <Check size={16} /> : <Download size={16} />}
        {t(busy ? "saving" : saved ? "ready" : "download")}
      </button>
      {busy && (
        <button
          type="button"
          className="icon-button"
          aria-label={t("cancelDownload")}
          onClick={() => {
            request.current?.abort();
            request.current = null;
            setBusy(false);
          }}
        >
          <X size={16} />
        </button>
      )}
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
    </div>
  );
}
