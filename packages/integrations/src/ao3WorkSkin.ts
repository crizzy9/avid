import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";

export interface Ao3WorkSkin {
  version: 1;
  css: string;
  chapters: { id: string; html: string; className: string }[];
}
const scope = ".avid-ao3-workskin";
const styleId = "avid-ao3-restored-workskin";
const maximumCss = 256 * 1024;
const properties =
  /^(?:color|background(?:-color|-image)?|border(?:-(?:top|right|bottom|left|width|style|color|radius|collapse|spacing|top-left-radius|top-right-radius|bottom-left-radius|bottom-right-radius))?|margin(?:-(?:top|right|bottom|left))?|padding(?:-(?:top|right|bottom|left))?|font(?:-(?:family|size|style|weight|variant|stretch))?|line-height|text-(?:align|decoration|indent|transform|shadow|overflow)|letter-spacing|word-spacing|white-space|word-break|overflow-wrap|display|position|top|right|bottom|left|float|clear|(?:min-|max-)?(?:width|height)|vertical-align|opacity|overflow(?:-x|-y)?|box-sizing|box-shadow|list-style(?:-type|-position)?|table-layout|caption-side|content|transform|transform-origin|flex(?:-direction|-wrap|-flow|-grow|-shrink|-basis)?|align-(?:items|self|content)|justify-content|gap|row-gap|column-gap)$/;

/** Flat AO3 work-skin rules only. No imports, fonts, URLs, custom properties or executable values. */
export function safeAo3SkinCss(input: string): string {
  if (input.length > maximumCss)
    throw new Error("This AO3 work skin exceeds the supported size limit.");
  const rules: string[] = [];
  let start = 0,
    depth = 0,
    quote = "",
    comment = false,
    escaped = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i],
      next = input[i + 1];
    if (comment) {
      if (c === "*" && next === "/") {
        comment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === "/" && next === "*") {
      comment = true;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth < 0) return "";
      if (depth === 0) {
        rules.push(input.slice(start, i + 1));
        start = i + 1;
      }
    } else if (c === ";" && depth === 0) start = i + 1; // Entire top-level @import/namespace is discarded.
  }
  if (depth || quote || comment) return "";
  const output: string[] = [];
  for (const raw of rules) {
    const clean = raw.replace(/\/\*[\s\S]*?\*\//g, "").trim();
    if (!clean || clean.startsWith("@")) continue;
    const brace = clean.indexOf("{");
    if (brace < 0) continue;
    const selectors = clean.slice(0, brace).split(",").map((value) => value.trim());
    if (
      selectors.some(
        (selector) =>
          !/^#workskin(?:$|[\s>.#[:])/.test(selector) ||
          /[\\{}@]/.test(selector) ||
          /^#workskin\s*[+~]/.test(selector),
      )
    )
      continue;
    // An inert template has no browsing context. Parse only declaration syntax,
    // without attaching a stylesheet or requiring the iOS 16.4 CSSStyleSheet constructor.
    const template = document.createElement("template");
    template.innerHTML = "<span></span>";
    const holder = template.content.firstElementChild as HTMLElement;
    try {
      selectors.forEach((selector) => template.content.querySelector(selector));
      holder.style.cssText = clean.slice(brace + 1, -1);
    } catch {
      continue;
    }
    const style = holder.style;
    const declarations: string[] = [];
    for (let i = 0; i < style.length; i++) {
      const name = style[i].toLowerCase(),
        value = style.getPropertyValue(name).trim();
      if (
        !properties.test(name) ||
        !value ||
        value.length > 4096 ||
        /[\\\u0000-\u001f<>]/.test(value) ||
        /\/\*|\*\//.test(value) ||
        /(?:url|image-set|image|paint|element|var|attr|expression)\s*\(|(?:javascript|vbscript|https?|data|file|blob)\s*:/i.test(
          value,
        )
      )
        continue;
      if (name === "position" && !/^(?:static|relative|absolute)$/.test(value))
        continue;
      if (
        name === "content" &&
        !/^(?:none|normal|"[^"\\]*"|'[^'\\]*')$/.test(value)
      )
        continue;
      declarations.push(
        `${name}:${value}${style.getPropertyPriority(name) === "important" ? " !important" : ""};`,
      );
    }
    if (declarations.length)
      output.push(
        `${selectors.map((selector) => selector.replace(/^#workskin/, scope)).join(",")}{${declarations.join("")}}`,
      );
  }
  return output.join("\n");
}

/** The pinned work template renders the work's own style block directly inside #work-skin. */
export function captureAo3WorkSkin(
  doc: DocumentFragment,
  chapters: readonly { id: string; element: Element }[],
): Ao3WorkSkin | undefined {
  const wrapper = doc.querySelector("#work-skin");
  if (!wrapper) return;
  const css = safeAo3SkinCss(
    [...wrapper.children]
      .filter(
        (element) =>
          element.localName === "style" &&
          (!element.getAttribute("type") ||
            element.getAttribute("type") === "text/css"),
      )
      .map((element) => element.textContent ?? "")
      .join("\n"),
  );
  if (!css) return;
  return {
    version: 1,
    css,
    chapters: chapters.map((chapter) => ({
      id: chapter.id,
      html: chapter.element.innerHTML,
      className: chapter.element.getAttribute("class") ?? "",
    })),
  };
}
const normalized = (value: string | null) =>
  value?.replace(/\s+/g, " ").trim() ?? "";
function elements(element: Element): Element[] {
  return [...element.children].filter(
    (child) => !["script", "style", "template"].includes(child.localName),
  );
}
function sourceFragment(html: string): Element {
  const template = document.createElement("template");
  template.innerHTML = `<div>${html}</div>`;
  const root = template.content.firstElementChild!;
  root
    .querySelectorAll("script,style,template,noscript,iframe,object,embed,form")
    .forEach((element) => element.remove());
  return root;
}
function sameStructure(source: Element, target: Element, root = true): boolean {
  if (
    (!root && source.localName !== target.localName) ||
    normalized(source.textContent) !== normalized(target.textContent)
  )
    return false;
  const a = elements(source),
    b = elements(target);
  return (
    a.length === b.length &&
    a.every((child, index) => sameStructure(child, b[index], false))
  );
}
function restoreAttributes(source: Element, target: Element) {
  // Keep converter classes too: they can be referenced by the existing EPUB stylesheets.
  const classes = new Set(
    [
      ...(target.getAttribute("class") ?? "").split(/\s+/),
      ...(source.getAttribute("class") ?? "").split(/\s+/),
    ].filter(Boolean),
  );
  if (classes.size) target.setAttribute("class", [...classes].join(" "));
  const id = source.getAttribute("id");
  if (id) {
    const existing = target.ownerDocument.getElementById(id);
    if ((existing && existing !== target) || (target.id && target.id !== id))
      throw new Error(
        "AO3 source IDs differ from the downloaded EPUB. No styled edition was imported.",
      );
    target.setAttribute("id", id);
  }
  const inline = source.getAttribute("style");
  if (inline) {
    const safe = safeAo3SkinCss(`#workskin{${inline}}`);
    const body = safe.slice(safe.indexOf("{") + 1, safe.lastIndexOf("}"));
    if (body)
      target.setAttribute(
        "style",
        `${target.getAttribute("style") ?? ""};${body}`,
      );
  }
  const a = elements(source),
    b = elements(target);
  a.forEach((child, index) => restoreAttributes(child, b[index]));
}
function archivePath(value: string, base = ""): string {
  if (
    !value ||
    /[\\?#\u0000-\u001f]/.test(value) ||
    value.startsWith("/") ||
    /^[a-z][a-z0-9+.-]*:/i.test(value)
  )
    throw new Error("Unsupported AO3 EPUB resource path.");
  const parts = base.split("/").slice(0, -1);
  for (const part of decodeURIComponent(value).split("/")) {
    if (part === "..") {
      if (!parts.length) throw new Error("AO3 EPUB path escapes its archive.");
      parts.pop();
    } else if (part && part !== ".") parts.push(part);
  }
  return parts.join("/");
}
function xml(bytes: Uint8Array | undefined, label: string): XMLDocument {
  if (!bytes || bytes.length > 8 * 1024 ** 2)
    throw new Error(`Missing or oversized AO3 EPUB ${label}.`);
  const value = strFromU8(bytes);
  if (/<!ENTITY/i.test(value))
    throw new Error("AO3 EPUB entities are unsupported.");
  const doc = new DOMParser().parseFromString(value, "application/xhtml+xml");
  if (doc.querySelector("parsererror"))
    throw new Error(`Invalid AO3 EPUB ${label}.`);
  return doc;
}
function local(doc: Document | Element, name: string) {
  return [...doc.getElementsByTagNameNS("*", name)];
}

/** New immutable edition only: retain original archive resources; restore no unmatched chapter. */
export async function restoreAo3WorkSkin(
  file: Blob,
  skin: Ao3WorkSkin,
  signal?: AbortSignal,
): Promise<Blob> {
  signal?.throwIfAborted();
  if (
    !file.size ||
    file.size > 64 * 1024 ** 2 ||
    skin.version !== 1 ||
    !skin.css ||
    !skin.chapters.length ||
    skin.chapters.length > 2000 ||
    skin.chapters.reduce((sum, chapter) => sum + chapter.html.length, 0) >
      8 * 1024 ** 2
  )
    throw new Error("Invalid or oversized AO3 styling source.");
  // Revalidate in case a caller supplies an object that did not come from the parser.
  const css = safeAo3SkinCss(skin.css.replaceAll(scope, "#workskin"));
  if (css !== skin.css) throw new Error("AO3 styling source is not canonical.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  signal?.throwIfAborted();
  let expanded = 0,
    count = 0;
  const names = new Set<string>();
  const entries = unzipSync(bytes, {
    filter: (entry) => {
      const path = entry.name.replace(/\/$/, "");
      if (
        ++count > 10_000 ||
        entry.originalSize > 64 * 1024 ** 2 ||
        (expanded += entry.originalSize) > 128 * 1024 ** 2 ||
        names.has(entry.name) ||
        archivePath(path) !== path
      )
        throw new Error(
          "AO3 EPUB archive exceeds the safe restoration limits.",
        );
      names.add(entry.name);
      return !entry.name.endsWith("/");
    },
  });
  if (
    strFromU8(entries.mimetype ?? new Uint8Array()) !== "application/epub+zip"
  )
    throw new Error("AO3 did not provide an EPUB container.");
  const container = xml(entries["META-INF/container.xml"], "container"),
    opfPath = archivePath(
      local(container, "rootfile")[0]?.getAttribute("full-path") ?? "",
    ),
    opf = xml(entries[opfPath], "package");
  const manifest = new Map(
    local(opf, "item").map((item) => [item.getAttribute("id"), item]),
  );
  const documents = new Map<string, XMLDocument>();
  for (const item of local(opf, "itemref")) {
    const resource = manifest.get(item.getAttribute("idref"));
    if (resource?.getAttribute("media-type") !== "application/xhtml+xml")
      continue;
    const path = archivePath(resource.getAttribute("href") ?? "", opfPath);
    if (documents.has(path))
      throw new Error("AO3 EPUB spine repeats a document.");
    documents.set(path, xml(entries[path], "chapter"));
  }
  const matched = new Set<Element>();
  for (const chapter of skin.chapters) {
    signal?.throwIfAborted();
    const source = sourceFragment(chapter.html),
      candidates: Element[] = [];
    source.setAttribute("class", chapter.className);
    for (const doc of documents.values())
      for (const target of doc.querySelectorAll("body,div,section,article"))
        if (!matched.has(target) && sameStructure(source, target))
          candidates.push(target);
    if (candidates.length !== 1)
      throw new Error(
        `AO3 chapter ${chapter.id} could not be matched exactly to the downloaded EPUB. No styled edition was imported.`,
      );
    matched.add(candidates[0]);
    restoreAttributes(source, candidates[0]);
  }
  for (const [path, doc] of documents) {
    const body = local(doc, "body")[0],
      head = local(doc, "head")[0];
    if (!body || !head)
      throw new Error("AO3 EPUB chapter has no head or body.");
    body.classList.add(scope.slice(1));
    doc
      .querySelectorAll(`style[id="${styleId}"]`)
      .forEach((element) => element.remove());
    const style = doc.createElementNS("http://www.w3.org/1999/xhtml", "style");
    style.setAttribute("id", styleId);
    style.setAttribute("type", "text/css");
    style.textContent = css;
    head.append(style);
    entries[path] = strToU8(new XMLSerializer().serializeToString(doc));
  }
  signal?.throwIfAborted();
  const ordered: Zippable = { mimetype: [entries.mimetype!, { level: 0 }] };
  for (const [name, value] of Object.entries(entries))
    if (name !== "mimetype") ordered[name] = value;
  const output = zipSync(ordered, {
    level: 6,
    mtime: new Date("2026-10-18T00:00:00Z"),
  });
  if (output.length > 64 * 1024 ** 2)
    throw new Error("Restored AO3 EPUB exceeds the import size limit.");
  return new Blob([new Uint8Array(output).buffer], {
    type: "application/epub+zip",
  });
}
