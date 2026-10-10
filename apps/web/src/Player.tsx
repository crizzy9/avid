import { useI18n } from "../../../packages/i18n/src";
import { useAlignmentI18n } from "./alignmentMessages";
import { useState, useSyncExternalStore } from "react";
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
} from "lucide-react";
import type {PlaybackTransport} from '../../mobile/src/native-transport';
import type { Book } from "../../../packages/core/src/types";
import { Cover, formatTime } from "./ui";

export function Player({
  controller,
  book,
  onNote,
  onRead,
}: {
  controller: PlaybackTransport;
  book: Book;
  onNote: () => void;
  onRead?: () => void;
}) {
  const { t, locale, setLocale } = useI18n();
  const { t: alignmentText } = useAlignmentI18n();

  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
  );
  const [chapters, setChapters] = useState(false);
  const chapterList = controller.getBook()?.chapters ?? [];
  return (
    <div className="player-view">
      <div className="player-art">
        <Cover book={book} large />
      </div>
      <div className="eyebrow">
        <Headphones size={13} />
        {t("player.now")}
      </div>
      <h2>{book.title}</h2>
      <p>{book.authors.join(", ")}</p>
      <p className="player-chapter">
        {chapterList[state.chapterIndex]?.title || t("common.audio")}
        {book.id.startsWith("demo-") ? ` · ${t("player.sample")}` : ""}
      </p>
      <input
        className="audio-range"
        aria-label={t("player.position")}
        type="range"
        min="0"
        max={state.duration || 1}
        step=".1"
        value={Math.min(state.currentTime, state.duration || 1)}
        onChange={(e) => controller.seek(Number(e.target.value))}
      />
      <div className="timeline-labels">
        <span>{formatTime(state.currentTime)}</span>
        <span>−{formatTime(state.duration - state.currentTime)}</span>
      </div>
      <div className="player-transport">
        <button
          className="icon-button skip-button"
          onClick={() => controller.skip(-30)}
          aria-label={t("player.back")}
        >
          <RotateCcw />
          <small>30</small>
        </button>
        <button
          className="play-button"
          onClick={() => void controller.toggle()}
          aria-label={
            state.status === "playing" ? t("common.pause") : t("common.play")
          }
        >
          {state.status === "playing" ? (
            <Pause fill="currentColor" />
          ) : (
            <Play fill="currentColor" />
          )}
        </button>
        <button
          className="icon-button skip-button"
          onClick={() => controller.skip(30)}
          aria-label={t("player.forward")}
        >
          <RotateCw />
          <small>30</small>
        </button>
      </div>
      {state.error && (
        <div role="alert" className="error-banner">
          {state.error}
        </div>
      )}
      <div className="player-options">
        <label>
          <span>{t("player.speed")}</span>
          <select
            value={state.rate}
            onChange={(e) => controller.setRate(Number(e.target.value))}
          >
            {[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3].map((rate) => (
              <option key={rate} value={rate}>
                {rate}×
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
      {onRead && <button className="secondary-button full-width" onClick={onRead}><BookOpen size={18} />{alignmentText('read')}</button>}
      <div className="player-bottom">
        <button className="text-button" onClick={onNote}>
          <BookmarkPlus size={18} />
          {t("note.add")}
        </button>
        <button className="text-button" onClick={() => setChapters(!chapters)}>
          <List size={18} />{" "}
          {chapters ? t("player.hideChapters") : t("player.chapters")}
        </button>
      </div>
      {chapters && (
        <div className="chapter-list">
          {chapterList.length ? (
            chapterList.map((chapter) => (
              <button
                key={chapter.id}
                onClick={() => controller.goToChapter(chapter.id)}
                className={
                  chapterList[state.chapterIndex]?.id === chapter.id
                    ? "active"
                    : ""
                }
              >
                <span>{chapter.title}</span>
                <small>{formatTime(chapter.start)}</small>
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
