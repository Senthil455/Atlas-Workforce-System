import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@/lib/test-utils";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import AnalyticsPage from "./page";
import { analyticsApi, attendanceApi } from "@/lib/api";

vi.mock("@/lib/api", () => ({
  analyticsApi: {
    department: vi.fn(),
    performance: vi.fn(),
  },
  attendanceApi: {
    heatmap: vi.fn(),
  },
}));

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AnalyticsPage />
    </QueryClientProvider>
  );
}

describe("AnalyticsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls the analytics and attendance APIs for its widgets", async () => {
    vi.mocked(analyticsApi.department).mockResolvedValue({
      data: [{ department: "Engineering", count: 10 }],
    });
    vi.mocked(analyticsApi.performance).mockResolvedValue({ data: {} });
    vi.mocked(attendanceApi.heatmap).mockResolvedValue({ data: [] });

    renderPage();

    await waitFor(() => {
      expect(analyticsApi.department).toHaveBeenCalled();
      expect(analyticsApi.performance).toHaveBeenCalled();
      expect(attendanceApi.heatmap).toHaveBeenCalledWith("week");
    });
  });

  it("renders error states and no mock numbers when the APIs reject", async () => {
    vi.mocked(analyticsApi.department).mockRejectedValue(new Error("down"));
    vi.mocked(analyticsApi.performance).mockRejectedValue(new Error("down"));
    vi.mocked(attendanceApi.heatmap).mockRejectedValue(new Error("down"));

    renderPage();

    await waitFor(() => {
      expect(
        screen.getByText("Failed to load department data")
      ).toBeInTheDocument();
      expect(
        screen.getByText("Failed to load performance insights")
      ).toBeInTheDocument();
      expect(
        screen.getByText("Failed to load attendance data")
      ).toBeInTheDocument();
    });

    // The mock headcount total must never stand in for live data.
    expect(screen.queryByText("1,248")).not.toBeInTheDocument();
    expect(screen.queryByTestId("sample-data-banner")).not.toBeInTheDocument();
  });

  it("renders an empty state when the APIs return no rows", async () => {
    vi.mocked(analyticsApi.department).mockResolvedValue({ data: [] });
    vi.mocked(analyticsApi.performance).mockResolvedValue({ data: null });
    vi.mocked(attendanceApi.heatmap).mockResolvedValue({ data: [] });

    renderPage();

    await waitFor(() => {
      expect(
        screen.getByText("No attendance data for this week")
      ).toBeInTheDocument();
      expect(
        screen.getByText("No performance data available")
      ).toBeInTheDocument();
    });
    expect(screen.queryByText("1,248")).not.toBeInTheDocument();
  });
});
