// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AvidDatabase,
  LibraryRepository,
} from "../../../packages/core/src/repository";
import type {
  Annotation,
  Book,
  Session,
} from "../../../packages/core/src/types";
import { useLibrary } from "./useLibrary";

const { transport } = vi.hoisted(() => ({ transport: vi.fn() }));
vi.mock("./Connect", () => ({
  bookOrbitFetch: (input: RequestInfo | URL, init?: RequestInit) =>
    transport(input, init),
  proxyBaseFor: () => undefined,
}));
const session = (id = "7"): Session => ({
  profile: { id: "s", name: "Library", url: "https://books.example" },
  userId: id,
  accessToken: "original",
});
const card = {
  id: 12,
  title: "Initial",
  authors: ["Author"],
  files: [{ id: 31, format: "epub", role: "primary" }],
  genres: [],
  readingProgress: 20,
  readStatus: { status: "reading" },
  addedAt: "2026-10-01T00:00:00Z",
  hasCover: false,
};
const note: Annotation = {
  id: "note-a",
  bookId: "12",
  fileId: "31",
  kind: "note",
  quote: "",
  text: "Account A",
  color: "yellow",
  locator: "epubcfi(/6/2)",
  createdAt: "2026-10-01T01:00:00Z",
  updatedAt: "2026-10-01T01:00:00Z",
};
const remoteNote = (id = 41) => ({
  id,
  bookId: 12,
  jumpFileId: 31,
  cfi: note.locator,
  text: note.quote,
  note: note.text,
  color: note.color,
  createdAt: note.createdAt,
  updatedAt: note.updatedAt,
});
const reply = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const page = (title = "Initial", hasCover = false) => ({
  items: [{ ...card, title, hasCover }],
  total: 1,
  page: 0,
  size: 48,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const defaultTransport = async (
  input: RequestInfo | URL,
  init?: RequestInit,
) => {
  const url = String(input);
  if (url.endsWith("/books/query"))
    return reply(page(JSON.parse(String(init?.body)).q || "Initial"));
  if (url.endsWith("/collections")) return reply([]);
  if (url.endsWith("/app-info"))
    return reply({ version: "3.3.0", features: [] });
  throw new Error(`Unexpected test request: ${url}`);
};
let root: Root;
let container: HTMLDivElement;
let api: ReturnType<typeof useLibrary>;
const database = new AvidDatabase();
const waitForStatus = async (status: string) => {
  const deadline = Date.now() + 2500;
  do {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  } while (api.syncStatus !== status && Date.now() < deadline);
  expect(api.syncStatus).toBe(status);
};
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  transport.mockReset().mockImplementation(defaultTransport);
  URL.createObjectURL = vi.fn(() => `blob:test-${crypto.randomUUID()}`);
  URL.revokeObjectURL = vi.fn();
  await Promise.all(database.tables.map((table) => table.clear()));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  function Harness() {
    api = useLibrary();
    return null;
  }
  await act(async () => {
    root.render(<Harness />);
  });
  await act(async () => {
    await vi.waitFor(async () =>
      expect((await api.repo.getBooks()).length).toBeGreaterThan(0),
    );
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.restoreAllMocks();
  container.remove();
});

describe("account-scoped library integration", () => {
  it("does not replace newer activity with delayed initial hydration", async () => {
    const waiting = deferred<Book[]>();
    const getBooks = vi.spyOn(LibraryRepository.prototype, "getBooks").mockImplementationOnce(() => waiting.promise);
    await act(async () => { await api.connect(session(), true); });
    await act(async () => {
      await api.recordSession({ id: "new-reading", bookId: "12", kind: "reading", startedAt: "2026-10-01T01:00:00Z", duration: 5 }, "31", { endedAt: "2026-10-01T01:00:05Z" });
    });
    expect(api.sessions.map(row => row.id)).toContain("new-reading");
    await act(async () => { waiting.resolve([]); await waiting.promise; });
    expect(api.sessions.map(row => row.id)).toContain("new-reading");
    getBooks.mockRestore();
  });

  it.each(["catalog", "discovery", "cache"])("does not activate a closed connection during %s", async (stage) => {
    let active = true;
    const wait = deferred<Response>();
    const cacheWait = deferred<void>();
    let reached = false;
    const originalPut = LibraryRepository.prototype.putBooks;
    if (stage === "cache") vi.spyOn(LibraryRepository.prototype, "putBooks").mockImplementation(async function (this: LibraryRepository, books) {
      reached = true;
      await cacheWait.promise;
      return originalPut.call(this, books);
    });
    transport.mockImplementation((input, init) => {
      if ((stage === "catalog" && String(input).endsWith("/books/query")) ||
          (stage === "discovery" && String(input).endsWith("/app-info"))) {
        reached = true;
        return wait.promise;
      }
      return defaultTransport(input, init);
    });
    let connecting!: Promise<void>;
    await act(async () => { connecting = api.connect(session(), true, () => active); });
    await act(async () => { await vi.waitFor(() => expect(reached).toBe(true)); });
    active = false;
    await act(async () => {
      wait.resolve(stage === "catalog" ? reply(page("Canceled")) : reply({version:"3.3.0",features:[]}));
      cacheWait.resolve();
      await connecting;
    });
    expect(api.client).toBeNull();
    expect(api.repo.scope).toContain("demo");
    expect(api.books.some(book => book.id === "12")).toBe(false);
  });
  it("does not start requests for an already superseded sign-in", async () => {
    transport.mockClear();
    await act(async () => { await api.connect(session(), true, () => false); });
    expect(transport).not.toHaveBeenCalled();
    expect(api.client).toBeNull();
  });

  it("discards a connection that resolves after disconnect", async () => {
    const response = deferred<Response>();
    transport.mockImplementation((input, init) =>
      String(input).endsWith("/books/query")
        ? response.promise
        : defaultTransport(input, init),
    );
    let connecting!: Promise<void>;
    await act(async () => {
      connecting = api.connect(session(), true);
    });
    await act(async () => {
      api.disconnect();
    });
    await act(async () => {
      response.resolve(reply(page("Old account")));
      await connecting;
    });
    expect(api.client).toBeNull();
    expect(api.books.some((book) => book.title === "Old account")).toBe(false);
  });
  it("clears account data immediately and confines late old callbacks to their original repository", async () => {
    await act(async () => {
      await api.connect(session("7"), true);
    });
    await act(async () => {
      await api.saveAnnotation(note);
    });
    const oldRepo = api.repo,
      oldSave = api.saveAnnotation;
    await act(async () => {
      await api.connect(session("8"), true);
    });
    expect(api.annotations).toEqual([]);
    await act(async () => {
      await oldSave({ ...note, id: "note-b" });
    });
    expect(api.annotations).toEqual([]);
    expect(await api.repo.getAnnotations()).toEqual([]);
    expect(await oldRepo.getAnnotations()).toHaveLength(2);
  });
  it("keeps the newest query when transport ignores cancellation, and clears aborted loading", async () => {
    await act(async () => {
      await api.connect(session(), true);
    });
    const slow = deferred<Response>();
    transport.mockImplementation((input, init) =>
      String(init?.body).includes("slow")
        ? slow.promise
        : defaultTransport(input, init),
    );
    let older!: Promise<void>;
    await act(async () => {
      older = api.query({ query: "slow" });
    });
    await act(async () => {
      await api.query({ query: "newest" });
    });
    await act(async () => {
      slow.resolve(reply(page("stale")));
      await older;
    });
    expect(api.books[0].title).toBe("newest");
    expect(api.loading).toBe(false);
    const abort = new AbortController();
    const pending = deferred<Response>();
    transport.mockImplementation(() => pending.promise);
    let cancelled!: Promise<void>;
    await act(async () => {
      cancelled = api.query({}, abort.signal);
      abort.abort();
      pending.resolve(reply(page("cancelled")));
      await cancelled;
    });
    expect(api.loading).toBe(false);
    expect(api.books[0].title).toBe("newest");
  });
  it("retains a token refreshed during server version discovery", async () => {
    transport.mockImplementation((input, init) => {
      if (String(input).endsWith("/auth/refresh"))
        return Promise.resolve(reply({ accessToken: "refreshed" }));
      if (
        String(input).endsWith("/app-info") &&
        new Headers(init?.headers).get("Authorization") === "Bearer original"
      )
        return Promise.resolve(reply({ message: "Expired" }, 401));
      return defaultTransport(input, init);
    });
    await act(async () => {
      await api.connect(session(), true);
    });
    expect(api.client?.session.accessToken).toBe("refreshed");
    expect(api.client?.session.profile.version).toBe("3.3.0");
  });
  it("keeps imported local-file activity out of the writable server outbox", async () => {
    await act(async () => {
      await api.connect(session(), false);
    });
    const calls = transport.mock.calls.length;
    await act(async () => {
      await api.saveAnchor({
        bookId: "local-book",
        fileId: "local-file",
        kind: "epub",
        locator: "epubcfi(/6/2)",
        progress: 0.2,
        updatedAt: note.updatedAt,
      });
      await api.saveAnnotation({
        ...note,
        bookId: "local-book",
        fileId: "local-file",
      });
      await api.recordSession(
        {
          id: "local-session",
          bookId: "local-book",
          kind: "reading",
          startedAt: note.createdAt,
          duration: 20,
        },
        "local-file",
      );
    });
    expect(await api.repo.pendingOperations()).toEqual([]);
    expect(transport).toHaveBeenCalledTimes(calls);
    expect(api.sessions).toHaveLength(1);
    expect(api.annotations).toHaveLength(1);
  });
  it("reuses authenticated covers across queries and releases their URLs on account change", async () => {
    transport.mockImplementation((input, init) => {
      if (String(input).endsWith("/books/query"))
        return Promise.resolve(reply(page("Covered", true)));
      if (String(input).endsWith("/cover"))
        return Promise.resolve(new Response("image"));
      return defaultTransport(input, init);
    });
    await act(async () => {
      await api.connect(session(), true);
    });
    expect(
      transport.mock.calls.filter((call) => String(call[0]).endsWith("/cover")),
    ).toHaveLength(0);
    const release = api.coverCache!.acquire("12");
    await act(async () => {
      await vi.waitFor(() =>
        expect(api.coverCache!.get("12")).toMatch(/^blob:/),
      );
    });
    const url = api.coverCache!.get("12");
    await act(async () => {
      await api.query({});
    });
    expect(api.coverCache!.get("12")).toBe(url);
    expect(
      transport.mock.calls.filter((call) => String(call[0]).endsWith("/cover")),
    ).toHaveLength(1);
    await act(async () => {
      api.disconnect();
    });
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(url);
    release();
  });
  it("rejects collection creation on read-only connections before sending a request", async () => {
    await act(async () => {
      await api.connect(session(), true);
    });
    const calls = transport.mock.calls.length;
    await expect(api.createCollection("Favorites")).rejects.toThrow(
      "read-only",
    );
    expect(transport).toHaveBeenCalledTimes(calls);
  });

  it("flushes durable notes on writable activation and refreshes the canonical server ID", async () => {
    const stored = new LibraryRepository(database, session());
    await act(async () => {
      await stored.putAnnotation(note);
    });
    const hydration = deferred<Book[]>();
    const originalGetBooks = LibraryRepository.prototype.getBooks;
    vi.spyOn(LibraryRepository.prototype, "getBooks").mockImplementation(
      function (this: LibraryRepository) {
        return this.scope === stored.scope
          ? hydration.promise
          : originalGetBooks.call(this);
      },
    );
    transport.mockImplementation((input, init) => {
      if (String(input).endsWith("/books/12/annotations"))
        return Promise.resolve(
          reply(init?.method === "POST" ? remoteNote() : []),
        );
      return defaultTransport(input, init);
    });
    await act(async () => {
      await api.connect(session(), false);
    });
    await waitForStatus("Synced");
    expect(api.annotations.map((value) => value.id)).toEqual(["41"]);
    await act(async () => {
      hydration.resolve([]);
    });
    // The slow initial hydration captured the old local ID before sync.
    expect(api.annotations.map((value) => value.id)).toEqual(["41"]);
    expect(await stored.pendingOperations()).toEqual([]);
    expect(
      transport.mock.calls.filter(
        ([input, init]) =>
          init?.method === "POST" && String(input).endsWith("/annotations"),
      ),
    ).toHaveLength(1);
  });

  it("never starts an outbox request for read-only activation or online events", async () => {
    const stored = new LibraryRepository(database, session());
    await act(async () => {
      await stored.putAnnotation(note);
    });
    await act(async () => {
      await api.connect(session(), true);
    });
    const calls = transport.mock.calls.length;
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(api.syncStatus).toBe("Read-only server");
    expect(transport).toHaveBeenCalledTimes(calls);
    expect(await stored.pendingOperations()).toHaveLength(1);
  });

  it("retries eligible queued changes online while reporting backoff as pending", async () => {
    const stored = new LibraryRepository(database, session());
    await act(async () => {
      await stored.putAnnotation(note);
    });
    const [operation] = await stored.pendingOperations();
    await stored.updateOperation(operation.id, {
      nextAttemptAt: new Date(Date.now() + 60_000).toISOString(),
    });
    transport.mockImplementation((input, init) => {
      if (String(input).endsWith("/books/12/annotations"))
        return Promise.resolve(
          reply(init?.method === "POST" ? remoteNote(42) : []),
        );
      return defaultTransport(input, init);
    });
    await act(async () => {
      await api.connect(session(), false);
    });
    await waitForStatus("Changes pending");
    const calls = transport.mock.calls.length;
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await waitForStatus("Changes pending");
    expect(transport).toHaveBeenCalledTimes(calls);
    await stored.updateOperation(operation.id, {
      nextAttemptAt: new Date(Date.now() - 1000).toISOString(),
    });
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await waitForStatus("Synced");
    expect(api.annotations.map((value) => value.id)).toEqual(["42"]);
    expect(await stored.pendingOperations()).toEqual([]);
  });

  it("stops a recovered old-account sync before mutation and preserves the new account status", async () => {
    const stored = new LibraryRepository(database, session());
    await act(async () => {
      await stored.putAnnotation(note);
    });
    const remote = deferred<Response>();
    transport.mockImplementation((input, init) => {
      if (String(input).endsWith("/books/12/annotations"))
        return remote.promise;
      return defaultTransport(input, init);
    });
    await act(async () => {
      await api.connect(session(), false);
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(
          transport.mock.calls.some(([input]) =>
            String(input).endsWith("/annotations"),
          ),
        ).toBe(true),
      );
    });
    await act(async () => {
      await api.connect(session("8"), true);
    });
    const calls = transport.mock.calls.length;
    await act(async () => {
      remote.resolve(reply([]));
      await vi.waitFor(async () =>
        expect(
          (await stored.pendingOperations())[0].leaseUntil,
        ).toBeUndefined(),
      );
    });
    expect(transport).toHaveBeenCalledTimes(calls);
    expect(api.syncStatus).toBe("Read-only server");
    expect(api.annotations).toEqual([]);
    expect(await stored.pendingOperations()).toHaveLength(1);
  });

  it("resumes released work when reconnecting the same account joins an old in-flight sync", async () => {
    const stored = new LibraryRepository(database, session());
    await act(async () => {
      await stored.putAnnotation(note);
    });
    const firstRead = deferred<Response>();
    let reads = 0;
    transport.mockImplementation((input, init) => {
      if (String(input).endsWith("/books/12/annotations")) {
        if (init?.method === "POST")
          return Promise.resolve(reply(remoteNote()));
        return ++reads === 1 ? firstRead.promise : Promise.resolve(reply([]));
      }
      return defaultTransport(input, init);
    });
    await act(async () => {
      await api.connect(session(), false);
    });
    await act(async () => {
      await vi.waitFor(() => expect(reads).toBe(1));
    });
    await act(async () => {
      await api.connect(session(), false);
    });
    await act(async () => {
      firstRead.resolve(reply([]));
    });
    await waitForStatus("Synced");
    expect(reads).toBe(2);
    expect(api.annotations.map((value) => value.id)).toEqual(["41"]);
    expect(await stored.pendingOperations()).toEqual([]);
  });
});
