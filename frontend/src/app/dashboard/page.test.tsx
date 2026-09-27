import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@/lib/test-utils";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import DashboardPage from "./page";
import {
  analyticsApi,
  employeeApi,
  attendanceApi,
  commandCenterApi,
} from "@/lib/api";

vi.mock("@/lib/api", () => ({
  analyticsApi: {
    department: vi.fn(),
  },
  employeeApi: {
    list: vi.fn(),
  },
  attendanceApi: {
    list: vi.fn(),
    heatmap: vi.fn(),
  },
  commandCenterApi: {
    hiringPipeline: vi.fn(),
    activityFeed: vi.fn(),
  },
}));

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <DashboardPage />
    </QueryClientProvider>
  );
}

describe("DashboardPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls the backing APIs for its widgets", async () => {
    vi.mocked(analyticsApi.department).mockResolvedValue({ data: [] });
    vi.mocked(employeeApi.list).mockResolvedValue({ data: { total: 0 } });
    vi.mocked(attendanceApi.list).mockResolvedValue({ data: [] });
    vi.mocked(attendanceApi.heatmap).mockResolvedValue({ data: [] });
    vi.mocked(commandCenterApi.hiringPipeline).mockResolvedValue({ data: {} });
    vi.mocked(commandCenterApi.activityFeed).mockResolvedValue({ data: {} });

    renderPage();

    await waitFor(() => {
      expect(analyticsApi.department).toHaveBeenCalled();
      expect(employeeApi.list).toHaveBeenCalled();
      expect(attendanceApi.list).toHaveBeenCalled();
      expect(attendanceApi.heatmap).toHaveBeenCalledWith("week");
      expect(commandCenterApi.hiringPipeline).toHaveBeenCalled();
      expect(commandCenterApi.activityFeed).toHaveBeenCalled();
    });
  });

  it("renders error states and no mock numbers when the APIs reject", async () => {
    vi.mocked(analyticsApi.department).mockRejectedValue(new Error("down"));
    vi.mocked(employeeApi.list).mockRejectedValue(new Error("down"));
    vi.mocked(attendanceApi.list).mockRejectedValue(new Error("down"));
    vi.mocked(attendanceApi.heatmap).mockRejectedValue(new Error("down"));
    vi.mocked(commandCenterApi.hiringPipeline).mockRejectedValue(new Error("down"));
    vi.mocked(commandCenterApi.activityFeed).mockRejectedValue(new Error("down"));

    renderPage();

    await waitFor(() => {
      // Attendance + hiring widgets surface the chart error state.
      expect(screen.getAllByText("Failed to load chart data").length).toBeGreaterThan(0);
      // Activity feed surfaces its own error state.
      expect(screen.getByText("Failed to load activity")).toBeInTheDocument();
      // Live check-ins surface their error state.
      expect(screen.getByText("Unable to load check-in data")).toBeInTheDocument();
    });

    // Mock totals must never stand in for live data.
    expect(screen.queryByText("1,248")).not.toBeInTheDocument();
    expect(screen.queryByTestId("sample-data-banner")).not.toBeInTheDocument();
  });

  it("renders empty states when the APIs return no rows", async () => {
    vi.mocked(analyticsApi.department).mockResolvedValue({ data: [] });
    vi.mocked(employeeApi.list).mockResolvedValue({ data: { total: 0 } });
    vi.mocked(attendanceApi.list).mockResolvedValue({ data: [] });
    vi.mocked(attendanceApi.heatmap).mockResolvedValue({ data: [] });
    vi.mocked(commandCenterApi.hiringPipeline).mockResolvedValue({ data: {} });
    vi.mocked(commandCenterApi.activityFeed).mockResolvedValue({ data: {} });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("No recent activity")).toBeInTheDocument();
      expect(screen.getByText("No check-ins recorded today")).toBeInTheDocument();
    });
    expect(screen.queryByText("1,248")).not.toBeInTheDocument();
  });
});
