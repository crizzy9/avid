/** Exact plain text for a timed source fragment. Never treat this string as HTML. */
export function passageText(element: Element): string {
  const copy = element.cloneNode(true) as Element;
  if (
    copy.matches(
      'script,style,template,noscript,iframe,object,[hidden],[aria-hidden="true"]',
    )
  )
    return "";
  copy
    .querySelectorAll(
      'script,style,template,noscript,iframe,object,[hidden],[aria-hidden="true"]',
    )
    .forEach((node) => node.remove());
  // Preserve word boundaries even when adjacent block elements have no source whitespace.
  copy.querySelectorAll("br,p,div,li,h1,h2,h3,h4,h5,h6").forEach((node) => {
    node.before(copy.ownerDocument.createTextNode(" "));
    node.after(copy.ownerDocument.createTextNode(" "));
  });
  return (copy.textContent ?? "").replace(/\s+/gu, " ").trim();
}
