// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BookDetails } from "./BookDetails";
import { BookOrbitClient } from "../../../packages/core/src/bookorbit";
import type { Book } from "../../../packages/core/src/types";
import { setLocale, translate } from "../../../packages/i18n/src";
import { appTranslate } from "./appMessages";

const book: Book = {
  id: "local-book",
  title: "Treasure Island",
  authors: ["Robert Louis Stevenson"],
  description: "Young Jim Hawkins finds a map.",
  format: "EPUB",
  files: [
    { id: "epub", name: "Island.epub", format: "EPUB" },
    { id: "pdf", name: "Island.pdf", format: "PDF" },
    { id: "audio", name: "Island.mp3", format: "AUDIO" },
  ],
  genres: ["Fiction", "Adventure"],
  color: "#176d77",
  progress: 0,
  status: "unread",
  addedAt: "2026-10-09T00:00:00Z",
};
let host: HTMLDivElement, root: Root;
let props: ComponentProps<typeof BookDetails>;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  props = {
    book,
    client: null,
    collections: [],
    annotations: [],
    readOnly: false,
    onRead: vi.fn(),
    onListen: vi.fn(),
    onQueue: vi.fn(),
    onStatus: vi.fn(),
    onShowNotes: vi.fn(),
  };
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  setLocale("en");
});
async function render(
  changes: Partial<ComponentProps<typeof BookDetails>> = {},
) {
  props = { ...props, ...changes };
  await act(async () => root.render(<BookDetails {...props} />));
}
function button(label: string) {
  return [...host.querySelectorAll("button")].find(
    (item) =>
      item.textContent === label || item.getAttribute("aria-label") === label,
  )!;
}
async function click(label: string) {
  await act(async () => button(label).click());
}

describe("book details reference sheet", () => {
  it("omits ratings and publication facts when metadata is unavailable", async () => {
    await render();
    expect(host.querySelector(".book-detail-handle")).not.toBeNull();
    expect(host.querySelector(".book-detail-personal-rating")).toBeNull();
    expect(host.querySelector(".book-detail-community")).toBeNull();
    expect(host.textContent).not.toContain(appTranslate("detailPublished"));
    expect(host.textContent).not.toContain(appTranslate("detailPublisher"));
    expect(host.textContent).toContain("EPUB + PDF + AUDIO");
  });
  it("shows only supplied ratings, provider counts and publication metadata", async () => {
    await render({
      book: {
        ...book,
        rating: 3.5,
        publishedYear: 1883,
        publisher: "Project Gutenberg",
        communityRatings: [
          { provider: "goodreads", rating: 3.8, ratingCount: 1234 },
          { provider: "hardcover", rating: 4 },
        ],
      },
    });
    expect(
      host
        .querySelector(".book-detail-personal-rating")
        ?.getAttribute("aria-label"),
    ).toBe("Your rating: 3.5 out of 5");
    expect(host.querySelectorAll(".book-detail-community-score")).toHaveLength(
      2,
    );
    expect(host.querySelectorAll(".book-detail-rating-count")).toHaveLength(1);
    expect(host.textContent).toContain("1,234 ratings");
    expect(host.textContent).toContain("1883");
    expect(host.textContent).toContain("Project Gutenberg");
    expect(host.textContent).not.toContain("iTunes");
  });
  it("preserves edition, read, listen, queue, status and notebook actions under More", async () => {
    await render();
    await click(translate("common.more"));
    await act(async () => {
      const select = host.querySelector<HTMLSelectElement>(
        ".edition-select select",
      )!;
      select.value = "pdf";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click(translate("detail.start"));
    expect(props.onRead).toHaveBeenCalledWith("pdf");
    await click(translate("common.listen"));
    expect(props.onListen).toHaveBeenCalledOnce();
    await click(translate("detail.queue"));
    expect(props.onQueue).toHaveBeenCalledOnce();
    await act(async () => {
      const select = host.querySelector<HTMLSelectElement>(
        ".status-select select",
      )!;
      select.value = "read";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(props.onStatus).toHaveBeenCalledWith("read");
    await click(translate("detail.openNotebook"));
    expect(props.onShowNotes).toHaveBeenCalledOnce();
  });
  it("keeps server mutation controls disabled in read-only mode while allowing reading", async () => {
    await render({ readOnly: true });
    await click(translate("common.more"));
    expect(button(translate("detail.queue")).disabled).toBe(true);
    expect(
      host.querySelector<HTMLSelectElement>(".status-select select")!.disabled,
    ).toBe(true);
    await click(translate("detail.queue"));
    expect(props.onQueue).not.toHaveBeenCalled();
    await click(translate("detail.start"));
    expect(props.onRead).toHaveBeenCalledWith("epub");
  });
  it("discards a prior book edition selection and resets the expanded tools", async () => {
    await render();
    await click(translate("common.more"));
    await act(async () => {
      const select = host.querySelector<HTMLSelectElement>(
        ".edition-select select",
      )!;
      select.value = "pdf";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await render({
      book: {
        ...book,
        id: "local-other",
        files: [{ id: "other", name: "Other.epub", format: "EPUB" }],
      },
    });
    expect(host.querySelector(".book-detail-tools")).toBeNull();
    await click(translate("detail.start"));
    expect(props.onRead).toHaveBeenLastCalledWith("other");
  });
  it("ignores a delayed detail response from a previous account with the same book ID", async () => {
    const first = new BookOrbitClient({
      profile: { id: "a", name: "A", url: "https://a.example" },
      userId: "1",
      accessToken: "a",
    });
    const second = new BookOrbitClient({
      profile: { id: "b", name: "B", url: "https://b.example" },
      userId: "2",
      accessToken: "b",
    });
    let resolve!: (value: Book) => void;
    vi.spyOn(first, "getBook").mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    vi.spyOn(second, "getBook").mockResolvedValue({
      ...book,
      id: "31",
      publisher: "Current account publisher",
    });
    await render({ book: { ...book, id: "31" }, client: first });
    await render({ client: second });
    await act(async () =>
      resolve({
        ...book,
        id: "31",
        publisher: "Old account publisher",
        communityRatings: [{ provider: "goodreads", rating: 5 }],
      }),
    );
    expect(host.textContent).toContain("Current account publisher");
    expect(host.textContent).not.toContain("Old account publisher");
    expect(host.querySelector(".book-detail-community")).toBeNull();
  });
  it("expands long descriptions without interpreting markup as elements", async () => {
    await render({
      book: {
        ...book,
        description:
          "<p>" +
          "An original description. ".repeat(30) +
          "</p><script>hidden()</script>",
      },
    });
    expect(host.querySelector("script")).toBeNull();
    await click(appTranslate("detailReadMore"));
    expect(host.querySelector(".book-detail-description-preview")).toBeNull();
    expect(
      button(appTranslate("detailShowLess")).getAttribute("aria-expanded"),
    ).toBe("true");
  });
});
