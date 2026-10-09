// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { buildSpeechText, nextLinearSection, speechBoundaryRange } from './speechText';
const parse = (body: string) => new DOMParser().parseFromString(`<html><body>${body}</body></html>`, 'text/html');
describe('speech source ranges', () => {
  it('starts inside the selected text node instead of skipping its paragraph', () => {
    const doc = parse('<p>Before this.</p><p>Start at this selected word.</p><p>Then continue.</p>');
    const node = doc.querySelectorAll('p')[1]!.firstChild!;
    const range = doc.createRange(); range.setStart(node, 14); range.setEnd(node, 22);
    const speech = buildSpeechText(doc, range);
    expect(speech.text).toBe('selected word.\nThen continue.');
    expect(speechBoundaryRange(doc, speech, 0, 8)?.toString()).toBe('selected');
  });
  it('preserves inline words and maps boundaries spanning markup', () => {
    const doc = parse('<p>An un<em>break</em>able word.</p><p>Next paragraph.</p>');
    const speech = buildSpeechText(doc);
    expect(speech.text).toBe('An unbreakable word.\nNext paragraph.');
    expect(speechBoundaryRange(doc, speech, 3, 11)?.toString()).toBe('unbreakable');
    expect(speechBoundaryRange(doc, speech, speech.text.indexOf('Next'), 4)?.toString()).toBe('Next');
  });
  it('ignores hidden/executable content and non-word boundary positions', () => {
    const doc = parse('<p>Visible.</p><script>secret()</script><p hidden>Hidden</p><p aria-hidden="true">Decoration</p>');
    const speech = buildSpeechText(doc);
    expect(speech.text).toBe('Visible.');
    expect(speechBoundaryRange(doc, speech, -1)).toBeUndefined();
    expect(speechBoundaryRange(doc, speech, 500)).toBeUndefined();
  });
  it('advances linear reading sections once and stops at the end', () => {
    const sections = [{}, { linear: 'no' }, {}, { linear: 'no' }];
    expect(nextLinearSection(sections, 0)).toBe(2);
    expect(nextLinearSection(sections, 2)).toBeUndefined();
  });
});
