// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { EPUB } from "../vendor/foliate/epub.js";
class FakeAudio extends EventTarget {
  static last: FakeAudio;
  currentTime = 0;
  paused = true;
  volume = 1;
  playbackRate = 1;
  constructor(public src: string) {
    super();
    FakeAudio.last = this;
  }
  async play() {
    this.paused = false;
    this.dispatchEvent(new Event("playing"));
  }
  pause() {
    this.paused = true;
  }
}
afterEach(() => {
  vi.unstubAllGlobals();
});
describe("existing EPUB media-overlay timing", () => {
  it("seeks/highlights using SMIL fragments and actual source time", async () => {
    vi.stubGlobal("Audio", FakeAudio);
    vi.stubGlobal(
      "URL",
      class extends URL {
        static createObjectURL() {
          return "blob:test-audio";
        }
        static revokeObjectURL() {}
      },
    );
    const xml: Record<string, string> = {
      "META-INF/container.xml":
        '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
      "book.opf":
        '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">aligned</dc:identifier><dc:title>Aligned fixture</dc:title><dc:language>en</dc:language></metadata><manifest><item id="c" href="chapter.xhtml" media-type="application/xhtml+xml" media-overlay="s"/><item id="s" href="timing.smil" media-type="application/smil+xml"/><item id="a" href="audio.wav" media-type="audio/wav"/></manifest><spine><itemref idref="c"/></spine></package>',
      "chapter.xhtml":
        '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Aligned</title></head><body><p id="p1">First passage</p><p id="p2">Second passage</p><p id="p3">Third passage</p></body></html>',
      "timing.smil":
        '<smil xmlns="http://www.w3.org/ns/SMIL"><body><seq><par><text src="chapter.xhtml#p1"/><audio src="audio.wav" clipBegin="2s" clipEnd="5s"/></par><par><text src="chapter.xhtml#p2"/><audio src="audio.wav" clipBegin="6s" clipEnd="9s"/></par><par><text src="chapter.xhtml#p3"/><audio src="audio2.wav" clipBegin="0s" clipEnd="3s"/></par></seq></body></smil>',
    };
    const book = await new EPUB({
      loadText: async (name: string) => xml[name] ?? null,
      loadBlob: async () => new Blob(["audio"]),
      getSize: (name: string) => xml[name]?.length ?? 0,
    }).init();
    const overlay = book.getMediaOverlay();
    const highlights: string[] = [];
    let active: string | null = null;
    overlay.addEventListener("highlight", (event: CustomEvent) => {
      active = event.detail.text;
      highlights.push(event.detail.text);
    });
    overlay.addEventListener("unhighlight", () => {
      active = null;
    });
    await overlay.start(0);
    FakeAudio.last.dispatchEvent(new Event("canplaythrough"));
    expect(FakeAudio.last.currentTime).toBe(2);
    expect(highlights.at(-1)).toBe("chapter.xhtml#p1");
    FakeAudio.last.currentTime = 5;
    FakeAudio.last.dispatchEvent(new Event("timeupdate"));
    expect(active).toBeNull(); // Exact clip end and the following silence have no words.
    FakeAudio.last.currentTime = 6.2;
    FakeAudio.last.dispatchEvent(new Event("timeupdate"));
    expect(highlights.at(-1)).toBe("chapter.xhtml#p2");
    expect(overlay.currentTime).toBe(6.2);
    overlay.pause();
    expect(overlay.state).toBe("paused");
    expect(FakeAudio.last.paused).toBe(true);
    FakeAudio.last.currentTime = 3;
    FakeAudio.last.dispatchEvent(new Event("timeupdate"));
    expect(active).toBe("chapter.xhtml#p1");
    FakeAudio.last.currentTime = 5.5;
    FakeAudio.last.dispatchEvent(new Event("timeupdate"));
    expect(active).toBeNull();
    const previousAudio = FakeAudio.last;
    await overlay.next();
    expect(active).toBe("chapter.xhtml#p2");
    expect(FakeAudio.last.currentTime).toBe(6);
    previousAudio.dispatchEvent(new Event("ended"));
    previousAudio.dispatchEvent(new Event("playing"));
    expect(active).toBe("chapter.xhtml#p2");
    expect(overlay.state).toBe("paused");
    await overlay.next();
    expect(highlights.at(-1)).toBe("chapter.xhtml#p3");
    expect(overlay.state).toBe("paused");
    overlay.resume();
    expect(overlay.state).toBe("playing");
    overlay.stop();
    const lastAudio = FakeAudio.last;
    let resolve!: (blob: Blob) => void;
    book.loadBlob = vi.fn(
      () =>
        new Promise<Blob>((done) => {
          resolve = done;
        }),
    );
    const pending = overlay.start(0);
    await vi.waitFor(() => expect(book.loadBlob).toHaveBeenCalledOnce());
    overlay.stop();
    resolve(new Blob(["original fixture audio"]));
    await pending;
    expect(FakeAudio.last).toBe(lastAudio);
    expect(overlay.state).toBe("stopped");
    book.destroy();
  });
});
