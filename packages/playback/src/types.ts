export type PlaybackStatus = 'stopped' | 'loading' | 'playing' | 'paused' | 'buffering' | 'interrupted' | 'failed';

export interface AudioTrack {
  id: string;
  url: string;
  title?: string;
  /** Source seconds, required for all but the final track of a multi-track book. */
  duration?: number;
  /** Decoder observation only. Never replaces a declared source-timeline boundary. */
  decodedDuration?: number;
}

export interface AudioChapter {
  id: string;
  title: string;
  /** Position in the complete book's source timeline, in seconds. */
  start: number;
  duration: number;
}

export interface PlaybackBook {
  bookId: string;
  fileId: string;
  title: string;
  authors: string[];
  coverUrl?: string;
  tracks: AudioTrack[];
  chapters?: AudioChapter[];
  /** Source edition identity supplied by the server, retained in exact checkpoints. */
  manifestRevision?: string;
}

export interface PlaybackSnapshot {
  status: PlaybackStatus;
  bookId: string | null;
  fileId: string | null;
  title: string;
  currentTime: number;
  duration: number;
  trackIndex: number;
  chapterIndex: number;
  rate: number;
  sleepUntil: number | null;
  /** Source-timeline position of the selected chapter end. */
  sleepAtChapterEnd: number | null;
  error: string | null;
}

export interface AudioCheckpoint {
  bookId: string;
  fileId: string;
  kind: 'audio';
  /** JSON AudioLocator, never a percentage used as an exact locator. */
  locator: string;
  progress: number;
  updatedAt: string;
}

export interface AudioLocator {
  version: 1;
  trackId: string;
  trackTime: number;
  time: number;
  manifestRevision?:string;
}

export type SleepTimer = { minutes: number } | { endOfChapter: true } | null;

/** Inject a media element in tests. The production controller owns one Audio. */
export type AudioElement = Pick<HTMLAudioElement,
  'src' | 'currentTime' | 'duration' | 'playbackRate' | 'preservesPitch' | 'paused' |
  'error' | 'preload' | 'ended' | 'play' | 'pause' | 'load' | 'removeAttribute' |
  'addEventListener' | 'removeEventListener'>;

export interface PlaybackOptions {
  audio?: AudioElement;
  /** Stable server/user identity supplied by the owner; never credentials. */
  accountScope?: () => string | null;
  mediaSession?: MediaSession | null;
  /** Invoked synchronously at checkpoints, before subscribers (e.g. durable journal). */
  persistCheckpoint?: (checkpoint: AudioCheckpoint) => void;
  preferredRate?: number;
  skipSeconds?: number;
  remotePolicy?: import('./remotePolicy').RemoteSkipPolicy;
}
