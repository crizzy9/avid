import { describe, expect, it } from "vitest";
import { LOCALES } from "../../../packages/i18n/src";
import {
  preparationMessages,
  preparationT,
  type PreparationMessage,
} from "./preparationMessages";

const placeholders = (value: string) =>
  [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
describe("preparation interface translations", () => {
  it("covers all seven locales with identical interpolation fields and no empty labels", () => {
    for (const [key, values] of Object.entries(preparationMessages)) {
      expect(values, key).toHaveLength(LOCALES.length);
      for (const [index, value] of values.entries()) {
        expect(value.trim(), `${key}:${LOCALES[index]!.code}`).not.toBe("");
        expect(placeholders(value), `${key}:${LOCALES[index]!.code}`).toEqual(
          placeholders(values[0]),
        );
        expect(
          preparationT(
            key as PreparationMessage,
            { matched: 12, total: 40 },
            LOCALES[index]!.code,
          ),
        ).not.toMatch(/\{\w+\}/);
      }
    }
  });
  it("keeps picker labels and stage labels available without requiring the preparation worker", () => {
    for (const { code } of LOCALES)
      for (const key of [
        "prepare",
        "prepared",
        "chooseBook",
        "noEligibleBooks",
        "openPrepared",
        "checking",
        "downloading",
        "model",
        "comparing",
        "saving",
      ] as const)
        expect(preparationT(key, {}, code).length).toBeGreaterThan(2);
  });
  it("preserves source size limits and session-only scope in every language", () => {
    for (const { code } of LOCALES) {
      const copy = preparationT("limits", {}, code);
      for (const size of ["64", "512", "2", "3"]) expect(copy).toContain(size);
    }
    expect(preparationT("ready", { matched: 12, total: 40 }, "en")).toContain(
      "12 of 40 passages matched",
    );
  });
});
