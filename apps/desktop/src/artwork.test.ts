import { describe, expect, it, vi } from "vitest";
import { DesktopArtwork } from "./artwork";
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};
describe("desktop artwork ownership", () => {
  it("publishes only the current account and exact source after asynchronous image loading", async () => {
    const cache = new DesktopArtwork(),
      ready = vi.fn();
    let finish!: (blob: Blob) => void;
    const old = vi.fn(
      (_signal: AbortSignal) =>
        new Promise<Blob>((resolve) => {
          finish = resolve;
        }),
    );
    expect(cache.update("account-a/book/file", old, ready)).toBeUndefined();
    cache.update(
      "account-b/book/file",
      async () => new Blob(["new"], { type: "image/png" }),
      ready,
    );
    await flush();
    finish(new Blob(["old"], { type: "image/jpeg" }));
    await flush();
    expect(old.mock.calls[0]![0].aborted).toBe(true);
    expect(ready).toHaveBeenCalledOnce();
    expect(cache.update("account-b/book/file", vi.fn(), ready)).toBe(
      "data:image/png;base64,bmV3",
    );
  });
  it("clears pending artwork on logout and does not refetch for metadata ticks", async () => {
    const cache = new DesktopArtwork(),
      ready = vi.fn();
    let finish!: (blob: Blob) => void;
    const load = vi.fn(
      () =>
        new Promise<Blob>((resolve) => {
          finish = resolve;
        }),
    );
    cache.update("source", load, ready);
    cache.update("source", load, ready);
    expect(load).toHaveBeenCalledOnce();
    cache.clear();
    finish(new Blob(["private"], { type: "image/png" }));
    await flush();
    expect(ready).not.toHaveBeenCalled();
    expect(cache.update(null, load, ready)).toBeUndefined();
  });
  it("does not send unsupported or oversized content into native image decoders", async () => {
    for (const blob of [
      new Blob(["<svg/>"], { type: "image/svg+xml" }),
      new Blob([new Uint8Array(2 * 1024 * 1024 + 1)], { type: "image/png" }),
      new Blob([], { type: "image/jpeg" }),
    ]) {
      const cache = new DesktopArtwork(),
        ready = vi.fn();
      cache.update("source", async () => blob, ready);
      await flush();
      expect(ready).not.toHaveBeenCalled();
      expect(cache.update("source", vi.fn(), ready)).toBeUndefined();
    }
  });
});
