// @vitest-environment jsdom
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {SelectionCard,HIGHLIGHT_COLORS} from './SelectionCard';
import {setLocale,LOCALES} from '../../i18n/src';
import {selectionTranslate} from './selectionMessages';
import {readerTranslate} from './readerI18n';
let root:Root,host:HTMLDivElement;
const selection={quote:'An original selected passage.',locator:'epubcfi(/6/2!/4/2,/1:4,/1:32)'},save=vi.fn(),dismiss=vi.fn();
const button=(label:string)=>[...host.querySelectorAll('button')].find(item=>item.textContent===label || item.getAttribute('aria-label')===label)!;
const click=(label:string)=>act(async()=>button(label).click());
const render=(annotationsEnabled=true)=>act(async()=>root.render(<SelectionCard selection={selection} title="Original book" authors={['Author']} annotationsEnabled={annotationsEnabled} onSave={save} onDismiss={dismiss}/>));
beforeEach(()=>{setLocale('en');Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});vi.clearAllMocks();host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.restoreAllMocks();vi.unstubAllGlobals();for(const key of ['share','canShare','clipboard'])delete (navigator as unknown as Record<string,unknown>)[key];});
it('does not send, copy or share anything until explicit action; provider links disclose their destination',async()=>{
  const fetch=vi.fn(),share=vi.fn(),copy=vi.fn();vi.stubGlobal('fetch',fetch);
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:copy}});Object.defineProperty(navigator,'share',{configurable:true,value:share});
  await render();expect(fetch).not.toHaveBeenCalled();expect(share).not.toHaveBeenCalled();expect(copy).not.toHaveBeenCalled();
  for(const link of host.querySelectorAll('a')){expect(link.target).toBe('_blank');expect(link.rel).toBe('noopener noreferrer');expect(link.getAttribute('referrerpolicy')).toBe('no-referrer');}
  expect(host.textContent).toContain('Only the selected text is sent when you open a link.');
  await click('Copy');expect(copy).toHaveBeenCalledWith(selection.quote);expect(host.querySelector('[role=status]')?.textContent).toBe('Copied to clipboard.');
  const language=host.querySelector('select')!;await act(async()=>{language.value='de';language.dispatchEvent(new Event('change',{bubbles:true}));});
  const translate=[...host.querySelectorAll('a')].find(item=>item.textContent==='Translate')!;expect(new URL(translate.href).searchParams.get('tl')).toBe('de');expect(fetch).not.toHaveBeenCalled();
});
it('saves the captured range and chosen color with an inline note without re-reading selection',async()=>{
  await render();await click(readerTranslate('highlightColor',{color:HIGHLIGHT_COLORS[2]}));await click('Add note');
  const field=host.querySelector('textarea')!;await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(field,'Remember this exact range.');field.dispatchEvent(new Event('input',{bubbles:true}));});
  await click('Save note');expect(save).toHaveBeenCalledWith(selection,HIGHLIGHT_COLORS[2],'Remember this exact range.');
});
it('permits non-editing actions in prepared mode while hiding annotation controls',async()=>{
  await render(false);expect(host.querySelector('.reader-selection-highlights')).toBeNull();expect(button('Copy')).toBeDefined();expect(host.querySelector('a')).not.toBeNull();expect(save).not.toHaveBeenCalled();
});
it('falls back to selectable text when clipboard is denied and never copies on share cancellation',async()=>{
  const copy=vi.fn().mockRejectedValue(new Error('Denied')),share=vi.fn().mockRejectedValue(new DOMException('Dismissed','AbortError'));
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:copy}});Object.defineProperty(navigator,'share',{configurable:true,value:share});
  await render();await click('Share');expect(copy).not.toHaveBeenCalled();expect(host.querySelector('[role=status]')).toBeNull();
  await click('Copy');expect((host.querySelector('textarea[readonly]') as HTMLTextAreaElement).value).toBe(selection.quote);
  expect(host.querySelector('[role=status]')?.textContent).toContain('Copy is unavailable');
});
it('offers attributed copy to share when no share sheet exists',async()=>{
  const copy=vi.fn().mockResolvedValue(undefined);Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:copy}});
  await render();await click('Copy to share');expect(copy).toHaveBeenCalledWith(`${selection.quote}\n\n— Original book, Author`);
});
it('localizes actions without changing selected publication text',async()=>{
  await render();for(const {code} of LOCALES){await act(async()=>setLocale(code));expect(host.querySelector('section')?.getAttribute('aria-label')).toBe(selectionTranslate('actions',{},code));expect(button(selectionTranslate('copy',{},code))).toBeDefined();expect(host.querySelector('blockquote')?.textContent).toBe(selection.quote);expect(host.textContent).toContain(selectionTranslate('providers',{},code));}
});
it('ignores a previous selection’s late clipboard failure after a new card replaces it',async()=>{
  let reject!:(error:Error)=>void;const copy=vi.fn(()=>new Promise<void>((_resolve,failed)=>{reject=failed;}));Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:copy}});
  await render();await click('Copy');
  await act(async()=>root.render(<SelectionCard key="new-source" selection={{quote:'New source text',locator:'new-locator'}} title="New book" authors={[]} annotationsEnabled onSave={save} onDismiss={dismiss}/>));
  await act(async()=>reject(new Error('Late denial')));expect(host.querySelector('blockquote')?.textContent).toBe('New source text');expect(host.querySelector('[role=status]')).toBeNull();expect(host.querySelector('textarea')).toBeNull();
});
