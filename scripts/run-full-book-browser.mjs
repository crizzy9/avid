// Opt-in isolated Chromium runner. No user browser/profile or remote account is used.
import { spawn } from "node:child_process";
import { mkdir, readFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_BOOK_TIMEOUT_MS,
  abortable,
  atomicJson,
  delay,
  failure,
  failureStatus,
  harnessOutcome,
  localFixtureUrl,
  positiveInteger,
  terminalSuiteStatus,
} from "./full-book-support.mjs";

export function createCdpClient(
  socket,
  { timeoutMs = 30000, onEvent = () => {} } = {},
) {
  let serial = 0,
    closedError;
  const pending = new Map();
  function fail(error) {
    closedError = error;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  }
  socket.addEventListener("close", (event) =>
    fail(
      Error(
        `CDP socket closed (${event.code ?? "unknown"}): ${event.reason ?? ""}`,
      ),
    ),
  );
  socket.addEventListener("error", () => fail(Error("CDP socket error.")));
  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      fail(Error("Invalid CDP message."));
      return;
    }
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      message.error
        ? request.reject(Error(JSON.stringify(message.error)))
        : request.resolve(message.result);
    } else onEvent(message);
  });
  return {
    call(method, params = {}, sessionId, options = {}) {
      if (closedError) return Promise.reject(closedError);
      if (socket.readyState !== 1)
        return Promise.reject(Error("CDP socket is not open."));
      const request = new Promise((resolve, reject) => {
        const id = ++serial,
          timer = setTimeout(() => {
            pending.delete(id);
            reject(Error(`CDP command timed out: ${method}`));
          }, options.timeoutMs ?? timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try {
          socket.send(
            JSON.stringify({
              id,
              method,
              params,
              ...(sessionId ? { sessionId } : {}),
            }),
          );
        } catch (error) {
          pending.delete(id);
          clearTimeout(timer);
          reject(error);
        }
      });
      return abortable(request, options.signal);
    },
    close() {
      fail(Error("CDP connection closed by runner."));
      socket.close();
    },
  };
}
async function openSocket(endpoint, signal, timeoutMs) {
  const socket = new WebSocket(endpoint);
  try {
    await abortable(
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(Error("CDP socket open timed out."));
        }, timeoutMs);
        const cleanup = () => {
          clearTimeout(timer);
          socket.removeEventListener("open", opened);
          socket.removeEventListener("error", errored);
          socket.removeEventListener("close", closed);
        };
        const opened = () => {
          cleanup();
          resolve();
        };
        const errored = () => {
          cleanup();
          reject(Error("CDP socket failed to open."));
        };
        const closed = () => {
          cleanup();
          reject(Error("CDP socket closed before opening."));
        };
        socket.addEventListener("open", opened);
        socket.addEventListener("error", errored);
        socket.addEventListener("close", closed);
      }),
      signal,
    );
    return socket;
  } catch (error) {
    socket.close();
    throw error;
  }
}
async function stopChromium(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await Promise.race([exited, delay(5000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([exited, delay(5000)]);
  }
}
export async function launchChromium({
  output,
  signal,
  onEvent,
  commandTimeoutMs,
}) {
  const chromium = spawn(
    process.env.AVID_CHROMIUM ?? "chromium",
    [
      "--headless",
      "--disable-dev-shm-usage",
      "--remote-debugging-port=0",
      `--user-data-dir=${output}/chromium-profile`,
      "--autoplay-policy=no-user-gesture-required",
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "",
    socket,
    client;
  chromium.stderr.on("data", (chunk) => {
    stderr = (stderr + String(chunk)).slice(-65536);
  });
  try {
    const endpoint = await abortable(
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(Error(`Chromium startup timed out: ${stderr.slice(-2000)}`));
        }, 45000);
        const cleanup = () => {
          clearTimeout(timer);
          chromium.stderr.removeListener("data", data);
          chromium.removeListener("error", errored);
          chromium.removeListener("exit", exited);
        };
        const data = () => {
          const found = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
          if (found) {
            cleanup();
            resolve(found[1]);
          }
        };
        const errored = (error) => {
          cleanup();
          reject(error);
        };
        const exited = (code, signal) => {
          cleanup();
          reject(
            Error(
              `Chromium exited before CDP (${code ?? signal}): ${stderr.slice(-2000)}`,
            ),
          );
        };
        chromium.stderr.on("data", data);
        chromium.on("error", errored);
        chromium.on("exit", exited);
      }),
      signal,
    );
    socket = await openSocket(endpoint, signal, 30000);
    client = createCdpClient(socket, { onEvent, timeoutMs: commandTimeoutMs });
    return {
      client,
      pid: chromium.pid,
      stderr: () => stderr,
      close: async () => {
        client.close();
        await stopChromium(chromium);
      },
    };
  } catch (error) {
    socket?.close();
    await stopChromium(chromium);
    throw error;
  }
}
async function rss(pid) {
  try {
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    return Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) * 1024;
  } catch {
    return null;
  }
}
async function configuration(url, signal) {
  const response = await fetch(new URL("/__fullbook/config", url), {
    signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
  });
  if (!response.ok)
    throw Error(`Fixture configuration HTTP ${response.status}.`);
  return response.json();
}
export async function runBrowser(options, dependencies = {}) {
  const base = localFixtureUrl(options.url),
    output = resolve(options.output);
  const timeoutMs = positiveInteger(
    options.bookTimeoutMs ?? DEFAULT_BOOK_TIMEOUT_MS,
    "Book watchdog",
  );
  const pollMs = positiveInteger(options.pollMs ?? 5000, "Poll interval");
  const signal = options.signal ?? new AbortController().signal;
  const log = dependencies.log ?? console.log;
  await mkdir(output, { recursive: true });
  const reportFile = resolve(output, "browser-runtime.json");
  for (const existing of [reportFile, resolve(output, "chromium-profile")]) {
    try {
      await access(existing);
      throw Error(
        "Browser evidence or profile already exists. Use a fresh output directory.",
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const evidence = {
    schemaVersion: 2,
    status: "running",
    startedAt: new Date().toISOString(),
    watchdogMsPerBook: timeoutMs,
    sourceCommit: process.env.AVID_SOURCE_COMMIT ?? null,
    runs: [],
    samples: [],
    exceptions: [],
    memoryMeasurement:
      "Linux /proc VmRSS per Chromium process; null when unavailable. RSS is not an independently measured mobile memory budget.",
    qualityReview: "not performed",
    nativeAcceptance: "not performed",
  };
  let browser,
    activeRun,
    stage = "configuration";
  const persist = () => atomicJson(reportFile, evidence);
  await persist();
  try {
    const config = await (dependencies.fetchConfig ?? configuration)(
      base,
      signal,
    );
    if (!Array.isArray(config.corpus?.books) || !config.corpus.books.length)
      throw Error("Fixture has no corpus books.");
    const ids = options.bookIds ?? config.corpus.books.map((book) => book.id);
    if (
      !ids.length ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !config.corpus.books.some((book) => book.id === id))
    )
      throw Error("Invalid requested book inventory.");
    evidence.requestedBooks = ids;
    evidence.sourceCommit = config.commit;
    evidence.baseline = config.baseline;
    evidence.sourceProof = config.sourceProof;
    evidence.harnessProof = config.harnessProof;
    evidence.buildProof = config.buildProof;
    stage = "browser-startup";
    browser = await (dependencies.launch ?? launchChromium)({
      output,
      signal,
      commandTimeoutMs: options.commandTimeoutMs ?? 30000,
      onEvent: (message) => {
        if (message.method === "Runtime.exceptionThrown") {
          evidence.exceptions.push(message.params);
          log(
            "Browser exception:",
            JSON.stringify(message.params).slice(0, 1500),
          );
        }
      },
    });
    evidence.browser = await browser.client.call(
      "Browser.getVersion",
      {},
      undefined,
      { signal },
    );
    for (const id of ids) {
      stage = "book";
      const started = Date.now();
      let targetId,
        sessionId,
        polls = 0;
      activeRun = {
        bookId: id,
        status: "running",
        startedAt: new Date().toISOString(),
        elapsedMs: 0,
      };
      evidence.runs.push(activeRun);
      await persist();
      const deadline = new AbortController(),
        timer = setTimeout(
          () =>
            deadline.abort(
              failure(
                "timed-out",
                `Book watchdog reached after ${timeoutMs}ms; no completion claimed.`,
              ),
            ),
          timeoutMs,
        );
      const bookSignal = AbortSignal.any([signal, deadline.signal]);
      try {
        ({ targetId } = await browser.client.call(
          "Target.createTarget",
          { url: "about:blank" },
          undefined,
          { signal: bookSignal },
        ));
        ({ sessionId } = await browser.client.call(
          "Target.attachToTarget",
          { targetId, flatten: true },
          undefined,
          { signal: bookSignal },
        ));
        await browser.client.call("Runtime.enable", {}, sessionId, {
          signal: bookSignal,
        });
        await browser.client.call("Page.enable", {}, sessionId, {
          signal: bookSignal,
        });
        const url = new URL(base);
        url.searchParams.set("book", id);
        url.searchParams.set("autorun", "1");
        const navigation = await browser.client.call(
          "Page.navigate",
          { url: url.href },
          sessionId,
          { signal: bookSignal },
        );
        if (navigation.errorText) throw Error(navigation.errorText);
        log(`Starting full-book browser baseline: ${id}`);
        while (true) {
          await (dependencies.delay ?? delay)(pollMs, bookSignal);
          const response = await browser.client.call(
            "Runtime.evaluate",
            {
              expression:
                'JSON.stringify({status:document.documentElement.dataset.fullBookStatus,text:document.querySelector("[role=status]")?.textContent})',
              returnByValue: true,
            },
            sessionId,
            { signal: bookSignal },
          );
          if (response.exceptionDetails)
            throw Error(
              `Harness status evaluation failed: ${JSON.stringify(response.exceptionDetails)}`,
            );
          const status = JSON.parse(response.result.value ?? "{}");
          activeRun.lastObserved = status;
          activeRun.elapsedMs = Date.now() - started;
          const outcome = harnessOutcome(status.status);
          if (polls++ % 6 === 0 || outcome) {
            let processes = null;
            try {
              const { processInfo } = await browser.client.call(
                "SystemInfo.getProcessInfo",
                {},
                undefined,
                { signal: bookSignal },
              );
              processes = await Promise.all(
                processInfo.map(async (process) => ({
                  type: process.type,
                  pid: process.id,
                  rssBytes: await (dependencies.rss ?? rss)(process.id),
                  cpuSeconds: process.cpuTime,
                })),
              );
            } catch (error) {
              if (bookSignal.aborted) throw error;
              evidence.memoryCollectionError = error.message;
            }
            evidence.samples.push({
              bookId: id,
              elapsedMs: activeRun.elapsedMs,
              status,
              processes,
            });
            await persist();
            log(
              id,
              Math.round(activeRun.elapsedMs / 1000) + "s",
              status.text ?? "opening",
            );
          }
          if (outcome) {
            Object.assign(activeRun, outcome, { harnessStatus: status.status });
            break;
          }
        }
      } catch (error) {
        Object.assign(activeRun, {
          status: failureStatus(error),
          error: error.message,
          elapsedMs: Date.now() - started,
        });
      } finally {
        clearTimeout(timer);
        activeRun.finishedAt = new Date().toISOString();
        await persist();
        if (targetId)
          await browser.client
            .call("Target.closeTarget", { targetId }, undefined, {
              timeoutMs: 3000,
            })
            .catch(() => {});
      }
      if (signal.aborted) throw signal.reason;
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
    for (const id of evidence.requestedBooks ?? [])
      if (!evidence.runs.some((run) => run.bookId === id))
        evidence.runs.push({
          bookId: id,
          status: "not-started",
          reason: "Runner terminated before this book.",
        });
    evidence.finishedAt = new Date().toISOString();
    if (browser)
      evidence.chromiumStderrTail = browser.stderr?.().slice(-8000) ?? null;
    let persistenceError;
    try {
      await persist();
    } catch (error) {
      persistenceError = error;
    }
    await browser?.close().catch((error) => {
      evidence.cleanupError = error.message;
      evidence.status = "failed";
    });
    if (evidence.cleanupError) await persist();
    if (persistenceError) throw persistenceError;
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
      "node scripts/run-full-book-browser.mjs --url http://127.0.0.1:5185/packages/readers/fixtures/full-book.html --output /tmp/run/browser [--book ID] [--book-timeout-ms 86400000]",
    );
    return;
  }
  if (!value("--url") || !value("--output"))
    throw Error("Provide --url and an external --output directory.");
  const controller = new AbortController();
  const interrupt = (signal) =>
    controller.abort(
      failure(
        "interrupted",
        `Runner received ${signal}; partial evidence retained.`,
      ),
    );
  const sigint = () => interrupt("SIGINT"),
    sigterm = () => interrupt("SIGTERM");
  process.on("SIGINT", sigint);
  process.on("SIGTERM", sigterm);
  try {
    const result = await runBrowser({
      url: value("--url"),
      output: value("--output"),
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
