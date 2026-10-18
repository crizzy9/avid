import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  CheckCircle2,
  Info,
  TriangleAlert,
  X,
  ChevronRight,
} from "lucide-react";
import { useI18n } from "../../../packages/i18n/src";
import type { AppNotifications } from "./appNotifications";
import { notificationT as t } from "./notificationMessages";
import "./TopNotificationBanner.css";

/** Native modal dialogs live above every z-index. Keep the one banner inside the active top-layer dialog. */
function useNotificationHost() {
  const [host, setHost] = useState<HTMLElement>(() => document.body);
  useEffect(() => {
    let previous: HTMLDialogElement[] = [],
      order: HTMLDialogElement[] = [];
    const update = () => {
      const open = [
        ...document.querySelectorAll<HTMLDialogElement>("dialog[open]"),
      ];
      order = order.filter((dialog) => open.includes(dialog));
      for (const dialog of open)
        if (!previous.includes(dialog)) order.push(dialog);
      previous = open;
      const target = order.at(-1) ?? document.body;
      setHost((current) => (current === target ? current : target));
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["open"],
    });
    return () => observer.disconnect();
  }, []);
  return host;
}

export function TopNotificationBanner({
  notifications,
  error,
  onDismissError,
}: {
  notifications: AppNotifications;
  error?: string;
  onDismissError: () => void;
}) {
  useI18n();
  const host = useNotificationHost();
  const [hover, setHover] = useState(false),
    [focus, setFocus] = useState(false),
    [hidden, setHidden] = useState(() => document.hidden);
  const active = notifications.items[0];
  const visible = !!error || !!active;
  // Moving the portal or removing its last notice can remove a focused/hovered
  // node without delivering blur/mouseleave. Do not pause later notices forever.
  useEffect(() => {
    setFocus(false);
    setHover(false);
  }, [host, visible]);
  const paused = hover || focus || hidden || !!error;
  const timer = useRef<
    | { id: string; revision: number; remaining: number; started: number }
    | undefined
  >(undefined);
  useEffect(() => {
    const update = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  useEffect(() => {
    if (!active || !active.duration) {
      timer.current = undefined;
      return;
    }
    if (
      timer.current?.id !== active.id ||
      timer.current.revision !== active.revision
    )
      timer.current = {
        id: active.id,
        revision: active.revision,
        remaining: active.duration,
        started: 0,
      };
    if (paused) return;
    const current = timer.current;
    current.started = performance.now();
    const timeout = window.setTimeout(
      () => notifications.dismiss(active.id),
      current.remaining,
    );
    return () => {
      window.clearTimeout(timeout);
      current.remaining = Math.max(
        0,
        current.remaining - (performance.now() - current.started),
      );
    };
  }, [
    active?.id,
    active?.revision,
    active?.duration,
    paused,
    notifications.dismiss,
  ]);
  if (!error && !active) return null;
  const kind = error ? "error" : active!.kind,
    message = error || active!.message;
  const waiting = notifications.items.length - (error ? 0 : 1);
  const dismiss = () => {
    if (error) onDismissError();
    else notifications.dismiss(active!.id);
  };
  const Icon =
    kind === "error" ? TriangleAlert : kind === "success" ? CheckCircle2 : Info;
  return createPortal(
    <div
      className={`top-notification top-notification-${kind}`}
      data-avid-notification="true"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocusCapture={() => setFocus(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setFocus(false);
      }}
    >
      <Icon size={19} aria-hidden="true" />
      <div className="top-notification-content">
        <p
          key={error ? `error:${error}` : active!.revision}
          role={kind === "error" ? "alert" : "status"}
          aria-atomic="true"
        >
          {message}
        </p>
        {waiting > 0 && (
          <button
            type="button"
            className="top-notification-next"
            aria-label={t("next")}
            onClick={dismiss}
          >
            {t("waiting", { count: waiting })}
            <ChevronRight size={14} />
          </button>
        )}
      </div>
      <button
        type="button"
        className="top-notification-close"
        aria-label={t("dismiss")}
        onClick={dismiss}
      >
        <X size={17} />
      </button>
    </div>,
    host,
  );
}
