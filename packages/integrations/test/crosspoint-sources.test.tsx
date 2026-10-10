// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { setLocale } from "../../i18n/src";
import { CrossPointPanel, type CrossPointFileSource } from "../src/CrossPointPanel";
import { CrossPointClient, type CrossPointReadiness, type CrossPointTransferPlan } from "../src/crosspoint";
import { connectorTranslate as t } from "../src/messages";

const device: CrossPointReadiness = {
  device: { address: "http://192.168.1.7", ip: "192.168.1.7", version: "fixture", mode: "STA" },
  directory: "/Books", files: [], status: "protocol-observed", firmwareQualified: false,
  transport: "browser-fetch", discovery: "manual-address", contractRevision: "fixture",
};
const plan: CrossPointTransferPlan = {
  id: "transfer-fixture", device: device.device, directory: "/Books", originalName: "Library book.epub",
  destinationName: "Library book - fixture.epub", size: 4, sha256: "a".repeat(64), createdAt: "2026-10-09T00:00:00Z",
};
let root: Root, host: HTMLDivElement, mounted: boolean;
let inspect: MockInstance<CrossPointClient["inspect"]>;
let prepare: MockInstance<CrossPointClient["prepare"]>;
let send: MockInstance<CrossPointClient["send"]>;
let network: MockInstance<typeof fetch>;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  setLocale("en"); localStorage.clear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host); mounted = true;
  inspect = vi.spyOn(CrossPointClient.prototype, "inspect").mockResolvedValue(device);
  prepare = vi.spyOn(CrossPointClient.prototype, "prepare").mockResolvedValue(plan);
  send = vi.spyOn(CrossPointClient.prototype, "send").mockRejectedValue(new Error("Unexpected upload"));
  network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network request"));
});
afterEach(async () => {
  if (mounted) await act(async () => root.unmount());
  host.remove();
  expect(send).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
  vi.restoreAllMocks(); localStorage.clear(); setLocale("en");
});
function button(label: string) {
  const found = [...host.querySelectorAll("button")].find(item => item.textContent === label);
  expect(found, `Missing button: ${label}`).toBeDefined(); return found!;
}
async function click(label: string) { await act(async () => button(label).click()); }
async function select(id: string) {
  await act(async () => {
    const element = host.querySelector("select")!; element.value = id;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function render(sources: CrossPointFileSource[], accountScope = "one") {
  await act(async () => root.render(<CrossPointPanel accountScope={accountScope} fileSources={sources} />));
}
function deferredSource() {
  let resolve!: (bytes: Blob) => void;
  const pending = new Promise<Blob>(yes => { resolve = yes; });
  const load = vi.fn((_signal?: AbortSignal) => pending);
  const source: CrossPointFileSource = { id: "library-book", name: plan.originalName, load };
  return { source, load, resolve };
}

describe("CrossPoint library sources", () => {
  it("loads only on explicit review and forwards the exact signal to loading and preparation", async () => {
    const pending = deferredSource(); const bytes = new Blob(["epub"]);
    pending.source.label = "Original book title · Library book.epub";
    await render([pending.source]);
    expect(pending.load).not.toHaveBeenCalled(); expect(inspect).not.toHaveBeenCalled();
    await click(t("checkReader"));
    expect(host.querySelector('option[value="library-book"]')?.textContent).toBe(pending.source.label);
    expect(pending.load).not.toHaveBeenCalled();
    await select(pending.source.id);
    expect(pending.load).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
    await click(t("reviewTransfer"));
    expect(pending.load).toHaveBeenCalledTimes(1);
    const signal = pending.load.mock.calls[0][0];
    expect(signal).toBeInstanceOf(AbortSignal); expect(signal!.aborted).toBe(false);
    expect(prepare).not.toHaveBeenCalled();
    await act(async () => pending.resolve(bytes));
    expect(prepare).toHaveBeenCalledExactlyOnceWith(device, bytes, pending.source.name, signal);
    expect(button(t("send")).disabled).toBe(false);
    expect(localStorage.length).toBe(0);
  });

  it.each(["account change", "unmount"] as const)("aborts delayed loading on %s and never prepares its late bytes", async change => {
    const pending = deferredSource();
    await render([pending.source]); await click(t("checkReader")); await select(pending.source.id);
    await click(t("reviewTransfer"));
    const signal = pending.load.mock.calls[0][0]!;
    if (change === "account change") await render([], "two");
    else { await act(async () => root.unmount()); mounted = false; }
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(new Blob(["old account bytes"])));
    expect(prepare).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain(plan.originalName);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(localStorage.length).toBe(0);
  });

  it("does not prepare bytes from a loader that ignores explicit cancellation", async () => {
    const pending = deferredSource();
    await render([pending.source]); await click(t("checkReader")); await select(pending.source.id);
    await click(t("reviewTransfer")); await click(t("cancel"));
    expect(pending.load.mock.calls[0][0]!.aborted).toBe(true);
    await act(async () => pending.resolve(new Blob(["late bytes"])));
    expect(prepare).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(t("cancelled"));
  });

  it("does not publish a plan that completes after its account changes", async () => {
    let resolve!: (value: CrossPointTransferPlan) => void;
    prepare.mockImplementation(() => new Promise(yes => { resolve = yes; }));
    const source = { id: "library-book", name: plan.originalName, load: vi.fn(async () => new Blob(["epub"])) };
    await render([source]); await click(t("checkReader")); await select(source.id); await click(t("reviewTransfer"));
    expect(prepare).toHaveBeenCalledTimes(1);
    const signal = prepare.mock.calls[0][3]!;
    await render([], "two"); expect(signal.aborted).toBe(true);
    await act(async () => resolve(plan));
    expect(host.textContent).not.toContain(plan.originalName);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("preserves local-file review without loading any library source", async () => {
    const pending = deferredSource(); const file = new File(["epub"], "Local book.epub", { type: "application/epub+zip" });
    await render([pending.source]); await click(t("checkReader"));
    await act(async () => {
      const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
      Object.defineProperty(input, "files", { value: [file] });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(prepare).not.toHaveBeenCalled();
    await click(t("reviewTransfer"));
    expect(pending.load).not.toHaveBeenCalled();
    expect(prepare).toHaveBeenCalledExactlyOnceWith(device, file, file.name, expect.any(AbortSignal));
  });
});
