// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import {
  useAppNotifications,
  type AppNotifications,
  NOTIFICATION_LIMIT,
} from "./appNotifications";
import { TopNotificationBanner } from "./TopNotificationBanner";
import { setLocale } from "../../../packages/i18n/src";
let root: Root,
  host: HTMLDivElement,
  api: AppNotifications,
  hidden = false;
function Harness({
  scope = "one",
  error = "",
  clear = () => {},
}: {
  scope?: string;
  error?: string;
  clear?: () => void;
}) {
  api = useAppNotifications(scope);
  return (
    <TopNotificationBanner
      notifications={api}
      error={error}
      onDismissError={clear}
    />
  );
}
beforeEach(() => {
  vi.useFakeTimers();
  setLocale("en");
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  hidden = false;
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => hidden,
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.querySelectorAll("dialog").forEach((dialog) => dialog.remove());
  vi.useRealTimers();
});
const render = (props: Parameters<typeof Harness>[0] = {}) =>
  act(async () => root.render(<Harness {...props} />));
const banner = () =>
  document.querySelector<HTMLElement>("[data-avid-notification]");
const advance = (ms: number) =>
  act(async () => {
    vi.advanceTimersByTime(ms);
  });
it("shows exactly one top notification, deduplicates repeats and advances to queued messages", async () => {
  await render();
  await act(async () => {
    api.notify("First");
    api.notify("First");
    api.notify("Second");
  });
  expect(api.items).toHaveLength(2);
  expect(document.querySelectorAll("[data-avid-notification]")).toHaveLength(1);
  expect(banner()?.textContent).toContain("First");
  expect(banner()?.textContent).not.toContain("Second");
  await advance(6000);
  expect(banner()?.textContent).toContain("Second");
  await advance(6000);
  expect(banner()).toBeNull();
});
it("prioritizes a persistent external error and does not expire a hidden queued message", async () => {
  const clear = vi.fn();
  await render({ error: "Connection failed", clear });
  await act(async () => api.notify("Saved"));
  expect(banner()?.querySelector('[role="alert"]')?.textContent).toBe(
    "Connection failed",
  );
  await advance(30000);
  expect(api.items).toHaveLength(1);
  await act(async () =>
    banner()!
      .querySelector<HTMLButtonElement>(".top-notification-close")!
      .click(),
  );
  expect(clear).toHaveBeenCalledOnce();
  await render();
  expect(banner()?.textContent).toContain("Saved");
  await advance(6000);
  expect(banner()).toBeNull();
});
it("pauses dismissal while hidden or focused and preserves remaining display time", async () => {
  await render();
  await act(async () => api.notify("Read this"));
  await advance(2000);
  await act(async () => {
    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await advance(30000);
  expect(banner()).not.toBeNull();
  await act(async () => {
    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await advance(2000);
  await act(async () =>
    banner()!
      .querySelector<HTMLButtonElement>(".top-notification-close")!
      .focus(),
  );
  await advance(30000);
  expect(banner()).not.toBeNull();
  await act(async () =>
    banner()!
      .querySelector<HTMLButtonElement>(".top-notification-close")!
      .blur(),
  );
  await advance(2000);
  expect(banner()).toBeNull();
});
it("moves the same single banner into the latest opened modal and back when it closes", async () => {
  await render();
  await act(async () => api.notify("Visible in the reader", { duration: 0 }));
  const first = document.createElement("dialog"),
    second = document.createElement("dialog");
  await act(async () => {
    document.body.append(first, second);
    second.open = true;
  });
  expect(banner()?.parentElement).toBe(second);
  await act(async () => {
    first.open = true;
  });
  expect(banner()?.parentElement).toBe(first);
  await act(async () => {
    first.open = false;
  });
  expect(banner()?.parentElement).toBe(second);
  await act(async () => {
    second.remove();
  });
  expect(banner()?.parentElement).toBe(document.body);
  expect(document.querySelectorAll("[data-avid-notification]")).toHaveLength(1);
});
it("clears account messages and rejects a late callback captured by the previous account", async () => {
  await render();
  const staleNotify = api.notify;
  await act(async () => api.notify("Private old account"));
  await render({ scope: "two" });
  await act(async () => staleNotify("Late old account"));
  expect(banner()).toBeNull();
  await act(async () => api.notify("New account"));
  expect(banner()?.textContent).toContain("New account");
});
it("resumes timers after a focused banner moves out of a closed modal or is removed", async () => {
  await render();
  const dialog = document.createElement("dialog");
  await act(async () => {
    dialog.open = true;
    document.body.append(dialog);
    api.notify("Modal message");
  });
  await advance(1000);
  await act(async () =>
    banner()!
      .querySelector<HTMLButtonElement>(".top-notification-close")!
      .focus(),
  );
  await advance(10000);
  expect(banner()).not.toBeNull();
  await act(async () => {
    dialog.open = false;
  });
  await advance(5000);
  expect(banner()).toBeNull();
  await act(async () => api.notify("Dismiss this"));
  await act(async () => {
    const close = banner()!.querySelector<HTMLButtonElement>(
      ".top-notification-close",
    )!;
    close.focus();
    close.click();
  });
  expect(banner()).toBeNull();
  await act(async () => api.notify("Later notice"));
  await advance(6000);
  expect(banner()).toBeNull();
});
it("keeps explicit errors until dismissed and bounds a burst of notices", async () => {
  await render();
  await act(async () => {
    for (let i = 0; i < 100; i++) api.notify(`Message ${i}`);
    api.notify("Error", { kind: "error" });
  });
  expect(api.items).toHaveLength(NOTIFICATION_LIMIT);
  expect(banner()?.querySelector('[role="alert"]')?.textContent).toBe("Error");
  await advance(30000);
  expect(banner()?.textContent).toContain("Error");
  await act(async () => api.notify(""));
  expect(banner()).toBeNull();
});
