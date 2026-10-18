import type { Locale } from '../../i18n/src';

export const LOOKUP_LIMIT = 160;
export const TRANSLATION_LIMIT = 2_000;
const languages:Record<Locale,{dictionary:string;translation:string}>={en:{dictionary:'en',translation:'en'},fi:{dictionary:'fi',translation:'fi'},fr:{dictionary:'fr',translation:'fr'},de:{dictionary:'de',translation:'de'},pl:{dictionary:'pl',translation:'pl'},'zh-Hans':{dictionary:'zh',translation:'zh-CN'},es:{dictionary:'es',translation:'es'}};
/** Only an explicit link activation sends the captured selection to the named provider. */
export function selectionProviderUrl(kind:'lookup'|'translate',text:string,locale:Locale):string|null {
  const value=text.trim(), maximum=kind==='lookup'?LOOKUP_LIMIT:TRANSLATION_LIMIT;
  if(!value || [...value].length>maximum)return null;
  const language=languages[locale]??languages.en;
  const url=new URL(kind==='lookup'?`https://${language.dictionary}.wiktionary.org/w/index.php`:'https://translate.google.com/');
  if(kind==='lookup')url.searchParams.set('search',value);
  else {url.searchParams.set('sl','auto');url.searchParams.set('tl',language.translation);url.searchParams.set('text',value);url.searchParams.set('op','translate');}
  return url.href;
}
export function selectionShareData(quote:string,title:string,authors:readonly string[]):ShareData {
  return {title,text:`${quote.trim()}\n\n— ${title}${authors.length?`, ${authors.join(', ')}`:''}`};
}
export function canShareSelection(data:ShareData):boolean {
  try{return typeof navigator.share==='function' && (!navigator.canShare || navigator.canShare(data));}
  catch{return false;}
}
/** AbortError is the normal share-sheet cancellation, never a reason to copy or send elsewhere. */
export async function shareSelection(data:ShareData):Promise<'shared'|'cancelled'|'unsupported'> {
  if(!canShareSelection(data))return 'unsupported';
  try{await navigator.share(data);return 'shared';}
  catch(error){if(error && typeof error==='object' && 'name' in error && error.name==='AbortError')return 'cancelled';throw error;}
}
