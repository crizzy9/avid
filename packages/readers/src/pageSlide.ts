import { useCallback, useEffect, useRef, type RefObject } from "react";
import { prefersReducedMotion, useReducedMotion } from "./reducedMotion";

/** Animate the actual decoded page, without remounting selection or reader controls. */
export function usePageSlide(
  target: RefObject<HTMLElement | null>,
  options: {
    identity: string;
    enabled: boolean;
    direction: "ltr" | "rtl";
  },
) {
  const reduced = useReducedMotion();
  const current = useRef(options);
  current.current = options;
  const previous = useRef<{ identity: string; page: number } | undefined>(
    undefined,
  );
  const animation = useRef<Animation | undefined>(undefined);
  const cancel = useCallback(() => {
    animation.current?.cancel();
    animation.current = undefined;
  }, []);
  useEffect(() => {
    if (!options.enabled || reduced) cancel();
    return cancel;
  }, [options.identity, options.enabled, options.direction, reduced, cancel]);
  return useCallback(
    (page: number) => {
      const options = current.current;
      const last = previous.current;
      previous.current = { identity: options.identity, page };
      if (last?.identity !== options.identity || last.page === page) return;
      cancel();
      if (
        !options.enabled ||
        prefersReducedMotion() ||
        !target.current?.animate
      )
        return;
      const sign =
        (page > last.page ? 1 : -1) * (options.direction === "rtl" ? -1 : 1);
      const active = target.current.animate(
        [
          { transform: `translateX(${sign * 100}%)` },
          { transform: "translateX(0)" },
        ],
        { duration: 220, easing: "cubic-bezier(.2,.7,.3,1)" },
      );
      animation.current = active;
      active.onfinish = active.oncancel = () => {
        if (animation.current === active) animation.current = undefined;
      };
    },
    [target, cancel],
  );
}
