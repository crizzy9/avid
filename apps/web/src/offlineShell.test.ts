import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { offlineShell } from "../../../scripts/offline-shell";

async function worker() {
  let code = "";
  const plugin = offlineShell();
  const hook = plugin.generateBundle;
  const run = typeof hook === "function" ? hook : hook!.handler;
  await run.call(
    {
      emitFile: (asset: { source: string }) => {
        code = asset.source;
      },
    } as never,
    {} as never,
    {
      "assets/main-123.js": {
        type: "chunk",
        code: "app",
        fileName: "assets/main-123.js",
      },
    } as never,
    false,
  );
  const handlers: Record<string, (event: any) => void> = {},
    match = vi.fn().mockResolvedValue("cached shell"),
    addAll = vi.fn().mockResolvedValue(undefined),
    network = vi.fn();
  runInNewContext(code, {
    URL,
    Set,
    self: {
      location: { origin: "https://avid.test" },
      clients: { claim: vi.fn() },
      addEventListener: (name: string, callback: any) => {
        handlers[name] = callback;
      },
    },
    caches: {
      open: vi.fn().mockResolvedValue({ match, addAll }),
      keys: vi.fn().mockResolvedValue([]),
      delete: vi.fn(),
    },
    fetch: network,
  });
  return { handlers, match, addAll, network };
}
describe("public offline application shell", () => {
  it("preloads build chunks and serves a cold root navigation without network", async () => {
    const w = await worker();
    let installed: Promise<unknown> | undefined;
    w.handlers.install!({
      waitUntil: (promise: Promise<unknown>) => {
        installed = promise;
      },
    });
    await installed;
    expect(w.addAll.mock.calls[0]![0]).toContain("/assets/main-123.js");
    let response: Promise<unknown> | undefined;
    w.handlers.fetch!({
      request: {
        url: "https://avid.test/?view=more",
        method: "GET",
        mode: "navigate",
      },
      respondWith: (promise: Promise<unknown>) => {
        response = promise;
      },
    });
    expect(await response).toBe("cached shell");
    expect(w.match).toHaveBeenCalledWith("/", { ignoreVary: true });
    expect(w.network).not.toHaveBeenCalled();
  });
  it("uses public cached modules across Vary: Origin request differences", async () => {
    const w = await worker();
    let response: Promise<unknown> | undefined;
    w.match.mockImplementation(async (_path, options) =>
      options?.ignoreVary ? "cached module" : undefined,
    );
    w.handlers.fetch!({
      request: {
        url: "https://avid.test/assets/main-123.js",
        method: "GET",
        mode: "cors",
        headers: { Origin: "https://avid.test" },
      },
      respondWith: (promise: Promise<unknown>) => {
        response = promise;
      },
    });
    expect(await response).toBe("cached module");
    expect(w.match).toHaveBeenCalledWith("/assets/main-123.js", {
      ignoreVary: true,
    });
    expect(w.network).not.toHaveBeenCalled();
  });
  it("never intercepts authentication, server content, external or token-bearing resource requests", async () => {
    const w = await worker(),
      respondWith = vi.fn();
    for (const [url, method] of [
      ["https://avid.test/api/v1/books/12", "GET"],
      ["https://avid.test/bookorbit/api/v1/auth/login", "POST"],
      ["https://avid.test/oauth2-callback?code=secret", "GET"],
      ["https://books.test/assets/main-123.js", "GET"],
      ["https://avid.test/assets/main-123.js?token=secret", "GET"],
    ])
      w.handlers.fetch!({
        request: { url, method, mode: "cors" },
        respondWith,
      });
    expect(respondWith).not.toHaveBeenCalled();
    expect(w.match).not.toHaveBeenCalled();
  });
});
