import { passageText } from "../../core/src/readAlongText";
import type {
  ExtractedPublicationText,
  GeneratedTextPassage,
} from "../../playback/src/generated-alignment";
import type { StandaloneAlignedSegment } from "../../playback/src/standalone-alignment";

const excluded =
  'script,style,template,noscript,iframe,object,[hidden],[aria-hidden="true"]';
const blocks =
  "p,h1,h2,h3,h4,h5,h6,li,blockquote,figcaption,dt,dd,pre,td,th,div,section,article";
export function passageElement(
  doc: Document,
  segment: Pick<StandaloneAlignedSegment, "textFragment" | "textElementPath">,
): Element | null {
  if (!segment.textElementPath) return doc.getElementById(segment.textFragment);
  let element: Element | null = doc.body ?? doc.querySelector("body");
  for (const index of segment.textElementPath)
    element = element?.children.item(index) ?? null;
  return element;
}
function pathFromBody(element: Element, body: Element): number[] {
  const path: number[] = [];
  for (let current = element; current !== body;) {
    const parent = current.parentElement;
    if (!parent)
      throw new Error("The extracted passage is outside the EPUB body.");
    path.unshift(Array.from(parent.children).indexOf(current));
    current = parent;
  }
  return path;
}
export interface GeneratedTextPublication {
  sections: Array<{
    id: string;
    linear?: string;
    createDocument?: () => Promise<Document>;
  }>;
}
/** Extract leaf reading blocks in spine order. Structural CFI ranges work without publisher IDs. */
export async function extractPublicationText(
  publication: GeneratedTextPublication,
  textSha256: string,
  cfi: (sectionIndex: number, range: Range) => string,
  isActive: () => boolean = () => true,
): Promise<ExtractedPublicationText> {
  const passages: GeneratedTextPassage[] = [];
  let characters = 0;
  for (const [sectionIndex, section] of publication.sections.entries()) {
    if (!isActive())
      throw new Error("The reader changed during text extraction.");
    if (section.linear === "no" || !section.createDocument) continue;
    const doc = await section.createDocument();
    const body = doc.body ?? doc.querySelector("body");
    if (!body) continue;
    const candidates = Array.from(body.querySelectorAll(blocks));
    // Deliberately do not concatenate a parent with nested leaf blocks a second time.
    const leaves = candidates.filter(
      (element) =>
        !element.closest(excluded) &&
        !Array.from(element.querySelectorAll(blocks)).some(
          (child) => !child.closest(excluded) && passageText(child),
        ),
    );
    if (!leaves.length) leaves.push(body);
    for (const element of leaves) {
      const text = passageText(element);
      if (!text) continue;
      characters += text.length;
      if (characters > 16_000_000 || passages.length >= 100_000)
        throw new Error(
          "This ebook is too large for on-device text preparation.",
        );
      const elementPath = pathFromBody(element, body),
        range = doc.createRange();
      // Element-boundary offsets are not text offsets in EPUB CFI. Real text endpoints
      // also survive a fresh parse when the publication did not assign any IDs.
      const walker = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT),
        nodes: Text[] = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode())
        if (node.nodeValue?.trim() && !node.parentElement?.closest(excluded))
          nodes.push(node as Text);
      if (!nodes.length) continue;
      range.setStart(nodes[0]!, 0);
      range.setEnd(nodes[nodes.length - 1]!, nodes[nodes.length - 1]!.length);
      const textLocator = cfi(sectionIndex, range);
      if (!textLocator.startsWith("epubcfi("))
        throw new Error(
          "The EPUB could not provide an exact passage location.",
        );
      passages.push({
        id: `${sectionIndex}:${elementPath.join(".")}`,
        text,
        textLocator,
        sectionIndex,
        textHref: section.id,
        elementPath,
      });
    }
  }
  if (!isActive())
    throw new Error("The reader changed during text extraction.");
  if (!passages.length)
    throw new Error(
      "No readable text was found in this EPUB. Scanned pages need text recognition before preparation.",
    );
  for (const passage of passages) {
    Object.freeze(passage.elementPath);
    Object.freeze(passage);
  }
  Object.freeze(passages);
  return Object.freeze({ version: 1 as const, textSha256, passages });
}
