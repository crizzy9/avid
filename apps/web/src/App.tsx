import { useI18n, LOCALES, type Locale } from "../../../packages/i18n/src";
import { useAppI18n, appMessageKeysByEnglish } from "./appMessages";
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
  UserRound,
  Download,
} from "lucide-react";
import type {
  Annotation,
  Book,
  BookFile,
  ReadingAnchor,
  BookOrbitReadStatus,
  Session,
} from "../../../packages/core/src/types";
import {
  resolveAudioResume,
  type PlaybackBook,
} from "../../../packages/playback/src";
import { demoBooks } from "./fixtures";
import { useLibrary } from "./useLibrary";
import { createPlatformLibraryStorage } from "../../mobile/src/native-storage";
import {
  getCrossPointFetch,
  getReaderDiscovery,
} from "../../mobile/src/native-crosspoint";
import { useLocalState } from "./useLocalState";
import { inReadingQueue, serverShelfFilter } from "./queueFilter";
import { BookCard, Cover, EmptyState, Modal, Shelf, formatTime } from "./ui";
import { Connect, bookOrbitFetch, proxyBaseFor } from "./Connect";
import { getNativeSessionVault } from "../../mobile/src/native-session";
import { getNativeJournal } from "../../mobile/src/native-journal";
import {
  createNativeSessionRefresh,
  getNativeAuth,
  nativeAuthScope,
} from "../../mobile/src/native-auth";
import { SessionPersistence } from "./sessionPersistence";
import { restoreNativeSession } from "./restoreNativeSession";
import { Player } from "./Player";
import { BookDetails } from "./BookDetails";
import { LibraryGlyph, BrowseGlyph } from "./NavigationIcons";
import { Activity } from "./Activity";
import {
  getDesktopFetch,
  resolveDesktopPlaybackBook,
} from "../../desktop/src/network";
import { CrossPointPanel, AO3Panel } from "../../../packages/integrations/src";
import { createCrossPointLibrarySources } from "./crossPointSources";
import {
  ProviderCallback,
  getNativeProviderCoordinator,
} from "./ProviderSignIn";
import { startNativeAuthentication } from "./nativeAuthentication";
import { setNativeAppearance } from "../../mobile/src/native-appearance";
import { useImportedBooks } from "./useImportedBooks";
import { useHomeShelves, uniqueBooks } from "./useHomeShelves";
import { PinnedHomeShelves } from "./PinnedHomeShelves";
import { useCurrentBookDescription } from "./useCurrentBookDescription";
import { descriptionToPlainText } from "./descriptionText";
import { useDesktopSurfaces } from "./useDesktopSurfaces";
import { SyncRecoveryPanel } from "./SyncRecoveryPanel";
import { readRemotePolicy } from "../../../packages/playback/src/remotePolicy";
import { createBookOrbitReaderPreferences } from "./readerPreferences";
import { recoveryTranslate } from "./recoveryMessages";
import { importAo3Edition, type ImportedAo3Edition } from "./localEditions";
import { usePlaybackActivity } from "./usePlaybackActivity";
import { createPlaybackTransport } from "../../mobile/src/native-transport";
import {
  getNativePlayback,
  readOwnerSnapshot,
} from "../../mobile/src/native-playback";
import { useNativeSurfaces } from "./useNativeSurfaces";
import { usePlatformCapabilities } from "./usePlatformCapabilities";
import type { NativeNavigation } from "../../mobile/src/native-surfaces";
import { useReadingActivity } from "./useReadingActivity";
import { SeriesBrowser } from "./SeriesBrowser";
import { BookFormatRequests } from "./BookFormatRequests";
import { formatRequestT } from "./formatRequestMessages";
import { createServerSpeechProvider } from "./serverSpeechProvider";
import { registerOnlineSpeechProvider } from "../../../packages/playback/src/speechRuntime";
import { StoryArcBrowser } from "./StoryArcBrowser";
import { TopNotificationBanner } from "./TopNotificationBanner";
import { useAppNotifications } from "./appNotifications";
import { VirtualBookGrid } from "./VirtualBookGrid";
import { ReferenceLibrary } from "./ReferenceLibrary";
import {
  partitionReferenceBooks,
  upsertCatalogBook,
} from "./referenceLibraryData";
import { CoverContext } from "./CoverContext";
import {
  chooseBookFile,
  readerKindForFile,
} from "../../../packages/readers/src/bookFile";
import { newestAnchor } from "./resume";
import { PrepareReadListen } from "./PrepareReadListen";
import { usePreparationI18n } from "./preparationMessages";
import type {
  ReaderAlignmentHandle,
  AlignedPassageText,
} from "../../../packages/readers/src/alignedPassage";
import {
  alignedAudioAnchor,
  alignedTextTarget,
  alignedPlaybackSeconds,
  alignmentSha256,
  handoffToText,
  type VerifiedAudioAlignment,
} from "../../../packages/playback/src/standalone-alignment";
import { ReadAlongPanel } from "./ReadAlongPanel";
import { HandoffControls } from "./HandoffControls";
import { useReadAlongI18n } from "./readAlongMessages";
import {
  readHandoffPolicy,
  handoffPolicyKey,
  latestConfirmedPosition,
  validReaderPosition,
  matchingAlignedPlayback,
  type HandoffPolicy,
  type ConfirmedLinkedPosition,
} from "./readAlongState";
import { playerTimeline } from "./playerTimeline";
import { playerRemainingLabel } from "./playerMessages";

type View =
  "home" | "library" | "browse" | "search" | "notebook" | "activity" | "more";
const Reader = lazy(() =>
  import("../../../packages/readers/src/Reader").then((module) => ({
    default: module.Reader,
  })),
);
const OfflineDownloads = lazy(() =>
  import("./OfflineDownloads").then((module) => ({
    default: module.OfflineDownloads,
  })),
);
type Dialog =
  | "connect"
  | "settings"
  | "help"
  | "upload"
  | "integrations"
  | "collection"
  | "recovery"
  | "requests"
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
  const { t: appT } = useAppI18n();
  const readAlongText = useReadAlongI18n();
  const preparationText = usePreparationI18n();
  const platformCapabilities = usePlatformCapabilities();
  const navigation = [
    { id: "home", label: t("nav.home"), icon: Home },
    { id: "library", label: t("nav.library"), icon: LibraryGlyph },
    { id: "browse", label: t("nav.browse"), icon: BrowseGlyph },
    { id: "more", label: t("nav.more"), icon: MoreHorizontal },
  ] as const;

  const [sessionPersistence] = useState(
    () => new SessionPersistence(getNativeSessionVault()),
  );
  const [nativeAuth] = useState(getNativeAuth);
  const [nativeProvider] = useState(getNativeProviderCoordinator);
  const nativeProviderAttempt = useRef<number | null>(null);
  const [providerCallbackAtLaunch] = useState(
    () => location.pathname === "/oauth2-callback",
  );
  const [libraryStorage] = useState(createPlatformLibraryStorage);
  const library = useLibrary({
    storage: libraryStorage,
    refreshSession: nativeAuth ? refreshNativeSession : undefined,
    onSessionChange: (session, readOnly, active) => {
      return sessionPersistence
        .persist(session, readOnly, active)
        .catch((error) => {
          if (active()) setToast(appT("secureStorage"));
          throw error;
        });
    },
  });
  useEffect(() => {
    const client = library.client;
    if (!client) {
      registerOnlineSpeechProvider(null);
      return;
    }
    let active = true;
    const provider = createServerSpeechProvider(client, {
      isActive: () => active,
    });
    registerOnlineSpeechProvider(provider);
    return () => {
      active = false;
      registerOnlineSpeechProvider(null);
      provider.dispose();
    };
  }, [library.client]);
  const importedBooks = useImportedBooks(library.repo);
  const syncMessage = appMessageKeysByEnglish[library.syncStatus];
  const [view, setView] = useState<View>(() => {
    const v = new URLSearchParams(location.search).get("view");
    return [
      "home",
      "library",
      "browse",
      "more",
      "search",
      "notebook",
      "activity",
    ].includes(v ?? "")
      ? (v as View)
      : "home";
  });
  const [dialog, setDialog] = useState<Dialog>(null);
  const connectionGeneration = useRef(0);
  async function refreshNativeSession(session: Session): Promise<Session> {
    if (!nativeAuth) throw new Error(appT("nativeRenewalUnavailable"));
    const attempt = connectionGeneration.current;
    const active = () => connectionGeneration.current === attempt;
    const latest = await getNativeSessionVault()!.read();
    if (!active())
      throw new DOMException(appT("connectionChanged"), "AbortError");
    // A background owner may have renewed this token before JS saw its event.
    if (
      latest.session &&
      nativeAuthScope(latest.session) === nativeAuthScope(session) &&
      latest.session.profile.id === session.profile.id &&
      latest.session.accessToken !== session.accessToken
    ) {
      await sessionPersistence.adoptNativeRecord(latest, active);
      return latest.session;
    }
    return createNativeSessionRefresh({
      plugin: nativeAuth,
      onRecord: (record) =>
        sessionPersistence.adoptNativeRecord(record, active),
    })(session);
  }
  const dialogRef = useRef(dialog);
  dialogRef.current = dialog;
  function openConnection() {
    connectionGeneration.current++;
    nativeProviderAttempt.current = null;
    void nativeProvider
      ?.cancel()
      .catch(() => setToast(appT("previousProviderClear")));
    setDialog("connect");
  }
  function closeConnection() {
    connectionGeneration.current++;
    nativeProviderAttempt.current = null;
    void nativeProvider
      ?.cancel()
      .catch(() => setToast(appT("providerClearRetry")));
    setDialog(null);
  }
  const [selected, setSelected] = useState<Book | null>(null);
  const [reader, setReader] = useState<ReaderState | null>(null);
  const [homeRevision, setHomeRevision] = useState(0);
  const home = useHomeShelves(
    library.client,
    library.repo,
    view === "home" && !reader,
    homeRevision,
  );
  const catalogBooks = useMemo(
    () =>
      uniqueBooks([
        ...library.books,
        ...(view === "home"
          ? [...home.continuing, ...home.queue, ...home.recent]
          : []),
        ...importedBooks,
      ]),
    [
      library.books,
      home.continuing,
      home.queue,
      home.recent,
      importedBooks,
      view,
    ],
  );
  useEffect(() => {
    library.coverCache?.register([
      ...home.continuing,
      ...home.queue,
      ...home.recent,
    ]);
  }, [library.coverCache, home.continuing, home.queue, home.recent]);
  useEffect(() => {
    if (home.error) library.setError(home.error);
  }, [home.error, library.setError]);
  const [readerAlignment, setReaderAlignment] =
    useState<ReaderAlignmentHandle | null>(null);
  const [alignment, setAlignment] = useState<VerifiedAudioAlignment | null>(
    null,
  );
  const [readingBusy, setReadingBusy] = useState(false);
  const [timedText, setTimedText] = useState<readonly AlignedPassageText[]>([]);
  const [linkedSource, setLinkedSource] = useState<ReaderState | null>(null);
  const [handoffPolicy, setHandoffPolicy] = useState<HandoffPolicy>("manual");
  const [previewReading, setPreviewReading] = useState(false);
  const [followAudio, setFollowAudio] = useState(false);
  const [showDownloads, setShowDownloads] = useState(false);
  const [showPreparationPicker, setShowPreparationPicker] = useState(false);
  const [undoAudioPosition, setUndoAudioPosition] = useState<{
    source: PlaybackBook;
    seconds: number;
  }>();
  const [previewPosition, setPreviewPosition] = useState<{
    source: ReaderState;
    anchor: ReadingAnchor;
  }>();
  const confirmedPositions = useRef<ConfirmedLinkedPosition[]>([]);
  const lastAudioCheckpoint = useRef<
    { bookId: string; fileId: string; seconds: number } | undefined
  >(undefined);
  const confirmedAudioAnchor = useRef<ReadingAnchor | undefined>(undefined);
  const confirmedTextAnchor = useRef<
    { source: ReaderState; anchor: ReadingAnchor } | undefined
  >(undefined);
  const currentAlignment = useRef(alignment);
  currentAlignment.current = alignment;
  const readingConfirmation = useRef(0);
  const alignmentAttempt = useRef(0);
  const pendingReadingConfirmation = useRef<Promise<boolean> | null>(null);
  const currentReader = useRef(reader);
  currentReader.current = reader;
  const currentReaderHandle = useRef(readerAlignment);
  currentReaderHandle.current = readerAlignment;
  const notifications = useAppNotifications(library.repo.scope);
  const setToast = notifications.notify;
  const [search, setSearch] = useState("");
  const [noteQuery, setNoteQuery] = useState("");
  const [noteBook, setNoteBook] = useState("all");
  const [format, setFormat] = useLocalState("format", "all");
  const [libraryNavigationRevision, setLibraryNavigationRevision] = useState(0);
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
  const crossPointContext = useRef({
    repo: library.repo,
    client: library.client,
  });
  crossPointContext.current = { repo: library.repo, client: library.client };
  const crossPointFiles = useMemo(() => {
    const repo = library.repo,
      client = library.client;
    return createCrossPointLibrarySources({
      books: catalogBooks,
      repo,
      client,
      isActive: () =>
        accountScope.current === repo.scope &&
        crossPointContext.current.repo === repo &&
        crossPointContext.current.client === client,
    });
  }, [catalogBooks, library.repo, library.client]);
  const readOnlyConnection = useRef(true);
  readOnlyConnection.current = library.client?.readOnly !== false;
  const readerPreferences = useMemo(
    () =>
      reader && library.client
        ? createBookOrbitReaderPreferences({
            repo: library.repo,
            client: library.client,
            bookId: reader.book.id,
            file: reader.file,
            isActive: () => accountScope.current === reader.ownerScope,
            onQueued: library.recoverSync,
          })
        : undefined,
    [
      reader?.ownerScope,
      reader?.book.id,
      reader?.file.id,
      library.repo,
      library.client,
      library.recoverSync,
    ],
  );
  const [controller] = useState(() =>
    createPlaybackTransport({
      accountScope: () => accountScope.current,
      readOnly: () => readOnlyConnection.current,
      remotePolicy: readRemotePolicy(localStorage),
    }),
  );
  const playback = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
  );
  useEffect(() => {
    const map = alignment,
      handle = readerAlignment;
    if (
      !reader ||
      !map ||
      !handle ||
      map.edition.bookId !== reader.book.id ||
      map.edition.textFileId !== reader.file.id ||
      !matchingAlignedPlayback(map, controller.getBook(), library.repo.scope)
    ) {
      handle?.clearAudioHighlight?.();
      return;
    }
    if (previewReading) {
      handle.clearAudioHighlight?.();
      return;
    }
    const seconds = alignedPlaybackSeconds(map, playback);
    if (seconds === null) {
      handle.clearAudioHighlight?.();
      return;
    }
    let active = true;
    void handle
      .followAudio?.(map, map.edition, seconds, {
        follow: followAudio,
      })
      .catch((error) => {
        if (active) setToast(String(error));
      });
    return () => {
      active = false;
    };
  }, [
    alignment,
    readerAlignment,
    reader,
    playback.currentTime,
    playback.bookId,
    playback.fileId,
    playback.status,
    playback.duration,
    playback.trackIndex,
    previewReading,
    followAudio,
    library.repo.scope,
    controller,
  ]);
  useEffect(
    () => () => {
      readerAlignment?.clearAudioHighlight?.();
    },
    [
      alignment,
      readerAlignment,
      reader,
      library.repo.scope,
      playback.bookId,
      playback.fileId,
    ],
  );
  const disposeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const playerUrls = useRef<string[]>([]);
  const localSources = useRef(
    new Map<string, { book: Book; sources: Map<string, File> }>(),
  );
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
  const uploadAttempt = useRef(0);

  const notify = (message: string) => setToast(message);
  useEffect(() => {
    if (providerCallbackAtLaunch) return;
    const abort = new AbortController();
    const stop = startNativeAuthentication({
      provider: nativeProvider,
      canRestore: () => connectionGeneration.current === 0,
      attempt: () => nativeProviderAttempt.current,
      claimStartup: () => {
        nativeProviderAttempt.current = 0;
      },
      active: (attempt) =>
        nativeProviderAttempt.current === attempt &&
        connectionGeneration.current === attempt,
      connect: library.connect,
      connected: () => {
        nativeProviderAttempt.current = null;
        connectionGeneration.current++;
        controller.pause();
        setPlayerBook(null);
        setDialog(null);
        setView("home");
        setToast(appT("connected"));
      },
      restore: (active) =>
        restoreNativeSession(
          sessionPersistence,
          (url) => ({
            fetch: bookOrbitFetch,
            transportBaseUrl: proxyBaseFor(url),
            refreshSession: nativeAuth ? refreshNativeSession : undefined,
          }),
          library.connect,
          active,
          abort.signal,
        ),
      error: (error) =>
        setToast(
          error instanceof Error ? error.message : appT("restoreFailed"),
        ),
    });
    return () => {
      stop();
      abort.abort();
    };
  }, [
    sessionPersistence,
    nativeProvider,
    nativeAuth,
    library.connect,
    providerCallbackAtLaunch,
    controller,
  ]);

  useEffect(() => {
    if (!nativeAuth) return;
    let mounted = true;
    const listener = nativeAuth.addListener("sessionChanged", (event) => {
      const attempt = connectionGeneration.current;
      const active = () =>
        mounted &&
        attempt === connectionGeneration.current &&
        event.accountScope === accountScope.current;
      if (!active()) return;
      void getNativeSessionVault()!
        .read()
        .then(async (record) => {
          if (active() && record.generation === event.generation)
            await sessionPersistence.adoptNativeRecord(record, active);
        })
        .catch(() => {
          if (active()) setToast(appT("renewedRestoreFailed"));
        });
    });
    return () => {
      mounted = false;
      void listener.then((handle) => handle.remove()).catch(() => {});
    };
  }, [nativeAuth, sessionPersistence]);

  const publishMobileRecent = useNativeSurfaces(
    library.repo.scope,
    !!library.client,
    catalogBooks,
    (request) => {
      void openNativeBook(request);
    },
    notify,
  );
  const publishDesktopRecent = useDesktopSurfaces({
    loadCover: library.client
      ? (id, signal) => library.client!.coverBlob(id, signal)
      : undefined,
    repo: library.repo,
    connected: !!library.client,
    controller,
    mediaScope: playbackScope.current,
    onOpen: (request) => {
      void openNativeBook(request);
    },
    onError: notify,
  });
  function publishNativeRecent(
    book: Book,
    file: BookFile,
    anchor?: ReadingAnchor,
  ) {
    publishMobileRecent(book, file, anchor);
    publishDesktopRecent(book, file, anchor);
  }
  const changeReadingActivity = useReadingActivity(
    playback.status === "playing" ? null : reader,
    library.recordSession,
    {
      accountScope: library.repo.scope,
      readOnly: library.client?.readOnly !== false,
      onError: notify,
    },
  );
  usePlaybackActivity(controller, library.recordSession, {
    enabled: !getNativeJournal(),
    readOnly: library.client?.readOnly !== false,
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
    setAlignment(null);
    setTimedText([]);
    setLinkedSource(null);
    setPreviewReading(false);
    setFollowAudio(false);
    setUndoAudioPosition(undefined);
    setPreviewPosition(undefined);
    lastAudioCheckpoint.current = undefined;
    readingConfirmation.current++;
    alignmentAttempt.current++;
    pendingReadingConfirmation.current = null;
    confirmedPositions.current = [];
    confirmedAudioAnchor.current = undefined;
    confirmedTextAnchor.current = undefined;
    setReaderAlignment(null);
    uploadAttempt.current++;
    setServerLibraries([]);
    setUploadLibrary("");
    setUploadFile(null);
    setUploadBusy(false);
    localSources.current.clear();
    for (const url of playerUrls.current) URL.revokeObjectURL(url);
    playerUrls.current = [];
  }, [library.repo.scope, controller]);
  useEffect(() => {
    const client = library.client;
    if (!client || !controller.adoptNative) return;
    let canceled = false;
    const scope = library.repo.scope;
    const opening = openRequest.current;
    const active = () =>
      !canceled &&
      accountScope.current === scope &&
      openRequest.current === opening;
    void (async () => {
      const owner = await readOwnerSnapshot();
      if (!owner || owner.accountScope !== scope || !active()) return;
      const book =
        (await library.repo.getBook(owner.bookId)) ??
        (await client.getBook(owner.bookId));
      if (
        !active() ||
        !book.files.some(
          (file) => file.id === owner.fileId && file.format === "AUDIO",
        )
      )
        return;
      const source = await client.getPlaybackSource(book);
      if (!active()) return;
      playbackScope.current = scope;
      if ((await controller.adoptNative!(source)) && active())
        setPlayerBook(book);
    })().catch(() => {
      if (active()) setToast(appT("audioRestoreFailed"));
    });
    return () => {
      canceled = true;
    };
  }, [library.client, library.repo, controller]);
  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const update = () => {
      document.documentElement.dataset.theme =
        theme === "system" ? (mq.matches ? "dark" : "light") : theme;
      void setNativeAppearance(
        theme === "dark" || theme === "light" ? theme : "system",
        locale,
      ).catch(() => setToast(appT("appearanceFailed")));
    };
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [theme, locale]);
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
              ...serverShelfFilter(activeCollection),
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
        let seconds: number;
        try {
          seconds = JSON.parse(anchor.locator).time;
        } catch {
          return;
        }
        if (!Number.isFinite(seconds)) return;
        const previousClock = lastAudioCheckpoint.current;
        if (
          previousClock?.bookId === anchor.bookId &&
          previousClock.fileId === anchor.fileId &&
          previousClock.seconds === seconds &&
          controller.getSnapshot().status !== "playing"
        )
          return;
        lastAudioCheckpoint.current = {
          bookId: anchor.bookId,
          fileId: anchor.fileId,
          seconds,
        };
        if (playbackScope.current === library.repo.scope)
          confirmedAudioAnchor.current = anchor;
        const linked = currentAlignment.current;
        if (
          playbackScope.current === library.repo.scope &&
          linked &&
          matchingAlignedPlayback(
            linked,
            controller.getBook(),
            library.repo.scope,
          ) &&
          linked.edition.bookId === anchor.bookId &&
          linked.edition.audioFileId === anchor.fileId &&
          alignedPlaybackSeconds(linked, controller.getSnapshot()) !== null
        ) {
          const previous = confirmedPositions.current.find(
            (item) => item.source === "listening",
          );
          if (previous?.seconds !== seconds)
            confirmedPositions.current = [
              ...confirmedPositions.current.filter(
                (item) => item.source !== "listening",
              ),
              { source: "listening", seconds, updatedAt: anchor.updatedAt },
            ];
        }
        if (!getNativeJournal() && playbackScope.current === library.repo.scope)
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
    const attempt = ++uploadAttempt.current;
    const client = library.client;
    const scope = library.repo.scope;
    let active = true;
    setServerLibraries([]);
    setUploadLibrary("");
    setUploadFile(null);
    setUploadBusy(false);
    if (dialog === "upload" && client)
      client
        .listLibraries()
        .then((rows) => {
          if (
            active &&
            attempt === uploadAttempt.current &&
            accountScope.current === scope
          )
            setServerLibraries(rows);
        })
        .catch((e) => {
          if (active && attempt === uploadAttempt.current) notify(e.message);
        });
    return () => {
      active = false;
    };
  }, [dialog, library.client, library.repo.scope]);

  function finishReading() {
    currentReader.current = null;
    alignmentAttempt.current++;
    setPreviewPosition(undefined);
    setReader(null);
  }
  function navigate(next: View) {
    setView(next);
    if (next === "library")
      setLibraryNavigationRevision((revision) => revision + 1);
    setMenu(false);
    setActiveCollection(null);
    if (next === "home" || next === "browse") setFormat("all");
    if (next !== "search") setSearch("");
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  const books = useMemo(() => {
    let items =
      format === "all"
        ? catalogBooks
        : partitionReferenceBooks(catalogBooks)[
            format === "audio" || format === "comics" ? format : "books"
          ];
    if (library.client) {
      items = items.filter(
        (book) =>
          !book.id.startsWith("local-") ||
          ((!activeCollection ||
            (activeCollection === "queue" &&
              book.serverStatus === "want_to_read")) &&
            (!search ||
              `${book.title} ${book.authors.join(" ")} ${book.genres.join(" ")}`
                .toLocaleLowerCase()
                .includes(search.toLocaleLowerCase()))),
      );
    }
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
    catalogBooks,
    library.client,
    library.collections,
    format,
    search,
    sort,
    activeCollection,
  ]);
  const currentBook =
    home.continuing[0] ??
    catalogBooks.find((b) => b.progress > 0 && b.progress < 1) ??
    catalogBooks[0];
  const currentDescription = useCurrentBookDescription(
    library.client,
    currentBook,
    view === "home" && !reader,
  );
  const selectedBook = selected
    ? (catalogBooks.find((b) => b.id === selected.id) ?? selected)
    : null;
  const notes = library.annotations.filter(
    (n) =>
      (noteBook === "all" || n.bookId === noteBook) &&
      `${n.quote} ${n.text}`.toLowerCase().includes(noteQuery.toLowerCase()),
  );
  const continuing = uniqueBooks([
    ...home.continuing,
    ...catalogBooks.filter(
      (book) => book.progress > 0 && book.progress < 0.995,
    ),
  ]).slice(0, 12);
  const queue = uniqueBooks([
    ...home.queue,
    ...catalogBooks.filter((book) =>
      inReadingQueue(book, library.collections, !!library.client),
    ),
  ]).slice(0, 12);

  async function openReader(
    book: Book,
    requestedAnchor?: ReadingAnchor,
    expectedTextHash?: string,
    keepAudio = false,
  ): Promise<boolean> {
    if (
      !keepAudio &&
      ["playing", "buffering"].includes(controller.getSnapshot().status)
    )
      controller.pause();
    const scope = accountScope.current;
    openRequest.current?.abort();
    const request = new AbortController();
    openRequest.current = request;
    let file: BookFile | undefined;
    try {
      file = chooseBookFile(book, requestedAnchor);
    } catch (e) {
      notify(e instanceof Error ? e.message : appT("positionUnavailable"));
      return false;
    }
    if (!file) {
      return await listen(book);
    }
    setReadingBusy(true);
    try {
      await library
        .recoverNative()
        .catch(() => notify(appT("historyRecoveryFailed")));
      if (scope !== accountScope.current || request.signal.aborted)
        return false;
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
      const mapped =
        alignment?.edition.bookId === book.id &&
        alignment.edition.accountScope === scope
          ? alignment
          : null;
      const confirmed = latestConfirmedPosition(confirmedPositions.current);
      if (
        !requestedAnchor &&
        mapped &&
        handoffPolicy === "latest" &&
        confirmed?.source === "listening"
      ) {
        const target = alignedTextTarget(
          mapped,
          mapped.edition,
          confirmed.seconds,
        );
        if (
          target &&
          target.fileId === file.id &&
          (!anchor ||
            Date.parse(confirmed.updatedAt) > Date.parse(anchor.updatedAt))
        ) {
          anchor = {
            bookId: book.id,
            fileId: file.id,
            kind: "epub",
            locator: target.locator,
            progress: confirmed.seconds / mapped.duration,
            updatedAt: confirmed.updatedAt,
          };
          expectedTextHash = mapped.edition.textSha256;
        }
      }
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
        localSources.current.get(book.id)?.sources.get(file.id) ??
        (book.id.startsWith("local-")
          ? await library.repo.getLocalFile(file.id)
          : undefined) ??
        (library.client && !book.id.startsWith("local-")
          ? await library.client.getFileBlob(file.id, request.signal)
          : undefined);
      if (book.id.startsWith("local-") && !source)
        throw new Error(appT("editionUnavailable"));
      if (scope !== accountScope.current || request.signal.aborted)
        return false;
      if (
        expectedTextHash &&
        (!source ||
          (await alignmentSha256(await source.arrayBuffer())) !==
            expectedTextHash)
      ) {
        if (scope !== accountScope.current || request.signal.aborted)
          return false;
        setAlignment(null);
        throw new Error(appT("epubChanged"));
      }
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
      if (scope !== accountScope.current || request.signal.aborted)
        return false;
      alignmentAttempt.current++;
      readingConfirmation.current++;
      pendingReadingConfirmation.current = null;
      currentReaderHandle.current = null;
      setReaderAlignment(null);
      setPreviewPosition(undefined);
      setPreviewReading(false);
      setFollowAudio(keepAudio);
      const openedReader = { book, file, source, anchor, ownerScope: scope };
      currentReader.current = openedReader;
      setReader(openedReader);
      if (!keepAudio) publishNativeRecent(book, file, anchor);
      setSelected(null);
      return true;
    } catch (e) {
      if (scope === accountScope.current && !request.signal.aborted)
        notify(e instanceof Error ? e.message : appT("bookOpenFailed"));
      return false;
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
    if (["playing", "buffering"].includes(controller.getSnapshot().status))
      controller.pause();
    let file: BookFile | undefined;
    try {
      file = chooseBookFile(book, requestedAnchor, "audio");
    } catch (e) {
      notify(e instanceof Error ? e.message : appT("positionUnavailable"));
      return false;
    }
    if (!file) {
      notify(appT("noAudiobook"));
      return false;
    }
    setReadingBusy(true);
    let bundledAudioUrl: string | undefined;
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
        throw new Error(appT("audioNoteSource"));
      let url = file.url;
      if (!playbackSource && !url) throw new Error(appT("noAudioSource"));
      if (
        getNativePlayback() &&
        book.id.startsWith("demo-") &&
        url === "/samples/narration.wav"
      ) {
        const host = globalThis as typeof globalThis & {
          CapacitorWebFetch?: typeof fetch;
        };
        const webFetch =
          host.CapacitorWebFetch?.bind(globalThis) ??
          globalThis.fetch.bind(globalThis);
        const response = await webFetch(url, { signal: request.signal });
        if (!response.ok) throw new Error(appT("audioLoadFailed"));
        const blob = await response.blob();
        if (scope !== accountScope.current || request.signal.aborted)
          return false;
        bundledAudioUrl = URL.createObjectURL(blob);
        url = bundledAudioUrl;
      }
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
      let source: PlaybackBook = playbackSource ?? {
        bookId: book.id,
        fileId: file.id,
        title: book.title,
        authors: book.authors,
        coverUrl: book.coverUrl,
        tracks: [{ id: file.id, url: url! }],
        chapters: book.chapters,
      };
      if (getDesktopFetch())
        source = await resolveDesktopPlaybackBook(
          source,
          scope,
          () => scope === accountScope.current && !request.signal.aborted,
        );
      let time = saved ? resolveAudioResume(source, saved.locator) : 0;
      const confirmed = latestConfirmedPosition(confirmedPositions.current);
      if (
        !requestedAnchor &&
        handoffPolicy === "latest" &&
        matchingAlignedPlayback(alignment, source, scope) &&
        confirmed?.source === "reading" &&
        (!saved ||
          Date.parse(confirmed.updatedAt) > Date.parse(saved.updatedAt))
      )
        time = confirmed.seconds;
      if (scope !== accountScope.current || request.signal.aborted)
        return false;
      controller.checkpoint();
      playbackScope.current = null;
      lastAudioCheckpoint.current = {
        bookId: source.bookId,
        fileId: source.fileId,
        seconds: time,
      };
      confirmedAudioAnchor.current = saved;
      setUndoAudioPosition(undefined);
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
        notify(e instanceof Error ? e.message : appT("audioLoadFailed"));
      return false;
    } finally {
      if (bundledAudioUrl) URL.revokeObjectURL(bundledAudioUrl);
      if (scope === accountScope.current && openRequest.current === request)
        setReadingBusy(false);
    }
  }

  async function listenFromText(
    map: VerifiedAudioAlignment,
    handle: ReaderAlignmentHandle,
  ) {
    const activeReader = reader;
    if (
      !activeReader ||
      map.edition.accountScope !== accountScope.current ||
      activeReader.book.id !== map.edition.bookId ||
      activeReader.file.id !== map.edition.textFileId ||
      currentReader.current !== activeReader ||
      currentReaderHandle.current !== handle
    )
      return;
    try {
      const passage = await handle.currentPassage(map, map.edition);
      if (!passage) throw new Error(appT("noAudioPosition"));
      const anchor = alignedAudioAnchor(map, map.edition, passage.textLocator);
      if (
        !anchor ||
        map.edition.accountScope !== accountScope.current ||
        currentReader.current !== activeReader ||
        currentReaderHandle.current !== handle
      )
        return;
      handle.pauseNarration();
      const opened = await listen(activeReader.book, anchor);
      if (opened && currentReader.current === activeReader) finishReading();
      else throw new Error(appT("linkedAudioFailed"));
    } catch (error) {
      if (map.edition.accountScope === accountScope.current) throw error;
    }
  }
  async function acceptAlignment(map: VerifiedAudioAlignment) {
    const source = reader,
      handle = readerAlignment;
    const attempt = ++alignmentAttempt.current;
    const active = () =>
      currentReader.current === source &&
      currentReaderHandle.current === handle &&
      accountScope.current === map.edition.accountScope &&
      alignmentAttempt.current === attempt;
    if (
      !source ||
      !handle ||
      !active() ||
      source.book.id !== map.edition.bookId ||
      source.file.id !== map.edition.textFileId
    )
      return;
    try {
      const text = (await handle.getTimedText?.(map, map.edition)) ?? [];
      if (!active()) return;
      currentAlignment.current = map;
      setAlignment(map);
      setTimedText(text);
      setLinkedSource(source);
      setUndoAudioPosition(undefined);
      setHandoffPolicy(
        readHandoffPolicy(map.edition.accountScope, map.edition.bookId),
      );
      confirmedPositions.current = [];
      // Seed only checkpoints actually observed and stored for this mounted text source.
      await pendingReadingConfirmation.current;
      if (!active() || currentAlignment.current !== map) return;
      const reading = confirmedTextAnchor.current;
      if (
        reading?.source === source &&
        validReaderPosition(source, accountScope.current, reading.anchor)
      ) {
        const passage = await handle.passageAtLocator?.(
          map,
          map.edition,
          reading.anchor.locator,
        );
        if (!active() || currentAlignment.current !== map) return;
        if (passage && confirmedTextAnchor.current === reading)
          confirmedPositions.current = [
            ...confirmedPositions.current.filter(
              (item) => item.source !== "reading",
            ),
            {
              source: "reading",
              seconds: passage.start,
              updatedAt: reading.anchor.updatedAt,
              textAnchor: reading.anchor,
            },
          ];
      }
      const audio = confirmedAudioAnchor.current;
      if (
        audio &&
        audio.bookId === map.edition.bookId &&
        audio.fileId === map.edition.audioFileId &&
        matchingAlignedPlayback(map, controller.getBook(), accountScope.current)
      ) {
        try {
          const clock = JSON.parse(audio.locator);
          if (
            clock.manifestRevision === map.edition.manifestRevision &&
            alignedPlaybackSeconds(map, {
              bookId: audio.bookId,
              fileId: audio.fileId,
              trackIndex: map.tracks.findIndex(
                (track) => track.id === clock.trackId,
              ),
              currentTime: clock.time,
            }) !== null
          )
            confirmedPositions.current = [
              ...confirmedPositions.current.filter(
                (item) => item.source !== "listening",
              ),
              {
                source: "listening",
                seconds: clock.time,
                updatedAt: audio.updatedAt,
              },
            ];
        } catch {
          /* A malformed saved locator is not a confirmed linked position. */
        }
      }
    } catch (error) {
      if (active())
        notify(error instanceof Error ? error.message : appT("linkFailed"));
    }
  }
  async function seedObservedReading(
    source: ReaderState,
    handle: ReaderAlignmentHandle,
  ) {
    const map = currentAlignment.current;
    const active = () =>
      currentReader.current === source &&
      currentReaderHandle.current === handle &&
      currentAlignment.current === map &&
      source.ownerScope === accountScope.current;
    if (
      !map ||
      map.edition.bookId !== source.book.id ||
      map.edition.textFileId !== source.file.id ||
      map.edition.accountScope !== source.ownerScope ||
      !active()
    )
      return;
    await pendingReadingConfirmation.current;
    const reading = confirmedTextAnchor.current;
    if (
      !active() ||
      reading?.source !== source ||
      !validReaderPosition(source, accountScope.current, reading.anchor)
    )
      return;
    const passage = await handle.passageAtLocator?.(
      map,
      map.edition,
      reading.anchor.locator,
    );
    if (passage && active() && confirmedTextAnchor.current === reading)
      confirmedPositions.current = [
        ...confirmedPositions.current.filter(
          (item) => item.source !== "reading",
        ),
        {
          source: "reading",
          seconds: passage.start,
          updatedAt: reading.anchor.updatedAt,
          textAnchor: reading.anchor,
        },
      ];
  }
  function changeHandoffPolicy(value: HandoffPolicy) {
    setHandoffPolicy(value);
    if (alignment)
      try {
        localStorage.setItem(
          handoffPolicyKey(
            alignment.edition.accountScope,
            alignment.edition.bookId,
          ),
          value,
        );
      } catch (error) {
        notify(String(error));
      }
  }
  async function returnToPlayer() {
    const source = reader,
      map = alignment,
      handle = readerAlignment,
      audio = controller.getBook();
    // Keep the publication alive until a just-observed page has resolved and saved.
    let pending;
    do {
      pending = pendingReadingConfirmation.current;
      await pending;
    } while (pending !== pendingReadingConfirmation.current);
    if (
      !source ||
      currentReader.current !== source ||
      source.ownerScope !== accountScope.current ||
      currentAlignment.current !== map ||
      controller.getBook() !== audio
    )
      return;
    const confirmed = latestConfirmedPosition(confirmedPositions.current);
    if (
      handoffPolicy === "latest" &&
      confirmed?.source === "reading" &&
      matchingAlignedPlayback(map, audio, accountScope.current)
    ) {
      setUndoAudioPosition({
        source: audio!,
        seconds: controller.getSnapshot().currentTime,
      });
      controller.seek(confirmed.seconds);
    }
    handle?.pauseNarration();
    finishReading();
    setShowPlayer(true);
  }
  function saveReadingPosition(anchor: ReadingAnchor): Promise<boolean> {
    const source = reader,
      handle = readerAlignment,
      map = alignment;
    if (
      !source ||
      currentReader.current !== source ||
      !validReaderPosition(source, accountScope.current, anchor)
    )
      return Promise.resolve(false);
    const confirmation = ++readingConfirmation.current;
    const active = () =>
      currentReader.current === source &&
      source.ownerScope === accountScope.current &&
      confirmation === readingConfirmation.current;
    // Resolve the captured anchor while the publication is alive, before storage waits.
    const passage =
      map &&
      handle &&
      map.edition.bookId === source.book.id &&
      map.edition.textFileId === source.file.id &&
      map.edition.accountScope === source.ownerScope
        ? handle
            .passageAtLocator?.(map, map.edition, anchor.locator)
            .catch(() => null)
        : undefined;
    const pending = (async () => {
      await library.saveAnchor(anchor);
      const stored = await library.repo.getAnchor(anchor);
      if (
        !active() ||
        stored?.locator !== anchor.locator ||
        stored.updatedAt !== anchor.updatedAt
      )
        return false;
      confirmedTextAnchor.current = { source, anchor };
      publishNativeRecent(source.book, source.file, anchor);
      const resolved = await passage;
      if (
        resolved &&
        active() &&
        currentReaderHandle.current === handle &&
        currentAlignment.current === map
      )
        confirmedPositions.current = [
          ...confirmedPositions.current.filter(
            (item) => item.source !== "reading",
          ),
          {
            source: "reading",
            seconds: resolved.start,
            updatedAt: anchor.updatedAt,
            textAnchor: anchor,
          },
        ];
      return active();
    })();
    pendingReadingConfirmation.current = pending;
    return pending;
  }
  async function readFromAudio() {
    const map = alignment;
    if (
      !map ||
      !playerBook ||
      map.edition.accountScope !== accountScope.current
    )
      return;
    try {
      const audio = controller.getBook();
      const playing = controller.getSnapshot().status === "playing";
      const target = handoffToText(map, map.edition, controller);
      if (!target) throw new Error(appT("noTextPosition"));
      const opened = await openReader(
        playerBook,
        {
          bookId: target.bookId,
          fileId: target.fileId,
          kind: "epub",
          locator: target.locator,
          progress: playerBook.progress,
          updatedAt: new Date().toISOString(),
        },
        map.edition.textSha256,
        true,
      );
      if (
        opened &&
        currentAlignment.current === map &&
        controller.getBook() === audio &&
        map.edition.accountScope === accountScope.current
      ) {
        setShowPlayer(false);
        setFollowAudio(true);
        if (playing) await controller.play();
      }
    } catch (error) {
      if (map.edition.accountScope === accountScope.current)
        notify(error instanceof Error ? error.message : appT("linkFailed"));
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
      quote: appT("audioNoteAt", { time: formatTime(playback.currentTime) }),
      text: "",
      color: "sand",
      locator: checkpoint.locator,
      createdAt: now,
      updatedAt: now,
    });
    setNoteText("");
  }
  async function openNativeBook(
    request: Pick<NativeNavigation, "bookId" | "fileId" | "kind">,
  ) {
    const scope = accountScope.current;
    try {
      const book =
        catalogBooks.find((item) => item.id === request.bookId) ??
        (await library.repo.getBook(request.bookId)) ??
        (await library.client?.getBook(request.bookId));
      if (scope !== accountScope.current) return;
      const file = book?.files.find((item) => item.id === request.fileId);
      if (!book || !file || readerKindForFile(file) !== request.kind)
        throw new Error(appT("shortcutSourceMissing"));
      if (
        request.kind === "audio" &&
        book.files.find((item) => item.format === "AUDIO")?.id !== file.id
      )
        throw new Error(appT("shortcutAudioSource"));
      const selectedFileBook = {
        ...book,
        format: file.format,
        files: [file, ...book.files.filter((item) => item.id !== file.id)],
      };
      if (request.kind === "audio") await listen(selectedFileBook);
      else await openReader(selectedFileBook);
    } catch (error) {
      if (scope === accountScope.current)
        notify(error instanceof Error ? error.message : appT("shortcutFailed"));
    }
  }
  async function jumpToNote(note: Annotation) {
    const scope = accountScope.current;
    const book =
      localSources.current.get(note.bookId)?.book ??
      catalogBooks.find((b) => b.id === note.bookId) ??
      (await library.repo.getBook(note.bookId));
    if (scope !== accountScope.current) return;
    if (!book)
      return notify(
        note.bookId.startsWith("local-")
          ? appT("reopenLocal")
          : appT("bookMissing"),
      );
    const file = book.files.find((f) => f.id === note.fileId);
    if (!file) return notify(appT("noteFileMissing"));
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
      name: appT("queue"),
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
    notify(contains ? appT("queueRemoved") : appT("queueAdded"));
  }
  async function changeStatus(book: Book, serverStatus: BookOrbitReadStatus) {
    const scope = accountScope.current;
    try {
      if (library.client && !book.id.startsWith("local-"))
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
        library.setBooks((previous) => upsertCatalogBook(previous, updated));
      } else await library.updateDemoBook(updated);
      if (scope === accountScope.current) {
        setHomeRevision((revision) => revision + 1);
        notify(appT("statusUpdated"));
      }
    } catch (e) {
      if (scope === accountScope.current)
        notify(e instanceof Error ? e.message : appT("statusFailed"));
    }
  }
  async function importFollowedWork(edition: ImportedAo3Edition) {
    const repo = library.repo;
    const book = await importAo3Edition(repo, edition);
    if (accountScope.current !== repo.scope)
      throw new Error(appT("importAccountChanged"));
    notify(appT("editionImported"));
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
      return notify(appT("chooseFile"));
    const id = `local-${crypto.randomUUID()}`;
    const url = URL.createObjectURL(file);
    playerUrls.current.push(url);
    const book: Book = {
      id,
      title: file.name.replace(/\.[^.]+$/, ""),
      authors: [appT("localFile")],
      description: appT("localFileDescription"),
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
    localSources.current.set(id, { book, sources: new Map([[id, file]]) });
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
      <div
        className={`app-shell reference-layout ${playerBook ? "has-player" : ""}`}
        data-view={view}
        style={
          {
            "--library-tint": currentBook?.color ?? "#a9a9a9",
          } as React.CSSProperties
        }
      >
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
          <h1 className="mobile-page-title">
            {view === "activity"
              ? t("nav.activity")
              : view === "notebook"
                ? t("nav.notebook")
                : view === "search"
                  ? t("nav.search")
                  : navigation.find((item) => item.id === view)?.label}
          </h1>
          <div className="navigation-dock">
            <nav className="main-nav" aria-label={t("a11y.navigation")}>
              {navigation.map((item) => (
                <button
                  key={item.id}
                  className={view === item.id ? "active" : ""}
                  aria-current={view === item.id ? "page" : undefined}
                  onClick={() => navigate(item.id)}
                >
                  <item.icon size={23} />
                  <span>{item.label}</span>
                </button>
              ))}
            </nav>
            <button
              className={`navigation-search ${view === "search" ? "active" : ""}`}
              aria-label={t("nav.search")}
              aria-current={view === "search" ? "page" : undefined}
              onClick={() => navigate("search")}
            >
              <Search size={23} />
            </button>
          </div>
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
              {library.client ? (
                library.client.session.profile.username
                  ?.slice(0, 1)
                  .toUpperCase() || "A"
              ) : (
                <UserRound size={23} />
              )}
            </button>
          </div>
          {menu && (
            <div className="account-menu">
              <p>
                {library.client?.session.profile.username ||
                  appT("personalLibrary")}
                <small>
                  {library.client?.session.profile.name || appT("exploring")}
                </small>
              </p>
              <button
                onClick={() => {
                  openConnection();
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
              <button onClick={() => navigate("notebook")}>
                <NotebookPen size={17} />
                {t("nav.notebook")}
              </button>
              <button
                onClick={() => {
                  setDialog("integrations");
                  setMenu(false);
                }}
              >
                <Layers size={17} />
                {appT("integrations")}
              </button>
              <button
                onClick={() => {
                  setDialog("help");
                  setMenu(false);
                }}
              >
                <CircleHelp size={17} />
                {appT("guide")}
              </button>
              {library.client && (
                <button
                  onClick={() => {
                    controller.pause();
                    setPlayerBook(null);
                    connectionGeneration.current++;
                    nativeProviderAttempt.current = null;
                    void nativeProvider
                      ?.cancel()
                      .catch(() => notify(appT("providerClearFailed")));
                    void sessionPersistence
                      .clear()
                      .catch(() => notify(appT("signOutFailed")));
                    library.disconnect();
                    setMenu(false);
                    notify(appT("disconnected"));
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
          <ProviderCallback
            onConnect={async (session, readOnly) => {
              const active = () => connectionGeneration.current === 0;
              if (!active()) return;
              await library.connect(session, readOnly, active);
              if (!active()) return;
              navigate("home");
              notify(t("common.connected"));
            }}
          />
          <div
            className={`connection-line ${library.client && ["Needs review", "Sync failed"].includes(library.syncStatus) ? "connection-needs-review" : ""}`}
          >
            <span>
              <span
                className={`status-dot ${library.client ? "connected" : ""}`}
              />
              {library.client
                ? `${library.client.session.profile.name} · ${syncMessage ? appT(syncMessage) : library.syncStatus}`
                : appT("homeLibraryHint")}
            </span>
            {library.client &&
              ["Needs review", "Sync failed"].includes(library.syncStatus) && (
                <button
                  className="text-button"
                  onClick={() => {
                    controller.pause();
                    setReader(null);
                    setDialog("recovery");
                  }}
                >
                  {recoveryTranslate("title")}
                </button>
              )}
            <button
              className="text-button"
              onClick={() => setDialog(library.client ? "settings" : "connect")}
            >
              {library.client ? appT("connectionSettings") : t("connect.title")}
              <ArrowUpRight size={14} />
            </button>
          </div>
          <TopNotificationBanner
            notifications={notifications}
            error={library.error}
            onDismissError={() => library.setError("")}
          />

          {view === "more" && (
            <section className="reference-more" aria-label={t("nav.more")}>
              <h1>{t("nav.more")}</h1>
              <div className="more-group">
                <button onClick={() => navigate("notebook")}>
                  <NotebookPen />
                  {t("nav.notebook")}
                  <ChevronRight />
                </button>
                <button onClick={() => navigate("activity")}>
                  <BarChart3 />
                  {t("nav.activity")}
                  <ChevronRight />
                </button>
                <button onClick={() => setDialog("upload")}>
                  <Plus />
                  {t("upload.open")}
                  <ChevronRight />
                </button>
                <button onClick={() => setShowPreparationPicker(true)}>
                  <Headphones />
                  {preparationText("prepare")}
                  <ChevronRight />
                </button>
                <button
                  onClick={() => {
                    controller.pause();
                    controller.checkpoint();
                    setShowDownloads(true);
                  }}
                >
                  <Download />
                  {preparationText("prepared")}
                  <ChevronRight />
                </button>
                <button onClick={() => setDialog("requests")}>
                  <Plus />
                  {formatRequestT("title")}
                  <ChevronRight />
                </button>
                <button onClick={() => setDialog("integrations")}>
                  <Layers />
                  {appT("integrations")}
                  <ChevronRight />
                </button>
              </div>
              <div className="more-group">
                <button onClick={openConnection}>
                  <Library />
                  {t("connect.aServer")}
                  <ChevronRight />
                </button>
                <button onClick={() => setDialog("settings")}>
                  <SlidersHorizontal />
                  {t("common.settings")}
                  <ChevronRight />
                </button>
                <button onClick={() => setDialog("help")}>
                  <CircleHelp />
                  {appT("guide")}
                  <ChevronRight />
                </button>
              </div>
              <p className="more-brand">
                avid <span>{t("footer.tagline")}</span>
              </p>
            </section>
          )}

          {view === "home" && (
            <>
              {currentBook ? (
                <section
                  className={`resume-hero ${currentBook.format === "AUDIO" ? "audio-hero" : ""}`}
                  style={
                    { "--hero-color": currentBook.color } as React.CSSProperties
                  }
                >
                  <button
                    className="hero-art"
                    onClick={() => setSelected(currentBook)}
                    aria-label={appT("detailsFor", {
                      title: currentBook.title,
                    })}
                  >
                    <Cover book={currentBook} large />
                  </button>
                  <div className="hero-copy">
                    <div className="hero-summary">
                      <p className="hero-kicker">{t("home.heading")}</p>
                      <h1>{currentBook.title}</h1>
                      <p className="hero-author">
                        {currentBook.authors.join(", ")}
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
                      <p className="hero-description">
                        {descriptionToPlainText(currentDescription)}
                      </p>
                    </div>
                    <div className="hero-buttons">
                      <button
                        className="primary-button"
                        onClick={() => void openReader(currentBook)}
                      >
                        <Play size={15} fill="currentColor" />
                        {appT(
                          currentBook.format === "AUDIO"
                            ? "resumeListening"
                            : "resumeReading",
                        )}
                      </button>
                      <button
                        className="hero-detail-button"
                        onClick={() => setSelected(currentBook)}
                        aria-label={appT("detailsFor", {
                          title: currentBook.title,
                        })}
                      >
                        <MoreHorizontal size={22} />
                      </button>
                    </div>
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
                books={continuing}
                onSelect={setSelected}
                onSeeAll={() => navigate("library")}
              />
              <Shelf
                title={t("home.queue")}
                books={queue}
                onSelect={setSelected}
                onSeeAll={() => {
                  setView("library");
                  setActiveCollection("queue");
                }}
              />
              <Shelf
                title={t("library.recent")}
                books={[...catalogBooks]
                  .sort((a, b) => Date.parse(b.addedAt) - Date.parse(a.addedAt))
                  .slice(0, 12)}
                onSelect={setSelected}
                onSeeAll={() => navigate("library")}
              />
              <PinnedHomeShelves
                client={library.client}
                repo={library.repo}
                collections={library.collections}
                books={catalogBooks}
                onSelect={setSelected}
                revision={homeRevision}
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
                  <button className="secondary-button" onClick={openConnection}>
                    {t("connect.server")}
                    <ArrowUpRight size={16} />
                  </button>
                </section>
              )}
            </>
          )}

          {(view === "library" || view === "search") && (
            <ReferenceLibrary
              books={catalogBooks}
              client={library.client}
              repo={library.repo}
              enabled={view === "library" && !activeCollection}
              resetKey={libraryNavigationRevision}
              onBrowse={setFormat}
              onSelect={setSelected}
              onError={library.setError}
            >
              <div className="page-heading">
                <div>
                  <span className="eyebrow">
                    {view === "search"
                      ? appT("searchEyebrow")
                      : appT("libraryEyebrow")}
                  </span>
                  <h1>
                    {view === "search"
                      ? appT("nextChapter")
                      : activeCollection === "queue"
                        ? t("home.queue")
                        : activeCollection
                          ? library.collections.find(
                              (c) => c.id === activeCollection,
                            )?.name
                          : t("library.title")}
                  </h1>
                  <p>
                    {library.client?.readOnly
                      ? appT("libraryCountReadOnly", { count: library.total })
                      : t("library.count", {
                          count: library.client ? library.total : books.length,
                        })}
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
                      aria-pressed={format === id}
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
                    heading={search ? appT("noMatches") : appT("emptyShelf")}
                    description={
                      search
                        ? appT("searchEmptyHint")
                        : appT("libraryEmptyHint")
                    }
                  />
                )
              )}
              {library.client && catalogBooks.length < library.total && (
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
                        ...serverShelfFilter(activeCollection),
                        media: format as "all" | "audio" | "books" | "comics",
                        direction: sort === "title" ? "asc" : "desc",
                      });
                    }}
                  >
                    {t("library.more")}
                  </button>
                </div>
              )}
            </ReferenceLibrary>
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
                        {(catalogBooks
                          .filter((b) => collection.bookIds.includes(b.id))
                          .slice(0, 3).length
                          ? catalogBooks
                              .filter((b) => collection.bookIds.includes(b.id))
                              .slice(0, 3)
                          : catalogBooks.slice(i * 3, i * 3 + 3)
                        ).map((book) => (
                          <Cover key={book.id} book={book} />
                        ))}
                      </div>
                      <div>
                        <h3>{collection.name}</h3>
                        <span>
                          {library.client
                            ? appT("openCollection")
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
                  {[...new Set(catalogBooks.flatMap((b) => b.genres))]
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
                <>
                  <StoryArcBrowser
                    client={library.client}
                    repo={library.repo}
                    books={catalogBooks}
                    onBook={setSelected}
                  />
                  <SeriesBrowser
                    client={library.client}
                    onBook={(book) => {
                      void library.repo.putBooks([book]);
                      setSelected(book);
                    }}
                  />
                </>
              ) : (
                <section>
                  <div className="section-heading">
                    <h2>{t("browse.series")}</h2>
                  </div>
                  {catalogBooks.some((b) => b.series) ? (
                    <div className="series-list">
                      {[
                        ...new Set(
                          catalogBooks.flatMap((b) =>
                            b.series ? [b.series] : [],
                          ),
                        ),
                      ].map((series) => (
                        <div key={series}>
                          <h3>{series}</h3>
                          <div className="shelf-track">
                            {catalogBooks
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
                  {catalogBooks.map((b) => (
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
                        {catalogBooks.find((b) => b.id === note.bookId)
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
              books={catalogBooks}
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
                  {playerRemainingLabel(
                    playerTimeline(controller.getBook(), playback),
                    locale,
                  )}
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
              readOnly={
                !selectedBook.id.startsWith("local-") &&
                (library.client?.readOnly ?? false)
              }
              client={library.client}
              audioRemaining={
                selectedBook.id === playerBook?.id
                  ? playerRemainingLabel(
                      playerTimeline(controller.getBook(), playback),
                      locale,
                    )
                  : undefined
              }
              onRead={(fileId) =>
                void openReader(
                  fileId
                    ? {
                        ...selectedBook,
                        files: [...selectedBook.files].sort(
                          (a, b) =>
                            Number(b.id === fileId) - Number(a.id === fileId),
                        ),
                      }
                    : selectedBook,
                )
              }
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
              externalNarration={
                alignment?.edition.bookId === reader.book.id &&
                alignment.edition.textFileId === reader.file.id &&
                matchingAlignedPlayback(
                  alignment,
                  controller.getBook(),
                  library.repo.scope,
                )
              }
              preferences={readerPreferences}
              key={`${reader.ownerScope}:${reader.book.id}:${reader.file.id}`}
              onAlignmentReady={(handle) => {
                if (currentReader.current === reader) {
                  currentReaderHandle.current = handle;
                  setReaderAlignment(handle);
                  if (handle)
                    void seedObservedReading(reader, handle).catch((error) => {
                      if (currentReader.current === reader)
                        notify(String(error));
                    });
                }
              }}
              persistProgress={!previewReading && !followAudio}
              onPreviewAnchor={(anchor) => {
                if (
                  currentReader.current === reader &&
                  validReaderPosition(reader, accountScope.current, anchor)
                )
                  setPreviewPosition({ source: reader, anchor });
              }}
              modeControls={
                reader.file.format === "EPUB" ? (
                  <>
                    {library.client &&
                      reader.source &&
                      reader.book.files.some(
                        (file) => file.format === "AUDIO",
                      ) &&
                      !reader.book.id.startsWith("local-") && (
                        <PrepareReadListen
                          key={`${reader.ownerScope}:${reader.book.id}:${reader.file.id}`}
                          client={library.client}
                          book={reader.book}
                          fileId={reader.file.id}
                          handle={readerAlignment}
                          source={reader.source}
                          scopeLabel={library.client.session.profile.name}
                          onPrepared={acceptAlignment}
                          onListen={listenFromText}
                          onOpenPrepared={() => {
                            controller.pause();
                            finishReading();
                            setShowDownloads(true);
                          }}
                        />
                      )}
                    <div className="read-along-reader-controls">
                      <HandoffControls
                        policy={handoffPolicy}
                        onPolicy={changeHandoffPolicy}
                        preview={previewReading}
                        onPreview={(value) => {
                          setPreviewReading(value);
                          if (value) setFollowAudio(false);
                        }}
                        onConfirm={
                          previewPosition?.source === reader &&
                          validReaderPosition(
                            reader,
                            accountScope.current,
                            previewPosition.anchor,
                          )
                            ? () => {
                                void saveReadingPosition({
                                  ...previewPosition.anchor,
                                  updatedAt: new Date().toISOString(),
                                })
                                  .then((saved) => {
                                    if (saved)
                                      notify(readAlongText("savedPlace"));
                                  })
                                  .catch((error) => notify(String(error)));
                              }
                            : undefined
                        }
                      />
                      {alignment?.edition.bookId === reader.book.id &&
                        alignment.edition.textFileId === reader.file.id &&
                        matchingAlignedPlayback(
                          alignment,
                          controller.getBook(),
                          library.repo.scope,
                        ) && (
                          <>
                            <label className="read-along-check">
                              <input
                                type="checkbox"
                                checked={followAudio}
                                onChange={(event) => {
                                  setFollowAudio(event.target.checked);
                                  if (event.target.checked)
                                    setPreviewReading(false);
                                }}
                              />
                              {readAlongText("follow")}
                            </label>
                            <button
                              className="reader-secondary"
                              onClick={() => void controller.toggle()}
                            >
                              {t(
                                playback.status === "playing"
                                  ? "common.pause"
                                  : "common.play",
                              )}
                            </button>
                            <button
                              className="reader-secondary"
                              onClick={() =>
                                void returnToPlayer().catch((error) =>
                                  notify(String(error)),
                                )
                              }
                            >
                              {readAlongText("openPlayer")}
                            </button>
                          </>
                        )}
                    </div>
                  </>
                ) : undefined
              }
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
                if (
                  currentReader.current === reader &&
                  validReaderPosition(reader, accountScope.current, anchor)
                )
                  setPreviewPosition({ source: reader, anchor });
                void saveReadingPosition(anchor).catch((error) =>
                  notify(String(error)),
                );
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
              onRead={
                alignment &&
                alignment.edition.accountScope === library.repo.scope &&
                alignment.edition.bookId === playerBook.id &&
                alignment.edition.audioFileId === playback.fileId
                  ? () => void readFromAudio()
                  : undefined
              }
              readAlong={
                alignment &&
                matchingAlignedPlayback(
                  alignment,
                  controller.getBook(),
                  library.repo.scope,
                ) ? (
                  <ReadAlongPanel
                    lines={timedText}
                    seconds={alignedPlaybackSeconds(alignment, playback)}
                    onSeek={(seconds) => {
                      const source = controller.getBook();
                      if (
                        source &&
                        matchingAlignedPlayback(
                          alignment,
                          source,
                          accountScope.current,
                        )
                      ) {
                        setUndoAudioPosition({
                          source,
                          seconds: controller.getSnapshot().currentTime,
                        });
                        controller.seek(seconds);
                      }
                    }}
                    onUndo={
                      undoAudioPosition?.source !== controller.getBook()
                        ? undefined
                        : () => {
                            if (
                              undoAudioPosition &&
                              undoAudioPosition.source ===
                                controller.getBook() &&
                              matchingAlignedPlayback(
                                alignment,
                                controller.getBook(),
                                accountScope.current,
                              )
                            )
                              controller.seek(undoAudioPosition.seconds);
                            setUndoAudioPosition(undefined);
                          }
                    }
                  >
                    <HandoffControls
                      policy={handoffPolicy}
                      onPolicy={changeHandoffPolicy}
                    />
                  </ReadAlongPanel>
                ) : undefined
              }
              offlineControl={
                <button
                  className="secondary-button"
                  onClick={() => {
                    controller.pause();
                    setShowPlayer(false);
                    setShowDownloads(true);
                  }}
                >
                  {preparationText("prepared")}
                </button>
              }
            />
          </Modal>
        )}
        {showPreparationPicker && (
          <Modal
            title={preparationText("prepare")}
            onClose={() => setShowPreparationPicker(false)}
          >
            <div className="form-panel">
              <p>{preparationText("chooseBook")}</p>
              {catalogBooks
                .filter(
                  (book) =>
                    book.files.some((file) => file.format === "EPUB") &&
                    book.files.some((file) => file.format === "AUDIO"),
                )
                .map((book) => (
                  <button
                    key={book.id}
                    className="secondary-button"
                    disabled={!library.client || book.id.startsWith("local-")}
                    onClick={() => {
                      setShowPreparationPicker(false);
                      void openReader({ ...book, format: "EPUB" });
                    }}
                  >
                    {book.title}
                  </button>
                ))}
              {!catalogBooks.some(
                (book) =>
                  book.files.some((file) => file.format === "EPUB") &&
                  book.files.some((file) => file.format === "AUDIO"),
              ) && <p>{preparationText("noEligibleBooks")}</p>}
              <button
                className="secondary-button"
                onClick={() => {
                  setShowPreparationPicker(false);
                  controller.pause();
                  setShowDownloads(true);
                }}
              >
                {preparationText("openPrepared")}
              </button>
            </div>
          </Modal>
        )}
        {showDownloads && (
          <Suspense
            fallback={
              <div className="loading-overlay" role="status">
                {t("common.openingBook")}
              </div>
            }
          >
            <OfflineDownloads
              storage={libraryStorage}
              onClose={() => setShowDownloads(false)}
            />
          </Suspense>
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
        {dialog === "requests" && (
          <Modal
            title={formatRequestT("title")}
            onClose={() => setDialog(null)}
          >
            <BookFormatRequests
              client={library.client}
              onOpenBook={(id) => {
                const client = library.client,
                  repo = library.repo;
                void (async () => {
                  const book =
                    (await repo.getBook(id)) ?? (await client?.getBook(id));
                  if (book && accountScope.current === repo.scope) {
                    setDialog(null);
                    setSelected(book);
                  }
                })().catch((error) => notify(String(error)));
              }}
            />
          </Modal>
        )}
        {dialog === "connect" && (
          <Modal title={t("connect.title")} onClose={closeConnection}>
            <Connect
              onAttempt={async (method) => {
                if (getNativeSessionVault() && !nativeAuth)
                  throw new Error(appT("nativeSignInUnavailable"));
                const attempt = ++connectionGeneration.current;
                nativeProviderAttempt.current =
                  method === "provider" && nativeProvider
                    ? connectionGeneration.current
                    : null;
                controller.pause();
                library.disconnect();
                if (method !== "provider") await nativeProvider?.cancel();
                // Invalidate the old native credential owner before a login can
                // write cookies, including while an old refresh is in flight.
                await sessionPersistence.clear();
                if (attempt !== connectionGeneration.current)
                  throw new DOMException(appT("signInCancelled"), "AbortError");
                const record = await sessionPersistence.read();
                if (attempt !== connectionGeneration.current)
                  throw new DOMException(appT("signInCancelled"), "AbortError");
                return {
                  nativeGeneration:
                    nativeAuth && record ? record.generation : undefined,
                };
              }}
              onConnect={async (session, readOnly) => {
                const attempt = connectionGeneration.current;
                const active = () =>
                  attempt === connectionGeneration.current &&
                  dialogRef.current === "connect";
                if (!active()) return;
                await library.connect(session, readOnly, active);
                if (!active()) return;
                controller.pause();
                setPlayerBook(null);
                setDialog(null);
                navigate("home");
                notify(t("common.connected"));
              }}
            />
          </Modal>
        )}
        {dialog === "recovery" && library.client && (
          <Modal
            title={recoveryTranslate("title")}
            onClose={() => setDialog(null)}
            wide
          >
            <SyncRecoveryPanel
              repo={library.repo}
              client={library.client}
              onResolved={async () => {
                await library.recoverSync();
                setHomeRevision((value) => value + 1);
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
                      aria-pressed={theme === id}
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
                <button className="secondary-button" onClick={openConnection}>
                  {library.client ? t("connect.another") : t("connect.short")}
                  <ArrowUpRight size={15} />
                </button>
                {library.client && (
                  <button
                    className="secondary-button"
                    onClick={() => {
                      controller.pause();
                      setReader(null);
                      setDialog("recovery");
                    }}
                  >
                    {recoveryTranslate("title")}
                  </button>
                )}
              </section>
              <section>
                <h3>{t("settings.capabilities")}</h3>
                <div className="capability-list">
                  {platformCapabilities.map((c) => (
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
                <p>
                  {t(
                    getNativeSessionVault()
                      ? "settings.nativePrivacyHint"
                      : "settings.privacyHint",
                  )}
                </p>
                <button
                  className="text-button"
                  onClick={() => {
                    const diagnostic = {
                      app: "Avid",
                      version: "0.1.0",
                      platform: navigator.platform,
                      capabilities: platformCapabilities.map((c) => ({
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
                [appT("guideLibraryTitle"), appT("guideLibraryBody")],
                [appT("guideReadingTitle"), appT("guideReadingBody")],
                [appT("guideAppearanceTitle"), appT("guideAppearanceBody")],
                [appT("guideListeningTitle"), appT("guideListeningBody")],
                [appT("guideNotesTitle"), appT("guideNotesBody")],
                [appT("guideFormatsTitle"), appT("guideFormatsBody")],
                [appT("guideRecoveryTitle"), appT("guideRecoveryBody")],
                [appT("guidePreviewTitle"), appT("guidePreviewBody")],
              ].map(([title, text], i) => (
                <details key={title} open={i === 0}>
                  <summary>
                    {title}
                    <ChevronRight size={17} />
                  </summary>
                  <p>{text}</p>
                </details>
              ))}
              <p className="field-hint">{appT("keyboardHint")}</p>
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
                    if (
                      uploadBusy ||
                      !uploadFile ||
                      !uploadLibrary ||
                      !library.client ||
                      library.client.readOnly ||
                      !serverLibraries.some((row) => row.id === uploadLibrary)
                    )
                      return;
                    const scope = library.repo.scope;
                    const attempt = ++uploadAttempt.current;
                    const active = () =>
                      accountScope.current === scope &&
                      uploadAttempt.current === attempt &&
                      dialogRef.current === "upload";
                    setUploadBusy(true);
                    void library.client
                      .uploadBook(uploadLibrary, uploadFile)
                      .then(() => {
                        if (!active()) return;
                        notify(appT("uploaded"));
                        setDialog(null);
                        void library.query({});
                      })
                      .catch((err) => {
                        if (active()) notify(err.message);
                      })
                      .finally(() => {
                        if (active()) setUploadBusy(false);
                      });
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
          <Modal
            title={appT("beyondBookshelf")}
            onClose={() => setDialog(null)}
          >
            <div className="settings-panel">
              <section>
                <h3>BookOrbit</h3>
                <p>{appT("bookOrbitDescription")}</p>
                <button className="secondary-button" onClick={openConnection}>
                  {appT("manageConnection")}
                  <ArrowUpRight size={15} />
                </button>
              </section>
              <section>
                <h3>{appT("crossPointDelivery")}</h3>
                <CrossPointPanel
                  key={library.repo.scope}
                  accountScope={library.repo.scope}
                  fileSources={crossPointFiles}
                  nativeFetch={getCrossPointFetch() ?? undefined}
                  discoverReaders={getReaderDiscovery()}
                />
              </section>
              <section>
                <h3>Archive of Our Own</h3>
                <AO3Panel
                  key={library.repo.scope}
                  accountScope={library.repo.scope}
                  onImport={importFollowedWork}
                />
              </section>
              <section>
                <h3>{appT("readAndListen")}</h3>
                <p>{appT("alignmentDescription")}</p>
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
