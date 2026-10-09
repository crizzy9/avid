import { useI18n, LOCALES, type Locale } from "../../../packages/i18n/src";
import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
} from "react";
import {
  BookOpen,
  Home,
  Library,
  Compass,
  Search,
  NotebookPen,
  Settings,
  Plus,
  SlidersHorizontal,
  ChevronRight,
  ArrowUpRight,
  Headphones,
  Play,
  Pause,
  Grid2X2,
  List,
  X,
  Check,
  MoreHorizontal,
  BarChart3,
  CircleHelp,
  Upload,
  LogOut,
  ShieldCheck,
  LoaderCircle,
  Bookmark,
  Trash2,
  Pencil,
  ExternalLink,
  Sun,
  Moon,
  Monitor,
  Layers,
  RefreshCw,
  ArrowLeft,
  FolderPlus,
} from "lucide-react";
import type {
  Annotation,
  Book,
  BookFile,
  ReadingAnchor,
  BookOrbitReadStatus,
} from "../../../packages/core/src/types";
import {
  resolveAudioResume,
  getPlatformCapabilities,
} from "../../../packages/playback/src";
import { demoBooks } from "./fixtures";
import { useLibrary } from "./useLibrary";
import { useLocalState } from "./useLocalState";
import { BookCard, Cover, EmptyState, Modal, Shelf, formatTime } from "./ui";
import { Connect } from "./Connect";
import { Player } from "./Player";
import { BookDetails } from "./BookDetails";
import { Activity } from "./Activity";
import { CrossPointPanel } from "../../../packages/integrations/src";
import { usePlaybackActivity } from "./usePlaybackActivity";
import { createPlaybackTransport } from "../../mobile/src/native-transport";
import { useNativeSurfaces } from "./useNativeSurfaces";
import type { NativeNavigation } from "../../mobile/src/native-surfaces";
import { useReadingActivity } from "./useReadingActivity";
import { SeriesBrowser } from "./SeriesBrowser";
import { VirtualBookGrid } from "./VirtualBookGrid";
import { CoverContext } from "./CoverContext";
import {
  chooseBookFile,
  readerKindForFile,
} from "../../../packages/readers/src/bookFile";
import { newestAnchor } from "./resume";

type View = "home" | "library" | "browse" | "search" | "notebook" | "activity";
const Reader = lazy(() =>
  import("../../../packages/readers/src/Reader").then((module) => ({
    default: module.Reader,
  })),
);
type Dialog =
  | "connect"
  | "settings"
  | "help"
  | "upload"
  | "integrations"
  | "collection"
  | null;
type ReaderState = {
  ownerScope: string;
  book: Book;
  file: BookFile;
  source?: Blob;
  anchor?: ReadingAnchor;
};

export default function App() {
  const { t, locale, setLocale } = useI18n();
  const navigation = [
    { id: "home", label: t("nav.home"), icon: Home },
    { id: "library", label: t("nav.library"), icon: Library },
    { id: "browse", label: t("nav.browse"), icon: Compass },
    { id: "notebook", label: t("nav.notebook"), icon: NotebookPen },
    { id: "search", label: t("nav.search"), icon: Search },
  ] as const;

  const library = useLibrary();
  const [view, setView] = useState<View>(() => {
    const v = new URLSearchParams(location.search).get("view");
    return navigation.some((n) => n.id === v) ? (v as View) : "home";
  });
  const [dialog, setDialog] = useState<Dialog>(null);
  const [selected, setSelected] = useState<Book | null>(null);
  const [reader, setReader] = useState<ReaderState | null>(null);
  const [readingBusy, setReadingBusy] = useState(false);
  const [toast, setToast] = useState("");
  const [search, setSearch] = useState("");
  const [noteQuery, setNoteQuery] = useState("");
  const [noteBook, setNoteBook] = useState("all");
  const [format, setFormat] = useLocalState("format", "all");
  const [layout, setLayout] = useLocalState("layout", "grid");
  const [sort, setSort] = useLocalState("sort", "addedAt");
  const [theme, setTheme] = useLocalState("theme", "light");
  const [motion, setMotion] = useLocalState("motion", "system");
  const [recentSearches, setRecentSearches] = useLocalState<string[]>(
    "recent-searches",
    [],
  );
  const [activeCollection, setActiveCollection] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [menu, setMenu] = useState(false);
  const [noteEdit, setNoteEdit] = useState<Annotation | null>(null);
  const [noteText, setNoteText] = useState("");
  const [collectionName, setCollectionName] = useState("");
  const [collectionBusy, setCollectionBusy] = useState(false);
  const [playerBook, setPlayerBook] = useState<Book | null>(null);
  const [showPlayer, setShowPlayer] = useState(false);
  const accountScope = useRef(library.repo.scope);
  accountScope.current = library.repo.scope;
  const [controller] = useState(() =>
    createPlaybackTransport({ accountScope: () => accountScope.current }),
  );
  const playback = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
  );
  const disposeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const playerUrls = useRef<string[]>([]);
  const localSources = useRef(new Map<string, { book: Book; source: File }>());
  const playbackScope = useRef<string | null>(null);
  const openRequest = useRef<AbortController | null>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadLibrary, setUploadLibrary] = useState("");
  const [serverLibraries, setServerLibraries] = useState<
    { id: string; name: string }[]
  >([]);
  const [uploadBusy, setUploadBusy] = useState(false);

  const notify = (message: string) => setToast(message);
  const publishNativeRecent = useNativeSurfaces(
    library.repo.scope,
    !!library.client,
    library.books,
    (request) => {
      void openNativeBook(request);
    },
    notify,
  );
  const changeReadingActivity = useReadingActivity(
    reader,
    library.recordSession,
    { accountScope: library.repo.scope, onError: notify },
  );
  usePlaybackActivity(controller, library.recordSession, {
    accountScope: library.repo.scope,
    onError: notify,
  });
  useEffect(() => {
    openRequest.current?.abort();
    if (controller.getBook()) controller.pause();
    playbackScope.current = null;
    setReader(null);
    setSelected(null);
    setNoteEdit(null);
    setPlayerBook(null);
    setShowPlayer(false);
    setReadingBusy(false);
    localSources.current.clear();
    for (const url of playerUrls.current) URL.revokeObjectURL(url);
    playerUrls.current = [];
  }, [library.repo.scope, controller]);
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(""), 4500);
      return () => clearTimeout(timer);
    }
  }, [toast]);
  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const update = () => {
      document.documentElement.dataset.theme =
        theme === "system" ? (mq.matches ? "dark" : "light") : theme;
    };
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [theme]);
  useEffect(() => {
    document.documentElement.dataset.motion = motion;
  }, [motion]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setView("search");
        setTimeout(() => searchRef.current?.focus(), 0);
      }
      if (e.key === "Escape") setMenu(false);
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);
  useEffect(() => {
    if (view === "search") searchRef.current?.focus();
  }, [view]);
  useEffect(() => {
    const abort = new AbortController();
    if (library.client) {
      const timer = setTimeout(
        () => {
          setPage(1);
          void library.query(
            {
              query: search,
              sort: sort as "title" | "addedAt",
              direction: sort === "title" ? "asc" : "desc",
              collectionId: activeCollection ?? undefined,
              media: (view === "library" || view === "search"
                ? format
                : "all") as "all" | "audio" | "books" | "comics",
            },
            abort.signal,
          );
        },
        search ? 300 : 0,
      );
      return () => {
        clearTimeout(timer);
        abort.abort();
      };
    }
  }, [
    library.client,
    library.query,
    search,
    sort,
    activeCollection,
    format,
    view,
  ]);
  useEffect(
    () =>
      controller.onCheckpoint((anchor) => {
        if (playbackScope.current === library.repo.scope)
          void library.saveAnchor(anchor);
      }),
    [controller, library.saveAnchor],
  );
  useEffect(() => {
    clearTimeout(disposeTimer.current);
    return () => {
      disposeTimer.current = setTimeout(() => {
        controller.destroy();
        for (const url of playerUrls.current) URL.revokeObjectURL(url);
      }, 0);
    };
  }, [controller]);
  useEffect(() => {
    if (dialog === "upload" && library.client)
      library.client
        .listLibraries()
        .then(setServerLibraries)
        .catch((e) => notify(e.message));
  }, [dialog, library.client]);

  function finishReading() {
    setReader(null);
  }
  function navigate(next: View) {
    setView(next);
    setMenu(false);
    setActiveCollection(null);
    if (next === "home" || next === "browse") setFormat("all");
    if (next !== "search") setSearch("");
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  const books = useMemo(() => {
    let items = library.books.filter(
      (b) =>
        format === "all" ||
        (format === "audio"
          ? b.files.some((f) => f.format === "AUDIO")
          : format === "comics"
            ? ["CBZ", "CBR", "CB7"].includes(b.format)
            : b.format !== "AUDIO" &&
              !["CBZ", "CBR", "CB7"].includes(b.format)),
    );
    if (!library.client) {
      if (search)
        items = items.filter((b) =>
          `${b.title} ${b.authors.join(" ")} ${b.genres.join(" ")}`
            .toLocaleLowerCase()
            .includes(search.toLocaleLowerCase()),
        );
      if (activeCollection)
        items = items.filter((b) =>
          library.collections
            .find((c) => c.id === activeCollection)
            ?.bookIds.includes(b.id),
        );
      items = [...items].sort((a, b) =>
        sort === "title"
          ? a.title.localeCompare(b.title)
          : Date.parse(b.addedAt) - Date.parse(a.addedAt),
      );
    }
    return items;
  }, [
    library.books,
    library.client,
    library.collections,
    format,
    search,
    sort,
    activeCollection,
  ]);
  const currentBook =
    library.books.find((b) => b.progress > 0 && b.progress < 1) ??
    library.books[0];
  const selectedBook = selected
    ? (library.books.find((b) => b.id === selected.id) ?? selected)
    : null;
  const notes = library.annotations.filter(
    (n) =>
      (noteBook === "all" || n.bookId === noteBook) &&
      `${n.quote} ${n.text}`.toLowerCase().includes(noteQuery.toLowerCase()),
  );
  const queue = library.books.filter((b) =>
    library.collections.find((c) => c.id === "queue")?.bookIds.includes(b.id),
  );

  async function openReader(book: Book, requestedAnchor?: ReadingAnchor) {
    controller.pause();
    const scope = accountScope.current;
    openRequest.current?.abort();
    const request = new AbortController();
    openRequest.current = request;
    let file: BookFile | undefined;
    try {
      file = chooseBookFile(book, requestedAnchor);
    } catch (e) {
      notify(
        e instanceof Error ? e.message : "This saved position is unavailable.",
      );
      return;
    }
    if (!file) {
      await listen(book);
      return;
    }
    setReadingBusy(true);
    try {
      let anchor =
        requestedAnchor ??
        (await library.repo.getAnchor({
          bookId: book.id,
          fileId: file.id,
          kind:
            file.format === "PDF"
              ? "pdf"
              : ["CBZ", "CBR", "CB7"].includes(file.format)
                ? "comic"
                : "epub",
        }));
      if (library.client && !requestedAnchor && !book.id.startsWith("local-")) {
        try {
          const remote = await library.client.getProgress({
            bookId: book.id,
            fileId: file.id,
            kind:
              file.format === "PDF"
                ? "pdf"
                : ["CBZ", "CBR", "CB7"].includes(file.format)
                  ? "comic"
                  : "epub",
          });
          const chosen = newestAnchor(anchor, remote);
          if (chosen && chosen === remote)
            await library.repo.importAnchor(chosen);
          anchor = chosen;
        } catch {
          /* Preserve a local checkpoint when remote progress is temporarily unavailable. */
        }
      }
      const source =
        localSources.current.get(book.id)?.source ??
        (library.client && !book.id.startsWith("local-")
          ? await library.client.getFileBlob(file.id, request.signal)
          : undefined);
      if (library.client && !book.id.startsWith("local-")) {
        try {
          const remoteNotes = await library.client.getAnnotations(
            book.id,
            file.id,
          );
          await library.repo.importAnnotations(remoteNotes);
          await library.refreshAnnotations();
        } catch {
          /* Reading remains available when the server cannot provide annotations for this format. */
        }
      }
      if (scope !== accountScope.current || request.signal.aborted) return;
      setReader({ book, file, source, anchor, ownerScope: scope });
      publishNativeRecent(book, file, anchor);
      setSelected(null);
    } catch (e) {
      if (scope === accountScope.current && !request.signal.aborted)
        notify(
          e instanceof Error ? e.message : "This book could not be opened.",
        );
    } finally {
      if (scope === accountScope.current && openRequest.current === request)
        setReadingBusy(false);
    }
  }

  async function listen(
    book: Book,
    requestedAnchor?: ReadingAnchor,
  ): Promise<boolean> {
    const scope = accountScope.current;
    openRequest.current?.abort();
    const request = new AbortController();
    openRequest.current = request;
    controller.pause();
    let file: BookFile | undefined;
    try {
      file = chooseBookFile(book, requestedAnchor, "audio");
    } catch (e) {
      notify(
        e instanceof Error ? e.message : "This saved position is unavailable.",
      );
      return false;
    }
    if (!file) {
      notify(
        "No audiobook file is attached to this title. Use Speak inside the reader for text-to-speech.",
      );
      return false;
    }
    setReadingBusy(true);
    try {
      const remoteClient = book.id.startsWith("local-") ? null : library.client;
      const playbackSource = remoteClient
        ? await remoteClient.getPlaybackSource(book)
        : undefined;
      if (
        requestedAnchor &&
        playbackSource &&
        playbackSource.fileId !== requestedAnchor.fileId
      )
        throw new Error(
          "This audio note belongs to a different source file. Its position has been preserved.",
        );
      let url = file.url;
      if (!playbackSource && !url)
        throw new Error("This audiobook has no playable source.");
      let saved =
        requestedAnchor ??
        (await library.repo.getAnchor({
          bookId: book.id,
          fileId: file.id,
          kind: "audio",
        }));
      if (remoteClient) {
        if (!requestedAnchor)
          try {
            const remote = await remoteClient.getProgress({
              bookId: book.id,
              fileId: file.id,
              kind: "audio",
            });
            const chosen = newestAnchor(saved, remote);
            if (chosen && chosen === remote)
              await library.repo.importAnchor(chosen);
            saved = chosen;
          } catch {
            /* Keep the last device checkpoint if the server cannot supply a position. */
          }
        try {
          await library.repo.importAnnotations(
            await remoteClient.getAudioAnnotations(book.id, file.id),
          );
          await library.refreshAnnotations();
        } catch {
          /* The player remains available if an older server lacks bookmarks. */
        }
      }
      const source = playbackSource ?? {
        bookId: book.id,
        fileId: file.id,
        title: book.title,
        authors: book.authors,
        coverUrl: book.coverUrl,
        tracks: [{ id: file.id, url: url! }],
        chapters: book.chapters,
      };
      const time = saved ? resolveAudioResume(source, saved.locator) : 0;
      if (scope !== accountScope.current || request.signal.aborted)
        return false;
      controller.checkpoint();
      playbackScope.current = null;
      controller.load(source, time);
      playbackScope.current = scope;
      setPlayerBook(book);
      publishNativeRecent(book, file, saved);
      setShowPlayer(true);
      setSelected(null);
      await controller.play();
      return scope === accountScope.current && !request.signal.aborted;
    } catch (e) {
      if (scope === accountScope.current && !request.signal.aborted)
        notify(e instanceof Error ? e.message : "Audio could not be loaded.");
      return false;
    } finally {
      if (scope === accountScope.current && openRequest.current === request)
        setReadingBusy(false);
    }
  }

  function audioNote() {
    if (!playerBook || !playback.fileId) return;
    const checkpoint = controller.checkpoint();
    if (!checkpoint) return;
    const now = new Date().toISOString();
    setNoteEdit({
      id: crypto.randomUUID(),
      bookId: playerBook.id,
      fileId: playback.fileId,
      kind: "audio",
      quote: `At ${formatTime(playback.currentTime)}`,
      text: "",
      color: "sand",
      locator: checkpoint.locator,
      createdAt: now,
      updatedAt: now,
    });
    setNoteText("");
  }
  async function openNativeBook(request: NativeNavigation) {
    const scope = accountScope.current;
    try {
      const book =
        library.books.find((item) => item.id === request.bookId) ??
        (await library.repo.getBook(request.bookId)) ??
        (await library.client?.getBook(request.bookId));
      if (scope !== accountScope.current) return;
      const file = book?.files.find((item) => item.id === request.fileId);
      if (!book || !file || readerKindForFile(file) !== request.kind)
        throw new Error(
          "This shortcut’s source file is no longer in the connected library.",
        );
      if (
        request.kind === "audio" &&
        book.files.find((item) => item.format === "AUDIO")?.id !== file.id
      )
        throw new Error(
          "This audio shortcut belongs to a different source. Open the audiobook from your library.",
        );
      const selectedFileBook = {
        ...book,
        format: file.format,
        files: [file, ...book.files.filter((item) => item.id !== file.id)],
      };
      if (request.kind === "audio") await listen(selectedFileBook);
      else await openReader(selectedFileBook);
    } catch (error) {
      if (scope === accountScope.current)
        notify(
          error instanceof Error
            ? error.message
            : "This book shortcut could not be opened.",
        );
    }
  }
  async function jumpToNote(note: Annotation) {
    const scope = accountScope.current;
    const book =
      localSources.current.get(note.bookId)?.book ??
      library.books.find((b) => b.id === note.bookId) ??
      (await library.repo.getBook(note.bookId));
    if (scope !== accountScope.current) return;
    if (!book)
      return notify(
        note.bookId.startsWith("local-")
          ? "Reopen the original local file to read it again. Local files are not retained after closing Avid."
          : "This book is no longer in the current library.",
      );
    const file = book.files.find((f) => f.id === note.fileId);
    if (!file)
      return notify(
        "The file associated with this note is no longer available.",
      );
    const anchor: ReadingAnchor = {
      bookId: note.bookId,
      fileId: note.fileId,
      kind: readerKindForFile(file),
      locator: note.locator,
      progress: book.progress,
      updatedAt: note.updatedAt,
    };
    if (note.kind === "audio") {
      await listen(book, anchor);
    } else await openReader(book, anchor);
  }
  async function toggleQueue(book: Book) {
    if (library.client) {
      await changeStatus(
        book,
        book.serverStatus === "want_to_read" ? "unread" : "want_to_read",
      );
      return;
    }
    const existing = library.collections.find((c) => c.id === "queue") ?? {
      id: "queue",
      name: "Reading queue",
      bookIds: [],
    };
    const contains = existing.bookIds.includes(book.id);
    const next = {
      ...existing,
      bookIds: contains
        ? existing.bookIds.filter((id) => id !== book.id)
        : [...existing.bookIds, book.id],
    };
    await library.saveCollections([
      ...library.collections.filter((c) => c.id !== "queue"),
      next,
    ]);
    notify(
      contains ? "Removed from your queue" : "Added to your reading queue",
    );
  }
  async function changeStatus(book: Book, serverStatus: BookOrbitReadStatus) {
    const scope = accountScope.current;
    try {
      if (library.client)
        await library.client.setReadStatus(book.id, serverStatus);
      if (scope !== accountScope.current) return;
      const status: Book["status"] = ["read", "skimmed"].includes(serverStatus)
        ? "finished"
        : ["reading", "rereading", "on_hold"].includes(serverStatus)
          ? "reading"
          : "unread";
      const updated = { ...book, status, serverStatus };
      if (library.client) {
        await library.repo.putBooks([updated]);
        if (scope !== accountScope.current) return;
        library.setBooks((previous) =>
          previous.map((b) => (b.id === book.id ? updated : b)),
        );
      } else await library.updateDemoBook(updated);
      if (scope === accountScope.current) notify("Reading status updated");
    } catch (e) {
      if (scope === accountScope.current)
        notify(
          e instanceof Error ? e.message : "Could not update reading status.",
        );
    }
  }
  async function importLocal(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const extension = file.name.split(".").pop()?.toUpperCase();
    const mapped = ["MP3", "M4B", "M4A", "OGG", "OPUS", "FLAC", "WAV"].includes(
      extension ?? "",
    )
      ? "AUDIO"
      : ["AZW", "AZW3"].includes(extension ?? "")
        ? "MOBI"
        : extension;
    if (
      !["EPUB", "MOBI", "PDF", "CBZ", "CBR", "CB7", "AUDIO"].includes(
        mapped ?? "",
      )
    )
      return notify("Choose an EPUB, MOBI, PDF, comic archive, or audio file.");
    const id = `local-${crypto.randomUUID()}`;
    const url = URL.createObjectURL(file);
    playerUrls.current.push(url);
    const book: Book = {
      id,
      title: file.name.replace(/\.[^.]+$/, ""),
      authors: ["Local file"],
      description:
        "Opened from this device. This file is not uploaded to your server or retained as an offline download.",
      format: mapped as Book["format"],
      color: "#476a67",
      progress: 0,
      status: "unread",
      genres: [],
      addedAt: new Date().toISOString(),
      files: [
        {
          id,
          name: file.name,
          format: mapped as Book["format"],
          url,
          size: file.size,
        },
      ],
    };
    localSources.current.set(id, { book, source: file });
    setDialog(null);
    controller.pause();
    if (mapped === "AUDIO") {
      controller.checkpoint();
      playbackScope.current = null;
      controller.load({
        bookId: id,
        fileId: id,
        title: book.title,
        authors: book.authors,
        tracks: [{ id, url }],
      });
      playbackScope.current = accountScope.current;
      setPlayerBook(book);
      setShowPlayer(true);
      await controller.play();
    } else {
      setReader({
        book,
        file: book.files[0],
        source: file,
        ownerScope: accountScope.current,
      });
    }
  }

  return (
    <CoverContext.Provider value={library.coverCache}>
      <div className={`app-shell ${playerBook ? "has-player" : ""}`}>
        <a className="skip-link" href="#main-content">
          {t("a11y.skip")}
        </a>
        <header className="app-header">
          <button
            className="wordmark"
            onClick={() => navigate("home")}
            aria-label={t("a11y.home")}
          >
            <BookOpen size={27} strokeWidth={1.7} />
            <span>avid</span>
          </button>
          <nav className="main-nav" aria-label={t("a11y.navigation")}>
            {navigation.map((item) => (
              <button
                key={item.id}
                className={view === item.id ? "active" : ""}
                aria-current={view === item.id ? "page" : undefined}
                onClick={() => navigate(item.id)}
              >
                <item.icon size={17} />
                <span>{item.label}</span>
              </button>
            ))}
          </nav>
          <div className="header-actions">
            <button
              className="icon-button"
              title={t("library.open")}
              aria-label={t("upload.open")}
              onClick={() => setDialog("upload")}
            >
              <Plus size={21} />
            </button>
            <button
              className="icon-button"
              title={t("common.settings")}
              aria-label={t("common.settings")}
              onClick={() => setDialog("settings")}
            >
              <SlidersHorizontal size={19} />
            </button>
            <button
              className="avatar"
              aria-label={t("common.more")}
              aria-expanded={menu}
              onClick={() => setMenu(!menu)}
            >
              {library.client
                ? library.client.session.profile.username
                    ?.slice(0, 1)
                    .toUpperCase() || "A"
                : "A"}
            </button>
          </div>
          {menu && (
            <div className="account-menu">
              <p>
                {library.client?.session.profile.username ||
                  "Your personal library"}
                <small>
                  {library.client?.session.profile.name || "Exploring Avid"}
                </small>
              </p>
              <button
                onClick={() => {
                  setDialog("connect");
                  setMenu(false);
                }}
              >
                <Library size={17} />
                {t("connect.aServer")}
              </button>
              <button onClick={() => navigate("activity")}>
                <BarChart3 size={17} />
                {t("nav.activity")}
              </button>
              <button
                onClick={() => {
                  setDialog("integrations");
                  setMenu(false);
                }}
              >
                <Layers size={17} />
                Integrations
              </button>
              <button
                onClick={() => {
                  setDialog("help");
                  setMenu(false);
                }}
              >
                <CircleHelp size={17} />
                Avid guide
              </button>
              {library.client && (
                <button
                  onClick={() => {
                    controller.pause();
                    setPlayerBook(null);
                    library.disconnect();
                    setMenu(false);
                    notify(
                      "Disconnected. Your local notes are kept for this account.",
                    );
                  }}
                >
                  <LogOut size={17} />
                  {t("connect.disconnect")}
                </button>
              )}
            </div>
          )}
        </header>

        <main id="main-content" className="main-content">
          <div className="connection-line">
            <span>
              <span
                className={`status-dot ${library.client ? "connected" : ""}`}
              />
              {library.client
                ? `${library.client.session.profile.name} · ${library.syncStatus}`
                : "A little library to make yourself at home"}
            </span>
            <button
              className="text-button"
              onClick={() => setDialog(library.client ? "settings" : "connect")}
            >
              {library.client ? "Connection settings" : t("connect.title")}
              <ArrowUpRight size={14} />
            </button>
          </div>
          {library.error && (
            <div className="error-banner" role="alert">
              {library.error}
              <button
                aria-label={t("a11y.dismissError")}
                className="icon-button"
                onClick={() => library.setError("")}
              >
                <X size={16} />
              </button>
            </div>
          )}

          {view === "home" && (
            <>
              {currentBook ? (
                <section
                  className="resume-hero"
                  style={
                    { "--hero-color": currentBook.color } as React.CSSProperties
                  }
                >
                  <div
                    className="hero-art"
                    onClick={() => setSelected(currentBook)}
                  >
                    <Cover book={currentBook} large />
                  </div>
                  <div className="hero-copy">
                    <div className="eyebrow">
                      <span />
                      {t("home.eyebrow")}
                    </div>
                    <p className="hero-kicker">{t("home.heading")}</p>
                    <h1>{currentBook.title}</h1>
                    <p className="hero-author">
                      {currentBook.authors.join(", ")}
                    </p>
                    <p className="hero-description">
                      {currentBook.description.replace(/<[^>]*>/g, "")}
                    </p>
                    <div className="hero-meta">
                      <BookOpen size={15} />
                      <span>
                        {t("common.complete", {
                          percent: Math.round(currentBook.progress * 100),
                        })}
                      </span>
                      <span className="meta-divider">·</span>
                      <span>
                        {currentBook.format === "AUDIO"
                          ? t("common.audiobook")
                          : currentBook.format}
                      </span>
                    </div>
                    <div className="hero-buttons">
                      <button
                        className="primary-button"
                        onClick={() => void openReader(currentBook)}
                      >
                        <Play size={15} fill="currentColor" />
                        {t("common.resume")}{" "}
                        {currentBook.format === "AUDIO"
                          ? "listening"
                          : "reading"}
                      </button>
                      <button
                        className="hero-detail-button"
                        onClick={() => setSelected(currentBook)}
                        aria-label={`Details for ${currentBook.title}`}
                      >
                        <MoreHorizontal size={22} />
                      </button>
                    </div>
                  </div>
                  <div className="hero-ornament" aria-hidden="true">
                    <BookOpen />
                  </div>
                </section>
              ) : (
                <EmptyState
                  icon={<Library />}
                  heading={t("home.start")}
                  description={t("library.empty")}
                />
              )}
              <Shelf
                title={t("home.continue")}
                subtitle={t("home.continueHint")}
                books={library.books.filter(
                  (b) => b.progress > 0 && b.progress < 1,
                )}
                onSelect={setSelected}
                onSeeAll={() => navigate("library")}
              />
              <Shelf
                title={t("home.queue")}
                subtitle={t("home.queueHint")}
                books={queue}
                onSelect={setSelected}
                onSeeAll={() => {
                  setView("library");
                  setActiveCollection("queue");
                }}
              />
              <Shelf
                title={t("library.recent")}
                books={[...library.books]
                  .sort((a, b) => Date.parse(b.addedAt) - Date.parse(a.addedAt))
                  .slice(0, 12)}
                onSelect={setSelected}
                onSeeAll={() => navigate("library")}
              />
              {!library.client && (
                <section className="library-invitation">
                  <div className="invitation-icon">
                    <Library size={28} />
                  </div>
                  <div>
                    <h3>{t("home.connectHeading")}</h3>
                    <p>{t("home.connectHint")}</p>
                  </div>
                  <button
                    className="secondary-button"
                    onClick={() => setDialog("connect")}
                  >
                    {t("connect.server")}
                    <ArrowUpRight size={16} />
                  </button>
                </section>
              )}
            </>
          )}

          {(view === "library" || view === "search") && (
            <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">
                    {view === "search"
                      ? "SOMETHING ON YOUR MIND?"
                      : "A PLACE FOR EVERY STORY"}
                  </span>
                  <h1>
                    {view === "search"
                      ? "Find your next chapter."
                      : activeCollection
                        ? library.collections.find(
                            (c) => c.id === activeCollection,
                          )?.name
                        : t("library.title")}
                  </h1>
                  <p>
                    {t("library.count", {
                      count: library.client ? library.total : books.length,
                    })}
                    {library.client?.readOnly ? " · Read-only connection" : ""}
                  </p>
                </div>
                {view === "library" && (
                  <button
                    className="secondary-button"
                    onClick={() => setDialog("upload")}
                  >
                    <Plus size={17} />
                    {t("library.add")}
                  </button>
                )}
              </div>
              {view === "search" && (
                <>
                  <div className="search-box">
                    <Search size={22} />
                    <input
                      ref={searchRef}
                      aria-label={t("library.search")}
                      placeholder={t("library.searchHint")}
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      onBlur={() => {
                        if (search.trim())
                          setRecentSearches(
                            [
                              search.trim(),
                              ...recentSearches.filter(
                                (q) => q !== search.trim(),
                              ),
                            ].slice(0, 6),
                          );
                      }}
                    />
                    {search && (
                      <button
                        className="icon-button"
                        onClick={() => setSearch("")}
                        aria-label={t("library.clearSearch")}
                      >
                        <X size={18} />
                      </button>
                    )}
                    <kbd>⌘ K</kbd>
                  </div>
                  {!search && recentSearches.length > 0 && (
                    <div className="recent-searches">
                      <span>{t("library.recentSearches")}</span>
                      {recentSearches.map((q) => (
                        <button key={q} onClick={() => setSearch(q)}>
                          {q}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
              <div className="library-toolbar">
                <div className="filter-tabs">
                  {[
                    ["all", t("library.all")],
                    ["books", t("library.ebooks")],
                    ["audio", t("library.audiobooks")],
                    ["comics", t("library.comics")],
                  ].map(([id, label]) => (
                    <button
                      key={id}
                      className={format === id ? "active" : ""}
                      onClick={() => setFormat(id)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="view-controls">
                  <select
                    aria-label={t("library.sort")}
                    value={sort}
                    onChange={(e) => setSort(e.target.value)}
                  >
                    <option value="addedAt">{t("library.recent")}</option>
                    <option value="title">{t("library.sortTitle")}</option>
                  </select>
                  <div className="segmented">
                    <button
                      className={layout === "grid" ? "active" : ""}
                      aria-label={t("library.grid")}
                      aria-pressed={layout === "grid"}
                      onClick={() => setLayout("grid")}
                    >
                      <Grid2X2 size={17} />
                    </button>
                    <button
                      className={layout === "list" ? "active" : ""}
                      aria-label={t("library.list")}
                      aria-pressed={layout === "list"}
                      onClick={() => setLayout("list")}
                    >
                      <List size={18} />
                    </button>
                  </div>
                </div>
              </div>
              {activeCollection && (
                <button
                  className="text-button back-link"
                  onClick={() => setActiveCollection(null)}
                >
                  <ArrowLeft size={16} />
                  {t("library.all")}
                </button>
              )}
              {library.loading && (
                <p className="loading-label" role="status">
                  <LoaderCircle size={17} className="spin" />
                  {t("library.loading")}
                </p>
              )}
              {books.length ? (
                <VirtualBookGrid
                  books={books}
                  onSelect={setSelected}
                  list={layout === "list"}
                />
              ) : (
                !library.loading && (
                  <EmptyState
                    icon={<Search size={32} />}
                    heading={
                      search
                        ? "No matching stories"
                        : "A shelf waiting to be filled"
                    }
                    description={
                      search
                        ? "Try a different title or author, or choose another format."
                        : "Choose another format, connect your server, or open a book from this device."
                    }
                  />
                )
              )}
              {library.client && library.books.length < library.total && (
                <div className="load-more">
                  <button
                    className="secondary-button"
                    disabled={library.loading}
                    onClick={() => {
                      setPage(page + 1);
                      void library.query({
                        page: page + 1,
                        query: search,
                        sort: sort as "title" | "addedAt",
                        collectionId: activeCollection ?? undefined,
                        media: format as "all" | "audio" | "books" | "comics",
                        direction: sort === "title" ? "asc" : "desc",
                      });
                    }}
                  >
                    {t("library.more")}
                  </button>
                </div>
              )}
            </>
          )}

          {view === "browse" && (
            <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">{t("browse.eyebrow")}</span>
                  <h1>{t("browse.heading")}</h1>
                  <p>{t("browse.hint")}</p>
                </div>
                <button
                  className="secondary-button"
                  disabled={library.client?.readOnly ?? false}
                  onClick={() => setDialog("collection")}
                >
                  <FolderPlus size={17} />
                  {t("collections.new")}
                </button>
              </div>
              <section>
                <div className="section-heading">
                  <h2>{t("collections.title")}</h2>
                  <span className="muted">
                    {t("collections.count", {
                      count: library.collections.length,
                    })}
                  </span>
                </div>
                <div className="collections-grid">
                  {library.collections.map((collection, i) => (
                    <button
                      className="collection-card"
                      key={collection.id}
                      onClick={() => {
                        setView("library");
                        setFormat("all");
                        setActiveCollection(collection.id);
                      }}
                    >
                      <div className={`collection-art collection-art-${i % 3}`}>
                        {(library.books
                          .filter((b) => collection.bookIds.includes(b.id))
                          .slice(0, 3).length
                          ? library.books
                              .filter((b) => collection.bookIds.includes(b.id))
                              .slice(0, 3)
                          : library.books.slice(i * 3, i * 3 + 3)
                        ).map((book) => (
                          <Cover key={book.id} book={book} />
                        ))}
                      </div>
                      <div>
                        <h3>{collection.name}</h3>
                        <span>
                          {library.client
                            ? "Open collection"
                            : t("library.count", {
                                count: collection.bookIds.length,
                              })}
                          <ChevronRight size={17} />
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
                {!library.collections.length && (
                  <EmptyState
                    icon={<Layers />}
                    heading={t("collections.empty")}
                    description={t("collections.emptyHint")}
                  />
                )}
              </section>
              <section className="browse-genres">
                <div className="section-heading">
                  <h2>{t("browse.genre")}</h2>
                </div>
                <div className="genre-grid">
                  {[...new Set(library.books.flatMap((b) => b.genres))]
                    .slice(0, 18)
                    .map((genre, i) => (
                      <button
                        key={genre}
                        onClick={() => {
                          setSearch(genre);
                          setView("search");
                          setFormat("all");
                        }}
                      >
                        <span className={`genre-symbol genre-${i % 4}`}>
                          <BookOpen size={20} />
                        </span>
                        {genre}
                        <ArrowUpRight size={16} />
                      </button>
                    ))}
                </div>
              </section>
              {library.client ? (
                <SeriesBrowser
                  client={library.client}
                  onBook={(book) => {
                    void library.repo.putBooks([book]);
                    setSelected(book);
                  }}
                />
              ) : (
                <section>
                  <div className="section-heading">
                    <h2>{t("browse.series")}</h2>
                  </div>
                  {library.books.some((b) => b.series) ? (
                    <div className="series-list">
                      {[
                        ...new Set(
                          library.books.flatMap((b) =>
                            b.series ? [b.series] : [],
                          ),
                        ),
                      ].map((series) => (
                        <div key={series}>
                          <h3>{series}</h3>
                          <div className="shelf-track">
                            {library.books
                              .filter((b) => b.series === series)
                              .sort(
                                (a, b) =>
                                  (a.seriesIndex ?? 0) - (b.seriesIndex ?? 0),
                              )
                              .map((b) => (
                                <BookCard
                                  book={b}
                                  onSelect={setSelected}
                                  key={b.id}
                                />
                              ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="muted">{t("series.localHint")}</p>
                  )}
                </section>
              )}
            </>
          )}

          {view === "notebook" && (
            <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">{t("note.eyebrow")}</span>
                  <h1>{t("note.heading")}</h1>
                  <p>{t("note.hint")}</p>
                </div>
                <span className="count-pill">
                  {t("note.count", { count: library.annotations.length })}
                </span>
              </div>
              <div className="notebook-toolbar">
                <div className="search-box compact">
                  <Search size={18} />
                  <input
                    aria-label={t("note.search")}
                    placeholder={t("note.searchHint")}
                    value={noteQuery}
                    onChange={(e) => setNoteQuery(e.target.value)}
                  />
                </div>
                <select
                  aria-label={t("note.filter")}
                  value={noteBook}
                  onChange={(e) => setNoteBook(e.target.value)}
                >
                  <option value="all">{t("library.all")}</option>
                  {library.books.map((b) => (
                    <option value={b.id} key={b.id}>
                      {b.title}
                    </option>
                  ))}
                </select>
              </div>
              {notes.length ? (
                <div className="notes-grid">
                  {notes.map((note) => (
                    <article className="note-card" key={note.id}>
                      <div className="note-book">
                        <BookOpen size={14} />
                        {library.books.find((b) => b.id === note.bookId)
                          ?.title ?? t("note.bookNote")}
                      </div>
                      {note.quote && <blockquote>{note.quote}</blockquote>}
                      {note.text && <p>{note.text}</p>}
                      <footer>
                        <button
                          className="text-button"
                          onClick={() => void jumpToNote(note)}
                        >
                          {note.kind === "audio" ? (
                            <Headphones size={14} />
                          ) : (
                            <Bookmark size={14} />
                          )}
                          {t("note.open")}
                        </button>
                        <div>
                          <button
                            className="icon-button"
                            aria-label={t("note.edit")}
                            onClick={() => {
                              setNoteEdit(note);
                              setNoteText(note.text);
                            }}
                          >
                            <Pencil size={15} />
                          </button>
                          <button
                            className="icon-button"
                            aria-label={t("note.delete")}
                            onClick={() =>
                              void library.saveAnnotation({
                                ...note,
                                deleted: true,
                                updatedAt: new Date().toISOString(),
                              })
                            }
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </footer>
                    </article>
                  ))}
                </div>
              ) : (
                <EmptyState
                  icon={<NotebookPen size={34} />}
                  heading={noteQuery ? t("note.emptySearch") : t("note.empty")}
                  description={
                    noteQuery ? t("note.emptySearchHint") : t("note.emptyHint")
                  }
                  action={
                    <button
                      className="secondary-button"
                      onClick={() => navigate("library")}
                    >
                      {t("common.findBook")}
                      <ChevronRight size={16} />
                    </button>
                  }
                />
              )}
            </>
          )}

          {view === "activity" && (
            <Activity
              client={library.client}
              books={library.books}
              sessions={library.sessions}
            />
          )}

          <footer className="app-footer">
            <span className="footer-brand">
              avid<span>{t("footer.tagline")}</span>
            </span>
            <div>
              <button onClick={() => navigate("activity")}>
                {t("nav.activity")}
              </button>
              <button onClick={() => setDialog("help")}>
                {t("footer.help")}
              </button>
              <span>{t("footer.love")}</span>
            </div>
          </footer>
        </main>

        {playerBook && (
          <div className="mini-player">
            <button className="mini-book" onClick={() => setShowPlayer(true)}>
              <Cover book={playerBook} />
              <span>
                <strong>{playerBook.title}</strong>
                <small>
                  {playerBook.authors.join(", ")} ·{" "}
                  {formatTime(playback.currentTime)}
                </small>
              </span>
            </button>
            <div className="mini-controls">
              <button
                className="icon-button"
                aria-label={
                  playback.status === "playing"
                    ? t("player.pauseAudio")
                    : t("player.playAudio")
                }
                onClick={() => void controller.toggle()}
              >
                {playback.status === "playing" ? (
                  <Pause size={21} fill="currentColor" />
                ) : (
                  <Play size={21} fill="currentColor" />
                )}
              </button>
              <button
                className="icon-button"
                aria-label={t("player.open")}
                onClick={() => setShowPlayer(true)}
              >
                <Headphones size={19} />
              </button>
              <button
                className="icon-button"
                aria-label={t("player.close")}
                onClick={() => {
                  controller.pause();
                  controller.checkpoint();
                  setPlayerBook(null);
                }}
              >
                <X size={18} />
              </button>
            </div>
            <div
              className="mini-progress"
              style={{
                width: `${playback.duration ? (playback.currentTime / playback.duration) * 100 : 0}%`,
              }}
            />
          </div>
        )}
        {toast && (
          <div className="toast" role="status">
            <Check size={16} />
            {toast}
            <button
              className="icon-button"
              aria-label={t("a11y.dismiss")}
              onClick={() => setToast("")}
            >
              <X size={14} />
            </button>
          </div>
        )}
        {readingBusy && (
          <div className="loading-overlay" role="status">
            <LoaderCircle className="spin" />
            <span>{t("common.openingBook")}</span>
            <button
              className="secondary-button"
              onClick={() => {
                openRequest.current?.abort();
                controller.pause();
                setReadingBusy(false);
              }}
            >
              {t("common.cancel")}
            </button>
          </div>
        )}
        {selectedBook && (
          <Modal
            title={t("common.bookDetails")}
            onClose={() => setSelected(null)}
            wide
          >
            <BookDetails
              book={selectedBook}
              collections={library.collections}
              annotations={library.annotations.filter(
                (a) => a.bookId === selectedBook.id,
              )}
              readOnly={library.client?.readOnly ?? false}
              client={library.client}
              onRead={() => void openReader(selectedBook)}
              onListen={() => void listen(selectedBook)}
              onQueue={() => void toggleQueue(selectedBook)}
              onStatus={(status) => void changeStatus(selectedBook, status)}
              onShowNotes={() => {
                setSelected(null);
                setView("notebook");
                setNoteBook(selectedBook.id);
              }}
            />
          </Modal>
        )}
        {reader && reader.ownerScope === library.repo.scope && (
          <Suspense
            fallback={
              <div className="loading-overlay" role="status">
                {t("common.openingReader")}
              </div>
            }
          >
            <Reader
              book={reader.book}
              file={reader.file}
              source={reader.source}
              accountScope={library.repo.scope}
              initialAnchor={reader.anchor}
              annotations={library.annotations.filter(
                (a) => a.bookId === reader.book.id,
              )}
              onClose={() => void finishReading()}
              onAnchor={(anchor) => {
                void library.saveAnchor(anchor);
                publishNativeRecent(reader.book, reader.file, anchor);
              }}
              onAnnotation={(annotation) =>
                void library
                  .saveAnnotation(annotation)
                  .catch((error) => notify(error.message))
              }
              onActivity={changeReadingActivity}
            />
          </Suspense>
        )}
        {showPlayer && playerBook && (
          <Modal title={t("player.title")} onClose={() => setShowPlayer(false)}>
            <Player
              controller={controller}
              book={playerBook}
              onNote={audioNote}
            />
          </Modal>
        )}
        {noteEdit && (
          <Modal
            title={
              noteEdit.kind === "audio" ? t("note.moment") : t("note.edit")
            }
            onClose={() => setNoteEdit(null)}
          >
            <form
              className="form-panel"
              onSubmit={(e) => {
                e.preventDefault();
                void library
                  .saveAnnotation({
                    ...noteEdit,
                    text: noteText,
                    updatedAt: new Date().toISOString(),
                  })
                  .then(() => {
                    setNoteEdit(null);
                    notify(t("common.saved"));
                  })
                  .catch((err) => notify(err.message));
              }}
            >
              {noteEdit.quote && <blockquote>{noteEdit.quote}</blockquote>}
              <label>
                {t("note.yours")}
                <textarea
                  autoFocus
                  value={noteText}
                  onChange={(e) => setNoteText(e.target.value)}
                  rows={5}
                  placeholder={t("note.placeholder")}
                />
              </label>
              <button className="primary-button" type="submit">
                {t("note.save")}
              </button>
            </form>
          </Modal>
        )}
        {dialog === "connect" && (
          <Modal title={t("connect.title")} onClose={() => setDialog(null)}>
            <Connect
              onConnect={async (session, readOnly) => {
                controller.pause();
                setPlayerBook(null);
                await library.connect(session, readOnly);
                setDialog(null);
                navigate("home");
                notify(t("common.connected"));
              }}
            />
          </Modal>
        )}
        {dialog === "settings" && (
          <Modal title={t("settings.heading")} onClose={() => setDialog(null)}>
            <div className="settings-panel">
              <section>
                <h3>{t("settings.language")}</h3>
                <p>{t("settings.languageHint")}</p>
                <label className="setting-row">
                  <span>{t("settings.language")}</span>
                  <select
                    aria-label={t("settings.language")}
                    value={locale}
                    onChange={(event) =>
                      setLocale(event.target.value as Locale)
                    }
                  >
                    {LOCALES.map((language) => (
                      <option
                        key={language.code}
                        value={language.code}
                        lang={language.code}
                      >
                        {language.name}
                      </option>
                    ))}
                  </select>
                </label>
              </section>
              <section>
                <h3>{t("settings.appearance")}</h3>
                <p>{t("settings.appearanceHint")}</p>
                <div className="theme-options">
                  {[
                    ["light", t("settings.light"), Sun],
                    ["dark", t("settings.dark"), Moon],
                    ["system", t("settings.system"), Monitor],
                  ].map(([id, label, Icon]) => (
                    <button
                      key={id as string}
                      className={theme === id ? "active" : ""}
                      onClick={() => setTheme(id as string)}
                    >
                      {typeof Icon !== "string" && <Icon size={22} />}
                      <span>{label as string}</span>
                      {theme === id && <Check size={14} />}
                    </button>
                  ))}
                </div>
                <label className="setting-row">
                  <span>
                    {t("settings.motion")}
                    <small>{t("settings.motionHint")}</small>
                  </span>
                  <select
                    value={motion}
                    onChange={(e) => setMotion(e.target.value)}
                  >
                    <option value="system">{t("settings.followSystem")}</option>
                    <option value="reduce">{t("settings.alwaysReduce")}</option>
                  </select>
                </label>
              </section>
              <section>
                <h3>{t("settings.server")}</h3>
                <div className="server-card">
                  <ShieldCheck size={23} />
                  <div>
                    <strong>
                      {library.client?.session.profile.name ||
                        t("settings.notConnected")}
                    </strong>
                    <small>
                      {library.client
                        ? `${library.client.session.profile.username} · ${library.client.readOnly ? t("common.readOnly") : t("common.syncEnabled")}`
                        : t("connect.sampleHint")}
                    </small>
                  </div>
                </div>
                <button
                  className="secondary-button"
                  onClick={() => setDialog("connect")}
                >
                  {library.client ? t("connect.another") : t("connect.short")}
                  <ArrowUpRight size={15} />
                </button>
              </section>
              <section>
                <h3>{t("settings.capabilities")}</h3>
                <div className="capability-list">
                  {getPlatformCapabilities().map((c) => (
                    <div key={c.id}>
                      <span>
                        {c.available ? (
                          <Check size={15} />
                        ) : (
                          <Monitor size={15} />
                        )}
                        <strong>{c.label}</strong>
                        <small>
                          {c.available
                            ? t("common.available")
                            : t("common.unavailable")}
                        </small>
                      </span>
                      <p>{c.detail}</p>
                    </div>
                  ))}
                </div>
              </section>
              <section>
                <h3>{t("settings.privacy")}</h3>
                <p>{t("settings.privacyHint")}</p>
                <button
                  className="text-button"
                  onClick={() => {
                    const diagnostic = {
                      app: "Avid",
                      version: "0.1.0",
                      platform: navigator.platform,
                      capabilities: getPlatformCapabilities().map((c) => ({
                        id: c.id,
                        available: c.available,
                      })),
                      timestamp: new Date().toISOString(),
                    };
                    const url = URL.createObjectURL(
                      new Blob([JSON.stringify(diagnostic, null, 2)], {
                        type: "application/json",
                      }),
                    );
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = "avid-diagnostics.json";
                    a.click();
                    setTimeout(() => URL.revokeObjectURL(url), 5000);
                  }}
                >
                  {t("settings.export")}
                  <ArrowUpRight size={15} />
                </button>
              </section>
              <p className="version-label">{t("settings.preview")}</p>
            </div>
          </Modal>
        )}
        {dialog === "help" && (
          <Modal title={t("footer.help")} onClose={() => setDialog(null)}>
            <div className="help-panel">
              {[
                [
                  "Bring your library",
                  "Open Connect your library and enter your BookOrbit server address and login. The server needs to permit this app’s origin, or be served through a same-origin reverse proxy. Read-only mode saves progress and notes only on this device.",
                ],
                [
                  "Settle into a book",
                  "Open a cover, then Start reading. The reader has contents, search, appearance, text selection, and notes. You can also open a file from your device using the + button.",
                ],
                [
                  "Make the page your own",
                  "Use the reader’s appearance panel to change fonts, text size, spacing, margins, theme, page flow, and animation. Position is saved using the book’s own locator.",
                ],
                [
                  "Listen at your pace",
                  "Open an audiobook to play, pause, skip, choose a chapter, or adjust speed. The sleep timer can stop after a duration or at a chapter boundary. Browser background playback depends on the browser and operating system.",
                ],
                [
                  "Keep a thought",
                  "Select text inside a book to save a highlight or note. Audio notes remember the playback position. Find everything in Notebook and choose Open passage to return.",
                ],
                [
                  "Formats and imported files",
                  "EPUB, DRM-free MOBI, PDF, CBZ, CBR, and CB7 have separate reader adapters. Encrypted books and unsupported codecs report an error. Files opened locally are temporary; complete offline downloads belong to Phase 2.",
                ],
                [
                  "When something goes wrong",
                  "A network failure should not erase your notes. Reconnect to the same server and account to return to its local data. Sync conflicts are preserved for review. Read-only connections never write library changes to the server.",
                ],
                [
                  "About this preview",
                  "The shared web app is under active development. Native background playback, system widgets, CarPlay, AO3 updates, CrossPoint delivery, and full localization have not passed the Phase 1 release gates. The repository checklist records their status.",
                ],
              ].map(([title, text], i) => (
                <details key={title} open={i === 0}>
                  <summary>
                    {title}
                    <ChevronRight size={17} />
                  </summary>
                  <p>{text}</p>
                </details>
              ))}
              <p className="field-hint">
                Keyboard shortcut: Ctrl/⌘ K opens library search. Escape closes
                a dialog.
              </p>
            </div>
          </Modal>
        )}
        {dialog === "upload" && (
          <Modal title={t("upload.title")} onClose={() => setDialog(null)}>
            <div className="upload-panel">
              <button
                className="file-drop"
                onClick={() => filePicker.current?.click()}
              >
                <Upload size={32} />
                <strong>{t("upload.local")}</strong>
                <span>{t("upload.formats")}</span>
                <small>{t("upload.localHint")}</small>
              </button>
              <h3>{t("upload.server")}</h3>
              {!library.client ? (
                <p className="muted">{t("upload.connectHint")}</p>
              ) : library.client.readOnly ? (
                <div className="notice">
                  <ShieldCheck size={20} />
                  <p>{t("upload.readOnly")}</p>
                </div>
              ) : (
                <form
                  className="form-panel"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!uploadFile || !uploadLibrary || !library.client)
                      return;
                    setUploadBusy(true);
                    void library.client
                      .uploadBook(uploadLibrary, uploadFile)
                      .then(() => {
                        notify("Book uploaded. Refreshing your library.");
                        setDialog(null);
                        void library.query({});
                      })
                      .catch((err) => notify(err.message))
                      .finally(() => setUploadBusy(false));
                  }}
                >
                  <label>
                    {t("nav.library")}
                    <select
                      required
                      value={uploadLibrary}
                      onChange={(e) => setUploadLibrary(e.target.value)}
                    >
                      <option value="">{t("upload.choose")}</option>
                      {serverLibraries.map((l) => (
                        <option value={l.id} key={l.id}>
                          {l.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    {t("upload.file")}
                    <input
                      required
                      type="file"
                      onChange={(e) =>
                        setUploadFile(e.target.files?.[0] ?? null)
                      }
                    />
                  </label>
                  <button disabled={uploadBusy} className="primary-button">
                    {uploadBusy ? t("upload.busy") : t("upload.button")}
                  </button>
                </form>
              )}
            </div>
          </Modal>
        )}
        {dialog === "integrations" && (
          <Modal title="Beyond your bookshelf" onClose={() => setDialog(null)}>
            <div className="settings-panel">
              <section>
                <h3>BookOrbit</h3>
                <p>
                  Your library’s source of truth. Books, collections, notes, and
                  progress use a versioned API adapter.
                </p>
                <button
                  className="secondary-button"
                  onClick={() => setDialog("connect")}
                >
                  Manage connection
                  <ArrowUpRight size={15} />
                </button>
              </section>
              <section>
                <h3>CrossPoint e-ink delivery</h3>
                <CrossPointPanel accountScope={library.repo.scope} />
              </section>
              <section>
                <h3>Archive of Our Own</h3>
                <p>
                  Account-based followed-work updates need an opt-in connector
                  with session handling and deduplication. This preview does not
                  connect to AO3.
                </p>
              </section>
              <section>
                <h3>Read and Listen</h3>
                <p>
                  Linked reading requires a verified text-to-audio alignment
                  map. A matching title alone cannot synchronize the two
                  editions. Existing media-overlay integration is tracked in the
                  Phase 1 checklist.
                </p>
              </section>
            </div>
          </Modal>
        )}
        {dialog === "collection" && (
          <Modal
            title={t("collections.dialog")}
            onClose={() => setDialog(null)}
          >
            <form
              className="form-panel"
              onSubmit={(e) => {
                e.preventDefault();
                if (!collectionName.trim() || collectionBusy) return;
                const scope = accountScope.current;
                setCollectionBusy(true);
                void library
                  .createCollection(collectionName.trim())
                  .then(() => {
                    if (scope !== accountScope.current) return;
                    setCollectionName("");
                    setDialog(null);
                    notify(t("collections.created"));
                  })
                  .catch((error) => {
                    if (scope === accountScope.current) notify(error.message);
                  })
                  .finally(() => setCollectionBusy(false));
              }}
            >
              <label>
                {t("collections.name")}
                <input
                  autoFocus
                  required
                  value={collectionName}
                  onChange={(e) => setCollectionName(e.target.value)}
                  placeholder={t("collections.placeholder")}
                />
              </label>
              <p className="field-hint">
                {library.client
                  ? t("collections.serverHint")
                  : t("collections.localHint")}
              </p>
              <button
                className="primary-button"
                disabled={collectionBusy || library.client?.readOnly}
              >
                {collectionBusy
                  ? t("collections.creating")
                  : t("collections.create")}
              </button>
            </form>
          </Modal>
        )}
        <input
          ref={filePicker}
          type="file"
          className="sr-only"
          tabIndex={-1}
          accept=".epub,.mobi,.azw3,.pdf,.cbz,.cbr,.cb7,.mp3,.m4b,.m4a,.ogg,.opus,.flac,.wav"
          onChange={(e) => void importLocal(e)}
        />
      </div>
    </CoverContext.Provider>
  );
}
