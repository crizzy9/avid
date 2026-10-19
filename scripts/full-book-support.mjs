import { resolve, sep } from "node:path";
import { readFileSync } from "node:fs";
import { writeFile, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
export const preparationSourceFiles = [
  "apps/web/src/preparation/prepareReadListen.ts",
  "apps/web/src/preparation/audioWindows.ts",
  "apps/web/src/preparation/transcription.ts",
  "apps/web/src/preparation/transcription.worker.ts",
  "apps/web/src/preparation/model.ts",
  "apps/web/src/preparation/match.ts",
  "apps/web/src/preparation/match.worker.ts",
  "packages/playback/src/generated-alignment.ts",
  "packages/playback/src/audioDuration.ts",
  "packages/playback/src/standalone-alignment.ts",
  "packages/readers/src/generatedText.ts",
  "packages/readers/src/alignedPassage.ts",
  "packages/core/src/preparedReadListen.ts",
  "package.json",
  "pnpm-lock.yaml",
  "packages/readers/src/Reader.tsx",
  "packages/readers/src/EbookView.tsx",
];
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export function sourceProof(
  root,
  baseline,
  repository = process.env.AVID_BASELINE_REPOSITORY ?? root,
) {
  const baselineCommit = execFileSync(
    "git",
    ["rev-parse", "--verify", `${baseline}^{commit}`],
    { cwd: repository, encoding: "utf8" },
  ).trim();
  return preparationSourceFiles.map((path) => {
    const sha256 = hash(readFileSync(resolve(root, path)));
    const baselineSha256 = hash(
      execFileSync("git", ["show", `${baselineCommit}:${path}`], {
        cwd: repository,
      }),
    );
    return {
      path,
      sha256,
      baselineSha256,
      matchesBaseline: sha256 === baselineSha256,
    };
  });
}
export function safeReportName(name) {
  if (typeof name !== "string" || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(name))
    throw Error("Invalid report name.");
  return name;
}
export function fullBookAsset(root, manifest, bookId, kind, index) {
  const book = manifest.books.find((item) => item.id === bookId);
  if (!book) throw Error("Unknown corpus book.");
  const item =
    kind === "epub"
      ? book.epub
      : kind === "audio" && /^\d+$/.test(index ?? "")
        ? book.audio[Number(index)]
        : null;
  if (!item?.path) throw Error("Unknown corpus asset.");
  const path = resolve(root, item.path);
  if (!path.startsWith(resolve(root) + sep))
    throw Error("Corpus path outside selected directory.");
  return path;
}
export const DEFAULT_BOOK_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0)
    throw Error(`${name} must be a positive integer.`);
  return number;
}
export function localFixtureUrl(value) {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username ||
    url.password
  )
    throw Error("The benchmark only opens an HTTP fixture on 127.0.0.1.");
  return url;
}
export function harnessOutcome(status) {
  if (status === "prepared") return { status: "prepared", exitCode: 0 };
  if (status === "failed" || status === "cancelled")
    return { status, exitCode: 1 };
  if (status)
    return {
      status: "failed",
      exitCode: 1,
      error: `Unknown harness terminal status: ${String(status)}`,
    };
  return null;
}
export function terminalSuiteStatus(runs, interrupted = false) {
  if (interrupted) return "interrupted";
  if (runs.length && runs.every((run) => run.status === "prepared"))
    return "completed";
  return "completed-with-failures";
}
export async function atomicJson(file, value) {
  const temporary = `${file}.${process.pid}.partial`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n");
  await rename(temporary, file);
}
export function failureStatus(error) {
  return ["interrupted", "timed-out"].includes(error?.status)
    ? error.status
    : "failed";
}
export function failure(status, message) {
  return Object.assign(new Error(message), { status });
}
export function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted)
    return Promise.reject(
      signal.reason ?? failure("interrupted", "Interrupted."),
    );
  return new Promise((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(signal.reason ?? failure("interrupted", "Interrupted."));
    };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}
export function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
