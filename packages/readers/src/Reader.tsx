import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { ArrowLeft, BookOpen, Bookmark, ChevronLeft, ChevronRight, Highlighter, List, Minus, Plus, Search, Settings2, Square, Volume2, X } from 'lucide-react';
import { EbookView } from './EbookView';
import { PdfView } from './PdfView';
import { ComicView } from './ComicView';
import { defaultSettings, themeColors, type Annotation, type EngineHandle, type ReaderProps, type ReaderSettings, type SearchResult, type SelectionAnchor, type TocItem } from './contracts';
import { importFont, storedFonts } from './fonts';
import { parsePageAnchor } from './anchors';
import { useReaderI18n, readerError } from './readerI18n';
import './reader.css';
export type { ReaderProps } from './contracts';
const settingsKey = (scope: string) => `avid.reader.settings.v1.${encodeURIComponent(scope)}`;
function getSettings(scope: string): ReaderSettings {
  try { return { ...defaultSettings, ...JSON.parse(localStorage.getItem(settingsKey(scope)) || '{}') }; } catch { return defaultSettings; }
}
export function Reader(props: ReaderProps) {
  const { t, locale } = useReaderI18n();
  const { book, annotations, onClose, onAnnotation } = props;
  const file = props.file ?? book.files.find(item => item.format !== 'AUDIO') ?? { id: `${book.id}-text`, name: book.title, format: book.format };
  const scope = props.accountScope ?? 'local';
  const [settings, setSettings] = useState(() => getSettings(scope));
  const [settingsAccount, setSettingsAccount] = useState(scope);
  const dialog = useRef<HTMLDialogElement>(null);
  const [panel, setPanel] = useState<'contents' | 'settings' | 'search' | 'notes' | null>(null);
  const [toc, setToc] = useState<TocItem[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [location, setLocation] = useState({ locator: props.initialAnchor?.locator || '', progress: props.initialAnchor?.progress ?? book.progress, label: t('opening') });
  const [selected, setSelected] = useState<SelectionAnchor>();
  const [speaking, setSpeaking] = useState(false);
  const [media, setMedia] = useState({ available: false, playing: false, seconds: 0 });
  const [followMedia, setFollowMedia] = useState(true);
  const [mediaRate, setMediaRate] = useState(1);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const draftKey = `avid.reader.note-draft.${encodeURIComponent(scope)}.${book.id}.${file.id}`;
  const [noteText, setNoteText] = useState(() => sessionStorage.getItem(draftKey) || '');
  const [noteDraftKey, setNoteDraftKey] = useState(draftKey);
  const [noteColor, setNoteColor] = useState('#d6b96e');
  const [editing, setEditing] = useState<Annotation>();
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [fonts, setFonts] = useState(() => storedFonts(scope).map(font => font.name));
  const [flash, setFlash] = useState(false);
  const engine = useRef<EngineHandle | undefined>(undefined);
  const activeLocation = useRef(location); activeLocation.current = location;
  const callbacks = useRef(props); callbacks.current = props;
  const kind = file.format === 'PDF' ? 'pdf' : ['CBZ', 'CBR', 'CB7'].includes(file.format) ? 'comic' : 'epub';
  const notes = annotations.filter(annotation => annotation.bookId === book.id && annotation.fileId === file.id && !annotation.deleted);
  const colors = themeColors(settings);
  const persistAnchor = useCallback((locator: string, progress: number, label: string) => {
    setLocation({ locator, progress, label });
    callbacks.current.onAnchor({ bookId: book.id, fileId: file.id, kind, locator, progress, updatedAt: new Date().toISOString() });
  }, [book.id, file.id, kind]);
  useEffect(() => { if (settingsAccount !== scope) { setSettings(getSettings(scope)); setFonts(storedFonts(scope).map(font => font.name)); setSettingsAccount(scope); } }, [scope, settingsAccount]);
  useEffect(() => { if (settingsAccount === scope) localStorage.setItem(settingsKey(scope), JSON.stringify(settings)); }, [settings, scope, settingsAccount]);
  useEffect(() => {
    const element = dialog.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    element?.showModal();
    element?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => { element?.close(); if (previouslyFocused?.isConnected) previouslyFocused.focus(); };
  }, []);
  useEffect(() => { if (noteDraftKey !== draftKey) { setNoteText(sessionStorage.getItem(draftKey) || ''); setNoteDraftKey(draftKey); setEditing(undefined); } }, [draftKey, noteDraftKey]);
  useEffect(() => { if (noteDraftKey === draftKey) { if (noteText) sessionStorage.setItem(draftKey, noteText); else sessionStorage.removeItem(draftKey); } }, [noteText, draftKey, noteDraftKey]);
  useEffect(() => {
    if (!('speechSynthesis' in window)) return;
    const update = () => setVoices(speechSynthesis.getVoices()); update();
    speechSynthesis.addEventListener('voiceschanged', update);
    return () => speechSynthesis.removeEventListener('voiceschanged', update);
  }, []);
  const turn = useCallback((direction: 'next' | 'prev') => {
    if (['fade', 'fast-fade'].includes(settings.animation) && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setFlash(true); window.setTimeout(() => setFlash(false), settings.animation === 'fade' ? 250 : 100);
    }
    engine.current?.[direction]();
  }, [settings.animation]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).closest('input,textarea,select,[contenteditable]')) return;
      if (event.key === 'ArrowRight') { event.preventDefault(); turn(settings.direction === 'rtl' && kind === 'comic' ? 'prev' : 'next'); }
      if (event.key === 'ArrowLeft') { event.preventDefault(); turn(settings.direction === 'rtl' && kind === 'comic' ? 'next' : 'prev'); }
      if (event.key === 'Escape') { event.preventDefault(); if (panel) setPanel(null); else onClose(); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [turn, panel, onClose, kind, settings.direction]);
  useEffect(() => { callbacks.current.onActivity?.(media.playing ? 'listening' : speaking ? 'speech' : 'reading'); }, [media.playing, speaking]);
  const change = <K extends keyof ReaderSettings>(key: K, value: ReaderSettings[K]) => setSettings(previous => ({ ...previous, [key]: value }));
  const saveAnnotation = (note: boolean) => {
    const selection = selected ?? engine.current?.selection() ?? { quote: location.label, locator: location.locator };
    if (!selection.locator) return;
    const now = new Date().toISOString();
    onAnnotation({ id: editing?.id ?? crypto.randomUUID(), bookId: book.id, fileId: file.id, kind: note ? 'note' : 'highlight', quote: editing?.quote ?? selection.quote, text: note ? noteText : '', color: noteColor, locator: editing?.locator ?? selection.locator, createdAt: editing?.createdAt ?? now, updatedAt: now });
    setSelected(undefined); setNoteText(''); setEditing(undefined); setPanel('notes');
  };
  const runSearch = async () => {
    if (!query.trim() || !engine.current) return;
    setSearching(true); setResults([]);
    try { setResults(await engine.current.search(query.trim())); } catch (error) { setNotice(readerError(error, 'searchFailed')); } finally { setSearching(false); }
  };
  const engineProps = { ...props, file, settings, onReady: (handle: EngineHandle, entries: TocItem[]) => { engine.current = handle; setToc(entries); setReady(true); }, onLocation: persistAnchor, onError: setError, onNotice: setNotice, onSelection: setSelected, onSpeaking: setSpeaking, onMediaState: setMedia };
  const locationLabel = !ready ? t('opening') : kind === 'epub' || !toc.length ? location.label : t('pageOf', { number: parsePageAnchor(location.locator, toc.length).page, count: toc.length });
  const togglePanel = (name: typeof panel) => setPanel(previous => previous === name ? null : name);
  return <dialog ref={dialog} onCancel={event => { event.preventDefault(); if (panel) setPanel(null); else onClose(); }} className={`avid-reader theme-${settings.theme}`} role="dialog" aria-modal="true" lang={locale} aria-label={t('readingTitle', { title: book.title })} style={{ '--reader-bg': colors.background, '--reader-fg': colors.foreground } as CSSProperties}>
    <header className="avid-reader-header">
      <button className="reader-icon" aria-label={t('closeReader')} onClick={onClose}><ArrowLeft size={20} /></button>
      <div className="reader-heading"><span>{book.title}</span><small>{book.authors.join(', ')}</small></div>
      <div className="reader-toolbar">
        <button className={`reader-icon ${panel === 'contents' ? 'active' : ''}`} aria-label={t('tableOfContents')} title={t('contents')} onClick={() => togglePanel('contents')}><List size={20} /></button>
        <button className={`reader-icon ${panel === 'search' ? 'active' : ''}`} aria-label={t('searchBook')} title={t('search')} onClick={() => togglePanel('search')}><Search size={19} /></button>
        <button className={`reader-icon ${panel === 'notes' ? 'active' : ''}`} aria-label={t('highlightsNotes')} title={t('notebook')} onClick={() => togglePanel('notes')}><Bookmark size={19} /></button>
        {kind === 'epub' && <button className={`reader-icon ${speaking ? 'active' : ''}`} aria-label={speaking ? t('stopReading') : t('readAloud')} title={t('readAloud')} disabled={!ready} onClick={() => speaking ? engine.current?.stopSpeaking?.() : engine.current?.speak?.()}>{speaking ? <Square size={18} /> : <Volume2 size={20} />}</button>}
        <button className={`reader-icon ${panel === 'settings' ? 'active' : ''}`} aria-label={t('readingSettings')} title={t('appearance')} onClick={() => togglePanel('settings')}><Settings2 size={20} /></button>
      </div>
    </header>
    {notice && <div className="reader-notice" role="alert"><span>{notice}</span><button className="reader-icon" aria-label={t('dismissMessage')} onClick={() => setNotice('')}><X size={16} /></button></div>}
    <div className="avid-reader-body">
      {panel && <aside className="reader-panel"><div className="reader-panel-title"><h2>{t(panel === 'contents' ? 'contents' : panel === 'settings' ? 'makeYours' : panel === 'notes' ? 'yourNotebook' : 'findBook')}</h2><button className="reader-icon" aria-label={t('closePanel')} onClick={() => setPanel(null)}><X size={18} /></button></div>
        {panel === 'contents' && <nav className="reader-toc" aria-label={t('chapters')}><Contents items={toc} go={locator => { engine.current?.goTo(locator); setPanel(null); }} />{!toc.length && <p className="reader-muted">{t('contentsHint')}</p>}</nav>}
        {panel === 'search' && <><form className="reader-search" onSubmit={event => { event.preventDefault(); void runSearch(); }}><input autoFocus placeholder={t(kind === 'comic' ? 'searchPages' : 'searchPassage')} value={query} onChange={event => setQuery(event.target.value)} /><button className="reader-icon" aria-label={t('runSearch')} disabled={searching}><Search size={18} /></button></form><p className="reader-muted">{searching ? t('searching') : t('matches', { count: results.length })}</p>{results.map((result, index) => <button className="reader-result" key={`${result.locator}-${index}`} onClick={() => engine.current?.goTo(result.locator)}><small>{result.pageNumber ? t('page', { number: result.pageNumber }) : result.label}</small><span>{result.excerpt}</span></button>)}</>}
        {panel === 'notes' && <><label className="reader-field">{t('searchNotes')}<input placeholder={t('thoughtPlaceholder')} value={query} onChange={event => setQuery(event.target.value)} /></label>
          <div className="reader-note-editor"><small>{t(editing ? 'editNote' : selected ? 'selectedPassage' : 'noteAtLocation')}</small>{selected && <blockquote>{selected.quote.slice(0, 200)}</blockquote>}<textarea aria-label={t('noteText')} placeholder={t('notePlaceholder')} value={noteText} onChange={event => setNoteText(event.target.value)} /><div className="reader-note-actions"><div className="reader-swatches">{['#d6b96e', '#9ebda1', '#8caebe', '#c8a0b5'].map(color => <button key={color} title={t('highlightColor', { color })} aria-label={t('highlightColor', { color })} className={noteColor === color ? 'chosen' : ''} style={{ background: color }} onClick={() => setNoteColor(color)} />)}</div><button className="reader-primary" disabled={!location.locator || !noteText.trim()} onClick={() => saveAnnotation(true)}>{t('saveNote')}</button></div></div>
          {notes.filter(annotation => `${annotation.quote} ${annotation.text}`.toLowerCase().includes(query.toLowerCase())).map(annotation => <article className="reader-note" key={annotation.id}><button className="reader-note-quote" style={{ borderColor: annotation.color }} onClick={() => engine.current?.goTo(annotation.locator)}>{annotation.quote || t('savedLocation')}</button>{annotation.text && <p>{annotation.text}</p>}<div><button onClick={() => { setEditing(annotation); setNoteText(annotation.text); setNoteColor(annotation.color); }}>{t('edit')}</button><button onClick={() => onAnnotation({ ...annotation, deleted: true, updatedAt: new Date().toISOString() })}>{t('delete')}</button></div></article>)}{!notes.length && <p className="reader-muted">{t('noNotes')}</p>}</>}
        {panel === 'settings' && <div className="reader-settings">
          <label className="reader-setting-label">{t('pageColor')}</label><div className="reader-theme-options">{(['light', 'warm', 'dark', 'custom'] as const).map(theme => <button className={`${theme} ${settings.theme === theme ? 'chosen' : ''}`} key={theme} onClick={() => change('theme', theme)}>{t(theme === 'light' ? 'paper' : theme === 'warm' ? 'sepia' : theme === 'dark' ? 'night' : 'custom')}</button>)}</div>
          {settings.theme === 'custom' && <div className="reader-two-fields"><label>{t('pageBackground')}<input type="color" value={settings.background} onChange={event => change('background', event.target.value)} /></label><label>{t('textColor')}<input type="color" value={settings.foreground} onChange={event => change('foreground', event.target.value)} /></label></div>}
          {kind === 'epub' && <><label className="reader-field">{t('typeface')}<select value={settings.font} onChange={event => change('font', event.target.value)}>{['Literata', 'Georgia', 'Palatino', 'Arial', 'Verdana', ...fonts].map(font => <option key={font}>{font}</option>)}</select></label><label className="reader-import-font">{t('importFont')}<input type="file" accept=".woff,.woff2,.ttf,.otf" onChange={async event => { const file = event.target.files?.[0]; if (!file) return; try { const name = await importFont(file, scope); setFonts(storedFonts(scope).map(font => font.name)); change('font', name); } catch (error) { setNotice(readerError(error, 'fontFailed')); } }} /></label>
          <div className="reader-font-size"><span>{t('fontSize')}</span><button className="reader-icon" aria-label={t('decreaseFont')} onClick={() => change('fontSize', Math.max(12, settings.fontSize - 1))}><Minus size={16} /></button><strong>{settings.fontSize}</strong><button className="reader-icon" aria-label={t('increaseFont')} onClick={() => change('fontSize', Math.min(40, settings.fontSize + 1))}><Plus size={16} /></button></div>
          <label className="reader-field">{t('lineSpacing')}<span>{new Intl.NumberFormat(locale, { minimumFractionDigits: 1 }).format(settings.lineHeight)}</span><input type="range" min="1.2" max="2.4" step="0.1" value={settings.lineHeight} onChange={event => change('lineHeight', Number(event.target.value))} /></label><label className="reader-field">{t('margins')}<input type="range" min="2" max="22" value={settings.margin} onChange={event => change('margin', Number(event.target.value))} /></label>
          <label className="reader-field">{t('pageFlow')}<select value={settings.flow} onChange={event => change('flow', event.target.value as ReaderSettings['flow'])}><option value="paginated">{t('turnPages')}</option><option value="scrolled">{t('continuous')}</option></select></label>
          <label className="reader-field">{t('installedVoice')}<select value={settings.voice} onChange={event => change('voice', event.target.value)}><option value="">{t('systemDefault')}</option>{voices.map(voice => <option key={voice.voiceURI} value={voice.voiceURI}>{voice.name} · {voice.lang}</option>)}</select></label><label className="reader-field">{t('speechSpeed', { rate: settings.speechRate })}<input type="range" min="0.5" max="2" step="0.1" value={settings.speechRate} onChange={event => change('speechRate', Number(event.target.value))} /></label><p className="reader-muted">{!voices.length && <>{t('noVoices')} </>}{t('wordTimingHint')}</p></>}
          {kind === 'comic' && <><label className="reader-field">{t('readingLayout')}<select value={settings.comicMode} onChange={event => change('comicMode', event.target.value as ReaderSettings['comicMode'])}><option value="paged">{t('onePage')}</option><option value="spread">{t('twoPages')}</option><option value="webtoon">{t('webtoon')}</option></select></label><label className="reader-field">{t('direction')}<select value={settings.direction} onChange={event => change('direction', event.target.value as ReaderSettings['direction'])}><option value="ltr">{t('ltr')}</option><option value="rtl">{t('rtl')}</option></select></label></>}
          {kind === 'pdf' && <div className="reader-two-fields"><button className="reader-primary" onClick={() => engine.current?.autoCrop?.()}>{t('detectMargins')}</button><button className="reader-secondary" onClick={() => engine.current?.resetCrop?.()}>{t('resetCrop')}</button></div>}
          <label className="reader-field">{t('pageTurn')}<select value={settings.animation} onChange={event => change('animation', event.target.value as ReaderSettings['animation'])}><option value="none">{t('none')}</option><option value="slide">{t('slide')}</option><option value="fade">{t('fade')}</option><option value="fast-fade">{t('fastFade')}</option></select></label><p className="reader-muted">{t('preferencesHint')}</p>
        </div>}
      </aside>}
      <div className={`reader-stage ${flash ? 'turning' : ''}`}>
        {error ? <div className="reader-error" role="alert"><BookOpen size={32} /><h2>{t('cannotOpen')}</h2><p>{error}</p><button className="reader-primary" onClick={() => setError('')}>{t('dismiss')}</button><button className="reader-secondary" onClick={onClose}>{t('backLibrary')}</button></div> : <>{kind === 'epub' ? <EbookView {...engineProps} /> : kind === 'pdf' ? <PdfView {...engineProps} /> : <ComicView {...engineProps} />}{!ready && <div className="reader-opening"><span className="reader-spinner" />{t('opening')}</div>}</>}
      </div>
      {selected && panel !== 'notes' && <div className="reader-selection-tools"><button onClick={() => saveAnnotation(false)}><Highlighter size={16} />{t('highlight')}</button><button onClick={() => { setPanel('notes'); setNoteText(''); setEditing(undefined); }}><Bookmark size={16} />{t('addNote')}</button><button aria-label={t('dismissSelection')} onClick={() => setSelected(undefined)}><X size={16} /></button></div>}
    </div>
    {media.available && <div className="reader-media-bar"><span><Volume2 size={16} />{t('alignedNarration')}</span><button className="reader-icon" aria-label={t('previousPassage')} onClick={() => engine.current?.mediaPrevious?.()}><ChevronLeft size={18} /></button><button className="reader-primary" onClick={() => media.playing ? engine.current?.pauseMedia?.() : engine.current?.playMedia?.()}>{t(media.playing ? 'pauseNarration' : 'readListen')}</button><button className="reader-icon" aria-label={t('nextPassage')} onClick={() => engine.current?.mediaNext?.()}><ChevronRight size={18} /></button><time>{Math.floor(media.seconds / 60)}:{String(Math.floor(media.seconds % 60)).padStart(2, '0')}</time><label><input type="checkbox" checked={followMedia} onChange={event => { setFollowMedia(event.target.checked); engine.current?.setMediaFollow?.(event.target.checked); }} />{t('followText')}</label><select aria-label={t('narrationSpeed')} value={mediaRate} onChange={event => { const rate = Number(event.target.value); setMediaRate(rate); engine.current?.setMediaRate?.(rate); }}>{[.75, 1, 1.25, 1.5, 1.75, 2].map(rate => <option key={rate} value={rate}>{new Intl.NumberFormat(locale).format(rate)}×</option>)}</select></div>}
    <footer className="avid-reader-footer"><span className="reader-chapter-label">{locationLabel}</span><div className="reader-page-controls"><button className="reader-icon" disabled={!ready} aria-label={t('previousPage')} onClick={() => turn('prev')}><ChevronLeft size={19} /></button><span>{Math.round(location.progress * 100)}%</span><button className="reader-icon" disabled={!ready} aria-label={t('nextPage')} onClick={() => turn('next')}><ChevronRight size={19} /></button></div><span className="reader-footer-brand">avid <span>·</span> {file.format}</span><div className="reader-progress"><span style={{ width: `${location.progress * 100}%` }} /></div></footer>
  </dialog>;
}
function Contents({ items, go }: { items: TocItem[]; go: (locator: string | number) => void }) {
  const { t } = useReaderI18n();
  return <ol>{items.map((item, index) => <li key={`${item.href}-${index}`}><button onClick={() => go(item.href)}>{item.pageNumber ? `${t('page', { number: item.pageNumber })}${item.fileName ? ` · ${item.fileName}` : ''}` : item.label || t('chapter', { number: index + 1 })}</button>{item.subitems && <Contents items={item.subitems} go={go} />}</li>)}</ol>;
}
