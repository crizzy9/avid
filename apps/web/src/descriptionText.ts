const omitted = new Set([
  "script",
  "style",
  "template",
  "noscript",
  "iframe",
  "object",
  "head",
]);
const paragraphs = new Set([
  "p",
  "blockquote",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
]);
const lines = new Set([
  "address",
  "article",
  "aside",
  "div",
  "dl",
  "dt",
  "dd",
  "footer",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "pre",
  "section",
  "table",
  "tr",
  "ul",
]);
const boundary = (tag: string) =>
  paragraphs.has(tag) ? "\n\n" : lines.has(tag) ? "\n" : "";
function appendBoundary(result: string[], separator: string): void {
  if (!separator) return;
  if (separator === " ") {
    result.push(separator);
    return;
  }
  let width = separator.length;
  while (result.length && /^\s*$/.test(result.at(-1)!)) {
    width = Math.max(width, result.pop()!.replace(/[^\n]/g, "").length);
  }
  result.push("\n".repeat(width));
}
const normalize = (text: string) =>
  text
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

// Browser parsing handles the complete HTML entity vocabulary. The DOM-less
// fallback preserves unknown names and decodes common publishing entities once.
const entities: Record<string, string> = {
  amp: "&",
  AMP: "&",
  lt: "<",
  LT: "<",
  gt: ">",
  GT: ">",
  quot: '"',
  QUOT: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  ndash: "–",
  mdash: "—",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
  bull: "•",
  middot: "·",
  laquo: "«",
  raquo: "»",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  eacute: "é",
  Eacute: "É",
};
function decodeFallback(text: string): string {
  return text.replace(
    /&(#(?:x[\da-f]+|\d+)|[a-z][\da-z]*);/gi,
    (whole, entity: string) => {
      if (entity[0] !== "#")
        return Object.hasOwn(entities, entity) ? entities[entity] : whole;
      const hexadecimal = entity[1]?.toLowerCase() === "x";
      const point = Number.parseInt(
        entity.slice(hexadecimal ? 2 : 1),
        hexadecimal ? 16 : 10,
      );
      return !point || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)
        ? "\ufffd"
        : String.fromCodePoint(point);
    },
  );
}

function withoutDom(input: string, text: (value: string) => string): string {
  const result: string[] = [];
  const tags =
    /<!--[^]*?(?:-->|$)|<\/?[a-z][\w:-]*(?:[^"'<>]|"[^"]*"|'[^']*')*(?:>|$)|<![^>]*(?:>|$)/gi;
  let previous = 0,
    ignored = "",
    depth = 0;
  for (const match of input.matchAll(tags)) {
    if (!ignored)
      result.push(text(decodeFallback(input.slice(previous, match.index))));
    previous = match.index! + match[0].length;
    const tag = /^<(\/)?([a-z][\w:-]*)/i.exec(match[0]);
    if (!tag) continue;
    const name = tag[2].toLowerCase(),
      closing = !!tag[1];
    if (ignored) {
      if (name === ignored) {
        if (closing && --depth === 0) ignored = "";
        else if (!closing && name === "template") depth++;
      }
      continue;
    }
    if (omitted.has(name) && !closing) {
      ignored = name;
      depth = 1;
      continue;
    }
    if (name === "br") result.push("\n");
    else appendBoundary(result, boundary(name));
    if ((name === "td" || name === "th") && closing) result.push(" ");
  }
  if (!ignored) result.push(text(decodeFallback(input.slice(previous))));
  return normalize(result.join(""));
}

/** Return display text only. Never attach the parsed nodes to a live document. */
export function descriptionToPlainText(input: string): string {
  const hasMarkup = /<(?:\/?[a-z][\w:-]*(?:[\s/>]|$)|!)/i.test(input);
  const text = (value: string) =>
    hasMarkup ? value.replace(/\s+/g, " ") : value;
  if (typeof document === "undefined") return withoutDom(input, text);

  // Template content has an inert owner document: scripts, custom elements and
  // image/iframe resources stay inactive. Only strings leave this function.
  const template = document.createElement("template");
  template.innerHTML = input;
  const result: string[] = [];
  const pending: (Node | string)[] = [...template.content.childNodes].reverse();
  while (pending.length) {
    const item = pending.pop()!;
    if (typeof item === "string") {
      appendBoundary(result, item);
      continue;
    }
    if (item.nodeType === 3) {
      result.push(text(item.textContent ?? ""));
      continue;
    }
    if (item.nodeType !== 1) continue;
    const tag = (item as Element).localName.toLowerCase();
    if (omitted.has(tag)) continue;
    if (tag === "br") {
      result.push("\n");
      continue;
    }
    const separator = boundary(tag);
    appendBoundary(result, separator);
    pending.push(tag === "td" || tag === "th" ? " " : separator);
    for (let index = item.childNodes.length - 1; index >= 0; index--) {
      pending.push(item.childNodes[index]);
    }
  }
  return normalize(result.join(""));
}
