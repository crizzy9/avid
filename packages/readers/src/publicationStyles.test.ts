// @vitest-environment jsdom
import {beforeEach,expect,it,vi} from 'vitest';
import {publicationStyleRules} from './publicationStyles';
import {defaultSettings} from './contracts';
import {sanitizeBookDocument,BOOK_CSP} from './isolation';
beforeEach(()=>{localStorage.clear();vi.stubGlobal('CSS',{escape:(value:string)=>value.replaceAll(' ',String.raw`\ `)});});
it('preserves embedded typography/colors in publication mode while retaining audio/selection highlights',()=>{
  expect(defaultSettings.publicationStyles).toBe(false);
  const reader=publicationStyleRules(defaultSettings);expect(reader).toContain('font-size: 18px !important');expect(reader).toContain('background: #fcfcfa');
  const publisher=publicationStyleRules({...defaultSettings,publicationStyles:true},'source-active');
  expect(publisher).toContain('.source-active');expect(publisher).toContain('.avid-audio-active');expect(publisher).toContain('::selection');
  expect(publisher).not.toContain('font-family');expect(publisher).not.toContain('body {');expect(publisher).not.toContain('html {');expect(publisher).not.toContain('h1');
  expect(publicationStyleRules({...defaultSettings,publicationStyles:false})).toBe(reader);
});
it('retains original EPUB classes, safe inline/linked CSS and semantic text without enabling scripts or remote fetches',()=>{
  const original='<html><head><style>.workskin .letter {color:#804000;font-family:serif}.message{border:1px solid}</style><link rel="stylesheet" href="blob:publication-css"/></head><body class="workskin"><p class="letter" style="text-align:right">An <em>original</em> letter</p><div class="message">A formatted message</div><script>evil()</script><p onclick="evil()">Safe</p></body></html>';
  const doc=new DOMParser().parseFromString(sanitizeBookDocument(original),'text/html');
  expect(doc.querySelector('.workskin .letter')?.getAttribute('style')).toBe('text-align:right');expect(doc.querySelector('.letter em')?.textContent).toBe('original');expect(doc.querySelector('style')?.textContent).toContain('.message{border:1px solid}');expect(doc.querySelector('link')?.getAttribute('href')).toBe('blob:publication-css');
  expect(doc.querySelector('script,[onclick]')).toBeNull();expect(doc.querySelector('meta')?.getAttribute('content')).toBe(BOOK_CSP);expect(BOOK_CSP).toContain("connect-src 'none'");expect(BOOK_CSP).toContain("style-src 'unsafe-inline' blob: data:");
});
