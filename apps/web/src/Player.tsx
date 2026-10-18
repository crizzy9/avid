import { useI18n } from "../../../packages/i18n/src";
import { useAlignmentI18n } from "./alignmentMessages";
import { useId, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  Play,
  Pause,
  RotateCcw,
  RotateCw,
  List,
  Timer,
  BookmarkPlus,
  Headphones,
  BookOpen,
  SkipBack,
  SkipForward,
} from "lucide-react";
import type { PlaybackTransport } from "../../mobile/src/native-transport";
import type { Book } from "../../../packages/core/src/types";
import { Cover } from "./ui";
import {
  remotePolicyKey,
  type RemoteSkipPolicy,
} from "../../../packages/playback/src/remotePolicy";
import { useRemoteI18n } from "./remoteMessages";
import { playerRemainingLabel, usePlayerI18n } from "./playerMessages";
import {
  formatPlayerTime as formatTime,
  playerSeekTime,
  playerTimeline,
  type PlayerTimeline,
} from "./playerTimeline";
import type { PlaybackBook } from "../../../packages/playback/src";
import "./player.css";

export function Player({
  controller,
  book,
  onNote,
  onRead,
  readAlong,
  offlineControl,
}: {
  controller: PlaybackTransport;
  book: Book;
  onNote?: () => void;
  onRead?: () => void;
  /** Account-scoped read-along UI supplied by the application. */
  readAlong?: ReactNode;
  /** Download/cache actions remain owned by the application's storage flow. */
  offlineControl?: ReactNode;
}) {
  const { t, locale } = useI18n();
  const { t: alignmentText } = useAlignmentI18n();
  const remoteText = useRemoteI18n();
  const playerText = usePlayerI18n();
  const chapterListId = useId();
  const [remotePolicy, setRemotePolicy] = useState(() =>
    controller.getRemotePolicy(),
  );
  const [preferenceError, setPreferenceError] = useState(false);
  function changeRemote(value: string) {
    const policy: RemoteSkipPolicy =
      value === "chapter"
        ? { ...remotePolicy, mode: "chapter" }
        : { mode: "time", seconds: Number(value) };
    controller.configureRemote(policy);
    setRemotePolicy(policy);
    try {
      localStorage.setItem(remotePolicyKey, JSON.stringify(policy));
      setPreferenceError(false);
    } catch {
      setPreferenceError(true);
    }
  }

  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
  );
  const [chapters, setChapters] = useState(false);
  // Hold the chapter clock during a pointer gesture. Reaching its final second
  // must not rebase that same drag onto the next chapter's start.
  const [scrub, setScrub] = useState<{
    source: PlaybackBook | null;
    timeline: PlayerTimeline;
    elapsed: number;
  } | null>(null);
  const source = controller.getBook();
  const timeline = playerTimeline(source, state);
  const activeScrub = scrub?.source === source ? scrub : null;
  const displayed = activeScrub
    ? {
        ...activeScrub.timeline,
        elapsed: activeScrub.elapsed,
        remaining:
          activeScrub.timeline.duration === null
            ? null
            : activeScrub.timeline.duration - activeScrub.elapsed,
      }
    : timeline;
  const chapterList = timeline.chapters;
  const chapterSkipping =
    remotePolicy.mode === "chapter" && chapterList.length > 0;
  const chapterTitle =
    displayed.chapter?.title ||
    (displayed.chapter
      ? playerText("chapterNumber", { number: displayed.chapterIndex + 1 })
      : playerText("wholeBook"));
  const activePlayback =
    state.status === "playing" || state.status === "buffering";
  return (
    <div className="player-view chapter-player">
      <div className="player-art">
        <Cover book={book} large />
      </div>
      <div className="eyebrow">
        <Headphones size={13} />
        {t("player.now")}
      </div>
      <h2>{book.title}</h2>
      <p className="player-authors">{book.authors.join(", ")}</p>
      <section
        className="player-chapter-timeline"
        aria-label={
          displayed.chapter
            ? playerText("chapterPosition")
            : t("player.position")
        }
      >
        <div className="player-chapter-heading">
          {(displayed.chapter || book.id.startsWith("demo-")) && (
            <span className="player-chapter-count">
              {displayed.chapter
                ? playerText("chapterCount", {
                    current: displayed.chapterIndex + 1,
                    total: chapterList.length,
                  })
                : ""}
              {book.id.startsWith("demo-")
                ? `${displayed.chapter ? " · " : ""}${t("player.sample")}`
                : ""}
            </span>
          )}
          <h3>{chapterTitle}</h3>
        </div>
        <input
          className="audio-range"
          aria-label={
            displayed.chapter
              ? playerText("chapterPosition")
              : t("player.position")
          }
          aria-valuetext={
            displayed.duration === null
              ? playerText("durationUnknown")
              : playerText("positionValue", {
                  elapsed: formatTime(displayed.elapsed),
                  duration: formatTime(displayed.duration),
                })
          }
          type="range"
          min="0"
          max={displayed.duration || 1}
          step=".1"
          disabled={displayed.duration === null}
          value={Math.min(displayed.elapsed, displayed.duration || 1)}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture?.(event.pointerId);
            setScrub({ source, timeline, elapsed: timeline.elapsed });
          }}
          onPointerUp={() => setScrub(null)}
          onPointerCancel={() => setScrub(null)}
          onLostPointerCapture={() => setScrub(null)}
          onBlur={() => setScrub(null)}
          onChange={(e) => {
            const target = playerSeekTime(displayed, Number(e.target.value));
            if (target !== null) {
              setScrub((previous) =>
                previous?.source === source
                  ? { ...previous, elapsed: target - displayed.start }
                  : previous,
              );
              controller.seek(target);
            }
          }}
        />
        <div className="timeline-labels">
          <span
            aria-label={`${playerText(displayed.chapter ? "chapterElapsed" : "bookElapsed")}: ${formatTime(displayed.elapsed)}`}
          >
            {formatTime(displayed.elapsed)}
          </span>
          <span
            aria-label={
              displayed.remaining === null
                ? playerText("durationUnknown")
                : `${playerText(displayed.chapter ? "chapterRemaining" : "bookRemaining")}: ${formatTime(displayed.remaining)}`
            }
          >
            {displayed.remaining === null
              ? "—"
              : `−${formatTime(displayed.remaining)}`}
          </span>
        </div>
      </section>
      <div className="player-transport">
        <button
          className="icon-button player-chapter-button"
          disabled={!timeline.previous}
          onClick={() =>
            timeline.previous && controller.goToChapter(timeline.previous.id)
          }
          aria-label={remoteText("previous")}
          title={remoteText("previous")}
        >
          <SkipBack fill="currentColor" />
        </button>
        <button
          className="icon-button skip-button"
          onClick={() => controller.skip(-remotePolicy.seconds)}
          aria-label={remoteText("back", { seconds: remotePolicy.seconds })}
        >
          <RotateCcw />
          <small>{remotePolicy.seconds}</small>
        </button>
        <button
          className="play-button"
          onClick={() => void controller.toggle()}
          aria-label={activePlayback ? t("common.pause") : t("common.play")}
        >
          {activePlayback ? (
            <Pause fill="currentColor" />
          ) : (
            <Play fill="currentColor" />
          )}
        </button>
        <button
          className="icon-button skip-button"
          onClick={() => controller.skip(remotePolicy.seconds)}
          aria-label={remoteText("forward", { seconds: remotePolicy.seconds })}
        >
          <RotateCw />
          <small>{remotePolicy.seconds}</small>
        </button>
        <button
          className="icon-button player-chapter-button"
          disabled={!timeline.next}
          onClick={() =>
            timeline.next && controller.goToChapter(timeline.next.id)
          }
          aria-label={remoteText("next")}
          title={remoteText("next")}
        >
          <SkipForward fill="currentColor" />
        </button>
      </div>
      <div className="player-book-summary">
        <span>{playerText("wholeBook")}</span>
        <strong>{playerRemainingLabel(timeline, locale)}</strong>
        {timeline.bookDuration !== null && (
          <progress
            aria-label={playerText("wholeBook")}
            max={timeline.bookDuration}
            value={timeline.bookElapsed}
          />
        )}
      </div>
      {state.error && (
        <div role="alert" className="error-banner">
          {state.error}
        </div>
      )}
      <div className="player-options">
        <label>
          <span>{playerText("remoteControls")}</span>
          <select
            value={
              remotePolicy.mode === "chapter"
                ? "chapter"
                : String(remotePolicy.seconds)
            }
            onChange={(event) => changeRemote(event.target.value)}
          >
            {[10, 15, 30, 45, 60].map((seconds) => (
              <option key={seconds} value={seconds}>
                {remoteText("seconds", { seconds })}
              </option>
            ))}
            <option value="chapter">{remoteText("chapter")}</option>
          </select>
        </label>
        <label>
          <span>{t("player.speed")}</span>
          <select
            value={state.rate}
            onChange={(e) => controller.setRate(Number(e.target.value))}
          >
            {Array.from(
              new Set([
                0.5,
                0.75,
                0.9,
                1,
                1.1,
                1.2,
                1.25,
                1.3,
                1.4,
                1.5,
                1.75,
                2,
                2.5,
                3,
                state.rate,
              ]),
            )
              .sort((a, b) => a - b)
              .map((rate) => (
                <option key={rate} value={rate}>
                  {new Intl.NumberFormat(locale, {
                    maximumFractionDigits: 2,
                  }).format(rate)}
                  ×
                </option>
              ))}
          </select>
        </label>
        <label>
          <span>
            <Timer size={14} />
            {t("player.timer")}
          </span>
          <select
            aria-label={t("player.timer")}
            value={
              state.sleepAtChapterEnd !== null
                ? "chapter"
                : state.sleepUntil !== null
                  ? "active"
                  : "off"
            }
            onChange={(e) =>
              controller.setSleepTimer(
                e.target.value === "off"
                  ? null
                  : e.target.value === "chapter"
                    ? { endOfChapter: true }
                    : { minutes: Number(e.target.value) },
              )
            }
          >
            <option value="off">{t("common.off")}</option>
            {state.sleepUntil && (
              <option value="active">
                {t("player.ends", {
                  time: new Date(state.sleepUntil).toLocaleTimeString(locale, {
                    hour: "numeric",
                    minute: "2-digit",
                  }),
                })}
              </option>
            )}
            {[5, 10, 15, 30, 45, 60].map((n) => (
              <option value={n} key={n}>
                {t("common.minutes", { count: n })}
              </option>
            ))}
            {chapterList.length > 0 && (
              <option value="chapter">{t("player.chapterEnd")}</option>
            )}
          </select>
        </label>
      </div>
      {preferenceError && (
        <p role="alert" className="error-banner">
          {remoteText("save")}
        </p>
      )}
      {remotePolicy.mode === "chapter" && !chapterSkipping && (
        <p className="player-policy-note">
          {remoteText("fallback", { seconds: remotePolicy.seconds })}
        </p>
      )}
      {onRead && (
        <button className="secondary-button full-width" onClick={onRead}>
          <BookOpen size={18} />
          {alignmentText("read")}
        </button>
      )}
      {readAlong && <div className="player-read-along">{readAlong}</div>}
      {offlineControl && (
        <div className="player-offline-control">{offlineControl}</div>
      )}
      <div className="player-bottom">
        {onNote && (
          <button className="text-button" onClick={onNote}>
            <BookmarkPlus size={18} />
            {t("note.add")}
          </button>
        )}
        <button
          className="text-button"
          aria-expanded={chapters}
          aria-controls={chapterListId}
          onClick={() => setChapters(!chapters)}
        >
          <List size={18} />{" "}
          {chapters ? t("player.hideChapters") : t("player.chapters")}
        </button>
      </div>
      {chapters && (
        <div className="chapter-list" id={chapterListId}>
          {chapterList.length ? (
            chapterList.map((chapter, index) => (
              <button
                key={chapter.id}
                onClick={() => controller.goToChapter(chapter.id)}
                aria-current={
                  timeline.chapter?.id === chapter.id ? "true" : undefined
                }
                className={timeline.chapter?.id === chapter.id ? "active" : ""}
              >
                <span className="player-chapter-number" aria-hidden="true">
                  {index + 1}
                </span>
                <span className="player-chapter-name">
                  {chapter.title ||
                    playerText("chapterNumber", { number: index + 1 })}
                </span>
                <small
                  aria-label={playerText("duration", {
                    time: formatTime(chapter.duration),
                  })}
                >
                  {formatTime(chapter.duration)}
                </small>
              </button>
            ))
          ) : (
            <p>{t("player.noChapters")}</p>
          )}
        </div>
      )}
    </div>
  );
}
