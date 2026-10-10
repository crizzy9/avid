// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCALES, setLocale } from "../../i18n/src";
import { AO3Panel } from "../src/AO3Panel";
import { CrossPointPanel } from "../src/CrossPointPanel";
import { Ao3Error } from "../src/ao3";
import {
  CrossPointClient,
  CrossPointError,
  type CrossPointReadiness,
  type CrossPointTransferPlan,
} from "../src/crosspoint";
import {
  connectorError,
  connectorMessages,
  connectorTranslate as t,
} from "../src/messages";

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  setLocale("en");
  localStorage.clear();
});
const button = (label: string) =>
  [...host.querySelectorAll("button")].find(
    (item) => item.textContent === label,
  )!;
const placeholders = (value: string) =>
  [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
const device: CrossPointReadiness = {
  device: {
    address: "http://192.168.1.7",
    ip: "192.168.1.7",
    version: "fixture-1",
    mode: "STA",
    device: "Original Device",
  },
  directory: "/Books",
  files: [],
  status: "protocol-observed",
  firmwareQualified: false,
  transport: "browser-fetch",
  discovery: "manual-address",
  contractRevision: "fixture",
};
const plan: CrossPointTransferPlan = {
  id: "transfer",
  device: device.device,
  directory: "/Books",
  originalName: "Original title 原文.epub",
  destinationName: "original-title-123.epub",
  size: 1024,
  sha256: "a".repeat(64),
  createdAt: "2026-10-09T00:00:00Z",
};

describe("connector localization", () => {
  it("covers every catalog key and preserves interpolation variables in all seven locales", () => {
    for (const row of Object.values(connectorMessages)) {
      expect(row).toHaveLength(7);
      for (const value of row) {
        expect(value.trim()).not.toBe("");
        expect(placeholders(value)).toEqual(placeholders(row[0]));
      }
    }
    for (const { code } of LOCALES)
      expect(
        t("checkingTitle", { title: "Original title 原文" }, code),
      ).toContain("Original title 原文");
  });
  it("changes both complete connector forms live without starting network requests", async () => {
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected request"));
    await act(async () =>
      root.render(
        <>
          <AO3Panel accountScope="one" onImport={async () => {}} />
          <CrossPointPanel accountScope="one" />
        </>,
      ),
    );
    await act(async () =>
      host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
    );
    for (const { code } of LOCALES) {
      await act(async () => setLocale(code));
      for (const key of [
        "ao3Intro",
        "setup",
        "pairingCode",
        "ao3Login",
        "ao3Password",
        "ao3Connect",
        "crossIntro",
        "readerAddress",
        "fallbackIp",
        "destinationFolder",
        "checkReader",
        "networkHint",
      ] as const)
        expect(host.textContent).toContain(t(key, {}, code));
      expect(host.textContent).toContain("node scripts/ao3-companion.mjs");
    }
    expect(request).not.toHaveBeenCalled();
  });
  it("retranslates an in-flight status and typed network failure without exposing internal diagnostics", async () => {
    let reject!: (error: unknown) => void;
    vi.spyOn(CrossPointClient.prototype, "inspect").mockImplementation(
      () =>
        new Promise((_, no) => {
          reject = no;
        }),
    );
    await act(async () => root.render(<CrossPointPanel />));
    await act(async () => button(t("checkReader")).click());
    expect(host.querySelector('[role="status"]')?.textContent).toContain(
      t("checkingReader"),
    );
    await act(async () => setLocale("zh-Hans"));
    expect(host.querySelector('[role="status"]')?.textContent).toContain(
      t("checkingReader"),
    );
    await act(async () =>
      reject(new CrossPointError("unreachable", "INTERNAL_DIAGNOSTIC")),
    );
    for (const { code } of LOCALES) {
      await act(async () => setLocale(code));
      expect(host.querySelector('[role="alert"]')?.textContent).toBe(
        t("unreachable"),
      );
      expect(host.textContent).not.toContain("INTERNAL_DIAGNOSTIC");
    }
  });
  it("keeps publication names intact and renders verified transfer outcomes in every locale", async () => {
    vi.spyOn(CrossPointClient.prototype, "inspect").mockResolvedValue(device);
    vi.spyOn(CrossPointClient.prototype, "prepare").mockResolvedValue(plan);
    const send = vi
      .spyOn(CrossPointClient.prototype, "send")
      .mockResolvedValue({
        state: "verified",
        plan,
        checkedAt: plan.createdAt,
        message: "INTERNAL_ENGLISH_RESULT",
      });
    await act(async () =>
      root.render(
        <CrossPointPanel
          accountScope="fixture"
          fileSources={[
            {
              id: "book",
              name: plan.originalName,
              load: async () => new Blob(["epub"]),
            },
          ]}
        />,
      ),
    );
    await act(async () => button(t("checkReader")).click());
    await act(async () => {
      const select = host.querySelector("select")!;
      select.value = "book";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => button(t("reviewTransfer")).click());
    expect(send).not.toHaveBeenCalled();
    await act(async () => button(t("send")).click());
    expect(send).toHaveBeenCalledTimes(1);
    for (const { code } of LOCALES) {
      await act(async () => setLocale(code));
      expect(host.textContent).toContain(plan.originalName);
      expect(host.textContent).toContain("Original Device");
      expect(host.querySelector('[role="status"]')?.textContent).toBe(
        `${t("transferVerified")} ${t("verifiedDetail")}`,
      );
      expect(host.textContent).toContain(t("verifyAgain"));
      expect(host.textContent).not.toContain("INTERNAL_ENGLISH_RESULT");
    }
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("maps throttling, authentication, cancellation and all device error classes to translated recovery messages", () => {
    expect(connectorError(new Ao3Error("raw", 429, 31.2), "ao3")).toEqual({
      key: "retryLater",
      values: { seconds: 32 },
    });
    expect(connectorError(new Ao3Error("raw", 401), "ao3")).toEqual({
      key: "ao3Auth",
    });
    expect(
      connectorError(new DOMException("raw", "AbortError"), "ao3"),
    ).toEqual({ key: "cancelled" });
    for (const code of [
      "invalid-address",
      "invalid-path",
      "unsupported-file",
      "unreachable",
      "unexpected-response",
      "file-exists",
      "device-changed",
      "upload-uncertain",
      "invalid-plan",
      "busy",
    ] as const) {
      const message = connectorError(
        new CrossPointError(code, "INTERNAL_DIAGNOSTIC"),
        "crosspoint",
      );
      for (const locale of LOCALES)
        expect(t(message.key, message.values, locale.code)).not.toContain(
          "INTERNAL_DIAGNOSTIC",
        );
    }
  });
});
