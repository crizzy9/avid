import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import type { Book } from "../../../packages/core/src/types";
import type { BookCoverCache } from "./coverCache";

export const CoverContext = createContext<BookCoverCache | null>(null);
const noSubscribe = () => () => {};
/** Viewport and keyboard focus own cover references; hidden books never start requests. */
export function useBookCover(book: Book) {
  const cache = useContext(CoverContext);
  const ref = useRef<HTMLDivElement>(null);
  const snapshot = useCallback(
    () => (cache?.has(book.id) ? cache.get(book.id) : book.coverUrl),
    [cache, book.id, book.coverUrl],
  );
  const url = useSyncExternalStore(
    cache?.subscribe ?? noSubscribe,
    snapshot,
    snapshot,
  );
  useEffect(() => {
    if (!cache || !cache.has(book.id) || !ref.current) return;
    const node = ref.current,
      focusTarget = node.closest("button") ?? node;
    let alive = true,
      visible = false,
      release: (() => void) | undefined;
    const update = () => {
      if (!alive) return;
      const needed = visible || focusTarget.contains(document.activeElement);
      if (needed && !release) release = cache.acquire(book.id);
      else if (!needed && release) {
        release();
        release = undefined;
      }
    };
    const focus = () => update();
    const blur = () => queueMicrotask(update);
    focusTarget.addEventListener("focusin", focus);
    focusTarget.addEventListener("focusout", blur);
    const observer =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(
            (entries) => {
              visible = entries.some((entry) => entry.isIntersecting);
              update();
            },
            { rootMargin: "160px" },
          );
    if (observer) observer.observe(node);
    else {
      visible = true;
      update();
    }
    return () => {
      alive = false;
      observer?.disconnect();
      focusTarget.removeEventListener("focusin", focus);
      focusTarget.removeEventListener("focusout", blur);
      release?.();
    };
  }, [cache, book.id, book.coverUrl]);
  return { ref, url };
}
