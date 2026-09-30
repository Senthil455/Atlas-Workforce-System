// Helpers that map live API payloads onto the shapes the dashboard charts expect.
// Pure functions, so they can be unit tested without rendering.
//
// Charts that have no backing endpoint (headcount trend, workforce growth)
// do not get mock numbers here. Callers gate the mock-data.ts fallbacks
// behind USE_MOCK_DATA instead, so production renders empty states rather
// than plausible-looking sample series.

export const USE_MOCK_DATA =
  process.env.NEXT_PUBLIC_USE_MOCK_DATA === "true";

export interface WeeklyAttendancePoint {
  day: string;
  rate: number;
}

export interface PipelineStage {
  stage: string;
  count: number;
}

export type ActivityType =
  | "hire"
  | "promotion"
  | "departure"
  | "training"
  | "achievement"
  | "leave";

export interface ActivityItem {
  id: string;
  type: ActivityType;
  actor: string;
  description: string;
  timestamp: string;
}

const KNOWN_ACTIVITY_TYPES: ActivityType[] = [
  "hire",
  "promotion",
  "departure",
  "training",
  "achievement",
  "leave",
];

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];

function weekdayLabel(dateStr: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  const dow = d.getUTCDay(); // 0 = Sunday ... 6 = Saturday
  if (dow < 1 || dow > 5) return null;
  return WEEKDAYS[dow - 1];
}

// attendanceApi.heatmap("week") returns { data: [{ date, statuses, total }] }.
// Collapse it into Mon-Fri present rates for the AttendanceChart.
export function toWeeklyAttendanceTrend(payload: unknown): WeeklyAttendancePoint[] {
  const rows = Array.isArray(payload)
    ? payload
    : (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(rows) || rows.length === 0) return [];

  const byDay = new Map<string, { present: number; total: number }>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const total = Number(record.total) || 0;
    if (total <= 0) continue;
    const label = typeof record.date === "string" ? weekdayLabel(record.date) : null;
    if (!label) continue;
    const statuses = (record.statuses ?? {}) as Record<string, unknown>;
    const present =
      Number(statuses.PRESENT ?? statuses.present ?? 0) || 0;
    const agg = byDay.get(label) ?? { present: 0, total: 0 };
    agg.present += present;
    agg.total += total;
    byDay.set(label, agg);
  }

  return WEEKDAYS.filter((day) => byDay.has(day)).map((day) => {
    const agg = byDay.get(day) as { present: number; total: number };
    return {
      day,
      rate: Math.round((agg.present / agg.total) * 1000) / 10,
    };
  });
}

// commandCenterApi.hiringPipeline() returns { pipelineStages: [{ stage, count }] }.
// Map it onto the HiringPipelineChart shape.
export function toHiringPipelineStages(payload: unknown): PipelineStage[] {
  const stages = Array.isArray(payload)
    ? payload
    : (payload as { pipelineStages?: unknown } | null)?.pipelineStages;
  if (!Array.isArray(stages)) return [];
  return stages
    .filter(
      (s): s is Record<string, unknown> => !!s && typeof s === "object"
    )
    .map((s) => ({
      stage: String(s.stage ?? s.name ?? ""),
      count: Number(s.count ?? s.value ?? 0) || 0,
    }))
    .filter((s) => s.stage !== "");
}

// commandCenterApi.activityFeed() returns { activities: [...] } with backend
// event types. Only pass through the types ActivityFeed can render; anything
// else is dropped so the widget never receives an unrenderable item.
export function toActivityItems(payload: unknown): ActivityItem[] {
  const items = Array.isArray(payload)
    ? payload
    : (payload as { activities?: unknown } | null)?.activities;
  if (!Array.isArray(items)) return [];
  const out: ActivityItem[] = [];
  items.forEach((item, i) => {
    if (!item || typeof item !== "object") return;
    const raw = item as Record<string, unknown>;
    const type = raw.type as ActivityType;
    if (!KNOWN_ACTIVITY_TYPES.includes(type)) return;
    out.push({
      id: String(raw.id ?? `activity-${i}`),
      type,
      actor: String(raw.actor ?? raw.department ?? ""),
      description: String(raw.description ?? raw.message ?? ""),
      timestamp: String(raw.timestamp ?? ""),
    });
  });
  return out;
}
