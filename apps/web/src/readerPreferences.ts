import { BookOrbitClient } from "../../../packages/core/src/bookorbit";
import {
  accountScope,
  LibraryRepository,
  type OutboxOperation,
} from "../../../packages/core/src/repository";
import { SyncCoordinator } from "../../../packages/core/src/sync";
import type { BookFile } from "../../../packages/core/src/types";
import type {
  ReaderPreferencePort,
  ReaderPreferenceValues,
} from "../../../packages/readers/src/contracts";

const fonts = new Set(["Literata", "Georgia", "Palatino", "Arial", "Verdana"]);
const number = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= min &&
  value <= max;
const ebook = (format: BookFile["format"]) =>
  format === "EPUB" || format === "MOBI";
const comic = (format: BookFile["format"]) =>
  ["CBZ", "CBR", "CB7"].includes(format);

/** Only representable v3.3 fields are mapped. Fonts installed/imported on one device stay local. */
export function fromBookOrbitPreferences(
  format: BookFile["format"],
  settings: Record<string, unknown>,
): ReaderPreferenceValues {
  const result: ReaderPreferenceValues = {};
  if (ebook(format)) {
    if (number(settings.fontSize, 6, 32)) result.fontSize = settings.fontSize;
    if (number(settings.lineHeight, 0.8, 3))
      result.lineHeight = settings.lineHeight;
    if (number(settings.gap, 0, 0.5)) result.margin = settings.gap * 100;
    if (
      typeof settings.fontFamily === "string" &&
      fonts.has(settings.fontFamily)
    )
      result.font = settings.fontFamily;
    if (settings.flow === "paginated" || settings.flow === "scrolled")
      result.flow = settings.flow;
    if (settings.isDark === true) result.theme = "dark";
    else if (settings.themeName === "sepia") result.theme = "warm";
    else if (settings.themeName === "default" || settings.isDark === false)
      result.theme = "light";
  }
  if (comic(format)) {
    if (settings.direction === "ltr" || settings.direction === "rtl")
      result.comicDirection = settings.direction;
    if (
      settings.scrollMode === "infinite" ||
      settings.scrollMode === "long-strip"
    )
      result.comicMode = "webtoon";
    else if (settings.viewMode === "two-page") result.comicMode = "spread";
    else if (
      settings.viewMode === "single" ||
      settings.scrollMode === "paginated"
    )
      result.comicMode = "paged";
    if (settings.bgColor === "black") result.theme = "dark";
    else if (settings.bgColor === "white") result.theme = "light";
  }
  return result;
}
export function toBookOrbitPreferencePatch(
  format: BookFile["format"],
  values: ReaderPreferenceValues,
) {
  const set: Record<string, unknown> = {},
    unset: string[] = [],
    portable = new Set<keyof ReaderPreferenceValues>();
  const take = (
    name: keyof ReaderPreferenceValues,
    key: string,
    value: unknown,
  ) => {
    set[key] = value;
    portable.add(name);
  };
  if (ebook(format)) {
    if (number(values.fontSize, 6, 32))
      take("fontSize", "fontSize", values.fontSize);
    if (number(values.lineHeight, 0.8, 3))
      take("lineHeight", "lineHeight", values.lineHeight);
    if (number(values.margin, 0, 50))
      take("margin", "gap", values.margin / 100);
    if (values.font && fonts.has(values.font))
      take("font", "fontFamily", values.font);
    if (values.flow === "paginated" || values.flow === "scrolled")
      take("flow", "flow", values.flow);
    if (values.theme && ["light", "warm", "dark"].includes(values.theme)) {
      take("theme", "themeName", values.theme === "warm" ? "sepia" : "default");
      set.isDark = values.theme === "dark";
    }
  }
  if (comic(format)) {
    if (values.comicDirection === "auto") {
      unset.push("direction");
      portable.add("comicDirection");
    } else if (
      values.comicDirection === "ltr" ||
      values.comicDirection === "rtl"
    )
      take("comicDirection", "direction", values.comicDirection);
    if (
      values.comicMode &&
      ["paged", "spread", "webtoon"].includes(values.comicMode)
    ) {
      take(
        "comicMode",
        "viewMode",
        values.comicMode === "spread" ? "two-page" : "single",
      );
      set.scrollMode =
        values.comicMode === "webtoon" ? "long-strip" : "paginated";
    }
    if (values.theme === "dark" || values.theme === "light")
      take("theme", "bgColor", values.theme === "dark" ? "black" : "white");
  }
  return { set, unset, portable };
}
export function sanitizeReaderPreferenceValues(
  value: Record<string, unknown>,
): ReaderPreferenceValues {
  const result: ReaderPreferenceValues = {};
  const choice = <K extends keyof ReaderPreferenceValues>(
    key: K,
    allowed: readonly unknown[],
  ) => {
    if (allowed.includes(value[key]))
      (result as Record<string, unknown>)[key] = value[key];
  };
  choice("theme", ["light", "warm", "dark", "custom"]);
  choice("flow", ["paginated", "scrolled"]);
  choice("animation", ["none", "slide", "fade", "fast-fade"]);
  choice("comicMode", ["paged", "spread", "webtoon"]);
  choice("comicDirection", ["auto", "ltr", "rtl"]);
  for (const [key, min, max] of [
    ["fontSize", 6, 40],
    ["lineHeight", 0.8, 3],
    ["margin", 0, 50],
    ["speechRate", 0.5, 2],
  ] as const)
    if (number(value[key], min, max)) result[key] = value[key];
  for (const key of ["background", "foreground"] as const)
    if (typeof value[key] === "string" && /^#[0-9a-f]{6}$/i.test(value[key]))
      result[key] = value[key];
  for (const key of ["font", "voice"] as const)
    if (typeof value[key] === "string" && value[key].length <= 200)
      result[key] = value[key];
  return result;
}

export function createBookOrbitReaderPreferences(options: {
  repo: LibraryRepository;
  client: BookOrbitClient | null;
  bookId: string;
  file: BookFile;
  isActive?: () => boolean;
  onQueued?: () => Promise<void>;
}): ReaderPreferencePort | undefined {
  const { repo, client, bookId, file, isActive, onQueued } = options;
  if (
    !client ||
    !/^\d+$/.test(bookId) ||
    !/^\d+$/.test(file.id) ||
    (!ebook(file.format) && !comic(file.format))
  )
    return undefined;
  if (repo.scope !== accountScope(client.session))
    throw new Error("Reader preferences belong to a different account.");
  const active = () => {
    if (isActive?.() === false)
      throw new Error(
        "The reader preference account or file is no longer active.",
      );
  };
  const queued = async () =>
    (await repo.pendingOperations()).filter(
      (operation) =>
        operation.payload.kind === "preferences" &&
        operation.payload.fileId === file.id,
    );
  const coordinator = new SyncCoordinator(repo, client, { isActive });
  return {
    id: JSON.stringify([repo.scope, bookId, file.id]),
    readOnly: client.readOnly,
    async load() {
      active();
      // Include intents acknowledged while the read was in flight, so a response
      // begun before our own write cannot undo it in the open reader.
      const before = await queued();
      active();
      const [defaults, response] = await Promise.all([
        client.getReaderDefaults(),
        client.getReaderPreferences(file.id),
      ]);
      active();
      const perFile = { ...response.settings },
        base = { ...defaults[ebook(file.format) ? "epub" : "cbx"] };
      // Automatic manga filing is device-specific. Only an explicit per-file
      // direction overrides classification; a server default is not such an override.
      delete base.direction;
      const operations = [
        ...new Map<string, OutboxOperation>(
          [...before, ...(await queued())].map((operation) => [
            operation.id,
            operation,
          ]),
        ).values(),
      ].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
      const intended: ReaderPreferenceValues = {};
      for (const operation of operations)
        if (operation.payload.kind === "preferences") {
          for (const name of operation.payload.unset) delete perFile[name];
          Object.assign(perFile, operation.payload.set);
          Object.assign(intended, operation.payload.localSet);
        }
      const device = await repo.getPreferences(
        `reader-file-overrides:${file.id}`,
      );
      active();
      return {
        ...fromBookOrbitPreferences(file.format, { ...base, ...perFile }),
        ...sanitizeReaderPreferenceValues(intended),
        ...sanitizeReaderPreferenceValues(device),
      };
    },
    async patch(changed) {
      active();
      const values = sanitizeReaderPreferenceValues(changed),
        wire = toBookOrbitPreferencePatch(file.format, values);
      const deviceSet: Record<string, unknown> = {},
        deviceUnset: string[] = [],
        localSet: Record<string, unknown> = {};
      for (const name of Object.keys(
        values,
      ) as (keyof ReaderPreferenceValues)[]) {
        if (client.readOnly || !wire.portable.has(name))
          deviceSet[name] = values[name];
        else {
          deviceUnset.push(name);
          localSet[name] = values[name];
        }
      }
      if (!Object.keys(values).length) return;
      // A local choice of automatic direction remains explicit even after the
      // server removes its override, rather than inheriting an old cached value.
      if (values.comicDirection === "auto") deviceSet.comicDirection = "auto";
      await repo.saveReaderPreferencePatch(
        bookId,
        file.id,
        { deviceSet, deviceUnset, set: wire.set, unset: wire.unset, localSet },
        { readOnly: client.readOnly },
      );
      active();
      if (
        !client.readOnly &&
        (Object.keys(wire.set).length || wire.unset.length)
      ) {
        if (onQueued) await onQueued();
        else await coordinator.flush();
      }
    },
  };
}
