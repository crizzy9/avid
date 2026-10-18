// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { Blob as NodeBlob } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import {
  Ao3Client,
  Ao3FollowStore,
  parseAo3ChapterIndex,
  parseAo3Edition,
} from "../src/ao3";
import {
  restoreAo3WorkSkin,
  safeAo3SkinCss,
  type Ao3WorkSkin,
} from "../src/ao3WorkSkin";
import { chapterIndex, workPage } from "./fixtures/ao3";
import { sanitizeBookDocument, BOOK_CSP } from "../../readers/src/isolation";
Object.defineProperty(globalThis, "crypto", {
  value: webcrypto,
  configurable: true,
});
const css =
  '#workskin .tweet {border:1px solid #aaa;background-color:#eee;padding:1em;} #workskin .sender{font-weight:bold} #workskin .message::before{content:"Message"}';
function styledPage(style = css) {
  return workPage()
    .replace(
      '<div id="workskin">',
      `<div id="work-skin"><style type="text/css">${style}</style><div id="workskin">`,
    )
    .replace(/<\/div><\/div>$/, "</div></div></div>")
    .replace(
      "The light crossed the open water. Passage 11.",
      '<span class="sender" style="color:blue" onclick="steal()">The light</span> crossed the open water. Passage 11.',
    )
    .replace("<p><span", '<p class="tweet"><span')
    .replace(
      "Passage 12.</p>",
      'Passage 12.</p><div class="message">A second original message.</div>',
    );
}
const edition = (html = styledPage()) =>
  parseAo3Edition(
    html,
    "reader",
    "123",
    parseAo3ChapterIndex(chapterIndex(), "reader", "123"),
  );
function originalEpub(mismatch = false) {
  const files = {
    mimetype: strToU8("application/epub+zip"),
    "META-INF/container.xml": strToU8(
      '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>',
    ),
    "OPS/book.opf": strToU8(
      '<package xmlns="http://www.idpf.org/2007/opf"><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/><item id="image" href="image.png" media-type="image/png"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>',
    ),
    "OPS/c1.xhtml": strToU8(
      `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>First chapter</title><link rel="stylesheet" href="original.css"/></head><body><h1>Chapter 1</h1><div class="converted"><p class="converted-p"><span class="converted-span">The light</span> crossed the ${mismatch ? "changed" : "open"} water. Passage 11.</p></div><img src="image.png" alt="Downloaded illustration"/></body></html>`,
    ),
    "OPS/c2.xhtml": strToU8(
      '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Second chapter</title></head><body><h1>Chapter 2</h1><div class="converted"><p>The light crossed the open water. Passage 12.</p><div>A second original message.</div></div></body></html>',
    ),
    "OPS/image.png": new Uint8Array([137, 80, 78, 71, 0, 1, 2]),
    "OPS/original.css": strToU8(".converted-p {line-height:1.5}"),
  };
  return new NodeBlob([zipSync(files, { level: 0 })], {
    type: "application/epub+zip",
  }) as unknown as Blob;
}
async function entries(blob: Blob) {
  return unzipSync(new Uint8Array(await blob.arrayBuffer()));
}
function fileBytes(file: Blob) {
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}
const originalArrayBuffer = Object.getOwnPropertyDescriptor(
  Blob.prototype,
  "arrayBuffer",
);
beforeEach(() => {
  localStorage.clear();
  if (!originalArrayBuffer)
    Object.defineProperty(Blob.prototype, "arrayBuffer", {
      configurable: true,
      value: function (this: Blob) {
        return fileBytes(this);
      },
    });
});
afterEach(() => {
  if (!originalArrayBuffer)
    delete (Blob.prototype as unknown as Record<string, unknown>).arrayBuffer;
  vi.unstubAllGlobals();
});
describe("AO3 authenticated work-skin restoration", () => {
  it("retains safe scoped typography/layout while dropping remote or executable CSS and global rules", () => {
    const result = safeAo3SkinCss(
      `${css} @import "https://bad.invalid/x.css"; @font-face{font-family:remote;src:url(https://bad.invalid/x)} body{color:red} #workskin + body{color:red} #workskin .bad{background:url(https://bad.invalid/i);color:var(--secret);behavior:expression(evil());position:fixed;--x:red} #workskin .escaped{background:u\\72l(https://bad.invalid/i)} #workskin .flex{display:flex;gap:1em}`,
    );
    expect(result).toContain(".avid-ao3-workskin .tweet{");
    expect(result).toContain("background-color:rgb(238, 238, 238)");
    expect(result).toContain('content:"Message"');
    expect(result).toContain("display:flex");
    expect(result).not.toMatch(
      /bad\.invalid|@import|font-face|url\(|expression|--secret|body\{|position:fixed|--x/,
    );
  });
  it("detects styling-only revisions while leaving no-skin legacy revisions unchanged and metadata content-free", async () => {
    const plain = await edition(workPage()),
      styled = await edition(),
      changed = await edition(styledPage(css.replace("#eee", "#fff"))),
      rootClassChanged = await edition(styledPage().replace('class="userstuff module"', 'class="userstuff module conversation"')),
      childClassChanged = await edition(styledPage().replace('class="sender"', 'class="sender alternate"')),
      previousUnstyled = await edition(styledPage().replace(/<style type="text\/css">[\s\S]*?<\/style>/, ""));
    const legacy = [
      ...new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(
            JSON.stringify(["123", plain.title, plain.author, plain.chapters]),
          ),
        ),
      ),
    ]
      .map((n) => n.toString(16).padStart(2, "0"))
      .join("");
    expect(plain.revision).toBe(legacy);
    expect(plain.workSkin).toBeUndefined();
    expect(styled.workSkin?.chapters).toHaveLength(2);
    expect(changed.chapters).toEqual(styled.chapters);
    expect(changed.revision).not.toBe(styled.revision);
    expect(rootClassChanged.chapters).toEqual(styled.chapters);
    expect(rootClassChanged.revision).not.toBe(styled.revision);
    expect(childClassChanged.revision).not.toBe(styled.revision);
    expect(previousUnstyled.chapters).toEqual(styled.chapters);
    expect(previousUnstyled.revision).not.toBe(styled.revision);
    const store = new Ao3FollowStore("account", "reader");
    store.record(previousUnstyled, true);
    store.record(styled);
    expect(store.all()[0].importedRevisions).toEqual([previousUnstyled.revision]);
    store.record(styled, true);
    store.record(styled, true);
    expect(store.all()[0].importedRevisions).toEqual([previousUnstyled.revision, styled.revision]);
    expect(JSON.stringify(store.all())).not.toContain("workSkin");
    expect(JSON.stringify(store.all())).not.toContain(
      "A second original message",
    );
  });
  it("restores source classes/styles into a new EPUB and preserves downloaded content, IDs and binary resources", async () => {
    const original = originalEpub(),
      before = await entries(original),
      skin = (await edition()).workSkin!;
    const restored = await restoreAo3WorkSkin(original, skin),
      after = await entries(restored);
    expect(after["OPS/book.opf"]).toEqual(before["OPS/book.opf"]);
    expect(after["OPS/image.png"]).toEqual(before["OPS/image.png"]);
    expect(after["OPS/original.css"]).toEqual(before["OPS/original.css"]);
    expect(await entries(original)).toEqual(before);
    const doc = new DOMParser().parseFromString(
      strFromU8(after["OPS/c1.xhtml"]),
      "application/xhtml+xml",
    );
    expect(
      doc.querySelector("body")?.classList.contains("avid-ao3-workskin"),
    ).toBe(true);
    expect(
      doc.querySelector(
        ".converted.userstuff.module .converted-p.tweet .converted-span.sender",
      )?.textContent,
    ).toBe("The light");
    expect(doc.querySelector(".sender")?.getAttribute("style")).toContain(
      "color:blue",
    );
    expect(doc.querySelector("[onclick]")).toBeNull();
    expect(doc.querySelector("img")?.getAttribute("src")).toBe("image.png");
    expect(doc.querySelector("#avid-ao3-restored-workskin")?.textContent).toBe(
      skin.css,
    );
    const isolated = new DOMParser().parseFromString(
      sanitizeBookDocument(
        strFromU8(after["OPS/c1.xhtml"]),
        "application/xhtml+xml",
      ),
      "application/xhtml+xml",
    );
    expect(isolated.querySelector("meta")?.getAttribute("content")).toBe(
      BOOK_CSP,
    );
    expect(BOOK_CSP).toContain("connect-src 'none'");
    expect(isolated.querySelector(".tweet")).not.toBeNull();
  });
  it("rejects a changed/missing chapter or conflicting IDs without modifying original bytes", async () => {
    const skin = (await edition()).workSkin!,
      original = originalEpub(true),
      before = await original.arrayBuffer();
    await expect(restoreAo3WorkSkin(original, skin)).rejects.toThrow(
      "could not be matched exactly",
    );
    expect(await original.arrayBuffer()).toEqual(before);
    const altered: Ao3WorkSkin = {
      ...skin,
      chapters: skin.chapters.map((chapter) => ({
        ...chapter,
        html: chapter.html
          .replace('<p class="tweet">', '<p class="tweet" id="same">')
          .replace('<span class="sender"', '<span id="same" class="sender"'),
      })),
    };
    await expect(restoreAo3WorkSkin(originalEpub(), altered)).rejects.toThrow(
      "IDs differ",
    );
  });
  it("uses only existing authorized page/download routes, and rechecks styling before publishing", async () => {
    let changed = false;
    const transport = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/session")
        return Response.json({ username: "reader", sessionId: "s".repeat(64) });
      if (url.pathname === "/v1/epub")
        return new Response(await originalEpub().arrayBuffer(), {
          headers: { "content-type": "application/epub+zip" },
        });
      const path = url.searchParams.get("path")!;
      return Response.json({
        url: `https://archiveofourown.org${path}`,
        html: path.endsWith("/navigate")
          ? chapterIndex()
          : styledPage(changed ? css.replace("#eee", "#fff") : css),
      });
    });
    const client = new Ao3Client("http://127.0.0.1:43119", "p".repeat(40), {
      fetch: transport,
    });
    await client.connect("reader", "fixture");
    const current = await client.edition("123"),
      imported = await client.download(current);
    const archive = unzipSync(new Uint8Array(await fileBytes(imported.file)));
    expect(strFromU8(archive["OPS/c1.xhtml"])).toContain(
      "avid-ao3-restored-workskin",
    );
    expect(imported.revision).toBe(current.revision);
    expect(
      new Set(
        transport.mock.calls.map(([url]) => new URL(String(url)).pathname),
      ),
    ).toEqual(new Set(["/v1/session", "/v1/page", "/v1/epub"]));
    changed = true;
    await expect(client.download(current)).rejects.toThrow(
      "changed during download",
    );
  });
  it("honors cancellation before restoration and rejects malformed archives and unscoped forged style objects", async () => {
    const skin = (await edition()).workSkin!,
      abort = new AbortController();
    abort.abort();
    await expect(
      restoreAo3WorkSkin(originalEpub(), skin, abort.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(
      restoreAo3WorkSkin(
        new NodeBlob(["not an epub"]) as unknown as Blob,
        skin,
      ),
    ).rejects.toThrow();
    await expect(
      restoreAo3WorkSkin(originalEpub(), { ...skin, css: "body{color:red}" }),
    ).rejects.toThrow("not canonical");
  });
  it("restores styled editions without constructable stylesheets or attached style nodes", async () => {
    vi.stubGlobal("CSSStyleSheet", class { constructor() { throw new TypeError("Illegal constructor"); } });
    const existingStyles = document.querySelectorAll("style").length;
    const skin = (await edition()).workSkin!;
    const restored = await entries(await restoreAo3WorkSkin(originalEpub(), skin));
    expect(strFromU8(restored["OPS/c1.xhtml"])).toContain("avid-ao3-restored-workskin");
    expect(document.querySelectorAll("style")).toHaveLength(existingStyles);
    expect((await edition(workPage())).workSkin).toBeUndefined();
  });
});
