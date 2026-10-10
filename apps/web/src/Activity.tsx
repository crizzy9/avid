import { useI18n } from "../../../packages/i18n/src";
import { useEffect, useState } from "react";
import { BookOpen, LoaderCircle } from "lucide-react";
import {
  BookOrbitClient,
  type ServerReadingStatistics,
} from "../../../packages/core/src/bookorbit";
import type { Book, ReadingSession } from "../../../packages/core/src/types";
import { formatTime } from "./ui";
import { activitySeconds, dateKey, recentDateKeys } from "./activityData";
import { useActivityI18n } from "./activityMessages";
import { ServerActivityHistory } from "./ServerActivityHistory";

export function Activity({
  client,
  books,
  sessions,
}: {
  client: BookOrbitClient | null;
  books: Book[];
  sessions: ReadingSession[];
}) {
  const { t, locale, setLocale } = useI18n();
  const a = useActivityI18n();

  const [stats, setStats] = useState<ServerReadingStatistics | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [kind, setKind] = useState<"all" | "reading" | "listening">("all");
  const [year, setYear] = useState<number | undefined>();
  const [source, setSource] = useState("all");
  useEffect(() => {
    let active = true;
    setStats(null);
    setError("");
    if (!client) return;
    setLoading(true);
    client
      .getReadingStatistics(year)
      .then((value) => {
        if (active) setStats(value);
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, year]);
  const filtered = sessions.filter(
    (s) =>
      kind === "all" ||
      (kind === "listening" ? s.kind === "listening" : s.kind !== "listening"),
  );
  const allSeconds = stats
    ? kind === "all"
      ? stats.snapshot.lastSevenDays.totalSeconds
      : kind === "reading"
        ? stats.snapshot.lastSevenDays.readingSeconds
        : stats.snapshot.lastSevenDays.listeningSeconds
    : filtered.reduce((sum, s) => sum + s.duration, 0);
  const days = recentDateKeys(
    stats?.generatedAt ?? new Date().toISOString(),
    stats?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  ).map((key) => {
    const date = new Date(`${key}T12:00:00Z`);
    const serverDay = (stats?.recentDays ?? stats?.currentCalendar.days)?.find(
      (d) => d.day === key,
    );
    const value = client
      ? activitySeconds(serverDay, kind, source)
      : filtered
          .filter(
            (s) =>
              dateKey(
                new Date(s.startedAt),
                Intl.DateTimeFormat().resolvedOptions().timeZone,
              ) === key,
          )
          .reduce((total, s) => total + s.duration, 0);
    return {
      key,
      label: date.toLocaleDateString(locale, {
        weekday: "short",
        timeZone: "UTC",
      }),
      seconds: value,
    };
  });
  const seconds =
    stats && source !== "all"
      ? days.reduce((sum, day) => sum + day.seconds, 0)
      : allSeconds;
  const sources = [
    ...new Set([
      ...(stats?.sources.slices.map((slice) => slice.bucket) ?? []),
      ...(stats?.calendar.days.flatMap((day) => Object.keys(day.bySource)) ??
        []),
    ]),
  ].sort();
  const max = Math.max(60, ...days.map((d) => d.seconds));
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">{t("activity.eyebrow")}</span>
          <h1>{t("activity.heading")}</h1>
          <p>
            {client
              ? t("activity.serverHint", { timezone: stats?.timezone ?? "" })
              : t("activity.localHint")}
          </p>
        </div>
      </div>
      <div className="library-toolbar">
        <div className="filter-tabs">
          {[
            ["all", t("activity.all")],
            ["reading", t("activity.reading")],
            ["listening", t("activity.listening")],
          ].map(([value, label]) => (
            <button
              key={value}
              className={kind === value ? "active" : ""}
              onClick={() => {
                setKind(value as typeof kind);
                setSource("all");
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {stats && (
          <label>
            {a("source")}{" "}
            <select
              value={source}
              onChange={(event) => {
                setSource(event.target.value);
                setKind("all");
              }}
            >
              <option value="all">{a("allSources")}</option>
              {sources.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
        )}
        {stats && (
          <select
            aria-label={t("activity.year")}
            value={year ?? stats.calendar.year}
            onChange={(e) => setYear(Number(e.target.value))}
          >
            {stats.calendar.availableYears.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        )}
      </div>
      {stats && <p className="muted">{a("sourceHint")}</p>}
      {error && (
        <div className="error-banner" role="alert">
          {t("activity.error", { error })}
        </div>
      )}
      {loading ? (
        <p className="loading-label" role="status">
          <LoaderCircle className="spin" size={17} />
          {t("activity.loading")}
        </p>
      ) : (
        (!client || stats) && (
          <>
            <div className="stats-grid">
              <div>
                <span>
                  {client ? t("activity.weekTime") : t("activity.time")}
                </span>
                <strong>
                  {Math.round(seconds / 60)}
                  <small>{t("common.min")}</small>
                </strong>
              </div>
              <div>
                <span>
                  {client ? t("activity.completed") : t("activity.explored")}
                </span>
                {client && <small>{a("allTime")}</small>}
                <strong>
                  {stats?.summary.completedBooks ??
                    new Set(filtered.map((s) => s.bookId)).size}
                </strong>
              </div>
              <div>
                <span>
                  {client ? t("activity.streak") : t("activity.sessions")}
                </span>
                {client && <small>{a("allTime")}</small>}
                <strong>
                  {stats?.snapshot.currentStreak ?? filtered.length}
                  {client && <small>{t("common.days")}</small>}
                </strong>
              </div>
            </div>
            <div className="activity-panel">
              <h2>{t("activity.week")}</h2>
              <div
                className="activity-chart"
                role="img"
                aria-label={days
                  .map(
                    (d) =>
                      `${d.label}: ${t("common.minutes", { count: Math.round(d.seconds / 60) })}`,
                  )
                  .join(", ")}
              >
                {days.map((day) => (
                  <div key={day.key}>
                    <span>
                      {Math.round(day.seconds / 60)} {t("common.min")}
                    </span>
                    <div className="bar-track">
                      <div
                        style={{ height: `${(day.seconds / max) * 100}%` }}
                      />
                    </div>
                    <small>{day.label}</small>
                  </div>
                ))}
              </div>
            </div>
            {stats && (
              <section className="activity-history">
                <h2>{t("activity.calendar", { year: stats.calendar.year })}</h2>
                <p className="muted">
                  {t("activity.yearSummary", {
                    days: stats.calendar.days.filter(
                      (d) => activitySeconds(d, kind, source) > 0,
                    ).length,
                    minutes: Math.round(
                      stats.calendar.days.reduce(
                        (sum, d) => sum + activitySeconds(d, kind, source),
                        0,
                      ) / 60,
                    ),
                  })}
                </p>
                <div className="activity-calendar">
                  {stats.calendar.days
                    .filter((d) => activitySeconds(d, kind, source) > 0)
                    .map((day) => (
                      <span
                        key={day.day}
                        title={`${day.day}: ${t("common.minutes", { count: Math.round(activitySeconds(day, kind, source) / 60) })}`}
                      >
                        {day.day}
                        <strong>
                          {Math.round(activitySeconds(day, kind, source) / 60)}{" "}
                          {t("common.min")}
                        </strong>
                      </span>
                    ))}
                </div>
              </section>
            )}
          </>
        )
      )}
      {client && (
        <ServerActivityHistory
          client={client}
          source={source}
          timezone={stats?.timezone}
        />
      )}
      <section className="activity-history">
        <h2>{client ? a("local") : t("activity.recent")}</h2>
        {filtered.length ? (
          [...filtered]
            .reverse()
            .slice(0, 20)
            .map((session) => (
              <div key={session.id}>
                <BookOpen size={20} />
                <span>
                  {books.find((b) => b.id === session.bookId)?.title ??
                    t("activity.sessions")}
                  <small>
                    {new Date(session.startedAt).toLocaleString(locale)} ·{" "}
                    {session.kind === "listening"
                      ? t("activity.listening")
                      : t("activity.reading")}
                  </small>
                </span>
                <strong>{formatTime(session.duration)}</strong>
              </div>
            ))
        ) : (
          <p className="muted">{t("activity.empty")}</p>
        )}
      </section>
    </>
  );
}
