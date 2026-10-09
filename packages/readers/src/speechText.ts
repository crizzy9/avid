export interface SpeechPart { node: Text; start: number; text: string; offset: number }
export interface SpeechText { text: string; parts: SpeechPart[] }
const BLOCKS = 'p,h1,h2,h3,h4,h5,h6,li,blockquote,dt,dd,div,section,article,figcaption,td,th';
/** Preserve inline words and map UTF-16 speech offsets back to the exact text nodes. */
export function buildSpeechText(doc: Document, startRange?: Range): SpeechText {
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const parts: SpeechPart[] = [];
  let text = '', started = !startRange, previousBlock: Element | null = null;
  for (let next = walker.nextNode(); next; next = walker.nextNode()) {
    const node = next as Text;
    if (!node.data || node.parentElement?.closest('script,style,head,[hidden],[aria-hidden="true"]')) continue;
    let start = 0;
    if (!started && startRange) {
      const nodeRange = doc.createRange(); nodeRange.selectNodeContents(node);
      if (nodeRange.comparePoint(startRange.startContainer, startRange.startOffset) > 0) continue;
      started = true;
      if (node === startRange.startContainer) start = startRange.startOffset;
    }
    const content = node.data.slice(start);
    if (!content) continue;
    const block = node.parentElement?.closest(BLOCKS) ?? doc.body;
    if (previousBlock && block !== previousBlock && text && !/\s$/.test(text)) text += '\n';
    parts.push({ node, start, text: content, offset: text.length });
    text += content; previousBlock = block;
  }
  return { text, parts };
}
export function speechBoundaryRange(doc: Document, speech: SpeechText, index: number, length?: number): Range | undefined {
  if (!Number.isInteger(index) || index < 0 || index >= speech.text.length) return;
  const part = speech.parts.find(item => index >= item.offset && index < item.offset + item.text.length);
  if (!part) return; // Block separators are not invented words.
  const start = part.start + index - part.offset;
  const count = length && length > 0 ? length : speech.text.slice(index).match(/^\S+/u)?.[0].length ?? 1;
  const endIndex = Math.min(speech.text.length, index + count);
  const endPart = [...speech.parts].reverse().find(item => endIndex > item.offset && endIndex <= item.offset + item.text.length) ?? part;
  const range = doc.createRange();
  range.setStart(part.node, start);
  range.setEnd(endPart.node, Math.min(endPart.node.length, endPart.start + endIndex - endPart.offset));
  return range;
}
export function nextLinearSection(sections: { linear?: string }[], current: number): number | undefined {
  for (let index = current + 1; index < sections.length; index++) if (sections[index]!.linear !== 'no') return index;
}
