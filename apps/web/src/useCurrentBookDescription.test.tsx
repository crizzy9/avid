// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BookOrbitClient } from "../../../packages/core/src/bookorbit";
import type { Book } from "../../../packages/core/src/types";
import { useCurrentBookDescription } from "./useCurrentBookDescription";

const book: Book = { id: "12", title: "Current book", authors: [], description: "Cached description", format: "EPUB", files: [{ id: "41", format: "EPUB", name: "book.epub" }], color: "#333333", progress: 0.6, status: "reading", genres: [], addedAt: "2026-10-09" };
const client = (url = "https://books.example", userId = "7") => new BookOrbitClient({ profile: { id: url, name: "Books", url }, userId, accessToken: "fixture" });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve }; }
function Probe({ api, current = book, active = true }: { api: BookOrbitClient | null; current?: Book; active?: boolean }) {
  const description = useCurrentBookDescription(api, current, active);
  return <p data-progress={current.progress} data-file={current.files[0]?.id}>{description}</p>;
}
let host: HTMLDivElement, root: Root;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });

describe("current Home book description", () => {
  it("hydrates only the blurb without replacing current progress, editions or actions", async () => {
    const api = client(), read = vi.spyOn(api, "getBook").mockResolvedValue({ ...book, description: "Actual server description", progress: 0, status: "unread", files: [] });
    await act(async () => root.render(<Probe api={api} />));
    expect(host.textContent).toBe("Actual server description");
    expect(host.querySelector("p")?.dataset).toMatchObject({ progress: "0.6", file: "41" });
    await act(async () => root.render(<Probe api={api} current={{ ...book, progress: 0.7 }} />));
    expect(read).toHaveBeenCalledExactlyOnceWith("12");
    expect(host.querySelector("p")?.dataset.progress).toBe("0.7");
  });
  it("deduplicates the current metadata request across StrictMode effects and Home re-entry", async () => {
    const api = client(), pending = deferred<Book>(), read = vi.spyOn(api, "getBook").mockReturnValue(pending.promise);
    await act(async () => root.render(<StrictMode><Probe api={api} /></StrictMode>));
    expect(read).toHaveBeenCalledOnce();
    await act(async () => pending.resolve({ ...book, description: "Hydrated" }));
    await act(async () => root.render(<StrictMode><Probe api={api} active={false} /></StrictMode>));
    await act(async () => root.render(<StrictMode><Probe api={api} /></StrictMode>));
    expect(read).toHaveBeenCalledOnce(); expect(host.textContent).toBe("Hydrated");
  });
  it("does not read local books or issue metadata requests outside Home", async () => {
    const api = client(), read = vi.spyOn(api, "getBook");
    await act(async () => root.render(<Probe api={api} active={false} />));
    await act(async () => root.render(<Probe api={api} current={{ ...book, id: "local-import" }} />));
    await act(async () => root.render(<Probe api={null} />));
    expect(read).not.toHaveBeenCalled(); expect(host.textContent).toBe("Cached description");
  });
  it("discards a response after leaving Home and reuses it safely if the same book returns", async () => {
    const api = client(), pending = deferred<Book>(), read = vi.spyOn(api, "getBook").mockReturnValue(pending.promise);
    await act(async () => root.render(<Probe api={api} />));
    await act(async () => root.render(<Probe api={api} active={false} />));
    await act(async () => pending.resolve({ ...book, description: "Late metadata" }));
    expect(host.textContent).toBe("Cached description");
    await act(async () => root.render(<Probe api={api} />));
    expect(host.textContent).toBe("Late metadata"); expect(read).toHaveBeenCalledOnce();
  });
  it("ignores prior-account responses even when the current book ID is identical", async () => {
    const first = client(), second = client("https://other.example", "8"), pending = deferred<Book>();
    vi.spyOn(first, "getBook").mockReturnValue(pending.promise);
    vi.spyOn(second, "getBook").mockResolvedValue({ ...book, description: "Current account" });
    await act(async () => root.render(<Probe api={first} />));
    await act(async () => root.render(<Probe api={second} />));
    await act(async () => pending.resolve({ ...book, description: "Private old account" }));
    expect(host.textContent).toBe("Current account");
  });
  it("ignores a stale current-book response and a mismatched returned book ID", async () => {
    const api = client(), pending = deferred<Book>();
    vi.spyOn(api, "getBook").mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ ...book, id: "999", description: "Wrong book" });
    await act(async () => root.render(<Probe api={api} />));
    await act(async () => root.render(<Probe api={api} current={{ ...book, id: "13", description: "Second card" }} />));
    await act(async () => pending.resolve({ ...book, description: "Old book" }));
    expect(host.textContent).toBe("Second card");
  });
  it("rejects an in-place account identity change before accepting metadata", async () => {
    const api = client(), pending = deferred<Book>(); vi.spyOn(api, "getBook").mockReturnValue(pending.promise);
    await act(async () => root.render(<Probe api={api} />));
    api.session = { ...api.session, userId: "different-user" };
    await act(async () => pending.resolve({ ...book, description: "Old owner" }));
    expect(host.textContent).toBe("Cached description");
  });
  it("preserves cached text on failure and retries only on a later Home entry", async () => {
    const api = client(), read = vi.spyOn(api, "getBook").mockRejectedValueOnce(new Error("Offline")).mockResolvedValueOnce({ ...book, description: "Online again" });
    await act(async () => root.render(<Probe api={api} />));
    expect(host.textContent).toBe("Cached description"); expect(read).toHaveBeenCalledOnce();
    await act(async () => root.render(<Probe api={api} active={false} />));
    await act(async () => root.render(<Probe api={api} />));
    expect(host.textContent).toBe("Online again"); expect(read).toHaveBeenCalledTimes(2);
  });
});
