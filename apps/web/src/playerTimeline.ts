import type {
  AudioChapter,
  PlaybackBook,
  PlaybackSnapshot,
} from "../../../packages/playback/src";

export interface PlayerChapter extends AudioChapter {
  end: number;
}
export interface PlayerTimeline {
  chapters: PlayerChapter[];
  chapter: PlayerChapter | null;
  chapterIndex: number;
  start: number;
  duration: number | null;
  elapsed: number;
  remaining: number | null;
  bookDuration: number | null;
  bookElapsed: number;
  listeningRemaining: number | null;
  rate: number;
  previous: PlayerChapter | null;
  next: PlayerChapter | null;
}

const positive = (value: number) => Number.isFinite(value) && value > 0;
const nonnegative = (value: number) =>
  Number.isFinite(value) ? Math.max(0, value) : 0;

export function formatPlayerTime(seconds: number): string {
  const total = Math.floor(nonnegative(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = String(total % 60).padStart(2, "0");
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${remainder}`
    : `${minutes}:${remainder}`;
}

/** Display and seeking always use the original book clock. Only the listening
 * estimate is adjusted for speed. Gaps are not mislabeled as chapters. */
export function playerTimeline(
  book: PlaybackBook | null,
  state: Pick<PlaybackSnapshot, "currentTime" | "duration" | "rate">,
): PlayerTimeline {
  const bookDuration = positive(state.duration) ? state.duration : null;
  const bookElapsed = Math.min(
    nonnegative(state.currentTime),
    bookDuration ?? Infinity,
  );
  const rate = positive(state.rate) ? state.rate : 1;
  const seen = new Set<string>();
  const candidates = (book?.chapters ?? [])
    .filter(
      (chapter) =>
        chapter.id &&
        Number.isFinite(chapter.start) &&
        chapter.start >= 0 &&
        positive(chapter.duration),
    )
    .slice()
    .sort((left, right) => left.start - right.start)
    .filter((chapter) => {
      if (seen.has(chapter.id)) return false;
      seen.add(chapter.id);
      return true;
    });
  const chapters = candidates.flatMap((chapter, index): PlayerChapter[] => {
    const end = Math.min(
      chapter.start + chapter.duration,
      candidates[index + 1]?.start ?? Infinity,
      bookDuration ?? Infinity,
    );
    return end > chapter.start
      ? [{ ...chapter, duration: end - chapter.start, end }]
      : [];
  });
  const chapterIndex = chapters.findIndex(
    (chapter, index) =>
      bookElapsed >= chapter.start &&
      (bookElapsed < chapter.end ||
        (index === chapters.length - 1 &&
          bookElapsed === chapter.end &&
          chapter.end === bookDuration)),
  );
  const chapter = chapters[chapterIndex] ?? null;
  const start = chapter?.start ?? 0;
  const duration = chapter?.duration ?? bookDuration;
  const elapsed = Math.min(
    Math.max(0, bookElapsed - start),
    duration ?? Infinity,
  );
  const previous = chapter
    ? (chapters[chapterIndex - 1] ?? null)
    : (chapters.filter((item) => item.start < bookElapsed).at(-1) ?? null);
  const next = chapter
    ? (chapters[chapterIndex + 1] ?? null)
    : (chapters.find((item) => item.start > bookElapsed) ?? null);
  return {
    chapters,
    chapter,
    chapterIndex,
    start,
    duration,
    elapsed,
    remaining: duration === null ? null : Math.max(0, duration - elapsed),
    bookDuration,
    bookElapsed,
    listeningRemaining:
      bookDuration === null
        ? null
        : Math.max(0, bookDuration - bookElapsed) / rate,
    rate,
    previous,
    next,
  };
}

/** Clamp an input within its captured chapter before returning source seconds. */
export function playerSeekTime(
  timeline: Pick<PlayerTimeline, "start" | "duration">,
  relative: number,
): number | null {
  if (timeline.duration === null || !Number.isFinite(relative)) return null;
  return timeline.start + Math.min(timeline.duration, Math.max(0, relative));
}
