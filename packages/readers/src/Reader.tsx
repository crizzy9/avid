import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  ArrowLeft,
  BookOpen,
  Bookmark,
  ChevronLeft,
  ChevronRight,
  Highlighter,
  List,
  Minus,
  Plus,
  Search,
  Settings2,
  Square,
  Volume2,
  X,
} from "lucide-react";
import { EbookView } from "./EbookView";
import { PdfView } from "./PdfView";
import { ComicView } from "./ComicView";
import {
  defaultSettings,
  themeColors,
  type Annotation,
  type EngineHandle,
  type ReaderProps,
  type ReaderSettings,
  type ReaderPreferenceValues,
  type ReaderPageInfo,
  type ReadingAnchor,
  type SearchResult,
  type SelectionAnchor,
  type TocItem,
} from "./contracts";
import { importFont, storedFonts } from "./fonts";
import { parsePageAnchor } from "./anchors";
import { useReaderI18n, readerError } from "./readerI18n";
import {
  speechProvider,
  type InstalledVoice,
} from "../../playback/src/speechRuntime";
import { prefersReducedMotion, useReducedMotion } from "./reducedMotion";
import { bindReadingTap } from "./readerChrome";
import {
  getComicDirectionMode,
  setComicDirectionMode,
  getMangaRule,
  setMangaRule,
  resolveComicDirection,
  type ComicDirectionMode,
  type MangaRule,
  type MangaRuleField,
} from "./comicDirection";
import "./reader.css";
export type { ReaderProps } from "./contracts";
const settingsKey = (scope: string, fileId?: string) =>
  fileId
    ? `avid.reader.settings.v2.${encodeURIComponent(scope)}.${encodeURIComponent(fileId)}`
    : `avid.reader.settings.v1.${encodeURIComponent(scope)}`;
function getSettings(scope: string, fileId: string): ReaderSettings {
  try {
    return {
      ...defaultSettings,
      ...JSON.parse(
        localStorage.getItem(settingsKey(scope, fileId)) ??
          localStorage.getItem(settingsKey(scope)) ??
          "{}",
      ),
    };
  } catch {
    return defaultSettings;
  }
}
export function Reader(props: ReaderProps) {
  const { t, locale } = useReaderI18n();
  const reducedMotion = useReducedMotion();
  const { book, annotations, onClose, onAnnotation } = props;
  const file = props.file ??
    book.files.find((item) => item.format !== "AUDIO") ?? {
      id: `${book.id}-text`,
      name: book.title,
      format: book.format,
    };
  const scope = props.accountScope ?? "local";
  const settingsIdentity = settingsKey(scope, file.id);
  const [storedSettings, setSettings] = useState(() =>
    getSettings(scope, file.id),
  );
  const touchedPreferences = useRef(new Set<keyof ReaderPreferenceValues>());
  const preferenceOwner = useRef({
    identity: settingsIdentity,
    port: props.preferences,
  });
  preferenceOwner.current = {
    identity: settingsIdentity,
    port: props.preferences,
  };
  const [, refreshComicPreferences] = useState(0);
  const comicDirectionMode = getComicDirectionMode(
    localStorage,
    scope,
    book.id,
  );
  const mangaRule = getMangaRule(localStorage, scope);
  // The old account-global direction is deliberately ignored for comics. Automatic
  // classification and explicit direction are evaluated for this title only.
  const direction = resolveComicDirection(book, comicDirectionMode, mangaRule);
  const settings = useMemo(
    () => ({ ...storedSettings, direction }),
    [storedSettings, direction],
  );
  const updateMangaRule = (rule: MangaRule) => {
    try {
      setMangaRule(localStorage, scope, rule);
      refreshComicPreferences((value) => value + 1);
    } catch (error) {
      setNotice(readerError(error, "preferenceSaveFailed"));
    }
  };
  const changeComicDirection = (mode: ComicDirectionMode) => {
    try {
      setComicDirectionMode(localStorage, scope, book.id, mode);
      refreshComicPreferences((value) => value + 1);
      persistPreference({ comicDirection: mode });
    } catch (error) {
      setNotice(readerError(error, "preferenceSaveFailed"));
    }
  };
  const [settingsAccount, setSettingsAccount] = useState(settingsIdentity);
  const dialog = useRef<HTMLDialogElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const runningHeading = useRef<HTMLButtonElement>(null);
  const [controls, setControls] = useState(false);
  const [panel, setPanel] = useState<
    "contents" | "settings" | "search" | "notes" | null
  >(null);
  const [toc, setToc] = useState<TocItem[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [location, setLocation] = useState<{
    locator: string;
    progress: number;
    label: string;
    pageInfo?: ReaderPageInfo;
  }>({
    locator: props.initialAnchor?.locator || "",
    progress: props.initialAnchor?.progress ?? book.progress,
    label: "",
  });
  const [selected, setSelected] = useState<SelectionAnchor>();
  const [speaking, setSpeaking] = useState(false);
  const [media, setMedia] = useState({
    available: false,
    playing: false,
    seconds: 0,
  });
  const [followMedia, setFollowMedia] = useState(true);
  const [mediaRate, setMediaRate] = useState(1);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const draftKey = `avid.reader.note-draft.${encodeURIComponent(scope)}.${book.id}.${file.id}`;
  const [noteText, setNoteText] = useState(
    () => sessionStorage.getItem(draftKey) || "",
  );
  const [noteDraftKey, setNoteDraftKey] = useState(draftKey);
  const [noteColor, setNoteColor] = useState("#d6b96e");
  const [editing, setEditing] = useState<Annotation>();
  const [voices, setVoices] = useState<InstalledVoice[]>([]);
  const [fonts, setFonts] = useState(() =>
    storedFonts(scope).map((font) => font.name),
  );
  const [flash, setFlash] = useState(false);
  const flashTimer = useRef<number | undefined>(undefined);
  const engine = useRef<EngineHandle | undefined>(undefined);
  const embeddedNarration = useRef<{ pauseNarration: () => void } | null>(null);
  const activeLocation = useRef(location);
  activeLocation.current = location;
  const callbacks = useRef(props);
  callbacks.current = props;
  const pauseEmbeddedNarration = useCallback(() => {
    if (embeddedNarration.current) embeddedNarration.current.pauseNarration();
    else {
      engine.current?.pauseMedia?.();
      engine.current?.stopSpeaking?.();
    }
  }, []);
  useEffect(() => {
    if (props.externalNarration) pauseEmbeddedNarration();
  }, [props.externalNarration, pauseEmbeddedNarration]);
  const kind =
    file.format === "PDF"
      ? "pdf"
      : ["CBZ", "CBR", "CB7"].includes(file.format)
        ? "comic"
        : "epub";
  const notes = annotations.filter(
    (annotation) =>
      annotation.bookId === book.id &&
      annotation.fileId === file.id &&
      !annotation.deleted,
  );
  const colors = themeColors(settings);
  const persistAnchor = useCallback(
    (
      locator: string,
      progress: number,
      label: string,
      pageInfo?: ReaderPageInfo,
      options?: { persist: false },
    ) => {
      setLocation({ locator, progress, label, pageInfo });
      const anchor: ReadingAnchor = {
        bookId: book.id,
        fileId: file.id,
        kind,
        locator,
        progress,
        updatedAt: new Date().toISOString(),
      };
      if (
        callbacks.current.persistProgress === false ||
        options?.persist === false
      )
        callbacks.current.onPreviewAnchor?.(anchor);
      else callbacks.current.onAnchor(anchor);
    },
    [book.id, file.id, kind],
  );
  useEffect(() => {
    if (settingsAccount !== settingsIdentity) {
      setSettings(getSettings(scope, file.id));
      setFonts(storedFonts(scope).map((font) => font.name));
      setSettingsAccount(settingsIdentity);
    }
  }, [scope, file.id, settingsIdentity, settingsAccount]);
  useEffect(() => {
    if (settingsAccount === settingsIdentity) {
      const { direction: _direction, ...preferences } = storedSettings;
      try {
        localStorage.setItem(settingsIdentity, JSON.stringify(preferences));
      } catch (error) {
        setNotice(readerError(error, "preferenceSaveFailed"));
      }
    }
  }, [storedSettings, settingsIdentity, settingsAccount]);
  useEffect(() => {
    const port = props.preferences;
    touchedPreferences.current = new Set();
    if (!port) return;
    let active = true;
    void port
      .load()
      .then((values) => {
        if (
          !active ||
          preferenceOwner.current.identity !== settingsIdentity ||
          preferenceOwner.current.port !== port
        )
          return;
        const available = Object.fromEntries(
          Object.entries(values).filter(
            ([key]) =>
              !touchedPreferences.current.has(
                key as keyof ReaderPreferenceValues,
              ),
          ),
        ) as ReaderPreferenceValues;
        const { comicDirection, ...settings } = available;
        if (comicDirection) {
          setComicDirectionMode(localStorage, scope, book.id, comicDirection);
          refreshComicPreferences((value) => value + 1);
        }
        setSettings((previous) => ({ ...previous, ...settings }));
      })
      .catch((error) => {
        if (
          active &&
          preferenceOwner.current.identity === settingsIdentity &&
          preferenceOwner.current.port === port
        )
          setNotice(readerError(error, "preferenceLoadFailed"));
      });
    return () => {
      active = false;
    };
  }, [props.preferences, settingsIdentity]);
  function persistPreference(values: ReaderPreferenceValues) {
    for (const key of Object.keys(values))
      touchedPreferences.current.add(key as keyof ReaderPreferenceValues);
    const port = props.preferences;
    if (!port) return;
    void port.patch(values).catch((error) => {
      if (
        preferenceOwner.current.identity === settingsIdentity &&
        preferenceOwner.current.port === port
      )
        setNotice(readerError(error, "preferenceSaveFailed"));
    });
  }
  useEffect(() => {
    const element = dialog.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const overflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    element?.showModal();
    element?.focus();
    return () => {
      element?.close();
      document.documentElement.style.overflow = overflow;
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, []);
  useEffect(() => {
    if (noteDraftKey !== draftKey) {
      setNoteText(sessionStorage.getItem(draftKey) || "");
      setNoteDraftKey(draftKey);
      setEditing(undefined);
    }
  }, [draftKey, noteDraftKey]);
  useEffect(() => {
    if (noteDraftKey === draftKey) {
      if (noteText) sessionStorage.setItem(draftKey, noteText);
      else sessionStorage.removeItem(draftKey);
    }
  }, [noteText, draftKey, noteDraftKey]);
  useEffect(() => {
    let active = true;
    const provider = speechProvider();
    const update = () => {
      void provider
        .voices()
        .then((voices) => {
          if (active) setVoices(voices);
        })
        .catch(() => {
          if (active) setVoices([]);
        });
    };
    update();
    const unsubscribe = provider.subscribeVoices(update);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  useEffect(() => {
    if (reducedMotion) {
      window.clearTimeout(flashTimer.current);
      setFlash(false);
    }
    return () => window.clearTimeout(flashTimer.current);
  }, [reducedMotion]);
  const turn = useCallback(
    (direction: "next" | "prev") => {
      window.clearTimeout(flashTimer.current);
      const continuous =
        kind === "comic"
          ? settings.comicMode === "webtoon"
          : kind === "epub" && settings.flow === "scrolled";
      if (
        !continuous &&
        ["fade", "fast-fade"].includes(settings.animation) &&
        !prefersReducedMotion()
      ) {
        setFlash(true);
        flashTimer.current = window.setTimeout(
          () => setFlash(false),
          settings.animation === "fade" ? 250 : 100,
        );
      } else setFlash(false);
      engine.current?.[direction]();
    },
    [settings.animation, settings.comicMode, settings.flow, kind],
  );
  const controlsVisible = controls || panel !== null || Boolean(error);
  const toggleControls = useCallback(() => {
    if (selected || (kind === "epub" && engine.current?.selection()?.quote))
      return;
    setControls((previous) => !previous);
    setPanel(null);
  }, [selected, kind]);
  const escape = useCallback(() => {
    if (panel) {
      setPanel(null);
      setControls(true);
      runningHeading.current?.focus();
    } else if (!controlsVisible) {
      setControls(true);
      runningHeading.current?.focus();
    } else onClose();
  }, [panel, controlsVisible, onClose]);
  useEffect(() => {
    if (!stage.current) return;
    return bindReadingTap(stage.current, toggleControls);
  }, [toggleControls]);
  useEffect(() => {
    if (!controls || panel || selected || error || !ready) return;
    const timer = window.setTimeout(() => {
      // Never remove controls from under a keyboard or assistive-technology user.
      if (!dialog.current?.querySelector("[data-reader-controls]:focus-within"))
        setControls(false);
    }, 4000);
    return () => window.clearTimeout(timer);
  }, [controls, panel, selected, error, ready]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      )
        return;
      if (event.key === "Escape") {
        event.preventDefault();
        escape();
        return;
      }
      if (
        (event.target as HTMLElement).closest(
          "input,textarea,select,[contenteditable]",
        )
      )
        return;
      if (event.key === "ArrowRight") {
        event.preventDefault();
        turn(
          settings.direction === "rtl" && kind === "comic" ? "prev" : "next",
        );
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        turn(
          settings.direction === "rtl" && kind === "comic" ? "next" : "prev",
        );
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [turn, escape, kind, settings.direction]);
  useEffect(() => {
    callbacks.current.onActivity?.(
      media.playing ? "listening" : speaking ? "speech" : "reading",
    );
  }, [media.playing, speaking]);
  const change = <K extends keyof ReaderSettings>(
    key: K,
    value: ReaderSettings[K],
  ) => {
    setSettings((previous) => ({ ...previous, [key]: value }));
    persistPreference({ [key]: value });
  };
  const saveAnnotation = (note: boolean) => {
    if (props.annotationsEnabled === false) return;
    const selection = selected ??
      engine.current?.selection() ?? {
        quote: location.label,
        locator: location.locator,
      };
    if (!selection.locator) return;
    const now = new Date().toISOString();
    onAnnotation({
      id: editing?.id ?? crypto.randomUUID(),
      bookId: book.id,
      fileId: file.id,
      kind: note ? "note" : "highlight",
      quote: editing?.quote ?? selection.quote,
      text: note ? noteText : "",
      color: noteColor,
      locator: editing?.locator ?? selection.locator,
      createdAt: editing?.createdAt ?? now,
      updatedAt: now,
    });
    setSelected(undefined);
    setNoteText("");
    setEditing(undefined);
    setPanel("notes");
  };
  const runSearch = async () => {
    if (!query.trim() || !engine.current) return;
    setSearching(true);
    setResults([]);
    try {
      setResults(await engine.current.search(query.trim()));
    } catch (error) {
      setNotice(readerError(error, "searchFailed"));
    } finally {
      setSearching(false);
    }
  };
  const engineProps = {
    ...props,
    file,
    settings,
    onAlignmentReady: (
      handle: Parameters<NonNullable<ReaderProps["onAlignmentReady"]>>[0],
    ) => {
      embeddedNarration.current = handle;
      if (handle && callbacks.current.externalNarration)
        pauseEmbeddedNarration();
      callbacks.current.onAlignmentReady?.(handle);
    },
    onReady: (handle: EngineHandle, entries: TocItem[]) => {
      engine.current = handle;
      if (callbacks.current.externalNarration) pauseEmbeddedNarration();
      setToc(entries);
      setReady(true);
    },
    onLocation: persistAnchor,
    onReadingTap: toggleControls,
    onReadingEscape: escape,
    onError: setError,
    onNotice: setNotice,
    onSelection: setSelected,
    onSpeaking: setSpeaking,
    onMediaState: setMedia,
  };
  const locationLabel = !ready
    ? t("opening")
    : kind === "epub" || !toc.length
      ? location.label
      : t("pageOf", {
          number: parsePageAnchor(location.locator, toc.length).page,
          count: toc.length,
        });
  const pageInfo = location.pageInfo;
  const pageLabel = !ready
    ? t("opening")
    : kind !== "epub"
      ? locationLabel
      : pageInfo?.pageNumber && pageInfo.pageCount
        ? t("pageOf", {
            number: pageInfo.pageNumber,
            count: pageInfo.pageCount,
          })
        : pageInfo?.pageLabel
          ? t("page", { number: pageInfo.pageLabel })
          : t("progressPercent", {
              percent: Math.round(location.progress * 100),
            });
  const togglePanel = (name: typeof panel) =>
    setPanel((previous) => (previous === name ? null : name));
  return (
    <dialog
      ref={dialog}
      onCancel={(event) => {
        event.preventDefault();
        escape();
      }}
      className={`avid-reader theme-${settings.theme}`}
      data-controls-visible={controlsVisible}
      data-reduced-motion={reducedMotion}
      role="dialog"
      aria-modal="true"
      lang={locale}
      aria-label={t("readingTitle", { title: book.title })}
      style={
        {
          "--reader-bg": colors.background,
          "--reader-fg": colors.foreground,
        } as CSSProperties
      }
    >
      <button
        ref={runningHeading}
        className="reader-running-heading"
        aria-label={t(controlsVisible ? "hideControls" : "showControls")}
        aria-expanded={controlsVisible}
        aria-controls="reader-controls"
        onClick={() => {
          setControls(!controlsVisible);
          setPanel(null);
        }}
      >
        <span>{book.title}</span>
        <small>{kind === "epub" && ready ? location.label : ""}</small>
      </button>
      <header
        id="reader-controls"
        className="avid-reader-header"
        data-reader-controls
        hidden={!controlsVisible}
      >
        <button
          className="reader-icon"
          aria-label={t("closeReader")}
          onClick={onClose}
        >
          <ArrowLeft size={20} />
        </button>
        <div className="reader-heading">
          <span>{book.title}</span>
          <small>{book.authors.join(", ")}</small>
        </div>
        <div className="reader-toolbar">
          <button
            className={`reader-icon ${panel === "contents" ? "active" : ""}`}
            aria-expanded={panel === "contents"}
            aria-controls="reader-panel"
            aria-label={t("tableOfContents")}
            title={t("contents")}
            onClick={() => togglePanel("contents")}
          >
            <List size={20} />
          </button>
          <button
            className={`reader-icon ${panel === "search" ? "active" : ""}`}
            aria-expanded={panel === "search"}
            aria-controls="reader-panel"
            aria-label={t("searchBook")}
            title={t("search")}
            onClick={() => togglePanel("search")}
          >
            <Search size={19} />
          </button>
          {props.annotationsEnabled !== false && <button
            className={`reader-icon ${panel === "notes" ? "active" : ""}`}
            aria-expanded={panel === "notes"}
            aria-controls="reader-panel"
            aria-label={t("highlightsNotes")}
            title={t("notebook")}
            onClick={() => togglePanel("notes")}
          >
            <Bookmark size={19} />
          </button>}
          {kind === "epub" && !props.externalNarration && (
            <button
              className={`reader-icon ${speaking ? "active" : ""}`}
              aria-label={speaking ? t("stopReading") : t("readAloud")}
              title={t("readAloud")}
              disabled={!ready}
              onClick={() =>
                speaking
                  ? engine.current?.stopSpeaking?.()
                  : engine.current?.speak?.()
              }
            >
              {speaking ? <Square size={18} /> : <Volume2 size={20} />}
            </button>
          )}
          <button
            className={`reader-icon ${panel === "settings" ? "active" : ""}`}
            aria-expanded={panel === "settings"}
            aria-controls="reader-panel"
            aria-label={t("readingSettings")}
            title={t("appearance")}
            onClick={() => togglePanel("settings")}
          >
            <Settings2 size={20} />
          </button>
        </div>
      </header>
      {notice && (
        <div className="reader-notice" role="alert">
          <span>{notice}</span>
          <button
            className="reader-icon"
            aria-label={t("dismissMessage")}
            onClick={() => setNotice("")}
          >
            <X size={16} />
          </button>
        </div>
      )}
      <div className="avid-reader-body">
        {panel && (
          <aside id="reader-panel" className="reader-panel">
            <div className="reader-panel-title">
              <h2>
                {t(
                  panel === "contents"
                    ? "contents"
                    : panel === "settings"
                      ? "makeYours"
                      : panel === "notes"
                        ? "yourNotebook"
                        : "findBook",
                )}
              </h2>
              <button
                className="reader-icon"
                aria-label={t("closePanel")}
                onClick={() => setPanel(null)}
              >
                <X size={18} />
              </button>
            </div>
            {panel === "contents" && (
              <nav className="reader-toc" aria-label={t("chapters")}>
                <Contents
                  items={toc}
                  go={(locator) => {
                    engine.current?.goTo(locator);
                    setPanel(null);
                  }}
                />
                {!toc.length && (
                  <p className="reader-muted">{t("contentsHint")}</p>
                )}
              </nav>
            )}
            {panel === "search" && (
              <>
                <form
                  className="reader-search"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void runSearch();
                  }}
                >
                  <input
                    autoFocus
                    aria-label={t(
                      kind === "comic" ? "searchPages" : "searchPassage",
                    )}
                    placeholder={t(
                      kind === "comic" ? "searchPages" : "searchPassage",
                    )}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                  <button
                    className="reader-icon"
                    aria-label={t("runSearch")}
                    disabled={searching}
                  >
                    <Search size={18} />
                  </button>
                </form>
                <p className="reader-muted">
                  {searching
                    ? t("searching")
                    : t("matches", { count: results.length })}
                </p>
                {results.map((result, index) => (
                  <button
                    className="reader-result"
                    key={`${result.locator}-${index}`}
                    onClick={() => engine.current?.goTo(result.locator)}
                  >
                    <small>
                      {result.pageNumber
                        ? t("page", { number: result.pageNumber })
                        : result.label}
                    </small>
                    <span>{result.excerpt}</span>
                  </button>
                ))}
              </>
            )}
            {panel === "notes" && props.annotationsEnabled !== false && (
              <>
                <label className="reader-field">
                  {t("searchNotes")}
                  <input
                    placeholder={t("thoughtPlaceholder")}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </label>
                <div className="reader-note-editor">
                  <small>
                    {t(
                      editing
                        ? "editNote"
                        : selected
                          ? "selectedPassage"
                          : "noteAtLocation",
                    )}
                  </small>
                  {selected && (
                    <blockquote>{selected.quote.slice(0, 200)}</blockquote>
                  )}
                  <textarea
                    aria-label={t("noteText")}
                    placeholder={t("notePlaceholder")}
                    value={noteText}
                    onChange={(event) => setNoteText(event.target.value)}
                  />
                  <div className="reader-note-actions">
                    <div className="reader-swatches">
                      {["#d6b96e", "#9ebda1", "#8caebe", "#c8a0b5"].map(
                        (color) => (
                          <button
                            key={color}
                            title={t("highlightColor", { color })}
                            aria-label={t("highlightColor", { color })}
                            aria-pressed={noteColor === color}
                            className={noteColor === color ? "chosen" : ""}
                            style={{ background: color }}
                            onClick={() => setNoteColor(color)}
                          />
                        ),
                      )}
                    </div>
                    <button
                      className="reader-primary"
                      disabled={!location.locator || !noteText.trim()}
                      onClick={() => saveAnnotation(true)}
                    >
                      {t("saveNote")}
                    </button>
                  </div>
                </div>
                {notes
                  .filter((annotation) =>
                    `${annotation.quote} ${annotation.text}`
                      .toLowerCase()
                      .includes(query.toLowerCase()),
                  )
                  .map((annotation) => (
                    <article className="reader-note" key={annotation.id}>
                      <button
                        className="reader-note-quote"
                        style={{ borderColor: annotation.color }}
                        onClick={() => engine.current?.goTo(annotation.locator)}
                      >
                        {annotation.quote || t("savedLocation")}
                      </button>
                      {annotation.text && <p>{annotation.text}</p>}
                      <div>
                        <button
                          onClick={() => {
                            setEditing(annotation);
                            setNoteText(annotation.text);
                            setNoteColor(annotation.color);
                          }}
                        >
                          {t("edit")}
                        </button>
                        <button
                          onClick={() =>
                            onAnnotation({
                              ...annotation,
                              deleted: true,
                              updatedAt: new Date().toISOString(),
                            })
                          }
                        >
                          {t("delete")}
                        </button>
                      </div>
                    </article>
                  ))}
                {!notes.length && (
                  <p className="reader-muted">{t("noNotes")}</p>
                )}
              </>
            )}
            {panel === "settings" && (
              <div className="reader-settings">
                <label className="reader-setting-label">{t("pageColor")}</label>
                <div className="reader-theme-options">
                  {(["light", "warm", "dark", "custom"] as const).map(
                    (theme) => (
                      <button
                        className={`${theme} ${settings.theme === theme ? "chosen" : ""}`}
                        key={theme}
                        aria-pressed={settings.theme === theme}
                        onClick={() => change("theme", theme)}
                      >
                        {t(
                          theme === "light"
                            ? "paper"
                            : theme === "warm"
                              ? "sepia"
                              : theme === "dark"
                                ? "night"
                                : "custom",
                        )}
                      </button>
                    ),
                  )}
                </div>
                {settings.theme === "custom" && (
                  <div className="reader-two-fields">
                    <label>
                      {t("pageBackground")}
                      <input
                        type="color"
                        value={settings.background}
                        onChange={(event) =>
                          change("background", event.target.value)
                        }
                      />
                    </label>
                    <label>
                      {t("textColor")}
                      <input
                        type="color"
                        value={settings.foreground}
                        onChange={(event) =>
                          change("foreground", event.target.value)
                        }
                      />
                    </label>
                  </div>
                )}
                {kind === "epub" && (
                  <>
                    <label className="reader-field">
                      {t("typeface")}
                      <select
                        value={settings.font}
                        onChange={(event) => change("font", event.target.value)}
                      >
                        {[
                          "Literata",
                          "Georgia",
                          "Palatino",
                          "Arial",
                          "Verdana",
                          ...fonts,
                        ].map((font) => (
                          <option key={font}>{font}</option>
                        ))}
                      </select>
                    </label>
                    <label className="reader-import-font">
                      {t("importFont")}
                      <input
                        type="file"
                        accept=".woff,.woff2,.ttf,.otf"
                        onChange={async (event) => {
                          const file = event.target.files?.[0];
                          if (!file) return;
                          try {
                            const name = await importFont(file, scope);
                            setFonts(
                              storedFonts(scope).map((font) => font.name),
                            );
                            change("font", name);
                          } catch (error) {
                            setNotice(readerError(error, "fontFailed"));
                          }
                        }}
                      />
                    </label>
                    <div className="reader-font-size">
                      <span>{t("fontSize")}</span>
                      <button
                        className="reader-icon"
                        aria-label={t("decreaseFont")}
                        onClick={() =>
                          change("fontSize", Math.max(6, settings.fontSize - 1))
                        }
                      >
                        <Minus size={16} />
                      </button>
                      <strong>{settings.fontSize}</strong>
                      <button
                        className="reader-icon"
                        aria-label={t("increaseFont")}
                        onClick={() =>
                          change(
                            "fontSize",
                            Math.min(40, settings.fontSize + 1),
                          )
                        }
                      >
                        <Plus size={16} />
                      </button>
                    </div>
                    <label className="reader-field">
                      {t("lineSpacing")}
                      <span>
                        {new Intl.NumberFormat(locale, {
                          minimumFractionDigits: 1,
                        }).format(settings.lineHeight)}
                      </span>
                      <input
                        type="range"
                        min="0.8"
                        max="3"
                        step="0.1"
                        value={settings.lineHeight}
                        onChange={(event) =>
                          change("lineHeight", Number(event.target.value))
                        }
                      />
                    </label>
                    <label className="reader-field">
                      {t("margins")}
                      <input
                        type="range"
                        min="0"
                        max="50"
                        value={settings.margin}
                        onChange={(event) =>
                          change("margin", Number(event.target.value))
                        }
                      />
                    </label>
                    <label className="reader-field">
                      {t("pageFlow")}
                      <select
                        value={settings.flow}
                        onChange={(event) =>
                          change(
                            "flow",
                            event.target.value as ReaderSettings["flow"],
                          )
                        }
                      >
                        <option value="paginated">{t("turnPages")}</option>
                        <option value="scrolled">{t("continuous")}</option>
                      </select>
                    </label>
                    <label className="reader-field">
                      {t("installedVoice")}
                      <select
                        value={settings.voice}
                        onChange={(event) =>
                          change("voice", event.target.value)
                        }
                      >
                        <option value="">{t("systemDefault")}</option>
                        {voices.map((voice) => (
                          <option key={voice.voiceURI} value={voice.voiceURI}>
                            {voice.name} · {voice.lang}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="reader-field">
                      {t("speechSpeed", { rate: settings.speechRate })}
                      <input
                        type="range"
                        min="0.5"
                        max="2"
                        step="0.1"
                        value={settings.speechRate}
                        onChange={(event) =>
                          change("speechRate", Number(event.target.value))
                        }
                      />
                    </label>
                    <p className="reader-muted">
                      {!voices.length && <>{t("noVoices")} </>}
                      {t("wordTimingHint")}
                    </p>
                  </>
                )}
                {kind === "comic" && (
                  <>
                    <label className="reader-field">
                      {t("readingLayout")}
                      <select
                        value={settings.comicMode}
                        onChange={(event) =>
                          change(
                            "comicMode",
                            event.target.value as ReaderSettings["comicMode"],
                          )
                        }
                      >
                        <option value="paged">{t("onePage")}</option>
                        <option value="spread">{t("twoPages")}</option>
                        <option value="webtoon">{t("webtoon")}</option>
                      </select>
                    </label>
                    <label className="reader-field">
                      {t("direction")}
                      <select
                        value={comicDirectionMode}
                        onChange={(event) =>
                          changeComicDirection(
                            event.target.value as ComicDirectionMode,
                          )
                        }
                      >
                        <option value="auto">{t("automaticDirection")}</option>
                        <option value="rtl">{t("mangaRtl")}</option>
                        <option value="ltr">{t("comicLtr")}</option>
                      </select>
                    </label>
                    <label className="reader-field">
                      {t("mangaKeywords")}
                      <input
                        defaultValue={mangaRule.keywords.join(", ")}
                        key={scope}
                        maxLength={8098}
                        onBlur={(event) =>
                          updateMangaRule({
                            ...mangaRule,
                            keywords: event.target.value.split(","),
                          })
                        }
                      />
                    </label>
                    <fieldset className="reader-manga-rule">
                      <legend>{t("matchMangaFields")}</legend>
                      {(["genres", "title", "series"] as MangaRuleField[]).map(
                        (field) => (
                          <label key={field}>
                            <input
                              type="checkbox"
                              checked={mangaRule.fields.includes(field)}
                              onChange={(event) =>
                                updateMangaRule({
                                  ...mangaRule,
                                  fields: event.target.checked
                                    ? [...mangaRule.fields, field]
                                    : mangaRule.fields.filter(
                                        (value) => value !== field,
                                      ),
                                })
                              }
                            />
                            {t(
                              field === "genres"
                                ? "genresField"
                                : field === "title"
                                  ? "titleField"
                                  : "seriesField",
                            )}
                          </label>
                        ),
                      )}
                    </fieldset>
                    <p className="reader-muted">{t("mangaRuleHint")}</p>
                  </>
                )}
                {kind === "pdf" && (
                  <div className="reader-two-fields">
                    <button
                      className="reader-primary"
                      onClick={() => engine.current?.autoCrop?.()}
                    >
                      {t("detectMargins")}
                    </button>
                    <button
                      className="reader-secondary"
                      onClick={() => engine.current?.resetCrop?.()}
                    >
                      {t("resetCrop")}
                    </button>
                  </div>
                )}
                <label className="reader-field">
                  {t("pageTurn")}
                  <select
                    value={settings.animation}
                    onChange={(event) =>
                      change(
                        "animation",
                        event.target.value as ReaderSettings["animation"],
                      )
                    }
                  >
                    <option value="none">{t("none")}</option>
                    <option value="slide">{t("slide")}</option>
                    <option value="fade">{t("fade")}</option>
                    <option value="fast-fade">{t("fastFade")}</option>
                  </select>
                </label>
                <p className="reader-muted">
                  {t(
                    props.preferences && !props.preferences.readOnly
                      ? "preferencesSyncHint"
                      : "preferencesHint",
                  )}
                </p>
              </div>
            )}
          </aside>
        )}
        <div
          ref={stage}
          className={`reader-stage ${flash && !reducedMotion ? "turning" : ""}`}
        >
          {error ? (
            <div className="reader-error" role="alert">
              <BookOpen size={32} />
              <h2>{t("cannotOpen")}</h2>
              <p>{error}</p>
              <button className="reader-primary" onClick={() => setError("")}>
                {t("dismiss")}
              </button>
              <button className="reader-secondary" onClick={onClose}>
                {t("backLibrary")}
              </button>
            </div>
          ) : (
            <>
              {kind === "epub" ? (
                <EbookView {...engineProps} />
              ) : kind === "pdf" ? (
                <PdfView {...engineProps} />
              ) : (
                <ComicView {...engineProps} />
              )}
              {!ready && (
                <div className="reader-opening">
                  <span className="reader-spinner" />
                  {t("opening")}
                </div>
              )}
            </>
          )}
        </div>
        {selected && panel !== "notes" && props.annotationsEnabled !== false && (
          <div className="reader-selection-tools">
            <button onClick={() => saveAnnotation(false)}>
              <Highlighter size={16} />
              {t("highlight")}
            </button>
            <button
              onClick={() => {
                setPanel("notes");
                setNoteText("");
                setEditing(undefined);
              }}
            >
              <Bookmark size={16} />
              {t("addNote")}
            </button>
            <button
              aria-label={t("dismissSelection")}
              onClick={() => setSelected(undefined)}
            >
              <X size={16} />
            </button>
          </div>
        )}
      </div>
      {media.available && !props.externalNarration && (
        <div className="reader-media-bar">
          <span>
            <Volume2 size={16} />
            {t("alignedNarration")}
          </span>
          <button
            className="reader-icon"
            aria-label={t("previousPassage")}
            onClick={() => engine.current?.mediaPrevious?.()}
          >
            <ChevronLeft size={18} />
          </button>
          <button
            className="reader-primary"
            onClick={() =>
              media.playing
                ? engine.current?.pauseMedia?.()
                : engine.current?.playMedia?.()
            }
          >
            {t(media.playing ? "pauseNarration" : "readListen")}
          </button>
          <button
            className="reader-icon"
            aria-label={t("nextPassage")}
            onClick={() => engine.current?.mediaNext?.()}
          >
            <ChevronRight size={18} />
          </button>
          <time>
            {Math.floor(media.seconds / 60)}:
            {String(Math.floor(media.seconds % 60)).padStart(2, "0")}
          </time>
          <label>
            <input
              type="checkbox"
              checked={followMedia}
              onChange={(event) => {
                setFollowMedia(event.target.checked);
                engine.current?.setMediaFollow?.(event.target.checked);
              }}
            />
            {t("followText")}
          </label>
          <select
            aria-label={t("narrationSpeed")}
            value={mediaRate}
            onChange={(event) => {
              const rate = Number(event.target.value);
              setMediaRate(rate);
              engine.current?.setMediaRate?.(rate);
            }}
          >
            {[0.75, 1, 1.25, 1.5, 1.75, 2].map((rate) => (
              <option key={rate} value={rate}>
                {new Intl.NumberFormat(locale).format(rate)}×
              </option>
            ))}
          </select>
        </div>
      )}
      {props.modeControls && (
        <div className="reader-media-bar">{props.modeControls}</div>
      )}
      <footer className="avid-reader-footer">
        <span className="reader-page-label">{pageLabel}</span>
        <span className="reader-section-remaining">
          {ready && pageInfo?.sectionRemaining !== undefined
            ? t("sectionPagesLeft", { count: pageInfo.sectionRemaining })
            : ""}
        </span>
        <div
          className="reader-page-controls"
          data-reader-controls
          hidden={!controlsVisible}
        >
          <button
            className="reader-icon"
            disabled={!ready}
            aria-label={t("previousPage")}
            onClick={() => turn("prev")}
          >
            <ChevronLeft size={19} />
          </button>
          <button
            className="reader-icon"
            disabled={!ready}
            aria-label={t("nextPage")}
            onClick={() => turn("next")}
          >
            <ChevronRight size={19} />
          </button>
        </div>
      </footer>
    </dialog>
  );
}
function Contents({
  items,
  go,
}: {
  items: TocItem[];
  go: (locator: string | number) => void;
}) {
  const { t } = useReaderI18n();
  return (
    <ol>
      {items.map((item, index) => (
        <li key={`${item.href}-${index}`}>
          <button onClick={() => go(item.href)}>
            {item.pageNumber
              ? `${t("page", { number: item.pageNumber })}${item.fileName ? ` · ${item.fileName}` : ""}`
              : item.label || t("chapter", { number: index + 1 })}
          </button>
          {item.subitems && <Contents items={item.subitems} go={go} />}
        </li>
      ))}
    </ol>
  );
}
