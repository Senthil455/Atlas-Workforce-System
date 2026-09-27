"use client";


import { useQuery } from "@tanstack/react-query";
import { analyticsApi, employeeApi, attendanceApi, commandCenterApi } from "@/lib/api";
import { KpiCard } from "@/components/dashboard/kpi-card";
import { HeadcountChart } from "@/components/charts/headcount-chart";
import { DepartmentChart } from "@/components/charts/department-chart";
import { AttendanceChart } from "@/components/charts/attendance-chart";
import { HiringPipelineChart } from "@/components/charts/hiring-pipeline-chart";
import { WorkforceGrowthChart } from "@/components/charts/workforce-growth-chart";
import { ActivityFeed } from "@/components/dashboard/activity-feed";
import { LiveCheckins } from "@/components/dashboard/live-checkins";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { PageContainer } from "@/components/layout/page-container";
import { Users, Clock, UserX, AlertTriangle, Briefcase, TrendingDown } from "lucide-react";
import {
  dashboardKpis as fallbackKpis,
  departmentBreakdown as fallbackDept,
  headcountTrend as fallbackHeadcount,
  attendanceTrend as fallbackAttendanceTrend,
  hiringPipeline as fallbackPipeline,
  workforceGrowth as fallbackGrowth,
  recentActivity as fallbackActivity,
  mockAttendance,
} from "@/lib/mock-data";
import {
  USE_MOCK_DATA,
  toWeeklyAttendanceTrend,
  toHiringPipelineStages,
  toActivityItems,
} from "@/lib/dashboard-data";
import { useMemo } from "react";

function parseAttendanceRecords(raw: any) {
  if (!raw || !Array.isArray(raw)) return [];
  return raw.map((r: any) => ({
    id: r.employeeId ?? r.id ?? "",
    employeeName: r.employeeName ?? "",
    time: r.clockIn
      ? new Date(r.clockIn).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
      : r.checkIn ?? "",
    status: r.status ?? "UNKNOWN",
  }));
}

export default function DashboardPage() {
  // --- Queries ---
  const deptQuery = useQuery({
    queryKey: ["analytics", "department"],
    queryFn: async () => {
      const { data } = await analyticsApi.department();
      return (data ?? []) as Array<{ department: string; count: number }>;
    },
    retry: 1,
    staleTime: 30000,
  });

  const empQuery = useQuery({
    queryKey: ["employees", "total"],
    queryFn: async () => {
      const { data } = await employeeApi.list({ page: 1, pageSize: 1 });
      return (data ?? { total: 0 }) as { total: number };
    },
    retry: 1,
    staleTime: 30000,
  });

  const attendanceQuery = useQuery({
    queryKey: ["attendance", "list"],
    queryFn: async () => {
      const { data } = await attendanceApi.list();
      return (Array.isArray(data) ? data : []) as Array<any>;
    },
    retry: 1,
    staleTime: 15000,
  });

  const heatmapQuery = useQuery({
    queryKey: ["attendance", "heatmap", "week"],
    queryFn: async () => {
      const { data } = await attendanceApi.heatmap("week");
      return data as unknown;
    },
    retry: 1,
    staleTime: 15000,
  });

  const pipelineQuery = useQuery({
    queryKey: ["command-center", "hiring-pipeline"],
    queryFn: async () => {
      const { data } = await commandCenterApi.hiringPipeline();
      return data as unknown;
    },
    retry: 1,
    staleTime: 30000,
  });

  const activityQuery = useQuery({
    queryKey: ["activity", "feed"],
    queryFn: async () => {
      const { data } = await commandCenterApi.activityFeed({ limit: 10 });
      return data as unknown;
    },
    retry: 1,
    staleTime: 30000,
  });

  // --- Derived metrics with validation ---
  const totalEmployees = useMemo(() => {
    if (deptQuery.data && Array.isArray(deptQuery.data) && deptQuery.data.length > 0) {
      return deptQuery.data.reduce((sum, d) => sum + (Number(d?.count) || 0), 0);
    }
    if (empQuery.data && typeof empQuery.data.total === "number") {
      return empQuery.data.total;
    }
    // No live total available. Only fall back to the mock headcount when
    // sample data is explicitly enabled; otherwise report 0 so an outage
    // is visible instead of looking like a healthy 1248-employee org.
    return USE_MOCK_DATA ? fallbackKpis[0]?.value ?? 0 : 0;
  }, [deptQuery.data, empQuery.data]);

  const todayStr = typeof window !== "undefined"
    ? new Date().toISOString().slice(0, 10)
    : "";

  const presentToday = useMemo(() => {
    const raw = attendanceQuery.data;
    if (!raw || !Array.isArray(raw) || raw.length === 0) return 0;
    const count = raw.filter((r: any) => r?.date === todayStr && r?.status === "PRESENT").length;
    return Math.min(count, totalEmployees);
  }, [attendanceQuery.data, todayStr, totalEmployees]);

  const lateToday = useMemo(() => {
    const raw = attendanceQuery.data;
    if (!raw || !Array.isArray(raw)) return 0;
    return raw.filter((r: any) => r?.status === "LATE").length;
  }, [attendanceQuery.data]);

  const absentToday = useMemo(() => {
    if (totalEmployees === 0) return 0;
    return Math.max(0, totalEmployees - presentToday - lateToday);
  }, [totalEmployees, presentToday, lateToday]);

  const attritionRate = USE_MOCK_DATA ? 8.4 : 0;

  const openPositions = useMemo(() => {
    const raw = (pipelineQuery.data as { openPositions?: unknown } | null)?.openPositions;
    if (typeof raw === "number") return raw;
    return USE_MOCK_DATA ? 23 : 0;
  }, [pipelineQuery.data]);

  const kpiMetrics = [
    { label: "Total Employees", value: totalEmployees, change: 4.2, trend: "up" as const, icon: Users, subtitle: `${totalEmployees} active` },
    { label: "Present Today", value: presentToday, change: 1.8, trend: presentToday > 0 ? "up" as const : "neutral" as const, icon: Clock, subtitle: `${((presentToday / Math.max(totalEmployees, 1)) * 100).toFixed(0)}% attendance` },
    { label: "Absent", value: absentToday, change: -8, trend: "down" as const, icon: UserX, subtitle: `${((absentToday / Math.max(totalEmployees, 1)) * 100).toFixed(0)}% of workforce` },
    { label: "Late", value: lateToday, change: 5, trend: "up" as const, icon: AlertTriangle, subtitle: "needs attention" },
    { label: "Open Positions", value: openPositions, change: -12, trend: "down" as const, icon: Briefcase, subtitle: `${openPositions} active reqs` },
    { label: "Attrition Rate", value: attritionRate, change: 0.6, trend: "up" as const, icon: TrendingDown, subtitle: "YTD average" },
  ];

  const isKpiLoading = deptQuery.isLoading || empQuery.isLoading || attendanceQuery.isLoading || pipelineQuery.isLoading;
  const isKpiError = deptQuery.isError && empQuery.isError;

  // --- Chart data ---
  const deptChartData = useMemo(() => {
    if (deptQuery.data && Array.isArray(deptQuery.data) && deptQuery.data.length > 0) {
      return deptQuery.data.map((d: any) => ({ name: d?.department ?? "", value: Number(d?.count) || 0 }));
    }
    return USE_MOCK_DATA ? fallbackDept : [];
  }, [deptQuery.data]);

  const checkinData = useMemo(() => {
    const raw = attendanceQuery.data;
    if (raw && Array.isArray(raw) && raw.length > 0) {
      const today = raw.filter((r: any) => r?.date === todayStr);
      if (today.length > 0) return parseAttendanceRecords(today.slice(0, 6));
      return parseAttendanceRecords(raw.slice(0, 6));
    }
    return USE_MOCK_DATA
      ? mockAttendance.map((r) => ({ id: r.id, employeeName: r.employeeName, time: r.checkIn, status: r.status }))
      : [];
  }, [attendanceQuery.data, todayStr]);

  // Weekly attendance trend comes from the live heatmap endpoint. The mock
  // series is only used when sample data is explicitly enabled.
  const attendanceTrendData = useMemo(() => {
    const live = toWeeklyAttendanceTrend(heatmapQuery.data);
    if (live.length > 0) return live;
    return USE_MOCK_DATA ? fallbackAttendanceTrend : [];
  }, [heatmapQuery.data]);

  // No headcount-history endpoint exists on the backend, so this chart has
  // no live source. It renders empty unless sample data is enabled.
  const headcountData = USE_MOCK_DATA ? fallbackHeadcount : [];

  const pipelineStages = useMemo(() => {
    const live = toHiringPipelineStages(pipelineQuery.data);
    if (live.length > 0) return live;
    return USE_MOCK_DATA ? fallbackPipeline : [];
  }, [pipelineQuery.data]);

  // No workforce-growth endpoint exists on the backend, so this chart has
  // no live source. It renders empty unless sample data is enabled.
  const growthData = USE_MOCK_DATA ? fallbackGrowth : [];

  const activityItems = useMemo(() => {
    const live = toActivityItems(activityQuery.data);
    if (live.length > 0) return live;
    return USE_MOCK_DATA ? fallbackActivity : [];
  }, [activityQuery.data]);

  // --- Retry handlers ---
  const handleRetry = (query: { refetch: () => unknown }) => () => {
    query.refetch();
  };

  return (
    <ErrorBoundary>
      <PageContainer>
        <div className="grid grid-cols-12 gap-4">
          {USE_MOCK_DATA && (
            <div
              data-testid="sample-data-banner"
              className="col-span-12 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-xs text-amber-700 dark:text-amber-300"
            >
              Sample data is enabled (NEXT_PUBLIC_USE_MOCK_DATA=true). Widgets
              below show mock values instead of live data.
            </div>
          )}
          {/* === KPI Cards: 6 metrics in 3x2 grid on 2xl, 2x3 on lg, 1-col on mobile === */}
          {kpiMetrics.map((m, i) => {
            const Icon = m.icon;
            const loading = isKpiLoading && !deptQuery.data && !empQuery.data;
            const error = i >= 2 ? false : isKpiError;
            return (
              <div key={m.label} className="col-span-6 md:col-span-4 2xl:col-span-2">
                <KpiCard
                  metric={{ label: m.label, value: m.value, change: m.change, trend: m.trend }}
                  index={i}
                  icon={<Icon className="h-4 w-4" />}
                  loading={loading && i < 2}
                  error={error}
                  onRetry={handleRetry(deptQuery)}
                  subtitle={m.subtitle}
                />
              </div>
            );
          })}

          {/* === Row 2: Headcount Trend (wide) + Department Distribution (narrow) === */}
          <div className="col-span-12 xl:col-span-8 2xl:col-span-7">
            <HeadcountChart
              data={headcountData}
            />
          </div>
          <div className="col-span-12 xl:col-span-4 2xl:col-span-5">
            <DepartmentChart
              data={deptChartData}
              loading={deptQuery.isLoading}
              error={deptQuery.isError}
              onRetry={handleRetry(deptQuery)}
            />
          </div>

          {/* === Row 3: Attendance Trend + Hiring Pipeline + Workforce Growth === */}
          <div className="col-span-12 md:col-span-6 xl:col-span-4">
            <AttendanceChart
              data={attendanceTrendData}
              loading={heatmapQuery.isLoading}
              error={heatmapQuery.isError}
              onRetry={handleRetry(heatmapQuery)}
            />
          </div>
          <div className="col-span-12 md:col-span-6 xl:col-span-4">
            <HiringPipelineChart
              data={pipelineStages}
              loading={pipelineQuery.isLoading}
              error={pipelineQuery.isError}
              onRetry={handleRetry(pipelineQuery)}
            />
          </div>
          <div className="col-span-12 xl:col-span-4">
            <WorkforceGrowthChart data={growthData} />
          </div>

          {/* === Row 4: Activity Feed + Live Check-ins === */}
          <div className="col-span-12 xl:col-span-7">
            <ActivityFeed
              data={activityItems}
              loading={activityQuery.isLoading}
              error={activityQuery.isError}
              onRetry={handleRetry(activityQuery)}
            />
          </div>
          <div className="col-span-12 xl:col-span-5">
            <LiveCheckins
              data={checkinData}
              loading={attendanceQuery.isLoading}
              error={attendanceQuery.isError}
              onRetry={handleRetry(attendanceQuery)}
            />
          </div>
        </div>
      </PageContainer>
    </ErrorBoundary>
  );
}
