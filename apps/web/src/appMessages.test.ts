import { describe, expect, it } from "vitest";
import { LOCALES } from "../../../packages/i18n/src";
import {
  appMessages,
  appMessageKeysByEnglish,
  appTranslate,
  type AppMessageKey,
} from "./appMessages";

describe("remaining application messages", () => {
  it("covers all seven locales and preserves every interpolation parameter", () => {
    const placeholders = (value: string) =>
      [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const [key, row] of Object.entries(appMessages)) {
      expect(row, key).toHaveLength(LOCALES.length);
      for (const locale of LOCALES) {
        const text = row[LOCALES.indexOf(locale)];
        expect(text.trim().length, `${key}:${locale.code}`).toBeGreaterThan(0);
        expect(placeholders(text), `${key}:${locale.code}`).toEqual(
          placeholders(row[0]),
        );
        const parameters = Object.fromEntries(
          placeholders(text).map((name) => [name, `value-${name}`]),
        );
        expect(
          appTranslate(key as AppMessageKey, parameters, locale.code),
        ).not.toMatch(/\{\w+\}/);
      }
      expect(appMessageKeysByEnglish[row[0]], row[0]).toBe(key);
    }
  });
  it("includes all eight guide entries without falling back to English", () => {
    const chapters = [
      "Library",
      "Reading",
      "Appearance",
      "Listening",
      "Notes",
      "Formats",
      "Recovery",
      "Preview",
    ];
    for (const chapter of chapters)
      for (const part of ["Title", "Body"]) {
        const key = `guide${chapter}${part}` as AppMessageKey;
        for (const locale of LOCALES.slice(1))
          expect(appTranslate(key, {}, locale.code)).not.toBe(
            appMessages[key][0],
          );
      }
  });
  it("translates complete action labels and treats user titles as data", () => {
    expect(appTranslate("resumeReading", {}, "zh-Hans")).toBe("继续阅读");
    expect(appTranslate("resumeListening", {}, "zh-Hans")).toBe("继续收听");
    const title = "<A user title> {time}";
    expect(appTranslate("detailsFor", { title }, "zh-Hans")).toBe(
      "《<A user title> {time}》的详情",
    );
    expect(appTranslate("audioNoteAt", { time: "01:23" }, "fr")).toBe(
      "À 01:23",
    );
  });
});
