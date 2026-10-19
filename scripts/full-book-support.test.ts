import { describe, it, expect, vi } from "vitest";
const { git } = vi.hoisted(() => ({ git: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync: git }));
import { fullBookAsset, safeReportName } from "./full-book-support.mjs";
describe("local full book fixture boundaries", () => {
  const manifest = {
    books: [
      {
        id: "alice",
        epub: { path: "alice/book.epub" },
        audio: [{ path: "alice/01.mp3" }],
      },
    ],
  };
  it("serves only an explicit manifest entry under the corpus", () => {
    expect(fullBookAsset("/tmp/corpus", manifest, "alice", "audio", "0")).toBe(
      "/tmp/corpus/alice/01.mp3",
    );
    expect(() =>
      fullBookAsset("/tmp/corpus", manifest, "alice", "audio", "../0"),
    ).toThrow();
    expect(() =>
      fullBookAsset("/tmp/corpus", manifest, "bob", "epub", null),
    ).toThrow();
    expect(() =>
      fullBookAsset(
        "/tmp/corpus",
        { books: [{ id: "alice", epub: { path: "../secret" } }] },
        "alice",
        "epub",
        null,
      ),
    ).toThrow();
  });
  it("cannot choose an arbitrary output path", () => {
    expect(safeReportName("alice-baseline")).toBe("alice-baseline");
    for (const name of [
      "../secret",
      "a/b",
      "/tmp/a",
      "x.json",
      null,
      "a".repeat(129),
    ])
      expect(() => safeReportName(name)).toThrow();
  });
});

import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  preparationSourceFiles,
  sourceProof,
  DEFAULT_BOOK_TIMEOUT_MS,
  localFixtureUrl,
  harnessOutcome,
  terminalSuiteStatus,
} from "./full-book-support.mjs";
it("compares a non-Git frozen snapshot with the original repository baseline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "avid-proof-")),
    repository = join(directory, "repository"),
    snapshot = join(directory, "snapshot");
  try {
    await mkdir(repository);
    await mkdir(snapshot);
    for (const file of preparationSourceFiles) {
      for (const root of [repository, snapshot]) {
        await mkdir(dirname(join(root, file)), { recursive: true });
        await writeFile(join(root, file), "frozen:" + file);
      }
    }
    const baseline = "a".repeat(40);
    git.mockImplementation(
      (binary: string, args: string[], options: { cwd: string }) => {
        expect(binary).toBe("git");
        expect(options.cwd).toBe(repository);
        if (args[0] === "rev-parse") return baseline + "\n";
        expect(args[0]).toBe("show");
        expect(args[1].startsWith(baseline + ":")).toBe(true);
        return readFileSync(
          join(repository, args[1].slice(baseline.length + 1)),
        );
      },
    );
    expect(
      sourceProof(snapshot, baseline, repository).every(
        (item) => item.matchesBaseline,
      ),
    ).toBe(true);
    expect(preparationSourceFiles).toHaveLength(17);
    expect(preparationSourceFiles).toContain(
      "packages/readers/src/EbookView.tsx",
    );
    await writeFile(join(snapshot, "pnpm-lock.yaml"), "changed dependency");
    expect(
      sourceProof(snapshot, baseline, repository)
        .filter((item) => !item.matchesBaseline)
        .map((item) => item.path),
    ).toEqual(["pnpm-lock.yaml"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
it("allows only explicit local fixtures and only prepared as a successful harness result", () => {
  expect(DEFAULT_BOOK_TIMEOUT_MS).toBe(86400000);
  expect(localFixtureUrl("http://127.0.0.1:5185/fixture").port).toBe("5185");
  for (const url of [
    "https://127.0.0.1/",
    "http://localhost/",
    "http://user@127.0.0.1/",
    "http://example.com/",
  ])
    expect(() => localFixtureUrl(url)).toThrow();
  expect(harnessOutcome("prepared")?.exitCode).toBe(0);
  for (const status of ["failed", "cancelled", "complete"])
    expect(harnessOutcome(status)?.exitCode).toBe(1);
  expect(
    terminalSuiteStatus([{ status: "prepared" }, { status: "failed" }]),
  ).toBe("completed-with-failures");
  expect(
    terminalSuiteStatus([{ status: "prepared" }, { status: "not-started" }]),
  ).toBe("completed-with-failures");
});
