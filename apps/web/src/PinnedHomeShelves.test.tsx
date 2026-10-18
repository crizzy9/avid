// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Book } from "../../../packages/core/src/types";
import { setLocale } from "../../../packages/i18n/src";
import {
  PinnedHomeShelves,
  type PinnedHomeShelvesProps,
} from "./PinnedHomeShelves";
import { demoBooks } from "./fixtures";
import { homePinT } from "./homePinMessages";
import {
  type HomePin,
  type HomePinClient,
  type HomePinRepository,
} from "./homePins";

vi.mock("./ui", () => ({
  BookCard: ({
    book,
    onSelect,
  }: {
    book: Book;
    onSelect: (book: Book) => void;
  }) => (
    <button data-book={book.id} onClick={() => onSelect(book)}>
      {book.title}
    </button>
  ),
}));
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  setLocale("en");
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  setLocale("en");
});

function repository(scope: string, initial: HomePin[] = []): HomePinRepository {
  let pins = structuredClone(initial);
  return {
    scope,
    getPreferences: vi.fn(async () => ({ pins: structuredClone(pins) })),
    patchPreferences: vi.fn(async (value) => {
      pins = structuredClone(value.pins as HomePin[]);
    }),
  };
}
function client(): HomePinClient {
  return {
    listSmartScopes: vi.fn(async () => [{ id: "1", name: "Smart favorites" }]),
    getSmartScopeBooks: vi.fn(async (_id, page = 1, size = 12) => ({
      items: [demoBooks[0]!],
      page,
      size,
      total: 1,
    })),
    getCollectionBooks: vi.fn(async (_id, page = 1, size = 12) => ({
      items: [demoBooks[1]!],
      page,
      size,
      total: 1,
    })),
  };
}
const render = (
  props: Partial<PinnedHomeShelvesProps> & Pick<PinnedHomeShelvesProps, "repo">,
) =>
  act(async () => {
    root.render(
      <PinnedHomeShelves
        client={null}
        collections={[
          { id: "1", name: "Original collection", bookIds: [demoBooks[1]!.id] },
        ]}
        books={demoBooks}
        onSelect={() => {}}
        {...props}
      />,
    );
  });
async function click(label: string) {
  const button = [...host.querySelectorAll("button")].find(
    (item) =>
      item.getAttribute("aria-label") === label || item.textContent === label,
  );
  expect(button, label).toBeDefined();
  await act(async () => {
    button!.click();
  });
}

it("pins collections and smart scopes, reorders saved shelves and keeps navigation inside the component", async () => {
  const repo = repository("first"),
    remote = client(),
    selected = vi.fn();
  await render({ repo, client: remote, onSelect: selected });
  await click("Customize Home");
  await click("Pin Original collection to Home");
  await click("Pin Smart favorites to Home");
  expect(repo.patchPreferences).toHaveBeenLastCalledWith(
    {
      pins: [
        { kind: "collection", id: "1" },
        { kind: "scope", id: "1" },
      ],
    },
    "home-pins-v1",
  );
  await click("Move Smart favorites up");
  expect(repo.patchPreferences).toHaveBeenLastCalledWith(
    {
      pins: [
        { kind: "scope", id: "1" },
        { kind: "collection", id: "1" },
      ],
    },
    "home-pins-v1",
  );
  await click("Done");
  expect(
    [...host.querySelectorAll(".home-pin-heading")].map(
      (item) => item.textContent,
    ),
  ).toEqual(["Smart favorites", "Original collection"]);
  await click("Open Smart favorites");
  expect(remote.getSmartScopeBooks).toHaveBeenLastCalledWith("1", 1, 40);
  await act(async () => {
    host.querySelector<HTMLButtonElement>("[data-book]")!.click();
  });
  expect(selected).toHaveBeenCalledWith(demoBooks[0]);
  await click("Back to Home shelves");
  await click("Customize Home");
  await click("Unpin Original collection");
  expect(repo.patchPreferences).toHaveBeenLastCalledWith(
    { pins: [{ kind: "scope", id: "1" }] },
    "home-pins-v1",
  );
});

it("retains a failed save's original order, shows a translated error, and permits retry", async () => {
  const repo = repository("first"),
    remote = client();
  vi.mocked(repo.patchPreferences).mockRejectedValueOnce(
    new Error("private storage detail"),
  );
  await render({ repo, client: remote });
  await click("Customize Home");
  await click("Pin Original collection to Home");
  expect(host.textContent).toContain("Could not save Home pins");
  expect(host.textContent).not.toContain("private storage detail");
  expect(host.querySelectorAll(".home-pin-heading")).toHaveLength(0);
  await act(async () => setLocale("fi"));
  expect(host.textContent).toContain(homePinT("saveError"));
  await click(homePinT("pin", { name: "Original collection" }));
  expect(host.querySelectorAll(".home-pin-heading")).toHaveLength(1);
});

it("does not expose an old account's late scope or book results after switching", async () => {
  const oldRepo = repository("first", [{ kind: "scope", id: "1" }]),
    remote = client();
  let resolveBooks!: (
    value: Awaited<ReturnType<HomePinClient["getSmartScopeBooks"]>>,
  ) => void;
  vi.mocked(remote.getSmartScopeBooks).mockReturnValueOnce(
    new Promise((resolve) => {
      resolveBooks = resolve;
    }),
  );
  await render({ repo: oldRepo, client: remote });
  expect(remote.getSmartScopeBooks).toHaveBeenCalledOnce();
  await render({ repo: repository("second"), collections: [], books: [] });
  await act(async () =>
    resolveBooks({
      items: [{ ...demoBooks[0]!, title: "Private old account book" }],
      total: 1,
      size: 12,
      page: 1,
    }),
  );
  expect(host.textContent).not.toContain("Private old account book");
  expect(host.textContent).not.toContain("Smart favorites");
  expect(host.querySelectorAll("[data-book]")).toHaveLength(0);
});

it("keeps unavailable pins saved and healthy collections usable when scope discovery fails", async () => {
  const pins: HomePin[] = [
    { kind: "scope", id: "1" },
    { kind: "collection", id: "1" },
  ];
  const repo = repository("first", pins),
    remote = client();
  vi.mocked(remote.listSmartScopes).mockRejectedValueOnce(new Error("network"));
  await render({ repo, client: remote });
  expect(host.textContent).toContain("Unavailable shelf");
  expect(host.querySelectorAll("[data-book]")).toHaveLength(1);
  expect(repo.patchPreferences).not.toHaveBeenCalled();
  await click("Retry");
  expect(host.querySelectorAll("[data-book]")).toHaveLength(2);
  expect(repo.patchPreferences).not.toHaveBeenCalled();
});

it("loads only the selected bounded page of a large shelf", async () => {
  const repo = repository("first", [{ kind: "scope", id: "1" }]),
    remote = client();
  vi.mocked(remote.getSmartScopeBooks).mockImplementation(
    async (_id, page = 1, size = 12) => ({
      items: Array.from({ length: size }, (_, index) => ({
        ...demoBooks[0]!,
        id: `${page}-${index}`,
        title: `Page ${page} book ${index}`,
      })),
      total: 10000,
      page,
      size,
    }),
  );
  await render({ repo, client: remote });
  expect(host.querySelectorAll("[data-book]")).toHaveLength(12);
  await click("Open Smart favorites");
  expect(host.querySelectorAll("[data-book]")).toHaveLength(40);
  await click("Next page");
  expect(remote.getSmartScopeBooks).toHaveBeenLastCalledWith("1", 2, 40);
  expect(host.querySelectorAll("[data-book]")).toHaveLength(40);
  expect(host.textContent).toContain("Page 2 book 0");
  expect(host.textContent).not.toContain("Page 1 book 0");
});

it("does not write over unreadable preferences or fetch untrusted pins", async () => {
  const repo = repository("first"),
    remote = client();
  vi.mocked(repo.getPreferences).mockResolvedValue({
    pins: [
      { kind: "scope", id: "1" },
      { kind: "scope", id: "1" },
    ],
  });
  await render({ repo, client: remote });
  await click("Customize Home");
  expect(host.textContent).toContain("They have not been overwritten");
  const pinButton = host.querySelector<HTMLButtonElement>(
    '[aria-label="Pin Original collection to Home"]',
  );
  expect(pinButton?.disabled).toBe(true);
  expect(remote.getSmartScopeBooks).not.toHaveBeenCalled();
  expect(repo.patchPreferences).not.toHaveBeenCalled();
});
