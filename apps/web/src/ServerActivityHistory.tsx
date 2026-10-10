import { useEffect, useState } from "react";
import { BookOpen } from "lucide-react";
import { useI18n } from "../../../packages/i18n/src";
import {
  BookOrbitClient,
  type ServerSessionTimeline,
} from "../../../packages/core/src/bookorbit";
import { formatTime } from "./ui";
import { useActivityI18n } from "./activityMessages";
import { isoWeek, shiftIsoWeek } from "./activityData";
export function ServerActivityHistory({
  client,
  source,
  timezone,
}: {
  client: BookOrbitClient;
  source: string;
  timezone?: string;
}) {
  const { t, locale } = useI18n(),
    a = useActivityI18n();
  const [week, setWeek] = useState(() => isoWeek(new Date())),
    [history, setHistory] = useState<ServerSessionTimeline | null>(null),
    [error, setError] = useState(""),
    [limit, setLimit] = useState(20);
  useEffect(() => {
    const abort = new AbortController();
    setHistory(null);
    setError("");
    setLimit(20);
    void client
      .getSessionTimeline({ ...week, signal: abort.signal })
      .then((value) => {
        if (!abort.signal.aborted) setHistory(value);
      })
      .catch((error) => {
        if (!abort.signal.aborted)
          setError(error instanceof Error ? error.message : String(error));
      });
    return () => abort.abort();
  }, [client, week]);
  useEffect(() => {
    setLimit(20);
  }, [source]);
  const items = (history?.items ?? [])
    .filter((item) => source === "all" || item.bookSource === source)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  return (
    <section className="activity-history">
      <h2>{a("timeline")}</h2>
      <p className="muted">{a("timelineHint")}</p>
      {error ? (
        <p className="error-banner" role="alert">
          {t("activity.error", { error })}
        </p>
      ) : !history ? (
        <p role="status">{t("activity.loading")}</p>
      ) : (
        <>
          <div className="library-toolbar">
            <button
              className="secondary-button"
              disabled={history.year <= 1970 && history.week === 1}
              onClick={() => setWeek(shiftIsoWeek(history.weekStart, -1))}
            >
              {a("previous")}
            </button>
            <span>
              {a("week", {
                year: history.year,
                week: history.week,
                start: history.weekStart,
                end: history.weekEnd,
              })}
            </span>
            <button
              className="secondary-button"
              disabled={history.year >= 2100 && history.week >= 52}
              onClick={() => setWeek(shiftIsoWeek(history.weekStart, 1))}
            >
              {a("next")}
            </button>
          </div>
          {items.length ? (
            items.slice(0, limit).map((item) => (
              <div key={item.sessionId}>
                <BookOpen size={20} />
                <span>
                  {item.bookTitle ?? t("activity.sessions")}
                  <small>
                    {new Date(item.startedAt).toLocaleString(locale, {
                      timeZone: timezone,
                    })}{" "}
                    · {item.bookFormat ?? ""} · {item.bookSource}
                  </small>
                </span>
                <strong>{formatTime(item.durationSeconds)}</strong>
              </div>
            ))
          ) : (
            <p className="muted">{a("noHistory")}</p>
          )}
          {items.length > limit && (
            <button
              className="text-button"
              onClick={() => setLimit((value) => value + 20)}
            >
              {a("more")}
            </button>
          )}
          {history.items.length >= 3000 && <p role="status">{a("limit")}</p>}
        </>
      )}
    </section>
  );
}
