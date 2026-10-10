// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AO3Panel } from "../src/AO3Panel";
import { Ao3FollowStore } from "../src/ao3";
import { chapterIndex, subscriptions, workPage } from "./fixtures/ao3";

Object.defineProperty(globalThis, "crypto", {
  value: webcrypto,
  configurable: true,
});
let root: Root, host: HTMLDivElement;
const imported =
  vi.fn<NonNullable<React.ComponentProps<typeof AO3Panel>["onImport"]>>();
const transport = vi.fn<typeof fetch>();
const fixture = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.pathname === "/v1/session")
    return Response.json(
      init?.method === "POST"
        ? { username: "reader", sessionId: "s".repeat(64) }
        : { disconnected: true },
    );
  if (url.pathname === "/v1/epub")
    return new Response("PK-fixture", {
      headers: { "Content-Type": "application/epub+zip" },
    });
  const path = url.searchParams.get("path")!;
  return Response.json({
    url: `https://archiveofourown.org${path}`,
    html: path.includes("/subscriptions")
      ? subscriptions()
      : path.endsWith("/navigate")
        ? chapterIndex()
        : workPage(),
  });
};
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  imported.mockReset().mockResolvedValue();
  transport.mockReset().mockImplementation(fixture);
  vi.stubGlobal("fetch", transport);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(<AO3Panel accountScope="account-a" onImport={imported} />),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const button = (label: string) =>
  [...host.querySelectorAll("button")].find(
    (button) => button.textContent === label,
  )!;
async function settle(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  do {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  } while (!predicate() && Date.now() < deadline);
  expect(predicate()).toBe(true);
}
async function connect() {
  await act(async () =>
    host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
  );
  for (const [suffix, value] of [
    ["pairing", "pairing".repeat(8)],
    ["login", "reader"],
    ["password", "fixture-password"],
  ]) {
    const input = host.querySelector<HTMLInputElement>(
      `input[id$="-${suffix}"]`,
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  await act(async () =>
    host
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  await settle(() => host.textContent!.includes("A Lantern at Sea"));
}
describe("opt-in AO3 panel", () => {
  it("makes no request until enabled and connected, then imports one explicit edition only once", async () => {
    expect(transport).not.toHaveBeenCalled();
    await connect();
    expect(localStorage.length).toBe(0);
    await act(async () => button("Check updates").click());
    await settle(() => !!button("Import this edition"));
    expect(imported).not.toHaveBeenCalled();
    await act(async () => button("Import this edition").click());
    await settle(() => host.textContent!.includes("Edition imported."));
    expect(imported).toHaveBeenCalledTimes(1);
    expect(imported.mock.calls[0][0]).toMatchObject({
      accountId: "reader",
      workId: "123",
      title: "A Lantern at Sea",
      chapterIds: ["11", "12"],
    });
    expect(imported.mock.calls[0][0].file.name).toMatch(/^AO3-123-.*\.epub$/);
    expect(button("Import this edition").disabled).toBe(true);
    await act(async () => button("Import this edition").click());
    expect(imported).toHaveBeenCalledTimes(1);
    expect(
      new Ao3FollowStore("account-a", "reader").all()[0].importedRevisions,
    ).toHaveLength(1);
    const saved = localStorage.getItem(localStorage.key(0)!)!;
    expect(saved).not.toContain("fixture-password");
    expect(saved).not.toContain("pairing");
    expect(saved).not.toContain("sessionId");
  });
  it("cancels an in-flight edition import on account switch and clears private form state", async () => {
    await connect();
    await act(async () => button("Check updates").click());
    await settle(() => !!button("Import this edition"));
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    transport.mockImplementation((input, init) =>
      new URL(String(input)).pathname === "/v1/epub"
        ? pending
        : fixture(input, init),
    );
    await act(async () => button("Import this edition").click());
    await settle(() =>
      transport.mock.calls.some(
        ([input]) => new URL(String(input)).pathname === "/v1/epub",
      ),
    );
    await act(async () =>
      root.render(<AO3Panel accountScope="account-b" onImport={imported} />),
    );
    await act(async () => {
      finish(
        new Response("PK-fixture", {
          headers: { "Content-Type": "application/epub+zip" },
        }),
      );
    });
    expect(imported).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("A Lantern at Sea");
    expect(
      host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked,
    ).toBe(false);
    await act(async () =>
      host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
    );
    expect(
      host.querySelector<HTMLInputElement>('input[id$="-pairing"]')!.value,
    ).toBe("");
    expect(
      host.querySelector<HTMLInputElement>('input[id$="-password"]')!.value,
    ).toBe("");
    expect(new Ao3FollowStore("account-b", "reader").all()).toEqual([]);
  });
});
