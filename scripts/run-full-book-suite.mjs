// Opt-in long-running suite. Use a fresh output directory; processing itself is not resumable.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  platform,
  release,
  arch,
  totalmem,
  availableParallelism,
  cpus,
} from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DEFAULT_BOOK_TIMEOUT_MS,
  abortable,
  atomicJson,
  delay,
  failure,
  failureStatus,
  hash,
  positiveInteger,
  safeReportName,
  terminalSuiteStatus,
} from "./full-book-support.mjs";
import { verifyManifest } from "./full-book-corpus.mjs";

export function bookResult(bookId, exit, report) {
  const run = report?.runs?.find((item) => item.bookId === bookId);
  if (
    exit.code === 0 &&
    report?.status === "completed" &&
    run?.status === "prepared"
  )
    return {
      status: "prepared",
      runnerStatus: report.status,
      processExit: exit,
    };
  return {
    status: ["failed", "cancelled", "timed-out", "interrupted"].includes(
      run?.status,
    )
      ? run.status
      : "failed",
    runnerStatus: report?.status ?? "missing",
    processExit: exit,
    error:
      run?.error ??
      report?.error?.message ??
      "Runner did not produce a successful terminal record.",
  };
}
function spawnLogged(command, args, { cwd, logFile }) {
  const log = createWriteStream(logFile, { flags: "wx" });
  const child = spawn(command, args, {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  let closed = false,
    launchError,
    stdoutTail = "";
  child.stdout.on("data", (chunk) => {
    stdoutTail = (stdoutTail + String(chunk)).slice(-16000);
  });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  child.on("error", (error) => {
    launchError = error;
  });
  const completion = new Promise((resolve) =>
    child.once("close", (code, signal) => {
      closed = true;
      log.end();
      resolve({ code, signal, error: launchError?.message });
    }),
  );
  log.on("error", (error) => {
    launchError = error;
    child.kill("SIGTERM");
  });
  return {
    child,
    completion,
    get closed() {
      return closed;
    },
    get error() {
      return launchError;
    },
    get stdout() {
      return stdoutTail;
    },
  };
}
async function stopProcess(processHandle) {
  if (!processHandle || processHandle.closed) return;
  const kill = (signal) => {
    try {
      if (process.platform !== "win32" && processHandle.child.pid)
        process.kill(-processHandle.child.pid, signal);
      else processHandle.child.kill(signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  kill("SIGTERM");
  await Promise.race([processHandle.completion, delay(10000)]);
  if (!processHandle.closed) {
    kill("SIGKILL");
    await Promise.race([processHandle.completion, delay(5000)]);
  }
}
async function waitForServer(origin, server, signal) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    if (server.closed)
      throw Error(
        `Fixture server exited during startup: ${server.error?.message ?? "see server.log"}`,
      );
    if (!server.stdout.includes(`Full-book fixture: ${origin}/`)) {
      await delay(500, signal);
      continue;
    }
    try {
      const response = await fetch(new URL("/__fullbook/config", origin), {
        signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]),
      });
      if (response.ok) return await response.json();
    } catch (error) {
      if (signal.aborted) throw signal.reason;
    }
    await delay(500, signal);
  }
  throw Error("Fixture server did not become ready within 120 seconds.");
}
async function readBrowserReport(output) {
  try {
    return JSON.parse(
      await readFile(resolve(output, "browser-runtime.json"), "utf8"),
    );
  } catch {
    return null;
  }
}
export async function runSuite(options) {
  const root = resolve(
    options.sourceRoot ??
      resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  );
  const corpus = resolve(options.corpus),
    output = resolve(options.output),
    port = positiveInteger(options.port ?? 5185, "Port");
  if (port > 65535) throw Error("Port must be at most 65535.");
  const timeoutMs = positiveInteger(
    options.bookTimeoutMs ?? DEFAULT_BOOK_TIMEOUT_MS,
    "Book watchdog",
  );
  const signal = options.signal ?? new AbortController().signal;
  await mkdir(output, { recursive: true });
  const reportFile = resolve(output, "suite-runtime.json");
  try {
    await access(reportFile);
    throw Error(
      "Suite evidence already exists. Use a fresh output directory; baseline ASR is not resumable.",
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const evidence = {
    schemaVersion: 1,
    status: "running",
    startedAt: new Date().toISOString(),
    sourceCommit: process.env.AVID_SOURCE_COMMIT ?? null,
    host: {
      platform: platform(),
      release: release(),
      architecture: arch(),
      totalMemoryBytes: totalmem(),
      availableParallelism: availableParallelism(),
      cpuModel: cpus()[0]?.model ?? null,
      nodeVersion: process.version,
    },
    baselineRepository: process.env.AVID_BASELINE_REPOSITORY ?? root,
    watchdogMsPerBook: timeoutMs,
    origin: `http://127.0.0.1:${port}`,
    runs: [],
    qualityReview: "not performed",
    nativeAcceptance: "not performed",
  };
  let server,
    runner,
    activeRun,
    stage = "corpus-verification";
  const persist = () => atomicJson(reportFile, evidence);
  await persist();
  try {
    const manifestText = await readFile(
        resolve(corpus, "manifest.json"),
        "utf8",
      ),
      manifest = JSON.parse(manifestText);
    evidence.corpusSha256 = hash(manifestText);
    evidence.inventory = await verifyManifest(manifest, corpus);
    const ids = options.bookIds ?? manifest.books.map((book) => book.id);
    if (
      !ids.length ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !manifest.books.some((book) => book.id === id))
    )
      throw Error("Invalid requested corpus books.");
    ids.forEach(safeReportName);
    evidence.requestedBooks = ids;
    await persist();
    stage = "server-startup";
    server = spawnLogged(
      process.execPath,
      [
        resolve(root, "scripts/full-book-server.mjs"),
        "--corpus",
        corpus,
        "--output",
        output,
        "--port",
        String(port),
      ],
      { cwd: root, logFile: resolve(output, "server.log") },
    );
    const configuration = await waitForServer(evidence.origin, server, signal);
    evidence.sourceCommit = configuration.commit;
    evidence.sourceProof = configuration.sourceProof;
    evidence.harnessProof = configuration.harnessProof;
    evidence.buildProof = configuration.buildProof;
    if (configuration.corpusManifestSha256 !== evidence.corpusSha256)
      throw Error(
        "Fixture corpus identity differs from the verified suite manifest.",
      );
    if (configuration.sourceProof?.some((item) => !item.matchesBaseline))
      throw Error("Fixture source proof differs from baseline.");
    await persist();
    for (const bookId of ids) {
      if (signal.aborted) throw signal.reason;
      if (
        hash(await readFile(resolve(corpus, "manifest.json"), "utf8")) !==
        evidence.corpusSha256
      )
        throw Error("Frozen corpus manifest changed during suite.");
      stage = "book";
      const started = Date.now(),
        browserOutput = resolve(output, "browsers", bookId);
      await mkdir(browserOutput, { recursive: true });
      activeRun = {
        bookId,
        status: "running",
        startedAt: new Date().toISOString(),
        browserOutput,
      };
      evidence.runs.push(activeRun);
      await persist();
      console.log(
        `Suite starting ${bookId}; watchdog ${(timeoutMs / 3600000).toFixed(2)} hours.`,
      );
      const url = new URL(
        "/packages/readers/fixtures/full-book.html",
        evidence.origin,
      );
      runner = spawnLogged(
        process.execPath,
        [
          resolve(root, "scripts/run-full-book-browser.mjs"),
          "--url",
          url.href,
          "--output",
          browserOutput,
          "--book",
          bookId,
          "--book-timeout-ms",
          String(timeoutMs),
        ],
        { cwd: root, logFile: resolve(browserOutput, "runner.log") },
      );
      const exit = await abortable(
        Promise.race([
          runner.completion,
          server.completion.then((result) => {
            throw Error(
              `Fixture server terminated during ${bookId}: ${result.code ?? result.signal}`,
            );
          }),
        ]),
        signal,
      );
      const report = await readBrowserReport(browserOutput);
      Object.assign(activeRun, bookResult(bookId, exit, report), {
        elapsedMs: Date.now() - started,
        finishedAt: new Date().toISOString(),
      });
      runner = undefined;
      await persist();
      console.log(`Suite finished ${bookId}: ${activeRun.status}.`);
    }
    evidence.status = terminalSuiteStatus(evidence.runs);
  } catch (error) {
    evidence.status = failureStatus(error);
    evidence.error = { message: error.message, stage };
    if (activeRun?.status === "running")
      Object.assign(activeRun, {
        status: failureStatus(error),
        error: error.message,
        finishedAt: new Date().toISOString(),
      });
  } finally {
    // Let the runner save its terminal partial record before stopping its fixture server.
    try {
      await stopProcess(runner);
    } catch (error) {
      evidence.runnerCleanupError = error.message;
    }
    if (activeRun?.browserOutput && runner) {
      const partial = await readBrowserReport(activeRun.browserOutput);
      activeRun.lastRunnerStatus = partial?.status ?? "missing";
      activeRun.lastObserved =
        partial?.runs?.find((run) => run.bookId === activeRun.bookId)
          ?.lastObserved ?? null;
    }
    try {
      await stopProcess(server);
    } catch (error) {
      evidence.serverCleanupError = error.message;
    }
    if (evidence.runnerCleanupError || evidence.serverCleanupError)
      evidence.status = "failed";
    for (const bookId of evidence.requestedBooks ?? [])
      if (!evidence.runs.some((run) => run.bookId === bookId))
        evidence.runs.push({
          bookId,
          status: "not-started",
          reason: "Suite terminated before this book.",
        });
    evidence.finishedAt = new Date().toISOString();
    await persist();
  }
  return {
    evidence,
    exitCode: evidence.status === "completed" ? 0 : signal.aborted ? 143 : 1,
  };
}
async function main() {
  const args = process.argv.slice(2),
    value = (name, fallback) =>
      args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  if (args.includes("--help")) {
    console.log(
      "node scripts/run-full-book-suite.mjs --corpus /tmp/avid-full-books --output /tmp/fresh-suite [--source-root /tmp/frozen-source] [--port 5185] [--book ID] [--book-timeout-ms 86400000]\nDefaults to all corpus books sequentially, with one isolated browser per book and 24h watchdog. Use a fresh output directory. No processing-resume or matching-quality claim.",
    );
    return;
  }
  if (!value("--corpus") || !value("--output"))
    throw Error("Provide --corpus and a fresh external --output directory.");
  const controller = new AbortController();
  const interrupt = (signal) =>
    controller.abort(
      failure(
        "interrupted",
        `Suite received ${signal}; partial evidence retained.`,
      ),
    );
  const sigint = () => interrupt("SIGINT"),
    sigterm = () => interrupt("SIGTERM");
  process.on("SIGINT", sigint);
  process.on("SIGTERM", sigterm);
  try {
    const result = await runSuite({
      sourceRoot: value("--source-root"),
      corpus: value("--corpus"),
      output: value("--output"),
      port: value("--port", 5185),
      bookIds: value("--book") ? [value("--book")] : undefined,
      bookTimeoutMs: value("--book-timeout-ms", DEFAULT_BOOK_TIMEOUT_MS),
      signal: controller.signal,
    });
    process.exitCode = result.exitCode;
  } finally {
    process.removeListener("SIGINT", sigint);
    process.removeListener("SIGTERM", sigterm);
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
