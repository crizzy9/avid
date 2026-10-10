// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BookOrbitClient } from "../../../packages/core/src/bookorbit";
import type { Session } from "../../../packages/core/src/types";
import { Connect } from "./Connect";
vi.mock("./ProviderSignIn", () => ({ ProviderSignIn: () => null }));
let root: Root,
  host: HTMLDivElement,
  unmounted = false;
const onConnect =
    vi.fn<NonNullable<React.ComponentProps<typeof Connect>["onConnect"]>>(),
  onAttempt = vi.fn();
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  unmounted = false;
  onConnect.mockReset().mockResolvedValue();
  onAttempt.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(<Connect onConnect={onConnect} onAttempt={onAttempt} />),
  );
  for (const [selector, value] of [
    ['input[autocomplete="url"]', "https://books.example"],
    ['input[autocomplete="username"]', "reader"],
    ['input[type="password"]', "fixture-password"],
  ]) {
    const input = host.querySelector<HTMLInputElement>(selector)!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
});
afterEach(async () => {
  if (!unmounted) await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});
const session: Session = {
  profile: { id: "p", url: "https://books.example", name: "Books" },
  userId: "7",
  accessToken: "fixture-token",
};
describe("password connection cancellation", () => {
  it('waits for the old native credential owner to clear before starting login', async () => {
    let ready!: () => void;
    onAttempt.mockImplementation(() => new Promise<void>(resolve => { ready = resolve; }));
    const login = vi.spyOn(BookOrbitClient, 'login').mockResolvedValue(session);
    await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles:true,cancelable:true})); });
    expect(login).not.toHaveBeenCalled();
    await act(async () => { ready(); });
    expect(login).toHaveBeenCalledOnce();
    expect(onConnect).toHaveBeenCalledOnce();
  });
  it("announces the manual attempt before login and ignores a response after modal unmount", async () => {
    let resolve!: (session: Session) => void;
    vi.spyOn(BookOrbitClient, "login").mockImplementation(() => {
      expect(onAttempt).toHaveBeenCalledOnce();
      return new Promise((done) => {
        resolve = done;
      });
    });
    await act(async () =>
      host
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    expect(
      host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled,
    ).toBe(true);
    await act(async () => root.unmount());
    unmounted = true;
    await act(async () => {
      resolve(session);
    });
    expect(onConnect).not.toHaveBeenCalled();
  });
  it("connects the confirmed active attempt with its read-only choice", async () => {
    vi.spyOn(BookOrbitClient, "login").mockResolvedValue(session);
    await act(async () =>
      host
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    expect(onAttempt).toHaveBeenCalledOnce();
    expect(onConnect).toHaveBeenCalledExactlyOnceWith(session, true);
    expect(
      host.querySelector<HTMLInputElement>('input[type="password"]')!.value,
    ).toBe("");
  });
});
