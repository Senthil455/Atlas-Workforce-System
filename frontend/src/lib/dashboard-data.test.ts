import { describe, it, expect } from "vitest";
import {
  USE_MOCK_DATA,
  toWeeklyAttendanceTrend,
  toHiringPipelineStages,
  toActivityItems,
} from "./dashboard-data";

describe("USE_MOCK_DATA", () => {
  it("is false by default so dashboards never render mock numbers unasked", () => {
    expect(USE_MOCK_DATA).toBe(false);
  });
});

describe("toWeeklyAttendanceTrend", () => {
  it("maps heatmap rows to Mon-Fri present rates", () => {
    const payload = {
      data: [
        { date: "2026-05-18", statuses: { PRESENT: 96, LATE: 4 }, total: 100, overtime: 0 },
        { date: "2026-05-19", statuses: { PRESENT: 90, ABSENT: 10 }, total: 100, overtime: 0 },
      ],
      period: "week",
    };
    expect(toWeeklyAttendanceTrend(payload)).toEqual([
      { day: "Mon", rate: 96 },
      { day: "Tue", rate: 90 },
    ]);
  });

  it("skips weekend rows and rows with no total", () => {
    const payload = {
      data: [
        { date: "2026-05-18", statuses: { PRESENT: 96 }, total: 100, overtime: 0 },
        { date: "2026-05-23", statuses: { PRESENT: 50 }, total: 100, overtime: 0 },
        { date: "2026-05-19", statuses: { PRESENT: 0 }, total: 0, overtime: 0 },
      ],
    };
    expect(toWeeklyAttendanceTrend(payload)).toEqual([
      { day: "Mon", rate: 96 },
    ]);
  });

  it("returns an empty array when the heatmap has no rows", () => {
    expect(toWeeklyAttendanceTrend({ data: [] })).toEqual([]);
    expect(toWeeklyAttendanceTrend(undefined)).toEqual([]);
    expect(toWeeklyAttendanceTrend(null)).toEqual([]);
  });
});

describe("toHiringPipelineStages", () => {
  it("maps pipelineStages onto chart data", () => {
    const payload = {
      openPositions: 23,
      pipelineStages: [
        { stage: "Applied", count: 156 },
        { stage: "Screening", count: 98 },
        { stage: "Offer", count: 7 },
      ],
    };
    expect(toHiringPipelineStages(payload)).toEqual([
      { stage: "Applied", count: 156 },
      { stage: "Screening", count: 98 },
      { stage: "Offer", count: 7 },
    ]);
  });

  it("returns an empty array when there are no stages", () => {
    expect(toHiringPipelineStages({})).toEqual([]);
    expect(toHiringPipelineStages(undefined)).toEqual([]);
  });
});

describe("toActivityItems", () => {
  it("maps activities and drops types the feed cannot render", () => {
    const payload = {
      activities: [
        {
          id: 1,
          type: "hire",
          department: "Engineering",
          message: "Sarah Chen accepted Senior Developer offer",
          timestamp: "2026-05-25T09:15:00Z",
        },
        {
          id: 4,
          type: "risk",
          department: "Engineering",
          message: "Alex Rivera flagged as high attrition risk",
          timestamp: "2026-05-25T07:30:00Z",
        },
      ],
    };
    expect(toActivityItems(payload)).toEqual([
      {
        id: "1",
        type: "hire",
        actor: "Engineering",
        description: "Sarah Chen accepted Senior Developer offer",
        timestamp: "2026-05-25T09:15:00Z",
      },
    ]);
  });

  it("returns an empty array when there are no activities", () => {
    expect(toActivityItems({ activities: [] })).toEqual([]);
    expect(toActivityItems(undefined)).toEqual([]);
  });
});
