import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { ArrowLeft, BookOpen, Bookmark, ChevronLeft, ChevronRight, Highlighter, List, Minus, Plus, Search, Settings2, Square, Volume2, X } from 'lucide-react';
import { EbookView } from './EbookView';
import { PdfView } from './PdfView';
import { ComicView } from './ComicView';
import { defaultSettings, themeColors, type Annotation, type EngineHandle, type ReaderProps, type ReaderSettings, type SearchResult, type SelectionAnchor, type TocItem } from './contracts';
import { importFont, storedFonts } from './fonts';
import './reader.css';
export type { ReaderProps } from './contracts';
const settingsKey = (scope: string) => `avid.reader.settings.v1.${encodeURIComponent(scope)}`;
function getSettings(scope: string): ReaderSettings {
  try { return { ...defaultSettings, ...JSON.parse(localStorage.getItem(settingsKey(scope)) || '{}') }; } catch { return defaultSettings; }
}
export function Reader(props: ReaderProps) {
  const { book, annotations, onClose, onAnnotation } = props;
  const file = props.file ?? book.files.find(item => item.format !== 'AUDIO') ?? { id: `${book.id}-text`, name: book.title, format: book.format };
  const scope = props.accountScope ?? 'local';
  const [settings, setSettings] = useState(() => getSettings(scope));
  const [panel, setPanel] = useState<'contents' | 'settings' | 'search' | 'notes' | null>(null);
  const [toc, setToc] = useState<TocItem[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [location, setLocation] = useState({ locator: props.initialAnchor?.locator || '', progress: props.initialAnchor?.progress ?? book.progress, label: 'Opening book…' });
  const [selected, setSelected] = useState<SelectionAnchor>();
  const [speaking, setSpeaking] = useState(false);
  const [media, setMedia] = useState({ available: false, playing: false, seconds: 0 });
  const [followMedia, setFollowMedia] = useState(true);
  const [mediaRate, setMediaRate] = useState(1);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [noteText, setNoteText] = useState('');
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
  useEffect(() => { localStorage.setItem(settingsKey(scope), JSON.stringify(settings)); }, [settings, scope]);
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
      if (event.key === 'Escape') { if (panel) setPanel(null); else onClose(); }
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
    try { setResults(await engine.current.search(query.trim())); } catch (error) { setError(error instanceof Error ? error.message : 'Search failed.'); } finally { setSearching(false); }
  };
  const engineProps = { ...props, file, settings, onReady: (handle: EngineHandle, entries: TocItem[]) => { engine.current = handle; setToc(entries); setReady(true); }, onLocation: persistAnchor, onError: setError, onSelection: setSelected, onSpeaking: setSpeaking, onMediaState: setMedia };
  const togglePanel = (name: typeof panel) => setPanel(previous => previous === name ? null : name);
  return <section className={`avid-reader theme-${settings.theme}`} role="dialog" aria-modal="true" aria-label={`Reading ${book.title}`} style={{ '--reader-bg': colors.background, '--reader-fg': colors.foreground } as CSSProperties}>
    <header className="avid-reader-header">
      <button className="reader-icon" aria-label="Close reader" onClick={onClose}><ArrowLeft size={20} /></button>
      <div className="reader-heading"><span>{book.title}</span><small>{book.authors.join(', ')}</small></div>
      <div className="reader-toolbar">
        <button className={`reader-icon ${panel === 'contents' ? 'active' : ''}`} aria-label="Table of contents" title="Contents" onClick={() => togglePanel('contents')}><List size={20} /></button>
        <button className={`reader-icon ${panel === 'search' ? 'active' : ''}`} aria-label="Search in book" title="Search" onClick={() => togglePanel('search')}><Search size={19} /></button>
        <button className={`reader-icon ${panel === 'notes' ? 'active' : ''}`} aria-label="Highlights and notes" title="Notebook" onClick={() => togglePanel('notes')}><Bookmark size={19} /></button>
        {kind === 'epub' && <button className={`reader-icon ${speaking ? 'active' : ''}`} aria-label={speaking ? 'Stop reading aloud' : 'Read aloud'} title="Read aloud" disabled={!ready} onClick={() => speaking ? engine.current?.stopSpeaking?.() : engine.current?.speak?.()}>{speaking ? <Square size={18} /> : <Volume2 size={20} />}</button>}
        <button className={`reader-icon ${panel === 'settings' ? 'active' : ''}`} aria-label="Reading settings" title="Appearance" onClick={() => togglePanel('settings')}><Settings2 size={20} /></button>
      </div>
    </header>
    <div className="avid-reader-body">
      {panel && <aside className="reader-panel"><div className="reader-panel-title"><h2>{panel === 'contents' ? 'Contents' : panel === 'settings' ? 'Make it yours' : panel === 'notes' ? 'Your notebook' : 'Find in book'}</h2><button className="reader-icon" aria-label="Close panel" onClick={() => setPanel(null)}><X size={18} /></button></div>
        {panel === 'contents' && <nav className="reader-toc" aria-label="Chapters"><Contents items={toc} go={locator => { engine.current?.goTo(locator); setPanel(null); }} />{!toc.length && <p className="reader-muted">Contents will appear when your book opens.</p>}</nav>}
        {panel === 'search' && <><form className="reader-search" onSubmit={event => { event.preventDefault(); void runSearch(); }}><input autoFocus placeholder={kind === 'comic' ? 'Search page names…' : 'A word or a passage…'} value={query} onChange={event => setQuery(event.target.value)} /><button className="reader-icon" aria-label="Run search" disabled={searching}><Search size={18} /></button></form><p className="reader-muted">{searching ? 'Searching your book…' : `${results.length} matches`}</p>{results.map((result, index) => <button className="reader-result" key={`${result.locator}-${index}`} onClick={() => engine.current?.goTo(result.locator)}><small>{result.label}</small><span>{result.excerpt}</span></button>)}</>}
        {panel === 'notes' && <><label className="reader-field">Search your notes<input placeholder="A thought worth keeping…" value={query} onChange={event => setQuery(event.target.value)} /></label>
          <div className="reader-note-editor"><small>{editing ? 'EDIT NOTE' : selected ? 'SELECTED PASSAGE' : 'A NOTE AT THIS LOCATION'}</small>{selected && <blockquote>{selected.quote.slice(0, 200)}</blockquote>}<textarea aria-label="Note text" placeholder="What are you thinking?" value={noteText} onChange={event => setNoteText(event.target.value)} /><div className="reader-note-actions"><div className="reader-swatches">{['#d6b96e', '#9ebda1', '#8caebe', '#c8a0b5'].map(color => <button key={color} title={`Highlight ${color}`} aria-label={`Highlight color ${color}`} className={noteColor === color ? 'chosen' : ''} style={{ background: color }} onClick={() => setNoteColor(color)} />)}</div><button className="reader-primary" disabled={!location.locator || !noteText.trim()} onClick={() => saveAnnotation(true)}>Save note</button></div></div>
          {notes.filter(annotation => `${annotation.quote} ${annotation.text}`.toLowerCase().includes(query.toLowerCase())).map(annotation => <article className="reader-note" key={annotation.id}><button className="reader-note-quote" style={{ borderColor: annotation.color }} onClick={() => engine.current?.goTo(annotation.locator)}>{annotation.quote || 'Saved location'}</button>{annotation.text && <p>{annotation.text}</p>}<div><button onClick={() => { setEditing(annotation); setNoteText(annotation.text); setNoteColor(annotation.color); }}>Edit</button><button onClick={() => onAnnotation({ ...annotation, deleted: true, updatedAt: new Date().toISOString() })}>Delete</button></div></article>)}{!notes.length && <p className="reader-muted">Select a passage to highlight it, or leave a note at your current location.</p>}</>}
        {panel === 'settings' && <div className="reader-settings">
          <label className="reader-setting-label">Page color</label><div className="reader-theme-options">{(['light', 'warm', 'dark', 'custom'] as const).map(theme => <button className={`${theme} ${settings.theme === theme ? 'chosen' : ''}`} key={theme} onClick={() => change('theme', theme)}>{theme === 'light' ? 'Paper' : theme === 'warm' ? 'Sepia' : theme === 'dark' ? 'Night' : 'Custom'}</button>)}</div>
          {settings.theme === 'custom' && <div className="reader-two-fields"><label>Page<input type="color" value={settings.background} onChange={event => change('background', event.target.value)} /></label><label>Text<input type="color" value={settings.foreground} onChange={event => change('foreground', event.target.value)} /></label></div>}
          {kind === 'epub' && <><label className="reader-field">Typeface<select value={settings.font} onChange={event => change('font', event.target.value)}>{['Literata', 'Georgia', 'Palatino', 'Arial', 'Verdana', ...fonts].map(font => <option key={font}>{font}</option>)}</select></label><label className="reader-import-font">Import a font<input type="file" accept=".woff,.woff2,.ttf,.otf" onChange={async event => { const file = event.target.files?.[0]; if (!file) return; try { const name = await importFont(file, scope); setFonts(storedFonts(scope).map(font => font.name)); change('font', name); } catch (error) { setError(error instanceof Error ? error.message : 'Font import failed.'); } }} /></label>
          <div className="reader-font-size"><span>Font size</span><button className="reader-icon" aria-label="Decrease font size" onClick={() => change('fontSize', Math.max(12, settings.fontSize - 1))}><Minus size={16} /></button><strong>{settings.fontSize}</strong><button className="reader-icon" aria-label="Increase font size" onClick={() => change('fontSize', Math.min(40, settings.fontSize + 1))}><Plus size={16} /></button></div>
          <label className="reader-field">Line spacing <span>{settings.lineHeight.toFixed(1)}</span><input type="range" min="1.2" max="2.4" step="0.1" value={settings.lineHeight} onChange={event => change('lineHeight', Number(event.target.value))} /></label><label className="reader-field">Margins<input type="range" min="2" max="22" value={settings.margin} onChange={event => change('margin', Number(event.target.value))} /></label>
          <label className="reader-field">Page flow<select value={settings.flow} onChange={event => change('flow', event.target.value as ReaderSettings['flow'])}><option value="paginated">Turn pages</option><option value="scrolled">Continuous scroll</option></select></label>
          <label className="reader-field">Installed voice<select value={settings.voice} onChange={event => change('voice', event.target.value)}><option value="">System default</option>{voices.map(voice => <option key={voice.voiceURI} value={voice.voiceURI}>{voice.name} · {voice.lang}</option>)}</select></label><label className="reader-field">Speech speed · {settings.speechRate.toFixed(1)}×<input type="range" min="0.5" max="2" step="0.1" value={settings.speechRate} onChange={event => change('speechRate', Number(event.target.value))} /></label><p className="reader-muted">Word tracking follows timing supplied by your installed voice. Some browser voices do not provide word timing.</p></>}
          {kind === 'comic' && <><label className="reader-field">Reading layout<select value={settings.comicMode} onChange={event => change('comicMode', event.target.value as ReaderSettings['comicMode'])}><option value="paged">One page</option><option value="spread">Two page spread</option><option value="webtoon">Webtoon scroll</option></select></label><label className="reader-field">Direction<select value={settings.direction} onChange={event => change('direction', event.target.value as ReaderSettings['direction'])}><option value="ltr">Left to right</option><option value="rtl">Right to left</option></select></label></>}
          {kind === 'pdf' && <div className="reader-two-fields"><button className="reader-primary" onClick={() => engine.current?.autoCrop?.()}>Detect margins</button><button className="reader-secondary" onClick={() => engine.current?.resetCrop?.()}>Reset crop</button></div>}
          <label className="reader-field">Page turn<select value={settings.animation} onChange={event => change('animation', event.target.value as ReaderSettings['animation'])}><option value="none">None</option><option value="slide">Slide</option><option value="fade">Fade</option><option value="fast-fade">Fast fade</option></select></label><p className="reader-muted">Your reading preferences stay with this account on this device.</p>
        </div>}
      </aside>}
      <div className={`reader-stage ${flash ? 'turning' : ''}`}>
        {error ? <div className="reader-error" role="alert"><BookOpen size={32} /><h2>We couldn’t open this page</h2><p>{error}</p><button className="reader-primary" onClick={() => setError('')}>Dismiss</button><button className="reader-secondary" onClick={onClose}>Back to library</button></div> : <>{kind === 'epub' ? <EbookView {...engineProps} /> : kind === 'pdf' ? <PdfView {...engineProps} /> : <ComicView {...engineProps} />}{!ready && <div className="reader-opening"><span className="reader-spinner" />Opening your book…</div>}</>}
      </div>
      {selected && panel !== 'notes' && <div className="reader-selection-tools"><button onClick={() => saveAnnotation(false)}><Highlighter size={16} /> Highlight</button><button onClick={() => { setPanel('notes'); setNoteText(''); setEditing(undefined); }}><Bookmark size={16} /> Add note</button><button aria-label="Dismiss selection" onClick={() => setSelected(undefined)}><X size={16} /></button></div>}
    </div>
    {media.available && <div className="reader-media-bar"><span><Volume2 size={16} /> Aligned narration</span><button className="reader-icon" aria-label="Previous narration passage" onClick={() => engine.current?.mediaPrevious?.()}><ChevronLeft size={18} /></button><button className="reader-primary" onClick={() => media.playing ? engine.current?.pauseMedia?.() : engine.current?.playMedia?.()}>{media.playing ? 'Pause narration' : 'Read & listen'}</button><button className="reader-icon" aria-label="Next narration passage" onClick={() => engine.current?.mediaNext?.()}><ChevronRight size={18} /></button><time>{Math.floor(media.seconds / 60)}:{String(Math.floor(media.seconds % 60)).padStart(2, '0')}</time><label><input type="checkbox" checked={followMedia} onChange={event => { setFollowMedia(event.target.checked); engine.current?.setMediaFollow?.(event.target.checked); }} /> Follow text</label><select aria-label="Narration speed" value={mediaRate} onChange={event => { const rate = Number(event.target.value); setMediaRate(rate); engine.current?.setMediaRate?.(rate); }}>{[.75, 1, 1.25, 1.5, 1.75, 2].map(rate => <option key={rate} value={rate}>{rate}×</option>)}</select></div>}
    <footer className="avid-reader-footer"><span className="reader-chapter-label">{location.label}</span><div className="reader-page-controls"><button className="reader-icon" disabled={!ready} aria-label="Previous page" onClick={() => turn('prev')}><ChevronLeft size={19} /></button><span>{Math.round(location.progress * 100)}%</span><button className="reader-icon" disabled={!ready} aria-label="Next page" onClick={() => turn('next')}><ChevronRight size={19} /></button></div><span className="reader-footer-brand">avid <span>·</span> {file.format}</span><div className="reader-progress"><span style={{ width: `${location.progress * 100}%` }} /></div></footer>
  </section>;
}
function Contents({ items, go }: { items: TocItem[]; go: (locator: string | number) => void }) {
  return <ol>{items.map((item, index) => <li key={`${item.href}-${index}`}><button onClick={() => go(item.href)}>{item.label || `Chapter ${index + 1}`}</button>{item.subitems && <Contents items={item.subitems} go={go} />}</li>)}</ol>;
}
