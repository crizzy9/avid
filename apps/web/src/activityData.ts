import type { ServerReadingStatistics } from "../../../packages/core/src/bookorbit";
export type ActivityKind = "all" | "reading" | "listening";
export type ActivityDay = ServerReadingStatistics["calendar"]["days"][number];
export function activitySeconds(
  day: ActivityDay | undefined,
  kind: ActivityKind,
  source = "all",
) {
  if (!day) return 0;
  const value =
    source !== "all"
      ? (day.bySource[source] ?? 0)
      : kind === "all"
        ? day.totalSeconds
        : kind === "reading"
          ? day.readingSeconds
          : day.listeningSeconds;
  return Number.isFinite(value) && value > 0 ? value : 0;
}
export function dateKey(date: Date, timezone = "UTC") {
  const parts = new Intl.DateTimeFormat("en", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: timezone,
  }).formatToParts(date);
  const part = (type: string) =>
    parts.find((value) => value.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
export function recentDateKeys(generatedAt: string, timezone: string) {
  const today = new Date(
    `${dateKey(new Date(generatedAt), timezone)}T12:00:00Z`,
  );
  return Array.from({ length: 7 }, (_, index) => {
    const value = new Date(today);
    value.setUTCDate(value.getUTCDate() - 6 + index);
    return value.toISOString().slice(0, 10);
  });
}
export function isoWeek(date: Date) {
  const value = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  value.setUTCDate(value.getUTCDate() + 4 - (value.getUTCDay() || 7));
  const year = value.getUTCFullYear();
  return {
    year,
    week: Math.ceil(
      ((value.getTime() - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7,
    ),
  };
}
export function shiftIsoWeek(weekStart: string, offset: number) {
  const date = new Date(`${weekStart}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset * 7);
  return isoWeek(date);
}
