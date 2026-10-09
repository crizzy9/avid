/** Applied before a publication URL is navigated to; sandbox is a second boundary. */
export const BOOK_CSP = "default-src 'none'; script-src 'none'; connect-src 'none'; img-src blob: data:; media-src blob: data:; font-src blob: data:; style-src 'unsafe-inline' blob: data:; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";
export function sanitizeBookDocument(html: string, mime = 'text/html'): string {
  const parser = new DOMParser();
  let doc = parser.parseFromString(html, mime === 'application/xhtml+xml' ? 'application/xhtml+xml' : 'text/html');
  if (doc.querySelector('parsererror')) doc = parser.parseFromString(html, 'text/html');
  doc.querySelectorAll('script,iframe,frame,frameset,object,embed,form,base,meta[http-equiv]').forEach(element => element.remove());
  doc.querySelectorAll('*').forEach(element => {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on') || name === 'srcdoc' || /^(?:javascript|vbscript):/i.test(attribute.value.trim())) element.removeAttribute(attribute.name);
    }
  });
  let head: Element | null = doc.querySelector('head');
  if (!head) { head = doc.createElementNS(doc.documentElement.namespaceURI, 'head'); doc.documentElement.prepend(head); }
  const csp = doc.createElementNS(doc.documentElement.namespaceURI, 'meta');
  csp.setAttribute('http-equiv', 'Content-Security-Policy'); csp.setAttribute('content', BOOK_CSP);
  head.prepend(csp);
  return new XMLSerializer().serializeToString(doc);
}
