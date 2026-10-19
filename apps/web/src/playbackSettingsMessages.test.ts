import { describe, expect, it } from "vitest";
import { LOCALES } from "../../../packages/i18n/src";
import {
  playbackSettingsMessages,
  playbackSettingsTranslate,
  type PlaybackSettingsMessage,
} from "./playbackSettingsMessages";

describe("listening settings translations", () => {
  it("covers seven locales and preserves field names and interpolation", () => {
    for (const [key, values] of Object.entries(playbackSettingsMessages)) {
      expect(values, key).toHaveLength(LOCALES.length);
      const placeholders = (value: string) =>
        [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
      for (const [index, value] of values.entries()) {
        expect(value.trim(), `${key}:${LOCALES[index]!.code}`).not.toBe("");
        expect(placeholders(value)).toEqual(placeholders(values[0]));
        expect(
          playbackSettingsTranslate(
            key as PlaybackSettingsMessage,
            {
              setting: "speed",
              source: "account",
              requested: 4,
              applied: 3,
              backward: 15,
              forward: 30,
            },
            LOCALES[index]!.code,
          ),
        ).not.toMatch(/\{\w+\}/);
      }
    }
  });
});
