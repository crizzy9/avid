// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LOCALES,
  getLocale,
  messages,
  setLocale,
  translate,
  useI18n,
  type MessageKey,
} from "../src";

afterEach(() => {
  setLocale("en");
  vi.restoreAllMocks();
});
describe("seven-language interface catalog", () => {
  it("covers every key in all seven locales with matching interpolation parameters", () => {
    expect(LOCALES.map((locale) => locale.code)).toEqual([
      "en",
      "fi",
      "fr",
      "de",
      "pl",
      "zh-Hans",
      "es",
    ]);
    const placeholders = (text: string) =>
      [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const [key, row] of Object.entries(messages)) {
      expect(row, key).toHaveLength(7);
      row.forEach((text) => {
        expect(text.trim().length, key).toBeGreaterThan(0);
        expect(placeholders(text), key).toEqual(placeholders(row[0]));
      });
      for (const locale of LOCALES) {
        const params = Object.fromEntries(
          placeholders(row[0]).map((name) => [name, 4]),
        );
        expect(
          translate(key as MessageKey, params, locale.code),
          key,
        ).not.toMatch(/\{\w+\}/);
      }
    }
  });
  it("changes existing controls immediately, persists the preference and updates document language", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const host = document.createElement("div"),
      root = createRoot(host);
    function Screen() {
      const { t } = useI18n();
      return (
        <>
          <h1>{t("nav.library")}</h1>
          <p>A user’s unchanged book title</p>
        </>
      );
    }
    await act(async () => root.render(<Screen />));
    expect(host.querySelector("h1")?.textContent).toBe("Library");
    await act(async () => setLocale("fr"));
    expect(host.querySelector("h1")?.textContent).toBe("Bibliothèque");
    expect(host.querySelector("p")?.textContent).toBe(
      "A user’s unchanged book title",
    );
    expect(localStorage.getItem("avid.language")).toBe("fr");
    expect(document.documentElement.lang).toBe("fr");
    await act(async () =>
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "avid.language",
          newValue: "zh-Hans",
        }),
      ),
    );
    expect(host.querySelector("h1")?.textContent).toBe("书库");
    await act(async () => root.unmount());
  });
  it("interpolates localized numbers and preserves book content as data", () => {
    expect(translate("common.minutes", { count: 1.5 }, "de")).toBe(
      "1,5 Minuten",
    );
    expect(translate("activity.calendar", { year: 2026 }, "en")).toBe(
      "2026 reading calendar",
    );
    expect(
      translate(
        "library.openLabel",
        { title: "<Title>", author: "Author" },
        "es",
      ),
    ).toBe("Abrir <Title>, de Author");
  });
  it("retains the in-memory language when browser storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage disabled");
    });
    expect(() => setLocale("fi")).not.toThrow();
    expect(getLocale()).toBe("fi");
    expect(translate("nav.library")).toBe("Kirjasto");
  });
});
