"use client";


import { useQuery } from "@tanstack/react-query";
import { analyticsApi, attendanceApi } from "@/lib/api";
import { HeadcountChart } from "@/components/charts/headcount-chart";
import { DepartmentChart } from "@/components/charts/department-chart";
import {
  attendanceTrend as fallbackAttendanceTrend,
  departmentBreakdown as fallbackDept,
  headcountTrend as fallbackHeadcount,
} from "@/lib/mock-data";
import {
  USE_MOCK_DATA,
  toWeeklyAttendanceTrend,
} from "@/lib/dashboard-data";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export default function AnalyticsPage() {
  const {
    data: deptData,
    isLoading: deptLoading,
    isError: deptError,
    refetch: refetchDept,
  } = useQuery({
    queryKey: ["analytics", "department"],
    queryFn: async () => {
      const { data } = await analyticsApi.department();
      return data as Array<{ department: string; count: number }>;
    },
    retry: false,
    staleTime: 30000,
  });

  const {
    data: perfData,
    isLoading: perfLoading,
    isError: perfError,
    refetch: refetchPerf,
  } = useQuery({
    queryKey: ["analytics", "performance"],
    queryFn: async () => {
      const { data } = await analyticsApi.performance();
      return data as Record<string, unknown>;
    },
    retry: false,
    staleTime: 60000,
  });

  const {
    data: heatmapData,
    isLoading: heatmapLoading,
    isError: heatmapError,
    refetch: refetchHeatmap,
  } = useQuery({
    queryKey: ["attendance", "heatmap", "week"],
    queryFn: async () => {
      const { data } = await attendanceApi.heatmap("week");
      return data as unknown;
    },
    retry: false,
    staleTime: 30000,
  });

  const realDeptBreakdown =
    deptData && deptData.length > 0
      ? deptData.map((d) => ({ name: d.department, value: d.count }))
      : USE_MOCK_DATA
        ? fallbackDept
        : [];

  // No headcount-history endpoint exists on the backend, so this chart has
  // no live source. It renders empty unless sample data is enabled.
  const headcountData = USE_MOCK_DATA ? fallbackHeadcount : [];

  const weeklyTrend = (() => {
    const live = toWeeklyAttendanceTrend(heatmapData);
    if (live.length > 0) return live;
    return USE_MOCK_DATA ? fallbackAttendanceTrend : [];
  })();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Analytics</h1>
        <p className="text-muted-foreground">
          Workforce trends and department insights
        </p>
      </div>

      {USE_MOCK_DATA && (
        <div
          data-testid="sample-data-banner"
          className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-xs text-amber-700 dark:text-amber-300"
        >
          Sample data is enabled (NEXT_PUBLIC_USE_MOCK_DATA=true). Charts
          below show mock values instead of live data.
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <HeadcountChart data={headcountData} />
        {deptLoading ? (
          <div className="rounded-xl border bg-card p-6">
            <Skeleton className="h-[300px] w-full" />
          </div>
        ) : deptError ? (
          <div className="rounded-xl border bg-card p-6">
            <div className="flex h-[300px] flex-col items-center justify-center gap-2 text-muted-foreground">
              <p className="text-sm">Failed to load department data</p>
              <button
                onClick={() => refetchDept()}
                className="rounded-md bg-primary/10 px-3 py-1 text-xs font-medium text-primary hover:bg-primary/20 transition-colors"
              >
                Retry
              </button>
            </div>
          </div>
        ) : (
          <DepartmentChart data={realDeptBreakdown} />
        )}
      </div>

      {perfLoading ? (
        <Card className="glass-panel">
          <CardContent className="pt-6">
            <Skeleton className="h-24 w-full" />
          </CardContent>
        </Card>
      ) : perfError ? (
        <Card className="glass-panel">
          <CardContent className="pt-6">
            <div className="flex flex-col items-center gap-2 py-6 text-muted-foreground">
              <p className="text-sm">Failed to load performance insights</p>
              <button
                onClick={() => refetchPerf()}
                className="rounded-md bg-primary/10 px-3 py-1 text-xs font-medium text-primary hover:bg-primary/20 transition-colors"
              >
                Retry
              </button>
            </div>
          </CardContent>
        </Card>
      ) : perfData ? (
        <Card className="glass-panel">
          <CardHeader>
            <CardTitle className="text-base">Performance Insights</CardTitle>
            <CardDescription>AI-powered workforce analysis</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 sm:grid-cols-3">
              {Object.entries(perfData).map(([key, value]) => (
                <div key={key} className="rounded-lg border p-4">
                  <p className="text-xs text-muted-foreground uppercase tracking-wide">
                    {key.replace(/_/g, " ")}
                  </p>
                  <p className="mt-1 text-lg font-semibold">
                    {typeof value === "number" ? value.toFixed(2) : String(value)}
                  </p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card className="glass-panel">
          <CardContent className="pt-6">
            <p className="py-4 text-center text-sm text-muted-foreground">
              No performance data available
            </p>
          </CardContent>
        </Card>
      )}

      <Card className="glass-panel">
        <CardHeader>
          <CardTitle className="text-base">Weekly Attendance Rate</CardTitle>
          <CardDescription>Average attendance by weekday</CardDescription>
        </CardHeader>
        <CardContent>
          {heatmapLoading ? (
            <Skeleton className="h-[280px] w-full" />
          ) : heatmapError ? (
            <div className="flex h-[280px] flex-col items-center justify-center gap-2 text-muted-foreground">
              <p className="text-sm">Failed to load attendance data</p>
              <button
                onClick={() => refetchHeatmap()}
                className="rounded-md bg-primary/10 px-3 py-1 text-xs font-medium text-primary hover:bg-primary/20 transition-colors"
              >
                Retry
              </button>
            </div>
          ) : weeklyTrend.length > 0 ? (
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={weeklyTrend}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis dataKey="day" className="text-xs" />
                <YAxis className="text-xs" domain={[85, 100]} />
                <Tooltip formatter={(v) => [`${v}%`, "Rate"]} />
                <Bar dataKey="rate" fill="hsl(239 84% 67%)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <p className="flex h-[280px] items-center justify-center text-sm text-muted-foreground">
              No attendance data for this week
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
