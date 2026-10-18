import {useEffect,useRef,useState} from 'react';
import {LOCALES,type Locale} from '../../i18n/src';
import type {SelectionAnchor} from './contracts';
import {useReaderI18n} from './readerI18n';
import {useSelectionI18n,type SelectionMessageKey} from './selectionMessages';
import {LOOKUP_LIMIT,TRANSLATION_LIMIT,selectionProviderUrl,selectionShareData,shareSelection,canShareSelection} from './selectionActions';

export const HIGHLIGHT_COLORS=['#d6b96e','#8cb99b','#8daed0','#c69bc3','#df9c89'] as const;
export function SelectionCard(props:{selection:SelectionAnchor;title:string;authors:string[];annotationsEnabled:boolean;onSave:(selection:SelectionAnchor,color:string,note?:string)=>void;onDismiss:()=>void}){
  const{t:reader}=useReaderI18n(),{t,locale}=useSelectionI18n();
  const [color,setColor]=useState<string>(HIGHLIGHT_COLORS[0]),[note,setNote]=useState(''),[addingNote,setAddingNote]=useState(false),[target,setTarget]=useState<Locale>(locale);
  const [notice,setNotice]=useState<SelectionMessageKey>(),[manual,setManual]=useState<string>(),[busy,setBusy]=useState(false);
  const active=useRef(true);
  useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
  const data=selectionShareData(props.selection.quote,props.title,props.authors);
  const shareAvailable=canShareSelection(data);
  async function copy(value:string){
    try{if(!navigator.clipboard?.writeText)throw new Error('Unavailable');await navigator.clipboard.writeText(value);if(active.current){setNotice('copied');setManual(undefined);}}
    catch{if(active.current){setNotice('copyFailed');setManual(value);}}
  }
  async function share(){
    setBusy(true);setNotice(undefined);
    try{const result=await shareSelection(data);if(active.current && result==='unsupported'){setNotice('shareFailed');setManual(data.text);}}
    catch{if(active.current)setNotice('shareFailed');}
    finally{if(active.current)setBusy(false);}
  }
  const lookup=selectionProviderUrl('lookup',props.selection.quote,locale),translation=selectionProviderUrl('translate',props.selection.quote,target);
  return <section className="reader-selection-tools reader-selection-card" aria-label={t('actions')} data-reader-controls>
    <div className="reader-selection-heading"><strong>{reader('selectedPassage')}</strong><button type="button" aria-label={reader('dismissSelection')} onClick={props.onDismiss}>×</button></div>
    <blockquote>{props.selection.quote}</blockquote>
    {props.annotationsEnabled && <>
      <div className="reader-selection-highlights"><div className="reader-swatches" role="group" aria-label={reader('highlight')}>
        {HIGHLIGHT_COLORS.map(value=><button key={value} type="button" aria-label={reader('highlightColor',{color:value})} aria-pressed={color===value} className={color===value?'chosen':''} style={{backgroundColor:value}} onClick={()=>setColor(value)}/>)}</div>
        <button type="button" onClick={()=>props.onSave(props.selection,color)}>{reader('highlight')}</button>
        <button type="button" aria-expanded={addingNote} onClick={()=>setAddingNote(value=>!value)}>{reader('addNote')}</button>
      </div>
      {addingNote && <div className="reader-selection-note"><label>{reader('noteText')}<textarea value={note} onChange={event=>setNote(event.target.value)} placeholder={reader('notePlaceholder')}/></label><button type="button" onClick={()=>props.onSave(props.selection,color,note)}>{reader('saveNote')}</button></div>}
    </>}
    <div className="reader-selection-actions">
      <button type="button" onClick={()=>void copy(props.selection.quote)}>{t('copy')}</button>
      {lookup?<a href={lookup} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{t('lookup')}</a>:<button type="button" disabled title={t('shorter',{count:LOOKUP_LIMIT})}>{t('lookup')}</button>}
      {translation?<a href={translation} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{t('translate')}</a>:<button type="button" disabled title={t('shorter',{count:TRANSLATION_LIMIT})}>{t('translate')}</button>}
      <button type="button" disabled={busy} onClick={()=>void(shareAvailable?share():copy(data.text!))}>{t(shareAvailable?'share':'copyToShare')}</button>
    </div>
    <label className="reader-selection-language">{t('target')}<select value={target} onChange={event=>setTarget(event.target.value as Locale)}>{LOCALES.map(language=><option key={language.code} value={language.code}>{language.name}</option>)}</select></label>
    <p className="reader-selection-disclosure">{t('providers')}</p>
    {notice && <p role="status">{t(notice)}</p>}
    {manual && <textarea className="reader-selection-manual" readOnly aria-label={reader('selectedPassage')} value={manual} onFocus={event=>event.target.select()}/>}
  </section>;
}
