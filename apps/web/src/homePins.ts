import type { BookOrbitClient } from "../../../packages/core/src/bookorbit";
import type { LibraryRepository } from "../../../packages/core/src/repository";
import type { Book, Collection } from "../../../packages/core/src/types";

export interface HomePin {
  kind: "collection" | "scope";
  id: string;
}
export type NamedHomePin = HomePin & { name: string };
export const HOME_PIN_LIMIT = 12;
export const HOME_PIN_PREFERENCE = "home-pins-v1";
export type HomePinRepository = Pick<
  LibraryRepository,
  "scope" | "getPreferences" | "patchPreferences"
>;
export type HomePinClient = Pick<
  BookOrbitClient,
  "listSmartScopes" | "getSmartScopeBooks" | "getCollectionBooks"
>;

export class HomePinError extends Error {
  constructor(public readonly code: "invalid" | "limit") {
    super(
      code === "limit"
        ? "Home pin limit reached."
        : "Invalid Home pin preferences.",
    );
  }
}
export const homePinKey = (pin: HomePin) => JSON.stringify([pin.kind, pin.id]);

/** Pin preferences contain identities only, never server URLs, credentials or book blobs. */
export function parseHomePins(value: unknown): HomePin[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > HOME_PIN_LIMIT)
    throw new HomePinError("invalid");
  const seen = new Set<string>();
  return value.map((item: unknown) => {
    if (
      !item ||
      typeof item !== "object" ||
      !("kind" in item) ||
      !("id" in item) ||
      (item.kind !== "collection" && item.kind !== "scope") ||
      typeof item.id !== "string" ||
      !item.id.trim() ||
      item.id.length > 256 ||
      /[\u0000-\u001f\u007f]/.test(item.id)
    )
      throw new HomePinError("invalid");
    const pin: HomePin = { kind: item.kind, id: item.id };
    const key = homePinKey(pin);
    if (seen.has(key)) throw new HomePinError("invalid");
    seen.add(key);
    return pin;
  });
}

export async function loadHomePins(
  repo: HomePinRepository,
): Promise<HomePin[]> {
  return parseHomePins((await repo.getPreferences(HOME_PIN_PREFERENCE)).pins);
}

export type HomePinChange =
  | { type: "pin" | "unpin"; pin: HomePin }
  | { type: "move"; pin: HomePin; direction: -1 | 1 };

/** Serialize rapid controls against fresh persisted preferences; a failed write cannot become UI state. */
const pending = new WeakMap<HomePinRepository, Promise<unknown>>();
export function changeHomePins(
  repo: HomePinRepository,
  change: HomePinChange,
): Promise<HomePin[]> {
  const run = (pending.get(repo) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const [pin] = parseHomePins([change.pin]);
      const pins = await loadHomePins(repo);
      const index = pins.findIndex(
        (item) => homePinKey(item) === homePinKey(pin),
      );
      if (change.type === "pin" && index < 0) {
        if (pins.length >= HOME_PIN_LIMIT) throw new HomePinError("limit");
        pins.push(pin);
      } else if (change.type === "unpin" && index >= 0) pins.splice(index, 1);
      else if (change.type === "move" && index >= 0) {
        if (change.direction !== -1 && change.direction !== 1)
          throw new HomePinError("invalid");
        const destination = index + change.direction;
        if (destination >= 0 && destination < pins.length)
          [pins[index], pins[destination]] = [pins[destination], pins[index]];
      }
      await repo.patchPreferences({ pins }, HOME_PIN_PREFERENCE);
      return pins;
    });
  pending.set(repo, run);
  void run
    .finally(() => {
      if (pending.get(repo) === run) pending.delete(repo);
    })
    .catch(() => {});
  return run;
}

export function homePinOptions(
  collections: readonly Collection[],
  scopes: readonly { id: string; name: string }[],
): NamedHomePin[] {
  const items: NamedHomePin[] = [
    ...collections
      .filter((item) => item.id !== "queue")
      .map((item) => ({
        kind: "collection" as const,
        id: item.id,
        name: item.name,
      })),
    ...scopes.map((item) => ({
      kind: "scope" as const,
      id: item.id,
      name: item.name,
    })),
  ];
  return [...new Map(items.map((item) => [homePinKey(item), item])).values()];
}

export async function loadPinnedBooks(
  pin: HomePin,
  client: HomePinClient | null,
  collections: readonly Collection[],
  books: readonly Book[],
  page: number,
  size: number,
  signal: AbortSignal,
): Promise<{ items: Book[]; total: number; page: number; size: number }> {
  parseHomePins([pin]);
  if (
    !Number.isInteger(page) ||
    page < 1 ||
    !Number.isInteger(size) ||
    size < 1 ||
    size > 40
  )
    throw new HomePinError("invalid");
  signal.throwIfAborted();
  if (client) {
    const result =
      pin.kind === "scope"
        ? await client.getSmartScopeBooks(pin.id, page, size)
        : await client.getCollectionBooks(
            pin.id,
            page,
            size,
            undefined,
            signal,
          );
    // The verified smart-scope client currently has no signal parameter. Its late
    // response is still discarded before caching or rendering another account.
    signal.throwIfAborted();
    return { ...result, items: result.items.slice(0, size) };
  }
  const collection =
    pin.kind === "collection"
      ? collections.find((item) => item.id === pin.id)
      : undefined;
  const ids = new Set(collection?.bookIds ?? []);
  const items = books.filter((book) => ids.has(book.id));
  return {
    items: items.slice((page - 1) * size, page * size),
    total: items.length,
    page,
    size,
  };
}
