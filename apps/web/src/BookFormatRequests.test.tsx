// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { BookFormatRequests } from "./BookFormatRequests";
import { BookOrbitClient } from "../../../packages/core/src/bookorbit";
import type { Book } from "../../../packages/core/src/types";
import { formatRequestMessages } from "./formatRequestMessages";
import { setLocale, LOCALES } from "../../../packages/i18n/src";
const book: Book = {
  id: "4",
  title: "Novel",
  authors: ["Author"],
  description: "",
  format: "EPUB",
  color: "#aaa",
  progress: 0,
  status: "unread",
  genres: [],
  addedAt: "2026-10-18",
  files: [{ id: "5", name: "Novel.epub", format: "EPUB" }],
};
const request = {
  id: 10,
  userId: 1,
  title: "Novel",
  authors: ["Author"],
  mediaKind: "audiobook",
  status: "pending",
  note: null,
  matchedBookId: null,
  statusReason: null,
  createdAt: "2026-10-18",
  updatedAt: "2026-10-18",
};
function fixture(readOnly = false, features = ["book-request-pairs"]) {
  const fetcher = vi.fn(async (input: any, init?: RequestInit) => {
    const path = String(input).split("/api/v1/")[1];
    return Response.json(
      path === "app-info"
        ? { version: "3.4.0", features }
        : path === "book-requests/availability"
          ? [
              {
                ownedBookId: null,
                existingRequestId: null,
                existingRequestStatus: null,
                alreadySubscribed: false,
              },
            ]
          : path === "book-requests"
            ? { request, subscribed: false }
            : { items: [], total: 0 },
    );
  });
  return {
    fetcher,
    client: new BookOrbitClient(
      {
        profile: { id: "a", name: "Server", url: "https://books.example" },
        userId: "1",
        accessToken: "test",
      },
      { fetch: fetcher, readOnly },
    ),
  };
}
let host: HTMLDivElement, root: Root;
async function flush() {
  await act(async () => {
    for (let i = 0; i < 15; i++) await Promise.resolve();
  });
}
function button(label: string) {
  return [...host.querySelectorAll("button")].find(
    (node) => node.textContent === label,
  )!;
}
beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
describe("format request interface", () => {
  it("does not probe request capabilities for complete books or local imports", async () => {
    const { client, fetcher } = fixture();
    await act(async () =>
      root.render(
        <BookFormatRequests
          client={client}
          book={{
            ...book,
            files: [
              ...book.files,
              { id: "6", name: "Novel.m4b", format: "AUDIO" },
            ],
          }}
        />,
      ),
    );
    await flush();
    expect(fetcher).not.toHaveBeenCalled();
    await act(async () =>
      root.render(
        <BookFormatRequests
          client={client}
          book={{ ...book, id: "local-import" }}
        />,
      ),
    );
    await flush();
    expect(fetcher).not.toHaveBeenCalled();
    expect(host.textContent).toBe("");
  });
  it("loads only capability metadata until explicit review and explicit send", async () => {
    const { client, fetcher } = fixture();
    await act(async () =>
      root.render(<BookFormatRequests client={client} book={book} />),
    );
    await flush();
    expect(
      fetcher.mock.calls.every(
        ([, init]) => !init?.method || init.method === "GET",
      ),
    ).toBe(true);
    await act(async () => button("Check availability").click());
    await flush();
    expect(
      fetcher.mock.calls.filter(([url]) =>
        String(url).endsWith("/book-requests"),
      ),
    ).toHaveLength(0);
    await act(async () => button("Send request").click());
    await flush();
    const submit = fetcher.mock.calls.find(([url]) =>
      String(url).endsWith("/book-requests"),
    );
    expect(JSON.parse(String(submit?.[1]?.body))).toEqual({
      title: "Novel",
      authors: ["Author"],
      mediaKind: "audiobook",
      targetBookId: 4,
    });
    expect(host.textContent).toContain("Request received");
  });
  it("allows read-only availability but blocks submission, including direct form dispatch", async () => {
    const { client, fetcher } = fixture(true);
    await act(async () =>
      root.render(<BookFormatRequests client={client} book={book} />),
    );
    await flush();
    expect(host.textContent).toContain("read-only");
    expect(host.querySelector("fieldset")?.disabled).toBe(false);
    expect(fetcher.mock.calls.every(([, init]) => !init?.method)).toBe(true);
    await act(async () => button("Check availability").click());
    await flush();
    expect(host.textContent).toContain("Not in the library");
    expect(button("Send request").disabled).toBe(true);
    await act(async () =>
      host
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    await flush();
    expect(
      fetcher.mock.calls.filter(([url]) =>
        String(url).endsWith("/book-requests"),
      ),
    ).toHaveLength(0);
    expect(
      fetcher.mock.calls
        .filter(([, init]) => init?.method === "POST")
        .map(([url]) => String(url).split("/api/v1/")[1]),
    ).toEqual(["book-requests/availability"]);
    await act(async () => button("Check availability").click());
    await flush();
    expect(
      fetcher.mock.calls.filter(([url]) =>
        String(url).endsWith("/availability"),
      ),
    ).toHaveLength(2);
  });
  it("keeps unsupported missing-format submission disabled on older servers", async () => {
    const older = fixture(false, []);
    await act(async () =>
      root.render(<BookFormatRequests client={older.client} book={book} />),
    );
    await flush();
    expect(host.textContent).toContain("book-request-pairs");
    expect(host.querySelector("form")).toBeNull();
  });
  it("ignores a delayed availability result after replacing the account client", async () => {
    const old = fixture();
    let resolve!: (value: Response) => void;
    old.fetcher.mockImplementation(async (input: any) =>
      String(input).endsWith("/availability")
        ? new Promise((r) => {
            resolve = r;
          })
        : Response.json(
            String(input).endsWith("app-info")
              ? { version: "3.4.0", features: ["book-request-pairs"] }
              : { items: [], total: 0 },
          ),
    );
    await act(async () =>
      root.render(<BookFormatRequests client={old.client} book={book} />),
    );
    await flush();
    await act(async () => button("Check availability").click());
    const next = fixture(true);
    next.client.session.userId = "2";
    await act(async () =>
      root.render(<BookFormatRequests client={next.client} book={book} />),
    );
    await flush();
    await act(async () =>
      resolve(
        Response.json([
          {
            ownedBookId: 99,
            existingRequestId: null,
            existingRequestStatus: null,
            alreadySubscribed: false,
          },
        ]),
      ),
    );
    await flush();
    expect(host.textContent).not.toContain("Already in the library");
    expect(host.textContent).toContain("read-only");
  });
  it("shows paired status in one bounded server page with explicit paging", async () => {
    const { client, fetcher } = fixture(true);
    fetcher.mockImplementation(async (input: any) =>
      Response.json(
        String(input).endsWith("app-info")
          ? { version: "3.4.0", features: ["book-request-pairs"] }
          : {
              items: [
                {
                  ...request,
                  mediaKind: "ebook",
                  companion: {
                    ...request,
                    id: 11,
                    status: "available",
                    matchedBookId: 4,
                  },
                },
              ],
              total: 21,
            },
      ),
    );
    const open = vi.fn();
    await act(async () =>
      root.render(<BookFormatRequests client={client} onOpenBook={open} />),
    );
    await flush();
    expect(host.textContent).toContain("Audiobook · Available");
    expect(host.textContent).toContain("Page 1 · 21 requests");
    await act(async () => button("Open book").click());
    expect(open).toHaveBeenCalledWith("4");
    await act(async () => button("Next").click());
    await flush();
    expect(
      fetcher.mock.calls.some(([url]) =>
        String(url).includes("page=2&limit=20&groupPairs=true"),
      ),
    ).toBe(true);
  });
  it("provides all labels and interpolation fields in all seven locales", () => {
    for (const [key, values] of Object.entries(formatRequestMessages)) {
      expect(values, key).toHaveLength(LOCALES.length);
      for (const value of values) {
        expect(value.trim()).not.toBe("");
        expect(
          [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort(),
        ).toEqual(
          [...values[0].matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort(),
        );
      }
    }
  });
});
