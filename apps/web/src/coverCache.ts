import type { Book } from "../../../packages/core/src/types";

type Entry = {
  id: string;
  source: string;
  url?: string;
  bytes?: number;
  users: number;
  touched: number;
  controller?: AbortController;
  retryAt?: number;
};
/** Account-owned, demand-driven media cache. Metadata registration never fetches media. */
export class BookCoverCache {
  private entries = new Map<string, Entry>();
  private queue = new Set<Entry>();
  private listeners = new Set<() => void>();
  private active = 0;
  private tick = 0;
  private disposed = false;
  constructor(
    private fetchCover: (id: string, signal: AbortSignal) => Promise<Blob>,
    private maxCached = 96,
    private concurrency = 4,
    private maxBytes = 32 * 1024 * 1024,
  ) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  get = (id: string) => this.entries.get(id)?.url;
  has = (id: string) => this.entries.has(id);
  register(books: Book[]): void {
    if (this.disposed) return;
    for (const book of books) {
      const prior = this.entries.get(book.id);
      if (!book.coverUrl) {
        if (prior) {
          prior.controller?.abort();
          this.queue.delete(prior);
          if (prior.url) URL.revokeObjectURL(prior.url);
          this.entries.delete(book.id);
        }
        continue;
      }
      if (book.coverUrl.startsWith("blob:")) continue;
      if (prior?.source === book.coverUrl) continue;
      if (prior) {
        prior.controller?.abort();
        this.queue.delete(prior);
        if (prior.url) URL.revokeObjectURL(prior.url);
      }
      const entry: Entry = {
        id: book.id,
        source: book.coverUrl,
        users: prior?.users ?? 0,
        touched: ++this.tick,
      };
      this.entries.set(book.id, entry);
      if (entry.users) this.queue.add(entry);
    }
    this.notify();
    this.pump();
  }
  acquire(id: string): () => void {
    const entry = this.entries.get(id);
    if (!entry || this.disposed) return () => {};
    entry.users++;
    entry.touched = ++this.tick;
    if (
      !entry.url &&
      !entry.controller &&
      (!entry.retryAt || entry.retryAt <= Date.now())
    )
      this.queue.add(entry);
    this.pump();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      // A cover revision replaces the entry while retaining its subscribers.
      const current = this.entries.get(id);
      if (!current) return;
      current.users = Math.max(0, current.users - 1);
      if (!current.users) {
        this.queue.delete(current);
        current.controller?.abort();
      }
      this.trim();
    };
  }
  getStats() {
    return {
      sources: this.entries.size,
      active: this.active,
      queued: this.queue.size,
      cached: [...this.entries.values()].filter((entry) => entry.url).length,
      bytes: [...this.entries.values()].reduce(
        (total, entry) => total + (entry.url ? (entry.bytes ?? 0) : 0),
        0,
      ),
      visible: [...this.entries.values()].filter((entry) => entry.users).length,
    };
  }
  dispose(): void {
    this.disposed = true;
    this.queue.clear();
    for (const entry of this.entries.values()) {
      entry.controller?.abort();
      if (entry.url) URL.revokeObjectURL(entry.url);
    }
    this.entries.clear();
    this.notify();
    this.listeners.clear();
  }
  private notify() {
    for (const listener of this.listeners) listener();
  }
  private trim(reservedBytes = 0, reservedCount = 0) {
    const loaded = [...this.entries.values()]
      .filter((entry) => entry.url)
      .sort((a, b) => a.touched - b.touched);
    let count = loaded.length,
      bytes = loaded.reduce((total, entry) => total + (entry.bytes ?? 0), 0),
      changed = false;
    for (const entry of loaded) {
      if (
        count + reservedCount <= this.maxCached &&
        bytes + reservedBytes <= this.maxBytes
      )
        break;
      if (entry.users) continue;
      URL.revokeObjectURL(entry.url!);
      entry.url = undefined;
      bytes -= entry.bytes ?? 0;
      entry.bytes = undefined;
      count--;
      changed = true;
    }
    if (changed) this.notify();
  }
  private pump() {
    if (this.disposed) return;
    while (this.active < this.concurrency && this.queue.size) {
      const entry = this.queue.values().next().value!;
      this.queue.delete(entry);
      if (!entry.users || entry.url || entry.controller) continue;
      const controller = new AbortController();
      entry.controller = controller;
      this.active++;
      void this.fetchCover(entry.id, controller.signal)
        .then((blob) => {
          if (
            this.disposed ||
            controller.signal.aborted ||
            this.entries.get(entry.id) !== entry
          )
            return;
          this.trim(blob.size, 1);
          const stats = this.getStats();
          // Keep visible covers intact; use a text cover if this image cannot fit.
          if (
            stats.cached >= this.maxCached ||
            stats.bytes + blob.size > this.maxBytes
          ) {
            entry.retryAt = Date.now() + 30000;
            return;
          }
          entry.url = URL.createObjectURL(blob);
          entry.bytes = blob.size;
          entry.touched = ++this.tick;
          entry.retryAt = undefined;
          this.notify();
          this.trim();
        })
        .catch(() => {
          if (!controller.signal.aborted) entry.retryAt = Date.now() + 30000;
        })
        .finally(() => {
          if (entry.controller === controller) entry.controller = undefined;
          this.active--;
          if (
            controller.signal.aborted &&
            entry.users &&
            this.entries.get(entry.id) === entry &&
            !this.disposed
          )
            this.queue.add(entry);
          this.pump();
        });
    }
  }
}
