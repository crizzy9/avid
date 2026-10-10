import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  NativeSystemSurfaces,
  SystemBook,
} from "../../mobile/src/native-surfaces";
const book = (value: SystemBook) => ({
  bookId: value.bookId,
  fileId: value.fileId,
  title: value.title,
  author: value.author,
  kind: value.kind,
});
const request = <T>(action: string, payload: Record<string, unknown> = {}) =>
  invoke<T>("desktop_spotlight", { request: { action, ...payload } });
const surfaces: NativeSystemSurfaces = {
  capabilities: () => request("capabilities"),
  activateAccount: (options) => request("activate", options),
  indexBooks: (options) =>
    request("index", {
      accountScope: options.accountScope,
      books: options.books.map(book),
    }),
  publishRecent: async (options) => {
    const result = await request<{ ids: string[] }>("index", {
      accountScope: options.accountScope,
      books: [book(options.book)],
    });
    return { id: result.ids[0] ?? "" };
  },
  removeBooks: (options) => request("remove", options),
  clearAccount: () => request("clear"),
  consumeNavigation: () => request("consume"),
  addListener: async (_event, callback) => {
    const remove = await listen("avid:desktop-navigation", callback);
    return { remove: async () => remove() };
  },
};
/** macOS reports the actual Core Spotlight bridge; other desktop systems report unavailable. */
export function getDesktopSystemSurfaces(): NativeSystemSurfaces | null {
  return isTauri() ? surfaces : null;
}
