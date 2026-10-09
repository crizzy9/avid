import { useSyncExternalStore } from "react";
import { messages, type MessageKey } from "./catalog";
export { messages, type MessageKey } from "./catalog";
export const LOCALES = [
  { code: "en", name: "English" },
  { code: "fi", name: "Suomi" },
  { code: "fr", name: "Français" },
  { code: "de", name: "Deutsch" },
  { code: "pl", name: "Polski" },
  { code: "zh-Hans", name: "简体中文" },
  { code: "es", name: "Español" },
] as const;
export type Locale = (typeof LOCALES)[number]["code"];
export type Parameters = Record<string, string | number>;
const storageKey = "avid.language";
const listeners = new Set<() => void>();
export function isLocale(value: unknown): value is Locale {
  return LOCALES.some((locale) => locale.code === value);
}
function storedLocale(): Locale {
  try {
    const value = globalThis.localStorage?.getItem(storageKey);
    return isLocale(value) ? value : "en";
  } catch {
    return "en";
  }
}
let selectedLocale: Locale = storedLocale();
export function getLocale(): Locale {
  return selectedLocale;
}
export function setLocale(locale: Locale): void {
  if (!isLocale(locale)) throw new Error("Unsupported Avid language.");
  selectedLocale = locale;
  try {
    globalThis.localStorage?.setItem(storageKey, locale);
  } catch {
    /* The in-memory setting still works in restricted storage. */
  }
  if (typeof document !== "undefined") document.documentElement.lang = locale;
  for (const listener of listeners) listener();
}
if (typeof window !== "undefined") {
  document.documentElement.lang = selectedLocale;
  window.addEventListener("storage", (event) => {
    if (event.key !== storageKey) return;
    selectedLocale = isLocale(event.newValue) ? event.newValue : "en";
    document.documentElement.lang = selectedLocale;
    for (const listener of listeners) listener();
  });
}
export function translate(
  key: MessageKey,
  parameters: Parameters = {},
  locale: Locale = selectedLocale,
): string {
  const index = LOCALES.findIndex((item) => item.code === locale);
  return messages[key][index < 0 ? 0 : index].replace(
    /\{(\w+)\}/g,
    (token, name: string) => {
      const value = parameters[name];
      return value === undefined
        ? token
        : typeof value === "number"
          ? new Intl.NumberFormat(locale, {
              maximumFractionDigits: 2,
              useGrouping: name !== "year",
            }).format(value)
          : value;
    },
  );
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export function useI18n() {
  const locale = useSyncExternalStore(
    subscribe,
    getLocale,
    () => "en" as Locale,
  );
  return {
    locale,
    setLocale,
    t: (key: MessageKey, parameters?: Parameters) =>
      translate(key, parameters, locale),
  };
}
