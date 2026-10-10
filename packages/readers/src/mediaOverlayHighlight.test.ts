// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import "../vendor/foliate/view.js";

const doc = new DOMParser().parseFromString(
  '<html xmlns="http://www.w3.org/1999/xhtml"><body><p id="p1">First</p><p id="p2">Second</p></body></html>',
  "application/xhtml+xml",
);
const navigate = vi.fn(async (_target: unknown) => {});
class FixtureRenderer extends HTMLElement {
  open() {}
  destroy() {}
  goTo(target: unknown) {
    return navigate(target);
  }
  getContents() {
    return [{ doc, index: 0 }];
  }
}
if (!customElements.get("foliate-paginator"))
  customElements.define("foliate-paginator", FixtureRenderer);
const tick = () => Promise.resolve().then(() => {});

describe("embedded narration DOM highlight ownership", () => {
  it("removes superseded highlights and does not resurrect a pending old highlight after a newer passage or gap", async () => {
    const view = document.createElement("foliate-view") as HTMLElement & {
      open(book: unknown): Promise<void>;
      close(): void;
      mediaOverlayFollow: boolean;
      mediaOverlayNavigating: boolean;
    };
    const overlay = new EventTarget();
    await view.open({
      sections: [
        { id: "chapter.xhtml", mediaOverlay: { href: "timing.smil" } },
      ],
      media: { activeClass: "narrating" },
      getMediaOverlay: () => overlay,
      resolveHref: (href: string) => ({
        index: 0,
        anchor: (content: Document) =>
          content.getElementById(href.split("#")[1]!),
      }),
    });
    let finish!: () => void;
    navigate.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    overlay.dispatchEvent(
      new CustomEvent("highlight", { detail: { text: "chapter.xhtml#p1" } }),
    );
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledOnce());
    expect(view.mediaOverlayNavigating).toBe(true);
    overlay.dispatchEvent(new Event("unhighlight"));
    overlay.dispatchEvent(
      new CustomEvent("highlight", { detail: { text: "chapter.xhtml#p2" } }),
    );
    await tick();
    expect(doc.querySelector(".narrating")).toBeNull();
    finish();
    await vi.waitFor(() =>
      expect(doc.querySelector(".narrating")?.id).toBe("p2"),
    );
    expect(doc.querySelectorAll(".narrating")).toHaveLength(1);
    expect(view.mediaOverlayNavigating).toBe(false);
    overlay.dispatchEvent(new Event("unhighlight"));
    expect(doc.querySelector(".narrating")).toBeNull();
    view.mediaOverlayFollow = false;
    const count = navigate.mock.calls.length;
    overlay.dispatchEvent(
      new CustomEvent("highlight", { detail: { text: "chapter.xhtml#p1" } }),
    );
    await tick();
    expect(navigate).toHaveBeenCalledTimes(count);
    expect(doc.querySelector(".narrating")?.id).toBe("p1");
    overlay.dispatchEvent(new Event("unhighlight"));
    view.close();
  });
});
