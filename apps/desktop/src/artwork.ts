const MAX_BYTES = 2 * 1024 * 1024;
/** Keep only one source's cover. Artwork is optional and never delays transport metadata. */
export class DesktopArtwork {
  private current: {
    key: string;
    abort: AbortController;
    data?: string;
  } | null = null;
  update(
    key: string | null,
    load: (signal: AbortSignal) => Promise<Blob | undefined>,
    ready: () => void,
  ): string | undefined {
    if (key === this.current?.key) return this.current.data;
    this.clear();
    if (!key) return undefined;
    const entry = {
      key,
      abort: new AbortController(),
      data: undefined as string | undefined,
    };
    this.current = entry;
    void (async () => {
      const blob = await load(entry.abort.signal);
      if (
        !blob ||
        blob.size === 0 ||
        blob.size > MAX_BYTES ||
        !/^image\/(png|jpeg|webp)$/.test(blob.type)
      )
        return;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (entry.abort.signal.aborted || this.current !== entry) return;
      let binary = "";
      for (let i = 0; i < bytes.length; i += 8192)
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      entry.data = `data:${blob.type};base64,${btoa(binary)}`;
      ready();
    })().catch(() => {
      /* An unavailable cover leaves neutral native artwork. */
    });
    return undefined;
  }
  clear() {
    this.current?.abort.abort();
    this.current = null;
  }
}
