// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReadAlongPanel } from "./ReadAlongPanel";
import { HandoffControls } from "./HandoffControls";
import {
  handoffPolicyKey,
  latestConfirmedPosition,
  readHandoffPolicy,
} from "./readAlongState";
import type { AlignedPassageText } from "../../../packages/readers/src/alignedPassage";
import { setLocale } from "../../../packages/i18n/src";

const lines: AlignedPassageText[] = [
  {
    segmentId: "one",
    text: "The tide turned.",
    textLocator: "epubcfi(/6/2!/4/2)",
    sectionIndex: 0,
    start: 0,
    end: 10,
    trackId: "audio",
    trackTime: 0,
  },
  {
    segmentId: "two",
    text: "The boat left the harbor.",
    textLocator: "epubcfi(/6/2!/4/4)",
    sectionIndex: 0,
    start: 10,
    end: 20,
    trackId: "audio",
    trackTime: 10,
  },
  {
    segmentId: "three",
    text: "The sea was still.",
    textLocator: "epubcfi(/6/4!/4/2)",
    sectionIndex: 1,
    start: 30,
    end: 50,
    trackId: "audio",
    trackTime: 30,
  },
];
let host: HTMLDivElement, root: Root;
let panel: ComponentProps<typeof ReadAlongPanel>;
let controls: ComponentProps<typeof HandoffControls>;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  setLocale("en");
  localStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  panel = { lines, seconds: 0, onSeek: vi.fn(), onUndo: vi.fn() };
  controls = {
    policy: "manual",
    onPolicy: vi.fn(),
    preview: false,
    onPreview: vi.fn(),
    onConfirm: vi.fn(),
  };
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  setLocale("en");
});
async function renderPanel(
  changes: Partial<ComponentProps<typeof ReadAlongPanel>> = {},
) {
  panel = { ...panel, ...changes };
  await act(async () => root.render(<ReadAlongPanel {...panel} />));
}
async function renderControls(
  changes: Partial<ComponentProps<typeof HandoffControls>> = {},
) {
  controls = { ...controls, ...changes };
  await act(async () => root.render(<HandoffControls {...controls} />));
}
function button(text: string) {
  const result = [...host.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === text,
  );
  if (!result) throw new Error(`Missing button ${text}`);
  return result;
}
async function click(text: string) {
  await act(async () => button(text).click());
}
function activeText() {
  return host.querySelector('[aria-current="true"]')?.textContent ?? null;
}

describe("read-along transcript", () => {
  it("reveals text explicitly and highlights only exact half-open intervals, including backward movement", async () => {
    await renderPanel();
    expect(host.querySelector(".read-along-lines")).toBeNull();
    expect(button("Show text").getAttribute("aria-expanded")).toBe("false");
    await click("Show text");
    expect(activeText()).toBe(lines[0]!.text);
    expect(button("Hide text").getAttribute("aria-expanded")).toBe("true");
    await renderPanel({ seconds: 10 });
    expect(activeText()).toBe(lines[1]!.text);
    await renderPanel({ seconds: 20 });
    expect(activeText()).toBeNull();
    expect(host.textContent).toContain("No aligned text at this moment.");
    await renderPanel({ seconds: 35 });
    expect(activeText()).toBe(lines[2]!.text);
    await renderPanel({ seconds: 4 });
    expect(activeText()).toBe(lines[0]!.text);
    await renderPanel({ seconds: 50 });
    expect(activeText()).toBeNull();
    await renderPanel({ seconds: NaN });
    expect(activeText()).toBeNull();
    expect(panel.onSeek).not.toHaveBeenCalled();
  });
  it("seeks to the chosen passage start and exposes undo without silently changing the position", async () => {
    await renderPanel({ seconds: 8 });
    await click("Show text");
    await click(lines[2]!.text);
    expect(panel.onSeek).toHaveBeenCalledExactlyOnceWith(30);
    expect(panel.onUndo).not.toHaveBeenCalled();
    await click("Undo position change");
    expect(panel.onUndo).toHaveBeenCalledOnce();
    await renderPanel({ onUndo: undefined });
    expect(host.textContent).not.toContain("Undo position change");
    await click("Hide text");
    expect(host.querySelector(".read-along-lines")).toBeNull();
    expect(panel.onSeek).toHaveBeenCalledOnce();
  });
  it("clears active text for a decoded tail outside the current track's declared timeline", async () => {
    await renderPanel({ seconds: 12 });
    await click("Show text");
    expect(activeText()).toBe(lines[1]!.text);
    await renderPanel({ seconds: null });
    expect(activeText()).toBeNull();
    expect(host.textContent).toContain("No aligned text at this moment.");
    expect(panel.onSeek).not.toHaveBeenCalled();
    await renderPanel({ seconds: 10 });
    expect(activeText()).toBe(lines[1]!.text);
  });
  it("scrolls only the transcript viewport, and leaves its position alone with follow disabled", async () => {
    vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains("read-along-lines")) return 20;
        return this.textContent === lines[0]!.text ? 80 : 300;
      },
    );
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.classList.contains("read-along-lines") ? 100 : 40;
      },
    );
    await renderPanel();
    await click("Show text");
    const viewport = host.querySelector<HTMLDivElement>(".read-along-lines")!;
    // The positioned viewport is the button's offset parent; its own page
    // offset must not be subtracted from this local scroll coordinate.
    expect(viewport.scrollTop).toBe(50);
    const follow = host.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    )!;
    await act(async () => follow.click());
    expect(follow.checked).toBe(false);
    viewport.scrollTop = 77;
    await renderPanel({ seconds: 12 });
    expect(activeText()).toBe(lines[1]!.text);
    expect(viewport.scrollTop).toBe(77);
    await act(async () => follow.click());
    expect(viewport.scrollTop).toBe(270);
    viewport.scrollTop = 91;
    await renderPanel({ seconds: 23 });
    expect(viewport.scrollTop).toBe(91);
    await renderPanel({ seconds: 4 });
    expect(viewport.scrollTop).toBe(50);
    expect(host.scrollTop).toBe(0);
    expect(document.documentElement.scrollTop).toBe(0);
  });
  it("renders extracted publication content as literal text without injecting elements or URL-bearing markup", async () => {
    const untrusted =
      '<img src="https://example.invalid/private" onerror="alert(1)"><script>throw Error()</script> & text';
    await renderPanel({
      lines: [{ ...lines[0]!, text: untrusted }],
      children: <p>Position preferences</p>,
    });
    await click("Show text");
    expect(host.querySelector(".read-along-lines button")?.textContent).toBe(
      untrusted,
    );
    expect(
      host.querySelectorAll("img,script,iframe,object,embed"),
    ).toHaveLength(0);
    expect(host.textContent).toContain("Position preferences");
  });
  it("has no active passage for an empty alignment and does not request a seek", async () => {
    await renderPanel({ lines: [] });
    await click("Show text");
    expect(activeText()).toBeNull();
    expect(host.querySelectorAll(".read-along-lines button")).toHaveLength(0);
    expect(panel.onSeek).not.toHaveBeenCalled();
  });
});

describe("deliberate handoff controls", () => {
  it("changes policy only on an explicit selection, without confirming a preview", async () => {
    await renderControls();
    const select = host.querySelector("select")!;
    expect([...select.options].map((option) => option.value)).toEqual([
      "manual",
      "latest",
      "separate",
    ]);
    expect(select.value).toBe("manual");
    expect(controls.onPolicy).not.toHaveBeenCalled();
    await act(async () => {
      select.value = "latest";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(controls.onPolicy).toHaveBeenCalledExactlyOnceWith("latest");
    expect(controls.onConfirm).not.toHaveBeenCalled();
    await renderControls({ policy: "separate" });
    expect(select.value).toBe("separate");
    expect(controls.onPolicy).toHaveBeenCalledOnce();
  });
  it("offers confirmation only while preview is active and does not save on checkbox changes", async () => {
    await renderControls();
    expect(host.textContent).not.toContain("Save this reading position");
    await act(async () =>
      host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
    );
    expect(controls.onPreview).toHaveBeenCalledExactlyOnceWith(true);
    expect(controls.onConfirm).not.toHaveBeenCalled();
    await renderControls({ preview: true });
    await click("Save this reading position");
    expect(controls.onConfirm).toHaveBeenCalledOnce();
    await renderControls({ onPreview: undefined, onConfirm: undefined });
    expect(host.querySelector('input[type="checkbox"]')).toBeNull();
    expect(host.textContent).not.toContain("Save this reading position");
  });
  it("restores only the selected account/book policy and defaults safely on storage denial", () => {
    localStorage.setItem(handoffPolicyKey("account-a", "book"), "latest");
    localStorage.setItem(handoffPolicyKey("account-b", "book"), "separate");
    expect(readHandoffPolicy("account-a", "book")).toBe("latest");
    expect(readHandoffPolicy("account-b", "book")).toBe("separate");
    expect(readHandoffPolicy("account-a", "other")).toBe("manual");
    localStorage.setItem(handoffPolicyKey("account-a", "book"), "unexpected");
    expect(readHandoffPolicy("account-a", "book")).toBe("manual");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("Denied", "SecurityError");
    });
    expect(readHandoffPolicy("account-b", "book")).toBe("manual");
  });
  it("chooses the most recent confirmed action even when it goes backward, ignoring corrupt records", () => {
    const forward = {
      source: "reading" as const,
      seconds: 800,
      updatedAt: "2026-10-10T12:00:00Z",
    };
    const backward = {
      source: "listening" as const,
      seconds: 20,
      updatedAt: "2026-10-10T12:01:00Z",
    };
    expect(
      latestConfirmedPosition([
        forward,
        backward,
        { source: "reading", seconds: -5, updatedAt: "2026-10-10T12:02:00Z" },
        {
          source: "listening",
          seconds: Infinity,
          updatedAt: "2026-10-10T12:03:00Z",
        },
        { source: "reading", seconds: 900, updatedAt: "invalid" },
      ]),
    ).toBe(backward);
    expect(latestConfirmedPosition([])).toBeUndefined();
  });
});
