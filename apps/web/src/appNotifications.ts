import { useCallback, useEffect, useRef, useState } from "react";

export type NotificationKind = "info" | "success" | "error";
export interface AppNotification {
  id: string;
  message: string;
  kind: NotificationKind;
  duration: number;
  revision: number;
  key?: string;
}
export interface NotificationOptions {
  kind?: NotificationKind;
  duration?: number;
  key?: string;
}
export const NOTIFICATION_LIMIT = 20;

/** One account's bounded in-memory notifications; old captured callbacks cannot post to a new account. */
export function useAppNotifications(scope: string) {
  const owner = useRef(scope);
  owner.current = scope;
  const counter = useRef(0);
  const [state, setState] = useState<{
    scope: string;
    items: AppNotification[];
  }>({ scope, items: [] });
  useEffect(() => {
    setState((previous) =>
      previous.scope === scope ? previous : { scope, items: [] },
    );
  }, [scope]);
  const notify = useCallback(
    (message: string, options: NotificationOptions = {}) => {
      if (owner.current !== scope) return;
      // Compatibility for the previous setToast("") dismissal calls.
      if (!message.trim()) {
        setState({ scope, items: [] });
        return;
      }
      const kind = options.kind ?? "info";
      const duration = options.duration ?? (kind === "error" ? 0 : 6000);
      if (!Number.isFinite(duration) || duration < 0)
        throw new Error("Invalid notification duration.");
      const revision = ++counter.current;
      setState((previous) => {
        if (owner.current !== scope) return previous;
        const items = previous.scope === scope ? [...previous.items] : [];
        const index = items.findIndex((item) =>
          options.key
            ? item.key === options.key
            : item.message === message && item.kind === kind,
        );
        const notification: AppNotification = {
          id: index >= 0 ? items[index].id : `notification-${revision}`,
          message,
          kind,
          duration,
          revision,
          key: options.key,
        };
        if (index >= 0) items[index] = notification;
        else if (kind === "error") items.unshift(notification);
        else items.push(notification);
        if (items.length > NOTIFICATION_LIMIT) {
          const discarded = items.findIndex(
            (item, index) => index > 0 && item.kind !== "error",
          );
          items.splice(discarded < 0 ? items.length - 1 : discarded, 1);
        }
        return { scope, items };
      });
    },
    [scope],
  );
  const dismiss = useCallback(
    (id?: string) => {
      if (owner.current !== scope) return;
      setState((previous) =>
        previous.scope !== scope
          ? previous
          : {
              scope,
              items: previous.items.filter(
                (item) => item.id !== (id ?? previous.items[0]?.id),
              ),
            },
      );
    },
    [scope],
  );
  return {
    scope,
    items: state.scope === scope ? state.items : [],
    notify,
    dismiss,
  };
}
export type AppNotifications = ReturnType<typeof useAppNotifications>;
