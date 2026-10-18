// @vitest-environment jsdom
import {afterEach,describe,expect,it,vi} from 'vitest';
import {LOOKUP_LIMIT,TRANSLATION_LIMIT,canShareSelection,selectionProviderUrl,selectionShareData,shareSelection} from './selectionActions';
import {LOCALES} from '../../i18n/src';
import {selectionMessages,selectionTranslate,type SelectionMessageKey} from './selectionMessages';
afterEach(()=>{vi.restoreAllMocks();delete (navigator as unknown as Record<string,unknown>).share;delete (navigator as unknown as Record<string,unknown>).canShare;});
describe('explicit selected-text actions',()=>{
  it('encodes selected text as data at fixed providers and translates into the chosen language',()=>{
    const text='a & https://private.test/?token=secret # " <b>你好</b>';
    const lookup=new URL(selectionProviderUrl('lookup',text,'fr')!);expect(lookup.origin).toBe('https://fr.wiktionary.org');expect(lookup.searchParams.get('search')).toBe(text);
    const translation=new URL(selectionProviderUrl('translate',text,'zh-Hans')!);expect(translation.origin).toBe('https://translate.google.com');expect(translation.searchParams.get('text')).toBe(text);expect(translation.searchParams.get('tl')).toBe('zh-CN');
  });
  it('refuses oversized selections instead of silently sending only a truncated passage',()=>{
    expect(selectionProviderUrl('lookup','😀'.repeat(LOOKUP_LIMIT),'en')).not.toBeNull();
    expect(selectionProviderUrl('lookup','😀'.repeat(LOOKUP_LIMIT+1),'en')).toBeNull();
    expect(selectionProviderUrl('translate','a'.repeat(TRANSLATION_LIMIT+1),'en')).toBeNull();
    expect(selectionProviderUrl('lookup','  ','en')).toBeNull();
  });
  it('shares only the selected text and attribution, and treats dismissal as cancellation',async()=>{
    const data=selectionShareData('  Captured passage.  ','Book',['Author']);
    expect(data).toEqual({title:'Book',text:'Captured passage.\n\n— Book, Author'});expect(data.url).toBeUndefined();
    const share=vi.fn().mockResolvedValue(undefined);Object.defineProperty(navigator,'share',{configurable:true,value:share});
    expect(await shareSelection(data)).toBe('shared');expect(share).toHaveBeenCalledWith(data);
    share.mockRejectedValue(new DOMException('Dismissed','AbortError'));expect(await shareSelection(data)).toBe('cancelled');
    share.mockRejectedValue(new Error('Failed'));await expect(shareSelection(data)).rejects.toThrow('Failed');
  });
  it('handles missing, rejected or throwing platform capability checks',async()=>{
    expect(await shareSelection({text:'Passage'})).toBe('unsupported');
    const share=vi.fn();Object.defineProperty(navigator,'share',{configurable:true,value:share});
    Object.defineProperty(navigator,'canShare',{configurable:true,value:()=>{throw new Error('Permissions');}});
    expect(canShareSelection({text:'Passage'})).toBe(false);expect(await shareSelection({text:'Passage'})).toBe('unsupported');expect(share).not.toHaveBeenCalled();
  });
  it('provides all seven locales with matching placeholders and no untranslated keys',()=>{
    for(const [key,values] of Object.entries(selectionMessages)){
      expect(values).toHaveLength(LOCALES.length);
      const parameters=(text:string)=>[...text.matchAll(/\{(\w+)\}/g)].map(match=>match[1]).sort();
      values.forEach((value,index)=>{expect(value.trim(),`${key}/${index}`).not.toBe('');expect(parameters(value)).toEqual(parameters(values[0]));expect(selectionTranslate(key as SelectionMessageKey,{count:2000},LOCALES[index]!.code)).not.toMatch(/\{\w+\}/);});
    }
  });
});
