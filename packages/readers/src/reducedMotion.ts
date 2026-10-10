import { useSyncExternalStore } from "react";

const query = "(prefers-reduced-motion: reduce)";

/** The app can request less motion, but never override an OS reduction. */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof document === "undefined")
    return true;
  return (
    document.documentElement.dataset.motion === "reduce" ||
    (typeof window.matchMedia === "function" &&
      window.matchMedia(query).matches)
  );
}

export function subscribeReducedMotion(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof document === "undefined")
    return () => {};
  const media =
    typeof window.matchMedia === "function"
      ? window.matchMedia(query)
      : undefined;
  if (media?.addEventListener) media.addEventListener("change", onChange);
  else media?.addListener?.(onChange);
  // App settings update the host attribute. Observe it rather than persisting
  // an effective value over the user's independent reader animation choice.
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-motion"],
  });
  return () => {
    observer.disconnect();
    if (media?.removeEventListener)
      media.removeEventListener("change", onChange);
    else media?.removeListener?.(onChange);
  };
}

export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    prefersReducedMotion,
    () => true,
  );
}
