import { describe, it, expect } from "vitest";
import {
  activitySeconds,
  recentDateKeys,
  isoWeek,
  shiftIsoWeek,
} from "./activityData";
describe("activity calendar and source presentation", () => {
  it("uses the server calendar day through timezone, DST and year boundaries", () => {
    expect(recentDateKeys("2027-01-01T01:00:00Z", "America/New_York")).toEqual([
      "2026-12-25",
      "2026-12-26",
      "2026-12-27",
      "2026-12-28",
      "2026-12-29",
      "2026-12-30",
      "2026-12-31",
    ]);
    expect(recentDateKeys("2026-03-09T02:00:00Z", "America/New_York")).toEqual([
      "2026-03-02",
      "2026-03-03",
      "2026-03-04",
      "2026-03-05",
      "2026-03-06",
      "2026-03-07",
      "2026-03-08",
    ]);
  });
  it("uses server source buckets without proportionally guessing reading/listening time", () => {
    const day = {
      day: "2026-10-09",
      totalSeconds: 100,
      readingSeconds: 60,
      listeningSeconds: 40,
      sessionsCount: 2,
      bySource: { ios: 30, android: 70 },
    };
    expect(activitySeconds(day, "all", "ios")).toBe(30);
    expect(activitySeconds(day, "reading")).toBe(60);
    expect(activitySeconds(day, "all", "unknown")).toBe(0);
  });
  it("moves through ISO week years without inventing week 54 or skipping week 53", () => {
    expect(isoWeek(new Date("2027-01-01T12:00:00Z"))).toEqual({
      year: 2026,
      week: 53,
    });
    expect(shiftIsoWeek("2026-12-28", 1)).toEqual({ year: 2027, week: 1 });
    expect(shiftIsoWeek("2027-01-04", -1)).toEqual({ year: 2026, week: 53 });
  });
});
