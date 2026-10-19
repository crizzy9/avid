import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { createCdpClient, runBrowser } from "./run-full-book-browser.mjs";
import { failure } from "./full-book-support.mjs";
import { bookResult } from "./run-full-book-suite.mjs";
class Socket extends EventEmitter {
  readyState = 1;
  messages: string[] = [];
  addEventListener(name: string, callback: (event: unknown) => void) {
    this.on(name, callback);
  }
  send(message: string) {
    this.messages.push(message);
  }
  close() {
    this.readyState = 3;
    this.emit("close", { code: 1000, reason: "test" });
  }
}
afterEach(() => vi.useRealTimers());
it("rejects every pending CDP request and future calls when its socket closes", async () => {
  const socket = new Socket(),
    client = createCdpClient(socket);
  const first = client.call("Runtime.evaluate").catch((error) => error.message);
  const second = client.call("Page.navigate").catch((error) => error.message);
  socket.close();
  expect(await first).toContain("CDP socket closed");
  expect(await second).toContain("CDP socket closed");
  await expect(client.call("Browser.getVersion")).rejects.toThrow(
    "CDP socket closed",
  );
});
it("bounds unresponsive CDP requests without leaving unresolved promises", async () => {
  vi.useFakeTimers();
  const socket = new Socket(),
    client = createCdpClient(socket, { timeoutMs: 25 });
  const result = client
    .call("Runtime.evaluate")
    .catch((error) => error.message);
  await vi.advanceTimersByTimeAsync(25);
  expect(await result).toContain("timed out: Runtime.evaluate");
  client.close();
});
it("does not treat process exit zero or an unrelated prepared marker as success", () => {
  expect(
    bookResult(
      "alice",
      { code: 0 },
      {
        status: "completed-with-failures",
        runs: [{ bookId: "alice", status: "failed" }],
      },
    ).status,
  ).toBe("failed");
  expect(
    bookResult(
      "alice",
      { code: 0 },
      { status: "completed", runs: [{ bookId: "pride", status: "prepared" }] },
    ).status,
  ).toBe("failed");
  expect(
    bookResult(
      "alice",
      { code: 1 },
      { status: "completed", runs: [{ bookId: "alice", status: "prepared" }] },
    ).status,
  ).toBe("failed");
  expect(
    bookResult(
      "alice",
      { code: 0 },
      { status: "completed", runs: [{ bookId: "alice", status: "prepared" }] },
    ).status,
  ).toBe("prepared");
});
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function output() {
  const directory = await mkdtemp(join(tmpdir(), "avid-browser-test-"));
  temporary.push(directory);
  return directory;
}
function runtime(status = "prepared") {
  let closed = false;
  const client = {
    async call(method: string) {
      if (method === "Target.createTarget") return { targetId: "target" };
      if (method === "Target.attachToTarget") return { sessionId: "session" };
      if (method === "Runtime.evaluate")
        return {
          result: {
            value: JSON.stringify({ status, text: "Fixture terminal state" }),
          },
        };
      if (method === "SystemInfo.getProcessInfo") return { processInfo: [] };
      return {};
    },
  };
  return {
    fetchConfig: async () => ({
      commit: "frozen",
      baseline: "baseline",
      sourceProof: [],
      corpus: { books: [{ id: "alice" }, { id: "pride" }] },
    }),
    launch: async () => ({
      client,
      close: async () => {
        closed = true;
      },
      stderr: () => "",
    }),
    log: () => {},
    get closed() {
      return closed;
    },
  };
}
it.each(["failed", "cancelled"])(
  "writes terminal evidence and exits unsuccessfully for harness %s",
  async (status) => {
    const directory = await output(),
      dependencies = runtime(status);
    const result = await runBrowser(
      {
        url: "http://127.0.0.1:5185/fixture",
        output: directory,
        bookIds: ["alice"],
        pollMs: 1,
      },
      dependencies,
    );
    expect(result.exitCode).toBe(1);
    expect(result.evidence.runs[0].status).toBe(status);
    expect(dependencies.closed).toBe(true);
    expect(
      JSON.parse(
        await readFile(join(directory, "browser-runtime.json"), "utf8"),
      ).status,
    ).toBe("completed-with-failures");
  },
);
it("saves an interrupted partial run and marks remaining books not started", async () => {
  const directory = await output(),
    controller = new AbortController(),
    dependencies = runtime();
  const result = await runBrowser(
    {
      url: "http://127.0.0.1:5185/fixture",
      output: directory,
      pollMs: 1,
      signal: controller.signal,
    },
    {
      ...dependencies,
      delay: async () => {
        controller.abort(failure("interrupted", "Fixture interruption"));
        throw controller.signal.reason;
      },
    },
  );
  expect(result.exitCode).not.toBe(0);
  expect(result.evidence.status).toBe("interrupted");
  expect(result.evidence.runs.map((run) => run.status)).toEqual([
    "interrupted",
    "not-started",
  ]);
  expect(
    JSON.parse(await readFile(join(directory, "browser-runtime.json"), "utf8"))
      .runs[0].error,
  ).toBe("Fixture interruption");
  expect(dependencies.closed).toBe(true);
});
it("turns a watchdog into terminal partial evidence rather than success", async () => {
  const directory = await output(),
    dependencies = runtime();
  const result = await runBrowser(
    {
      url: "http://127.0.0.1:5185/fixture",
      output: directory,
      bookIds: ["alice"],
      pollMs: 50,
      bookTimeoutMs: 1,
    },
    dependencies,
  );
  expect(result.exitCode).toBe(1);
  expect(result.evidence.runs[0].status).toBe("timed-out");
  expect(dependencies.closed).toBe(true);
});
it("refuses to reuse an existing browser profile even when its report is missing", async () => {
  const directory = await output();
  await mkdir(join(directory, "chromium-profile"));
  await expect(
    runBrowser(
      { url: "http://127.0.0.1:5185/fixture", output: directory },
      runtime(),
    ),
  ).rejects.toThrow("profile already exists");
});
