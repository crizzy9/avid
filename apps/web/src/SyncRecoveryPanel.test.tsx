// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BookOrbitClient } from "../../../packages/core/src/bookorbit";
import {
  AvidDatabase,
  LibraryRepository,
  type OutboxOperation,
} from "../../../packages/core/src/repository";
import {
  SyncRecovery,
  type SyncReview,
} from "../../../packages/core/src/syncRecovery";
import { setLocale } from "../../../packages/i18n/src";
import { SyncRecoveryPanel } from "./SyncRecoveryPanel";
import { recoveryMessages } from "./recoveryMessages";

const session = {
  profile: { id: "one", name: "Library", url: "https://books.example" },
  userId: "1",
  accessToken: "secret",
};
const repo = new LibraryRepository(new AvidDatabase("panel-test"), session),
  client = new BookOrbitClient(session);
const anchor = {
  bookId: "4",
  fileId: "5",
  kind: "epub" as const,
  locator: "epubcfi(/6/2)",
  progress: 0.3,
  updatedAt: "2026-10-09T10:00:00Z",
};
const operation: OutboxOperation = {
  id: "operation",
  key: "key",
  scope: repo.scope,
  entityKey: "progress",
  occurredAt: anchor.updatedAt,
  status: "conflict",
  attempts: 1,
  payload: { kind: "progress", anchor },
};
const review: SyncReview = {
  scope: repo.scope,
  operation,
  operations: [operation],
  local: operation.payload,
  remote: {
    kind: "progress",
    value: { ...anchor, locator: "epubcfi(/6/8)", progress: 0.1 },
  },
};
let root: Root;
beforeEach(() => {
  (
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  setLocale("en");
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.spyOn(SyncRecovery.prototype, "list").mockResolvedValue([operation]);
  vi.spyOn(SyncRecovery.prototype, "receipts").mockResolvedValue([]);
  vi.spyOn(LibraryRepository.prototype, "getBooks").mockResolvedValue([]);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  setLocale("en");
});
async function click(text: string) {
  await act(async () => {
    const button = [...document.querySelectorAll("button")].find(
      (item) => item.textContent === text,
    );
    expect(button).toBeDefined();
    button!.click();
  });
}

it("shows both exact versions and applies only the explicitly selected action", async () => {
  vi.spyOn(SyncRecovery.prototype, "inspect").mockResolvedValue(review);
  const resolve = vi
    .spyOn(SyncRecovery.prototype, "resolve")
    .mockResolvedValue({
      id: "receipt",
      action: "use-server",
      resolvedAt: anchor.updatedAt,
      review,
    });
  const onResolved = vi.fn();
  await act(async () =>
    root.render(
      <SyncRecoveryPanel repo={repo} client={client} onResolved={onResolved} />,
    ),
  );
  expect(resolve).not.toHaveBeenCalled();
  await click("Compare versions");
  expect(document.body.textContent).toContain("epubcfi(/6/2)");
  expect(document.body.textContent).toContain("epubcfi(/6/8)");
  expect(resolve).not.toHaveBeenCalled();
  await click("Use the server version");
  expect(resolve).toHaveBeenCalledWith(review, "use-server");
  expect(onResolved).toHaveBeenCalledTimes(1);
});
it("discards a late comparison after the account changes", async () => {
  let finish!: (value: SyncReview) => void;
  vi.spyOn(SyncRecovery.prototype, "inspect").mockReturnValue(
    new Promise((done) => {
      finish = done;
    }),
  );
  await act(async () =>
    root.render(<SyncRecoveryPanel repo={repo} client={client} />),
  );
  await click("Compare versions");
  const next = { ...session, userId: "2" };
  const nextRepo = new LibraryRepository(repo.db, next),
    nextClient = new BookOrbitClient(next);
  await act(async () =>
    root.render(<SyncRecoveryPanel repo={nextRepo} client={nextClient} />),
  );
  await act(async () => finish(review));
  expect(document.body.textContent).not.toContain("epubcfi(/6/2)");
  expect(document.body.textContent).not.toContain("epubcfi(/6/8)");
});
it("exposes only the local keep action for a read-only connection", async () => {
  vi.spyOn(SyncRecovery.prototype, "inspect").mockResolvedValue({
    ...review,
    remote: { kind: "unavailable", reason: "read-only" },
  });
  await act(async () =>
    root.render(
      <SyncRecoveryPanel
        repo={repo}
        client={new BookOrbitClient(session, { readOnly: true })}
      />,
    ),
  );
  await click("Compare versions");
  const labels = [...document.querySelectorAll("button")].map(
    (item) => item.textContent,
  );
  expect(labels).toContain("Keep on this device only");
  expect(labels).not.toContain("Use this device’s version");
  expect(labels).not.toContain("Retry safely");
});
it("provides all seven translations with matching interpolation placeholders", () => {
  for (const translations of Object.values(recoveryMessages)) {
    expect(translations).toHaveLength(7);
    const placeholders = translations[0].match(/\{\w+\}/g) ?? [];
    for (const text of translations) {
      expect(text.trim()).not.toBe("");
      expect(text.match(/\{\w+\}/g) ?? []).toEqual(placeholders);
    }
  }
});
