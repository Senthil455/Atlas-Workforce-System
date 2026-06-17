import axios, { type AxiosError, type InternalAxiosRequestConfig } from "axios";
import { z } from "zod";
import type {
  Course,
  Certification,
  Assessment,
  LearningPath,
  PerformanceGoal,
  PerformanceReview,
  Feedback360,
  SuccessionPlan,
  CompliancePolicy,
  ComplianceViolation,
  GoalAlignment,
  KpiTarget,
  ContinuousFeedback,
  ManagerReview,
  PeerReview,
  PerformanceCalibration,
  PromotionReadiness,
  TalentReviewBoard,
  HiPoEmployee,
  LeadershipReadiness,
  CoachingRecommendation,
  DevelopmentPlan,
} from "@/types";
import {
  clearAuth,
  getAccessToken,
  setTokens,
} from "./auth";

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080/api";

export const api = axios.create({
  baseURL: API_BASE,
  headers: { "Content-Type": "application/json" },
  withCredentials: true,
});

api.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const token = getAccessToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

let refreshPromise: Promise<string | null> | null = null;

api.interceptors.response.use(
  (res) => res,
  async (error: AxiosError) => {
    const original = error.config as InternalAxiosRequestConfig & {
      _retry?: boolean;
    };
    if (error.response?.status !== 401 || original._retry) {
      return Promise.reject(error);
    }

    original._retry = true;

    if (refreshPromise) {
      const token = await refreshPromise;
      if (token) {
        original.headers.Authorization = `Bearer ${token}`;
        return api(original);
      }
      return Promise.reject(error);
    }

    refreshPromise = axios
      .post(`${API_BASE}/auth/refresh`, {}, { withCredentials: true })
      .then(({ data }) => {
        setTokens(data.token);
        return data.token as string;
      })
      .catch(() => {
        clearAuth();
        if (typeof window !== "undefined") {
          const currentPath = window.location.pathname + window.location.search;
          window.location.href = "/login?redirect=" + encodeURIComponent(currentPath);
        }
        return null;
      })
      .finally(() => {
        refreshPromise = null;
      });

    const token = await refreshPromise;
    if (!token) return Promise.reject(error);
    original.headers.Authorization = `Bearer ${token}`;
    return api(original);
  }
);

function validateResponse<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    console.error("API response validation failed:", result.error.issues);
    throw new Error("Invalid API response format");
  }
  return result.data;
}

const loginResponseSchema = z.object({
  token: z.string().min(1),
  refreshToken: z.string().optional(),
  user: z.object({
    id: z.number(),
    email: z.string().email(),
    name: z.string(),
    role: z.enum(["admin", "hr", "manager", "employee"]).optional(),
  }),
});

export const authApi = {
  login: async (email: string, password: string) => {
    const res = await api.post("/auth/login", { email, password });
    return validateResponse(loginResponseSchema, res.data);
  },
  register: async (data: {
    email: string;
    password: string;
    name: string;
    department?: string;
    position?: string;
  }) => {
    const res = await api.post("/auth/register", data);
    return validateResponse(loginResponseSchema, res.data);
  },
  refresh: async () => {
    const res = await api.post("/auth/refresh");
    return validateResponse(loginResponseSchema, res.data);
  },
  logout: () =>
    api.post("/auth/logout"),
};

export const employeeApi = {
  list: (params?: { page?: number; pageSize?: number; search?: string }) =>
    api.get("/employee/employees", {
      params: {
        page: params?.page,
        page_size: params?.pageSize,
        search: params?.search,
      },
    }),
  get: (email: string) => api.get(`/employee/employees/${email}`),
  create: (employee: object) => api.post("/employee/employees", employee),
  update: (email: string, employee: object) =>
    api.put(`/employee/employees/${email}`, employee),
  delete: (email: string) =>
    api.delete(`/employee/employees/${email}`),
};

export const analyticsApi = {
  department: () => api.get("/analytics/department"),
  payroll: () => api.get("/analytics/payroll"),
  performance: () => api.get("/analytics/performance"),
  aiInsights: () => api.post("/analytics/ai-insights"),
};

export const leaveApi = {
  list: () => api.get("/leave"),
  getByEmployee: (employeeId: string) =>
    api.get(`/leave/employee/${employeeId}`),
  request: (data: {
    employeeId: string;
    startDate: string;
    endDate: string;
    leaveType: string;
    reason?: string;
  }) => api.post("/leave/request", data),
  updateStatus: (id: number, status: string) =>
    api.put(`/leave/${id}/status`, { status }),
};

export const payrollApi = {
  list: () => api.get("/payroll"),
  getByEmployee: (employeeId: string) =>
    api.get(`/payroll/employee/${employeeId}`),
  run: (data: {
    employeeId: string;
    period: string;
    baseSalary: number;
    allowances?: number;
    deductions?: number;
  }) => api.post("/payroll/run", data),

  // Module 5 - Payroll Enterprise
  enterprise: {
    dashboard: () => api.get("/payroll/enterprise/dashboard"),

    // Multi-country payroll
    payrolls: {
      list: () => api.get("/payroll/enterprise/payrolls"),
      byEmployee: (employeeId: string) => api.get(`/payroll/enterprise/payrolls/employee/${employeeId}`),
      byPeriod: (period: string) => api.get(`/payroll/enterprise/payrolls/period/${period}`),
      run: (data: {
        employeeId: string; period: string; baseSalary: number;
        allowances?: number; deductions?: number; country?: string; currency?: string;
      }) => api.post("/payroll/enterprise/payrolls/run", data),
    },

    // Tax engine
    tax: {
      configs: {
        list: () => api.get("/payroll/enterprise/tax-configs"),
        create: (data: Partial<import("@/types").CountryTaxConfig>) => api.post("/payroll/enterprise/tax-configs", data),
      },
      brackets: {
        list: () => api.get("/payroll/enterprise/tax-brackets"),
        create: (data: Partial<import("@/types").TaxBracket>) => api.post("/payroll/enterprise/tax-brackets", data),
      },
      simulate: (country: string, grossSalary: number) =>
        api.post("/payroll/enterprise/tax/simulate", { country, grossSalary }),
      compare: (countries: string[], grossSalary: number) =>
        api.post("/payroll/enterprise/tax/compare", { countries, grossSalary }),
    },

    // Forecasting
    forecasts: {
      list: () => api.get("/payroll/enterprise/forecasts"),
      generate: (period: string) => api.post("/payroll/enterprise/forecasts/generate", { period }),
    },

    // Auditing
    auditLogs: () => api.get("/payroll/enterprise/audit-logs"),

    // Payslips
    payslips: {
      list: () => api.get("/payroll/enterprise/payslips"),
      byEmployee: (employeeId: string) => api.get(`/payroll/enterprise/payslips/employee/${employeeId}`),
    },

    // Bank
    bank: {
      list: () => api.get("/payroll/enterprise/bank/transactions"),
      create: (data: {
        employeeId: string; payrollId: number; amount: number;
        accountNumber: string; routingNumber: string; bankName?: string;
      }) => api.post("/payroll/enterprise/bank/transactions", data),
      process: (id: number) => api.post(`/payroll/enterprise/bank/transactions/${id}/process`),
    },

    // Expenses
    expenses: {
      list: () => api.get("/payroll/enterprise/expenses"),
      byEmployee: (employeeId: string) => api.get(`/payroll/enterprise/expenses/employee/${employeeId}`),
      submit: (data: {
        employeeId: string; category: string; amount: number;
        description?: string; receiptUrl?: string;
      }) => api.post("/payroll/enterprise/expenses", data),
      approve: (id: number, approvedBy: string) =>
        api.post(`/payroll/enterprise/expenses/${id}/approve`, { approvedBy }),
      reject: (id: number, reason: string) =>
        api.post(`/payroll/enterprise/expenses/${id}/reject`, { reason }),
    },

    // Benefits
    benefits: {
      plans: {
        list: () => api.get("/payroll/enterprise/benefit-plans"),
        create: (data: Partial<import("@/types").BenefitPlan>) => api.post("/payroll/enterprise/benefit-plans", data),
      },
      enrollments: {
        list: () => api.get("/payroll/enterprise/benefit-enrollments"),
        enroll: (employeeId: string, planId: number) =>
          api.post("/payroll/enterprise/benefit-enrollments", { employeeId, planId }),
      },
    },

    // Compensation
    compensation: {
      list: () => api.get("/payroll/enterprise/compensation-plans"),
      create: (data: {
        employeeId: string; currentSalary: number; proposedSalary: number;
        currency?: string; reason?: string; reviewCycle?: string;
      }) => api.post("/payroll/enterprise/compensation-plans", data),
    },

    // Bonuses
    bonuses: {
      list: () => api.get("/payroll/enterprise/bonuses"),
      create: (data: {
        employeeId: string; amount: number; type?: string; reason?: string;
      }) => api.post("/payroll/enterprise/bonuses", data),
      approve: (id: number, approvedBy?: string) =>
        api.post(`/payroll/enterprise/bonuses/${id}/approve`, { approvedBy }),
    },

    // Equity
    equity: {
      list: () => api.get("/payroll/enterprise/equity"),
      byEmployee: (employeeId: string) => api.get(`/payroll/enterprise/equity/employee/${employeeId}`),
      create: (data: {
        employeeId: string; shares: number; strikePrice: number;
        fairMarketValue: number; equityType?: string; vestingSchedule?: string;
      }) => api.post("/payroll/enterprise/equity", data),
    },

    // Benchmarks
    benchmarks: {
      list: () => api.get("/payroll/enterprise/benchmarks"),
      add: (data: {
        role: string; experience?: string; location?: string;
        p10: number; p25: number; p50: number; p75: number; p90: number;
        currency?: string; source?: string;
      }) => api.post("/payroll/enterprise/benchmarks", data),
      compare: (role: string, currentSalary: number, experience?: string, location?: string) =>
        api.post("/payroll/enterprise/benchmarks/compare", { role, currentSalary, experience, location }),
    },

    // Compliance
    compliance: {
      list: () => api.get("/payroll/enterprise/compliance-reports"),
      generate: (reportType: string, period: string, country?: string) =>
        api.post("/payroll/enterprise/compliance-reports/generate", { reportType, period, country }),
    },

    // Anomalies
    anomalies: {
      list: () => api.get("/payroll/enterprise/anomalies"),
      resolve: (id: number) => api.post(`/payroll/enterprise/anomalies/${id}/resolve`),
    },
  },
};

export const attendanceApi = {
  list: (params?: { employeeId?: string; status?: string; date?: string; startDate?: string; endDate?: string }) =>
    api.get("/attendance", { params }),
  get: (id: string) => api.get(`/attendance/${id}`),
  getByEmployee: (employeeId: string) =>
    api.get(`/attendance/employee/${employeeId}`),
  clockIn: (employeeId: string, localDate?: string, options?: {
    latitude?: number; longitude?: number; method?: string; deviceId?: string;
    qrToken?: string; nfcUid?: string; faceImage?: string; biometricHash?: string;
    isRemote?: boolean; isWfh?: boolean; ipAddress?: string; userAgent?: string;
  }) =>
    api.post("/attendance/clock-in", { employeeId, localDate, ...options }),
  clockOut: (employeeId: string, localDate?: string, options?: {
    latitude?: number; longitude?: number; method?: string;
  }) =>
    api.post("/attendance/clock-out", { employeeId, localDate, ...options }),
  dashboard: () => api.get("/attendance/dashboard/summary"),

  // Geo-fence
  geoFences: {
    list: () => api.get("/attendance/geo-fences"),
    create: (data: Partial<import("@/types").GeoFence>) => api.post("/attendance/geo-fences", data),
    update: (id: number, data: Partial<import("@/types").GeoFence>) => api.put(`/attendance/geo-fences/${id}`, data),
    delete: (id: number) => api.delete(`/attendance/geo-fences/${id}`),
    verify: (latitude: number, longitude: number) =>
      api.post("/attendance/geo-fences/verify", { latitude, longitude }),
  },

  // Shifts
  shifts: {
    list: () => api.get("/attendance/shifts"),
    create: (data: Partial<import("@/types").Shift>) => api.post("/attendance/shifts", data),
    update: (id: number, data: Partial<import("@/types").Shift>) => api.put(`/attendance/shifts/${id}`, data),
    delete: (id: number) => api.delete(`/attendance/shifts/${id}`),
  },

  // Employee shifts
  employeeShifts: {
    assign: (data: Partial<import("@/types").EmployeeShift>) => api.post("/attendance/employee-shifts", data),
    getByEmployee: (employeeId: string) => api.get(`/attendance/employee-shifts/${employeeId}`),
  },

  // Rosters
  rosters: {
    list: (params?: { date?: string; employeeId?: string }) => api.get("/attendance/rosters", { params }),
    create: (data: Partial<import("@/types").Roster>) => api.post("/attendance/rosters", data),
    bulk: (employeeIds: string[], date: string, shiftId: number) =>
      api.post("/attendance/rosters/bulk", { employeeIds, date, shiftId }),
    publish: (id: number) => api.post(`/attendance/rosters/${id}/publish`),
  },

  // QR
  qr: {
    generate: () => api.post("/attendance/qr/generate"),
    validate: (token: string) => api.post("/attendance/qr/validate", { token }),
    use: (token: string) => api.post("/attendance/qr/use", { token }),
  },

  // NFC
  nfc: {
    register: (data: Partial<import("@/types").NFCRegistration>) => api.post("/attendance/nfc/register", data),
    list: () => api.get("/attendance/nfc/list"),
    validate: (nfcUid: string) => api.post("/attendance/nfc/validate", { nfcUid }),
  },

  // Face recognition
  face: {
    enroll: (employeeId: string, imageUrl: string, faceVector?: string) =>
      api.post("/attendance/face/enroll", { employeeId, imageUrl, faceVector }),
    getEnrollment: (employeeId: string) => api.get(`/attendance/face/enrollment/${employeeId}`),
    verify: (employeeId: string, faceImage: string) =>
      api.post("/attendance/face/verify", { employeeId, faceImage }),
  },

  // Biometric
  biometric: {
    register: (data: Partial<import("@/types").BiometricDevice>) => api.post("/attendance/biometric/register", data),
    devices: () => api.get("/attendance/biometric/devices"),
    verify: (employeeId: string, hash: string) =>
      api.post("/attendance/biometric/verify", { employeeId, hash }),
  },

  // Anomalies
  anomalies: {
    list: (params?: { employeeId?: string; type?: string; resolved?: string }) =>
      api.get("/attendance/anomalies", { params }),
    resolve: (id: number) => api.post(`/attendance/anomalies/${id}/resolve`),
  },

  // WFH
  wfh: {
    create: (data: Partial<import("@/types").WFHTracking>) => api.post("/attendance/wfh", data),
    list: (params?: { employeeId?: string; date?: string }) => api.get("/attendance/wfh", { params }),
  },

  // Heatmap
  heatmap: (period?: string) => api.get("/attendance/heatmap", { params: { period } }),

  // Predictions & AI
  predictLateArrival: (employeeId: string) =>
    api.post("/attendance/predict/late-arrival", { employeeId }),
  aiInsights: () => api.get("/attendance/ai/insights"),
};

export const atsApi = {
  getJobs: (params?: {
    page?: number;
    pageSize?: number;
    search?: string;
    status?: string;
    department?: string;
    type?: string;
  }) => api.get("/ats/jobs", { params }),
  getJob: (id: string) => api.get(`/ats/jobs/${id}`),
  createJob: (data: object) => api.post("/ats/jobs", data),
  updateJob: (id: string, data: object) => api.put(`/ats/jobs/${id}`, data),
  deleteJob: (id: string) => api.delete(`/ats/jobs/${id}`),
  publishJob: (id: string) => api.post(`/ats/jobs/${id}/publish`),
  closeJob: (id: string) => api.post(`/ats/jobs/${id}/close`),

  getCandidates: (params?: {
    page?: number;
    pageSize?: number;
    search?: string;
    status?: string;
    skills?: string;
    source?: string;
  }) => api.get("/ats/candidates", { params }),
  getCandidate: (id: string) => api.get(`/ats/candidates/${id}`),
  createCandidate: (data: object) => api.post("/ats/candidates", data),
  updateCandidate: (id: string, data: object) =>
    api.put(`/ats/candidates/${id}`, data),
  deleteCandidate: (id: string) => api.delete(`/ats/candidates/${id}`),

  getApplications: (params?: {
    page?: number;
    pageSize?: number;
    jobId?: string;
    candidateId?: string;
    status?: string;
  }) => api.get("/ats/applications", { params }),
  getApplication: (id: string) => api.get(`/ats/applications/${id}`),
  submitApplication: (data: object) => api.post("/ats/applications", data),
  updateApplicationStatus: (id: string, status: string) =>
    api.put(`/ats/applications/${id}/status`, { status }),

  getInterviews: (params?: {
    page?: number;
    pageSize?: number;
    jobId?: string;
    candidateId?: string;
  }) => api.get("/ats/interviews", { params }),
  scheduleInterview: (data: object) => api.post("/ats/interviews", data),
  updateInterview: (id: string, data: object) =>
    api.put(`/ats/interviews/${id}`, data),
  submitInterviewFeedback: (id: string, data: {
    feedback: string;
    rating: number;
    status: string;
  }) => api.post(`/ats/interviews/${id}/feedback`, data),

  getOffers: (params?: {
    page?: number;
    pageSize?: number;
    jobId?: string;
    candidateId?: string;
  }) => api.get("/ats/offers", { params }),
  createOffer: (data: object) => api.post("/ats/offers", data),
  updateOffer: (id: string, data: object) =>
    api.put(`/ats/offers/${id}`, data),
  sendOffer: (id: string) => api.post(`/ats/offers/${id}/send`),
  acceptOffer: (id: string) => api.post(`/ats/offers/${id}/accept`),
  declineOffer: (id: string) => api.post(`/ats/offers/${id}/decline`),

  getAnalyticsOverview: () => api.get("/ats/analytics/overview"),
  getTimeToHire: () => api.get("/ats/analytics/time-to-hire"),
  getSourceEffectiveness: () => api.get("/ats/analytics/source-effectiveness"),
  getConversionFunnel: () => api.get("/ats/analytics/conversion-funnel"),
};

export const billingApi = {
  createCheckout: () => api.post("/billing/create-checkout-session"),
};

export const performanceApi = {
  goals: {
    list: (params?: { department?: string; ownerId?: string; status?: string }) =>
      api.get("/performance/goals", { params }),
    get: (id: string) => api.get(`/performance/goals/${id}`),
    create: (data: Partial<PerformanceGoal>) => api.post("/performance/goals", data),
    update: (id: string, data: Partial<PerformanceGoal>) => api.put(`/performance/goals/${id}`, data),
    delete: (id: string) => api.delete(`/performance/goals/${id}`),
    updateProgress: (id: string, progress: number) =>
      api.put(`/performance/goals/${id}/progress`, { progress }),
    align: (id: string, data: Partial<GoalAlignment>) =>
      api.post(`/performance/goals/${id}/align`, data),
  },
  reviews: {
    list: (params?: { employeeId?: string; status?: string; type?: string }) =>
      api.get("/performance/reviews", { params }),
    get: (id: string) => api.get(`/performance/reviews/${id}`),
    create: (data: Partial<PerformanceReview>) => api.post("/performance/reviews", data),
    update: (id: string, data: Partial<PerformanceReview>) =>
      api.put(`/performance/reviews/${id}`, data),
    submit: (id: string, data: { ratings: PerformanceReview["ratings"]; summary: string }) =>
      api.post(`/performance/reviews/${id}/submit`, data),
    delete: (id: string) => api.delete(`/performance/reviews/${id}`),
  },
  feedback: {
    list: (params?: { toId?: string; fromId?: string; category?: string }) =>
      api.get("/performance/feedback", { params }),
    create: (data: Partial<Feedback360>) => api.post("/performance/feedback", data),
    delete: (id: string) => api.delete(`/performance/feedback/${id}`),
  },
  succession: {
    list: () => api.get("/performance/succession"),
    get: (id: string) => api.get(`/performance/succession/${id}`),
    create: (data: Partial<SuccessionPlan>) => api.post("/performance/succession", data),
    update: (id: string, data: Partial<SuccessionPlan>) =>
      api.put(`/performance/succession/${id}`, data),
    evaluate: (id: string) => api.post(`/performance/succession/${id}/evaluate`),
  },
  kpiTargets: {
    list: (params?: { category?: string; owner?: string }) =>
      api.get("/performance/kpi-targets", { params }),
    get: (id: string) => api.get(`/performance/kpi-targets/${id}`),
    create: (data: Partial<KpiTarget>) => api.post("/performance/kpi-targets", data),
    update: (id: string, data: Partial<KpiTarget>) => api.put(`/performance/kpi-targets/${id}`, data),
    delete: (id: string) => api.delete(`/performance/kpi-targets/${id}`),
  },
  continuousFeedback: {
    list: (params?: { toId?: string; fromId?: string; type?: string }) =>
      api.get("/performance/continuous-feedback", { params }),
    create: (data: Partial<ContinuousFeedback>) => api.post("/performance/continuous-feedback", data),
    acknowledge: (id: string) => api.post(`/performance/continuous-feedback/${id}/acknowledge`),
    delete: (id: string) => api.delete(`/performance/continuous-feedback/${id}`),
  },
  managerReviews: {
    list: (params?: { employeeId?: string; status?: string }) =>
      api.get("/performance/manager-reviews", { params }),
    get: (id: string) => api.get(`/performance/manager-reviews/${id}`),
    create: (data: Partial<ManagerReview>) => api.post("/performance/manager-reviews", data),
    update: (id: string, data: Partial<ManagerReview>) =>
      api.put(`/performance/manager-reviews/${id}`, data),
    submit: (id: string) => api.post(`/performance/manager-reviews/${id}/submit`),
  },
  peerReviews: {
    list: (params?: { revieweeId?: string; reviewerId?: string; status?: string }) =>
      api.get("/performance/peer-reviews", { params }),
    get: (id: string) => api.get(`/performance/peer-reviews/${id}`),
    create: (data: Partial<PeerReview>) => api.post("/performance/peer-reviews", data),
    update: (id: string, data: Partial<PeerReview>) =>
      api.put(`/performance/peer-reviews/${id}`, data),
  },
  calibrations: {
    list: (params?: { status?: string }) =>
      api.get("/performance/calibrations", { params }),
    get: (id: string) => api.get(`/performance/calibrations/${id}`),
    create: (data: Partial<PerformanceCalibration>) => api.post("/performance/calibrations", data),
    update: (id: string, data: Partial<PerformanceCalibration>) =>
      api.put(`/performance/calibrations/${id}`, data),
    complete: (id: string) => api.post(`/performance/calibrations/${id}/complete`),
  },
  promotionReadiness: {
    list: (params?: { employeeId?: string; overallRating?: string }) =>
      api.get("/performance/promotion-readiness", { params }),
    get: (id: string) => api.get(`/performance/promotion-readiness/${id}`),
    create: (data: Partial<PromotionReadiness>) => api.post("/performance/promotion-readiness", data),
    update: (id: string, data: Partial<PromotionReadiness>) =>
      api.put(`/performance/promotion-readiness/${id}`, data),
  },
  talentReviewBoard: {
    list: (params?: { status?: string }) =>
      api.get("/performance/talent-review-board", { params }),
    get: (id: string) => api.get(`/performance/talent-review-board/${id}`),
    create: (data: Partial<TalentReviewBoard>) => api.post("/performance/talent-review-board", data),
    update: (id: string, data: Partial<TalentReviewBoard>) =>
      api.put(`/performance/talent-review-board/${id}`, data),
    complete: (id: string) => api.post(`/performance/talent-review-board/${id}/complete`),
  },
  hiPo: {
    list: (params?: { department?: string; status?: string }) =>
      api.get("/performance/hipo", { params }),
    get: (id: string) => api.get(`/performance/hipo/${id}`),
    create: (data: Partial<HiPoEmployee>) => api.post("/performance/hipo", data),
    update: (id: string, data: Partial<HiPoEmployee>) =>
      api.put(`/performance/hipo/${id}`, data),
  },
  leadershipReadiness: {
    list: (params?: { employeeId?: string; overallReadiness?: string }) =>
      api.get("/performance/leadership-readiness", { params }),
    get: (id: string) => api.get(`/performance/leadership-readiness/${id}`),
    create: (data: Partial<LeadershipReadiness>) => api.post("/performance/leadership-readiness", data),
    update: (id: string, data: Partial<LeadershipReadiness>) =>
      api.put(`/performance/leadership-readiness/${id}`, data),
  },
  aiInsights: {
    list: (params?: { employeeId?: string; insightType?: string }) =>
      api.get("/performance/ai-insights", { params }),
    get: (id: string) => api.get(`/performance/ai-insights/${id}`),
    generate: (employeeId: string) => api.post(`/performance/ai-insights/generate/${employeeId}`),
  },
  coachingRecommendations: {
    list: (params?: { employeeId?: string; priority?: string; status?: string }) =>
      api.get("/performance/coaching-recommendations", { params }),
    get: (id: string) => api.get(`/performance/coaching-recommendations/${id}`),
    create: (data: Partial<CoachingRecommendation>) =>
      api.post("/performance/coaching-recommendations", data),
    update: (id: string, data: Partial<CoachingRecommendation>) =>
      api.put(`/performance/coaching-recommendations/${id}`, data),
  },
  developmentPlans: {
    list: (params?: { employeeId?: string; status?: string }) =>
      api.get("/performance/development-plans", { params }),
    get: (id: string) => api.get(`/performance/development-plans/${id}`),
    create: (data: Partial<DevelopmentPlan>) => api.post("/performance/development-plans", data),
    update: (id: string, data: Partial<DevelopmentPlan>) =>
      api.put(`/performance/development-plans/${id}`, data),
    delete: (id: string) => api.delete(`/performance/development-plans/${id}`),
  },
  goalAlignment: {
    list: (params?: { goalId?: string }) =>
      api.get("/performance/goal-alignment", { params }),
    create: (data: Partial<GoalAlignment>) => api.post("/performance/goal-alignment", data),
  },
  dashboard: () => api.get("/performance/dashboard"),
};

export const complianceApi = {
  policies: {
    list: (params?: { framework?: string; status?: string }) =>
      api.get("/compliance/policies", { params }),
    get: (id: string) => api.get(`/compliance/policies/${id}`),
    create: (data: Partial<CompliancePolicy>) => api.post("/compliance/policies", data),
    update: (id: string, data: Partial<CompliancePolicy>) =>
      api.put(`/compliance/policies/${id}`, data),
    delete: (id: string) => api.delete(`/compliance/policies/${id}`),
    review: (id: string) => api.post(`/compliance/policies/${id}/review`),
  },
  violations: {
    list: (params?: { status?: string; severity?: string }) =>
      api.get("/compliance/violations", { params }),
    get: (id: string) => api.get(`/compliance/violations/${id}`),
    create: (data: Partial<ComplianceViolation>) => api.post("/compliance/violations", data),
    updateStatus: (id: string, status: string, resolution?: string) =>
      api.put(`/compliance/violations/${id}/status`, { status, resolution }),
  },
  auditLogs: {
    list: (params?: { page?: number; pageSize?: number; action?: string }) =>
      api.get("/compliance/audit-logs", { params }),
    export: (params?: { startDate?: string; endDate?: string }) =>
      api.get("/compliance/audit-logs/export", { params, responseType: "blob" }),
  },
  dashboard: () => api.get("/compliance/dashboard"),
  readiness: () => api.get("/compliance/readiness"),
};

export const copilotApi = {
  chat: {
    send: (message: string, sessionId?: string) =>
      api.post("/copilot/chat", { message, sessionId }),
    stream: (message: string, sessionId?: string): Promise<Response> => {
      const token = getAccessToken();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers["Authorization"] = `Bearer ${token}`;
      return fetch(`${API_BASE}/copilot/chat/stream`, {
        method: "POST",
        headers,
        body: JSON.stringify({ message, sessionId }),
      });
    },
  },
  sessions: {
    list: () => api.get("/copilot/sessions"),
    get: (id: string) => api.get(`/copilot/sessions/${id}`),
    create: (title: string) => api.post("/copilot/sessions", { title }),
    delete: (id: string) => api.delete(`/copilot/sessions/${id}`),
  },
  predictions: {
    attrition: () => api.get("/copilot/predictions/attrition"),
    hiring: () => api.get("/copilot/predictions/hiring"),
    performance: () => api.get("/copilot/predictions/performance"),
  },
  insights: () => api.get("/copilot/insights"),
};

export const commandCenterApi = {
  overview: () => api.get("/command-center/overview"),
  orgHealth: () => api.get("/command-center/org-health"),
  departmentHeatmap: () => api.get("/command-center/department-heatmap"),
  workforceCost: () => api.get("/command-center/workforce-cost"),
  attritionRiskMap: () => api.get("/command-center/attrition-risk-map"),
  hiringPipeline: () => api.get("/command-center/hiring-pipeline"),
  budgetForecast: () => api.get("/command-center/budget-forecast"),
  utilization: () => api.get("/command-center/utilization"),
  benchmarking: () => api.get("/command-center/benchmarking"),
  aiBriefing: () => api.get("/command-center/ai-briefing"),
  riskDashboard: () => api.get("/command-center/risk-dashboard"),
  activityFeed: (params?: { limit?: number }) =>
    api.get("/command-center/activity-feed", { params }),
  kpiHistory: (kpi: string) => api.get(`/command-center/kpi-history/${kpi}`),
};

export const integrationApi = {
  dashboard: () => api.get("/integration/dashboard"),
  webhooks: {
    list: (params?: { page?: number; page_size?: number; enabled?: boolean }) =>
      api.get("/integration/webhooks", { params }),
    get: (id: string) => api.get(`/integration/webhooks/${id}`),
    create: (data: {
      name: string;
      url: string;
      event_types: string[];
      secret?: string;
      retry_count?: number;
      timeout_sec?: number;
    }) => api.post("/integration/webhooks", data),
    update: (id: string, data: Record<string, unknown>) =>
      api.put(`/integration/webhooks/${id}`, data),
    delete: (id: string) => api.delete(`/integration/webhooks/${id}`),
    deliveries: (id: string, params?: { status?: string; page?: number; page_size?: number }) =>
      api.get(`/integration/webhooks/${id}/deliveries`, { params }),
  },
  subscriptions: {
    list: (params?: { page?: number; page_size?: number; enabled?: boolean }) =>
      api.get("/integration/subscriptions", { params }),
    create: (data: {
      event_type: string;
      kafka_topic?: string;
      source_service?: string;
    }) => api.post("/integration/subscriptions", data),
    update: (id: string, data: Record<string, unknown>) =>
      api.put(`/integration/subscriptions/${id}`, data),
    delete: (id: string) => api.delete(`/integration/subscriptions/${id}`),
  },
  outbox: {
    list: (params?: { status?: string; page?: number; page_size?: number }) =>
      api.get("/integration/outbox", { params }),
  },
  config: {
    list: () => api.get("/integration/config"),
    get: (key: string) => api.get(`/integration/config/${key}`),
    create: (data: { key: string; value: unknown; description?: string }) =>
      api.post("/integration/config", data),
    update: (key: string, data: { value: unknown; description?: string }) =>
      api.put(`/integration/config/${key}`, data),
    delete: (key: string) => api.delete(`/integration/config/${key}`),
  },
};

export const lifecycleApi = {
  dashboard: () => api.get("/lifecycle/dashboard"),
  onboarding: {
    templates: {
      list: (params?: { page?: number; page_size?: number; is_active?: boolean }) =>
        api.get("/lifecycle/onboarding/templates", { params }),
      create: (data: Record<string, unknown>) => api.post("/lifecycle/onboarding/templates", data),
      get: (id: string) => api.get(`/lifecycle/onboarding/templates/${id}`),
      update: (id: string, data: Record<string, unknown>) => api.put(`/lifecycle/onboarding/templates/${id}`, data),
      delete: (id: string) => api.delete(`/lifecycle/onboarding/templates/${id}`),
    },
    assignments: {
      list: (params?: { page?: number; page_size?: number; employee_id?: string; status?: string }) =>
        api.get("/lifecycle/onboarding/assignments", { params }),
      create: (data: Record<string, unknown>) => api.post("/lifecycle/onboarding/assignments", data),
      get: (id: string) => api.get(`/lifecycle/onboarding/assignments/${id}`),
      update: (id: string, data: Record<string, unknown>) => api.put(`/lifecycle/onboarding/assignments/${id}`, data),
      delete: (id: string) => api.delete(`/lifecycle/onboarding/assignments/${id}`),
    },
  },
  offboarding: {
    list: (params?: { page?: number; page_size?: number; employee_id?: string; status?: string }) =>
      api.get("/lifecycle/offboarding", { params }),
    create: (data: Record<string, unknown>) => api.post("/lifecycle/offboarding", data),
    get: (id: string) => api.get(`/lifecycle/offboarding/${id}`),
    update: (id: string, data: Record<string, unknown>) => api.put(`/lifecycle/offboarding/${id}`, data),
  },
  probation: {
    list: (params?: { page?: number; page_size?: number; employee_id?: string; status?: string }) =>
      api.get("/lifecycle/probation", { params }),
    create: (data: Record<string, unknown>) => api.post("/lifecycle/probation", data),
    getByEmployee: (employeeId: string) => api.get(`/lifecycle/probation/employee/${employeeId}`),
    get: (id: string) => api.get(`/lifecycle/probation/${id}`),
    update: (id: string, data: Record<string, unknown>) => api.put(`/lifecycle/probation/${id}`, data),
    assessments: {
      list: (probationId: string) => api.get(`/lifecycle/probation/${probationId}/assessments`),
      create: (probationId: string, data: Record<string, unknown>) =>
        api.post(`/lifecycle/probation/${probationId}/assessments`, data),
      update: (id: string, data: Record<string, unknown>) =>
        api.put(`/lifecycle/probation/assessments/${id}`, data),
    },
  },
  career: {
    frameworks: {
      list: () => api.get("/lifecycle/career/frameworks"),
      create: (data: Record<string, unknown>) => api.post("/lifecycle/career/frameworks", data),
    },
    jobFamilies: {
      list: (frameworkId?: string) => api.get("/lifecycle/career/job-families", { params: { framework_id: frameworkId } }),
      create: (data: Record<string, unknown>) => api.post("/lifecycle/career/job-families", data),
    },
    paths: {
      list: (jobFamilyId?: string) => api.get("/lifecycle/career/paths", { params: { job_family_id: jobFamilyId } }),
      create: (data: Record<string, unknown>) => api.post("/lifecycle/career/paths", data),
    },
    roadmaps: {
      list: (employeeId?: string) => api.get("/lifecycle/career/roadmaps", { params: { employee_id: employeeId } }),
      create: (data: Record<string, unknown>) => api.post("/lifecycle/career/roadmaps", data),
      get: (id: string) => api.get(`/lifecycle/career/roadmaps/${id}`),
      update: (id: string, data: Record<string, unknown>) => api.put(`/lifecycle/career/roadmaps/${id}`, data),
    },
  },
  mobility: {
    jobs: {
      list: (params?: { status?: string; department?: string }) =>
        api.get("/lifecycle/mobility/jobs", { params }),
      create: (data: Record<string, unknown>) => api.post("/lifecycle/mobility/jobs", data),
      get: (id: string) => api.get(`/lifecycle/mobility/jobs/${id}`),
      update: (id: string, data: Record<string, unknown>) => api.put(`/lifecycle/mobility/jobs/${id}`, data),
      delete: (id: string) => api.delete(`/lifecycle/mobility/jobs/${id}`),
    },
    applications: {
      list: (params?: { job_id?: string; employee_id?: string; status?: string }) =>
        api.get("/lifecycle/mobility/applications", { params }),
      create: (data: Record<string, unknown>) => api.post("/lifecycle/mobility/applications", data),
      update: (id: string, data: Record<string, unknown>) => api.put(`/lifecycle/mobility/applications/${id}`, data),
    },
    transfers: {
      list: (params?: { page_size?: number; employee_id?: string; status?: string }) =>
        api.get("/lifecycle/mobility/transfers", { params }),
      create: (data: Record<string, unknown>) => api.post("/lifecycle/mobility/transfers", data),
      get: (id: string) => api.get(`/lifecycle/mobility/transfers/${id}`),
      update: (id: string, data: Record<string, unknown>) => api.put(`/lifecycle/mobility/transfers/${id}`, data),
    },
  },
  promotions: {
    list: (params?: { page_size?: number; employee_id?: string; status?: string }) =>
      api.get("/lifecycle/promotions", { params }),
    create: (data: Record<string, unknown>) => api.post("/lifecycle/promotions", data),
    get: (id: string) => api.get(`/lifecycle/promotions/${id}`),
    update: (id: string, data: Record<string, unknown>) => api.put(`/lifecycle/promotions/${id}`, data),
  },
  timeline: {
    list: (employeeId: string) => api.get(`/lifecycle/timeline/${employeeId}`),
    create: (data: Record<string, unknown>) => api.post("/lifecycle/timeline", data),
  },
  documents: {
    list: (employeeId: string, category?: string) =>
      api.get(`/lifecycle/documents/${employeeId}`, { params: { category } }),
    create: (data: Record<string, unknown>) => api.post("/lifecycle/documents", data),
    get: (id: string) => api.get(`/lifecycle/documents/doc/${id}`),
    update: (id: string, data: Record<string, unknown>) => api.put(`/lifecycle/documents/doc/${id}`, data),
    delete: (id: string) => api.delete(`/lifecycle/documents/doc/${id}`),
  },
  profile: {
    get: (employeeId: string) => api.get(`/lifecycle/profile/${employeeId}`),
    upsert: (employeeId: string, data: Record<string, unknown>) =>
      api.put(`/lifecycle/profile/${employeeId}`, data),
  },
  achievements: {
    list: (employeeId: string, category?: string) =>
      api.get(`/lifecycle/achievements/${employeeId}`, { params: { category } }),
    create: (data: Record<string, unknown>) => api.post("/lifecycle/achievements", data),
    update: (id: string, data: Record<string, unknown>) => api.put(`/lifecycle/achievements/${id}`, data),
    delete: (id: string) => api.delete(`/lifecycle/achievements/${id}`),
  },
};

export const workforcePlanningApi = {
  dashboard: () => api.get("/workforce/dashboard"),

  // Demand Forecasting
  forecasts: {
    list: (params?: { page?: number; page_size?: number; period?: string; department?: string }) =>
      api.get("/workforce/forecasts", { params }),
    get: (id: string) => api.get(`/workforce/forecasts/${id}`),
    create: (data: Partial<import("@/types").WorkforceDemandForecast>) => api.post("/workforce/forecasts", data),
    update: (id: string, data: Partial<import("@/types").WorkforceDemandForecast>) => api.put(`/workforce/forecasts/${id}`, data),
    delete: (id: string) => api.delete(`/workforce/forecasts/${id}`),
  },

  // Resource Forecasting
  resourceForecasts: {
    list: (params?: { page?: number; page_size?: number; department?: string; period?: string }) =>
      api.get("/workforce/resource-forecasts", { params }),
    get: (id: string) => api.get(`/workforce/resource-forecasts/${id}`),
    create: (data: Partial<import("@/types").ResourceForecast>) => api.post("/workforce/resource-forecasts", data),
    update: (id: string, data: Partial<import("@/types").ResourceForecast>) => api.put(`/workforce/resource-forecasts/${id}`, data),
    delete: (id: string) => api.delete(`/workforce/resource-forecasts/${id}`),
  },

  // Talent Forecasting
  talentForecasts: {
    list: (params?: { page?: number; page_size?: number; role?: string; period?: string }) =>
      api.get("/workforce/talent-forecasts", { params }),
    get: (id: string) => api.get(`/workforce/talent-forecasts/${id}`),
    create: (data: Partial<import("@/types").TalentForecast>) => api.post("/workforce/talent-forecasts", data),
    update: (id: string, data: Partial<import("@/types").TalentForecast>) => api.put(`/workforce/talent-forecasts/${id}`, data),
    delete: (id: string) => api.delete(`/workforce/talent-forecasts/${id}`),
  },

  // Attrition Forecasting
  attritionForecasts: {
    list: (params?: { page?: number; page_size?: number; department?: string; period?: string }) =>
      api.get("/workforce/attrition-forecasts", { params }),
    get: (id: string) => api.get(`/workforce/attrition-forecasts/${id}`),
    create: (data: Partial<import("@/types").AttritionForecast>) => api.post("/workforce/attrition-forecasts", data),
    update: (id: string, data: Partial<import("@/types").AttritionForecast>) => api.put(`/workforce/attrition-forecasts/${id}`, data),
    delete: (id: string) => api.delete(`/workforce/attrition-forecasts/${id}`),
  },

  // Retirement Forecasting
  retirementForecasts: {
    list: (params?: { page?: number; page_size?: number; department?: string; period?: string }) =>
      api.get("/workforce/retirement-forecasts", { params }),
    get: (id: string) => api.get(`/workforce/retirement-forecasts/${id}`),
    create: (data: Partial<import("@/types").RetirementForecast>) => api.post("/workforce/retirement-forecasts", data),
    update: (id: string, data: Partial<import("@/types").RetirementForecast>) => api.put(`/workforce/retirement-forecasts/${id}`, data),
    delete: (id: string) => api.delete(`/workforce/retirement-forecasts/${id}`),
  },

  // Capacity Planning
  capacityPlans: {
    list: (params?: { page?: number; page_size?: number; period?: string; department?: string }) =>
      api.get("/workforce/capacity-plans", { params }),
    get: (id: string) => api.get(`/workforce/capacity-plans/${id}`),
    create: (data: Partial<import("@/types").CapacityPlan>) => api.post("/workforce/capacity-plans", data),
    update: (id: string, data: Partial<import("@/types").CapacityPlan>) => api.put(`/workforce/capacity-plans/${id}`, data),
    delete: (id: string) => api.delete(`/workforce/capacity-plans/${id}`),
  },

  // Workforce Allocation
  allocations: {
    list: (params?: { page?: number; page_size?: number; department?: string; status?: string }) =>
      api.get("/workforce/allocations", { params }),
    get: (id: string) => api.get(`/workforce/allocations/${id}`),
    create: (data: Partial<import("@/types").WorkforceAllocation>) => api.post("/workforce/allocations", data),
    update: (id: string, data: Partial<import("@/types").WorkforceAllocation>) => api.put(`/workforce/allocations/${id}`, data),
    delete: (id: string) => api.delete(`/workforce/allocations/${id}`),
  },

  // Project Staffing
  projectStaffing: {
    list: (params?: { page?: number; page_size?: number; department?: string; status?: string }) =>
      api.get("/workforce/project-staffing", { params }),
    get: (id: string) => api.get(`/workforce/project-staffing/${id}`),
    create: (data: Partial<import("@/types").ProjectStaffing>) => api.post("/workforce/project-staffing", data),
    update: (id: string, data: Partial<import("@/types").ProjectStaffing>) =>
      api.put(`/workforce/project-staffing/${id}`, data),
    delete: (id: string) => api.delete(`/workforce/project-staffing/${id}`),
  },

  // Skills Gap
  skillGaps: {
    list: (params?: { page?: number; page_size?: number; role?: string; period?: string }) =>
      api.get("/workforce/skill-gaps", { params }),
    get: (id: string) => api.get(`/workforce/skill-gaps/${id}`),
    create: (data: Partial<import("@/types").SkillGapAnalysis>) => api.post("/workforce/skill-gaps", data),
    update: (id: string, data: Partial<import("@/types").SkillGapAnalysis>) => api.put(`/workforce/skill-gaps/${id}`, data),
    delete: (id: string) => api.delete(`/workforce/skill-gaps/${id}`),
  },

  // Bench Management
  bench: {
    list: (params?: { page?: number; page_size?: number; department?: string; status?: string }) =>
      api.get("/workforce/bench", { params }),
    get: (id: string) => api.get(`/workforce/bench/${id}`),
    create: (data: Partial<import("@/types").BenchManagement>) => api.post("/workforce/bench", data),
    update: (id: string, data: Partial<import("@/types").BenchManagement>) => api.put(`/workforce/bench/${id}`, data),
    delete: (id: string) => api.delete(`/workforce/bench/${id}`),
  },

  // Hiring Recommendations
  hiringRecommendations: {
    list: (params?: { page?: number; page_size?: number; department?: string; urgency?: string; status?: string }) =>
      api.get("/workforce/hiring-recommendations", { params }),
    get: (id: string) => api.get(`/workforce/hiring-recommendations/${id}`),
    create: (data: Partial<import("@/types").HiringRecommendation>) => api.post("/workforce/hiring-recommendations", data),
    update: (id: string, data: Partial<import("@/types").HiringRecommendation>) =>
      api.put(`/workforce/hiring-recommendations/${id}`, data),
    delete: (id: string) => api.delete(`/workforce/hiring-recommendations/${id}`),
  },

  // Simulations
  simulations: {
    list: (params?: { page?: number; page_size?: number; sim_type?: string }) =>
      api.get("/workforce/simulations", { params }),
    get: (id: string) => api.get(`/workforce/simulations/${id}`),
    create: (data: Partial<import("@/types").WorkforceSimulation>) => api.post("/workforce/simulations", data),
    update: (id: string, data: Partial<import("@/types").WorkforceSimulation>) =>
      api.put(`/workforce/simulations/${id}`, data),
    delete: (id: string) => api.delete(`/workforce/simulations/${id}`),
    run: (data: { simulation_type: string; parameters: Record<string, unknown> }) =>
      api.post("/workforce/simulations/run", data),
  },

  // What-If Analysis
  whatIfAnalyses: {
    list: (params?: { page?: number; page_size?: number; simulation_id?: string }) =>
      api.get("/workforce/what-if-analyses", { params }),
    get: (id: string) => api.get(`/workforce/what-if-analyses/${id}`),
    create: (data: Partial<import("@/types").WhatIfAnalysis>) => api.post("/workforce/what-if-analyses", data),
    update: (id: string, data: Partial<import("@/types").WhatIfAnalysis>) =>
      api.put(`/workforce/what-if-analyses/${id}`, data),
    delete: (id: string) => api.delete(`/workforce/what-if-analyses/${id}`),
  },

  // Org Redesign
  orgRedesigns: {
    list: (params?: { page?: number; page_size?: number; status?: string }) =>
      api.get("/workforce/org-redesigns", { params }),
    get: (id: string) => api.get(`/workforce/org-redesigns/${id}`),
    create: (data: Partial<import("@/types").OrgRedesignSimulator>) => api.post("/workforce/org-redesigns", data),
    update: (id: string, data: Partial<import("@/types").OrgRedesignSimulator>) =>
      api.put(`/workforce/org-redesigns/${id}`, data),
    delete: (id: string) => api.delete(`/workforce/org-redesigns/${id}`),
  },

  // Strategic Plans
  strategicPlans: {
    list: (params?: { page?: number; page_size?: number; status?: string }) =>
      api.get("/workforce/strategic-plans", { params }),
    get: (id: string) => api.get(`/workforce/strategic-plans/${id}`),
    create: (data: Partial<import("@/types").StrategicPlan>) => api.post("/workforce/strategic-plans", data),
    update: (id: string, data: Partial<import("@/types").StrategicPlan>) =>
      api.put(`/workforce/strategic-plans/${id}`, data),
    delete: (id: string) => api.delete(`/workforce/strategic-plans/${id}`),
  },
};

export const ldApi = {
  overview: () => api.get("/learning/analytics/overview"),
  departments: () => api.get("/learning/analytics/departments"),
  trends: (period?: string) => api.get("/learning/analytics/trends", { params: { period } }),

  compliance: {
    list: (params?: { employee_id?: string; status?: string; policy?: string; page?: number; page_size?: number }) =>
      api.get("/learning/compliance", { params }),
    create: (data: {
      course_id?: string; employee_id: string; policy_name: string;
      policy_category?: string; due_date?: string; is_mandatory?: boolean;
    }) => api.post("/learning/compliance", data),
    update: (id: string, data: { status?: string; score?: number; completed_date?: string }) =>
      api.put(`/learning/compliance/${id}`, data),
    delete: (id: string) => api.delete(`/learning/compliance/${id}`),
    dashboard: () => api.get("/learning/compliance/dashboard"),
  },

  recommendations: {
    list: (params?: { employee_id?: string; priority?: string }) =>
      api.get("/learning/recommendations", { params }),
    generate: (employee_id: string) => api.post("/learning/recommendations/generate", null, { params: { employee_id } }),
    acknowledge: (id: string) => api.put(`/learning/recommendations/${id}/acknowledge`),
  },

  journeys: {
    list: (employee_id?: string) => api.get("/learning/journeys", { params: { employee_id } }),
    create: (data: Partial<import("@/types").LearningJourney>) => api.post("/learning/journeys", data),
    update: (id: string, data: { current_step?: number; progress_pct?: number; status?: string }) =>
      api.put(`/learning/journeys/${id}`, data),
    delete: (id: string) => api.delete(`/learning/journeys/${id}`),
  },

  mentors: {
    list: (params?: { department?: string; available?: string; expertise?: string }) =>
      api.get("/learning/mentors", { params }),
    create: (data: {
      employee_id: string; full_name: string; department?: string;
      role?: string; bio?: string; expertise?: string[]; max_mentees?: number;
    }) => api.post("/learning/mentors", data),
    update: (id: string, data: { bio?: string; is_available?: boolean; max_mentees?: number }) =>
      api.put(`/learning/mentors/${id}`, data),
    delete: (id: string) => api.delete(`/learning/mentors/${id}`),
    match: (employee_id?: string, skill?: string) =>
      api.get("/learning/mentors/match", { params: { employee_id, skill } }),
  },

  mentorSessions: {
    list: (params?: { mentor_id?: string; mentee_id?: string }) =>
      api.get("/learning/mentor-sessions", { params }),
    create: (data: {
      mentor_id: string; mentee_id: string; topic: string;
      scheduled_at?: string; duration_mins?: number;
    }) => api.post("/learning/mentor-sessions", data),
    update: (id: string, data: { status?: string; notes?: string; feedback?: string; rating?: number }) =>
      api.put(`/learning/mentor-sessions/${id}`, data),
  },

  marketplace: {
    list: (params?: { category?: string; type?: string; status?: string; page?: number; page_size?: number }) =>
      api.get("/learning/marketplace", { params }),
    create: (data: {
      title: string; description?: string; provider?: string; category?: string;
      type?: string; skills?: string[]; duration_hours?: number;
      cost?: number; currency?: string; max_participants?: number;
    }) => api.post("/learning/marketplace", data),
    update: (id: string, data: { title?: string; description?: string; cost?: number; status?: string }) =>
      api.put(`/learning/marketplace/${id}`, data),
    delete: (id: string) => api.delete(`/learning/marketplace/${id}`),
  },

  knowledge: {
    list: (params?: { category?: string; search?: string; tag?: string; content_type?: string; page?: number; page_size?: number }) =>
      api.get("/learning/knowledge", { params }),
    get: (id: string) => api.get(`/learning/knowledge/${id}`),
    create: (data: {
      title: string; summary?: string; content?: string; category?: string;
      tags?: string[]; author_id?: string; author_name?: string;
      content_type?: string; content_url?: string;
    }) => api.post("/learning/knowledge", data),
    update: (id: string, data: Record<string, unknown>) => api.put(`/learning/knowledge/${id}`, data),
    delete: (id: string) => api.delete(`/learning/knowledge/${id}`),
    markUseful: (id: string) => api.post(`/learning/knowledge/${id}/useful`),
  },

  endorsements: {
    list: (params?: { employee_id?: string; skill_id?: string }) =>
      api.get("/learning/endorsements", { params }),
    create: (data: {
      skill_id: string; employee_id: string; endorsed_by: string;
      endorser_name?: string; skill_name: string; proficiency?: string; comment?: string;
    }) => api.post("/learning/endorsements", data),
    delete: (id: string) => api.delete(`/learning/endorsements/${id}`),
  },

  competencyMatrix: () => api.get("/learning/analytics/competency-matrix"),
};

export const securityApi = {
  dashboard: (tenant_id?: string) => api.get("/security/dashboard", { params: { tenant_id: tenant_id || "default" } }),

  zeroTrust: {
    list: (params?: { tenant_id?: string; enabled?: boolean; page?: number; page_size?: number }) =>
      api.get("/security/zero-trust", { params }),
    get: (id: string) => api.get(`/security/zero-trust/${id}`),
    create: (data: Partial<import("@/types").ZeroTrustPolicy>) => api.post("/security/zero-trust", data),
    update: (id: string, data: Partial<import("@/types").ZeroTrustPolicy>) => api.put(`/security/zero-trust/${id}`, data),
    delete: (id: string) => api.delete(`/security/zero-trust/${id}`),
    evaluate: (id: string, context: Record<string, unknown>) =>
      api.post(`/security/zero-trust/${id}/evaluate`, context),
  },

  conditionalAccess: {
    list: (params?: { tenant_id?: string; enabled?: boolean; page?: number; page_size?: number }) =>
      api.get("/security/conditional-access", { params }),
    get: (id: string) => api.get(`/security/conditional-access/${id}`),
    create: (data: Partial<import("@/types").ConditionalAccessPolicy>) => api.post("/security/conditional-access", data),
    update: (id: string, data: Partial<import("@/types").ConditionalAccessPolicy>) =>
      api.put(`/security/conditional-access/${id}`, data),
    delete: (id: string) => api.delete(`/security/conditional-access/${id}`),
    evaluate: (context: Record<string, unknown>, tenant_id?: string) =>
      api.post("/security/conditional-access/evaluate", context, { params: { tenant_id: tenant_id || "default" } }),
  },

  risk: {
    assess: (data: Partial<import("@/types").RiskAssessment>) => api.post("/security/risk/assess", data),
    list: (params?: { tenant_id?: string; user_id?: string; page?: number; page_size?: number }) =>
      api.get("/security/risk/assessments", { params }),
  },

  pam: {
    roles: {
      list: (tenant_id?: string) => api.get("/security/pam/roles", { params: { tenant_id } }),
      get: (id: string) => api.get(`/security/pam/roles/${id}`),
      create: (data: Partial<import("@/types").PrivilegedRole>) => api.post("/security/pam/roles", data),
    },
    requests: {
      list: (params?: { tenant_id?: string; user_id?: string; status?: string; page?: number; page_size?: number }) =>
        api.get("/security/pam/requests", { params }),
      create: (data: Partial<import("@/types").PrivilegedAccess>) => api.post("/security/pam/requests", data),
      approve: (id: string, approved_by: string) =>
        api.post(`/security/pam/requests/${id}/approve`, null, { params: { approved_by } }),
      revoke: (id: string) => api.post(`/security/pam/requests/${id}/revoke`),
    },
  },

  dataClassification: {
    list: (params?: { tenant_id?: string; classification_level?: string }) =>
      api.get("/security/data-classification", { params }),
    get: (id: string) => api.get(`/security/data-classification/${id}`),
    create: (data: Partial<import("@/types").DataClassification>) => api.post("/security/data-classification", data),
    classify: (id: string, resource_data: Record<string, unknown>) =>
      api.post(`/security/data-classification/${id}/classify`, resource_data),
  },

  dlp: {
    policies: {
      list: (params?: { tenant_id?: string; enabled?: boolean }) =>
        api.get("/security/dlp/policies", { params }),
      get: (id: string) => api.get(`/security/dlp/policies/${id}`),
      create: (data: Partial<import("@/types").DLPPolicy>) => api.post("/security/dlp/policies", data),
    },
    incidents: {
      list: (params?: { tenant_id?: string; status?: string; severity?: string; page?: number; page_size?: number }) =>
        api.get("/security/dlp/incidents", { params }),
      report: (data: Partial<import("@/types").DLPIncident>) => api.post("/security/dlp/incidents", data),
      updateStatus: (id: string, status: string) =>
        api.put(`/security/dlp/incidents/${id}/status`, null, { params: { status } }),
    },
  },

  encryptionKeys: {
    list: (params?: { tenant_id?: string; status?: string }) =>
      api.get("/security/encryption-keys", { params }),
    create: (data: Partial<import("@/types").EncryptionKey>) => api.post("/security/encryption-keys", data),
    rotate: (key_id: string, data?: Record<string, unknown>) =>
      api.post(`/security/encryption-keys/${key_id}/rotate`, data || {}),
  },

  dataResidency: {
    list: (tenant_id?: string) => api.get("/security/data-residency", { params: { tenant_id } }),
    create: (data: Partial<import("@/types").DataResidencyPolicy>) => api.post("/security/data-residency", data),
    check: (policy_id: string, target_region: string) =>
      api.post(`/security/data-residency/${policy_id}/check`, null, { params: { target_region } }),
  },

  sessionRecordings: {
    start: (data: Record<string, unknown>) => api.post("/security/session-recordings/start", data),
    stop: (id: string) => api.post(`/security/session-recordings/${id}/stop`),
    addEvent: (id: string, event: Record<string, unknown>) =>
      api.post(`/security/session-recordings/${id}/events`, event),
    list: (params?: { tenant_id?: string; user_id?: string; status?: string; page?: number; page_size?: number }) =>
      api.get("/security/session-recordings", { params }),
  },
};

export const lmsApi = {
  dashboard: () => api.get("/lms/dashboard"),
  courses: {
    list: (params?: { category?: string; level?: string; status?: string; search?: string }) =>
      api.get("/lms/courses", { params }),
    get: (id: string) => api.get(`/lms/courses/${id}`),
    create: (data: Partial<Course>) => api.post("/lms/courses", data),
    update: (id: string, data: Partial<Course>) => api.put(`/lms/courses/${id}`, data),
    delete: (id: string) => api.delete(`/lms/courses/${id}`),
    publish: (id: string) => api.post(`/lms/courses/${id}/publish`),
    archive: (id: string) => api.post(`/lms/courses/${id}/archive`),
  },
  enrollments: {
    list: (params?: { courseId?: string; employeeId?: string; status?: string }) =>
      api.get("/lms/enrollments", { params }),
    create: (data: { employeeId: string; courseId: string }) =>
      api.post("/lms/enrollments", data),
    bulkCreate: (data: { employeeIds: string[]; courseId: string }) =>
      api.post("/lms/enrollments/bulk", data),
    updateProgress: (id: string, progress: number) =>
      api.put(`/lms/enrollments/${id}/progress`, { progress }),
    complete: (id: string, grade?: number) =>
      api.post(`/lms/enrollments/${id}/complete`, { grade }),
    delete: (id: string) => api.delete(`/lms/enrollments/${id}`),
  },
  certifications: {
    list: (params?: { employeeId?: string; status?: string }) =>
      api.get("/lms/certifications", { params }),
    create: (data: Partial<Certification>) => api.post("/lms/certifications", data),
    update: (id: string, data: Partial<Certification>) =>
      api.put(`/lms/certifications/${id}`, data),
    verify: (id: string) => api.post(`/lms/certifications/${id}/verify`),
    delete: (id: string) => api.delete(`/lms/certifications/${id}`),
  },
  assessments: {
    list: (courseId: string) => api.get(`/lms/assessments`, { params: { courseId } }),
    get: (id: string) => api.get(`/lms/assessments/${id}`),
    create: (data: Partial<Assessment>) => api.post("/lms/assessments", data),
    update: (id: string, data: Partial<Assessment>) =>
      api.put(`/lms/assessments/${id}`, data),
    delete: (id: string) => api.delete(`/lms/assessments/${id}`),
    attempts: {
      list: (assessmentId: string) =>
        api.get(`/lms/assessments/${assessmentId}/attempts`),
      submit: (assessmentId: string, answers: number[]) =>
        api.post(`/lms/assessments/${assessmentId}/attempts`, { answers }),
    },
  },
  learningPaths: {
    list: () => api.get("/lms/learning-paths"),
    get: (id: string) => api.get(`/lms/learning-paths/${id}`),
    create: (data: Partial<LearningPath>) => api.post("/lms/learning-paths", data),
    update: (id: string, data: Partial<LearningPath>) =>
      api.put(`/lms/learning-paths/${id}`, data),
    delete: (id: string) => api.delete(`/lms/learning-paths/${id}`),
  },
  skills: {
    matrix: () => api.get("/lms/skills/matrix"),
    employee: (employeeId: string) => api.get(`/lms/skills/employee/${employeeId}`),
    upsert: (data: { employeeId: string; skill: string; level: number; category: string }) =>
      api.post("/lms/skills", data),
    gapAnalysis: () => api.get("/lms/skills/gap-analysis"),
  },
};

export const liveApi = {
  sse: {
    start: (channel: string) => `${API_BASE}/live/sse/${channel}`,
  },
  ws: {
    connect: (channel: string) =>
      `${API_BASE.replace("http", "ws")}/live/ws/${channel}`,
  },
  publish: {
    presence: (data: Record<string, unknown>) => api.post("/live/publish/presence", data),
    alert: (data: Record<string, unknown>) => api.post("/live/publish/alert", data),
    announcement: (data: Record<string, unknown>) => api.post("/live/publish/announcement", data),
    activity: (data: Record<string, unknown>) => api.post("/live/publish/activity", data),
    attendance: (data: Record<string, unknown>) => api.post("/live/publish/attendance", data),
    payroll: (data: Record<string, unknown>) => api.post("/live/publish/payroll", data),
    leave: (data: Record<string, unknown>) => api.post("/live/publish/leave", data),
    kpi: (data: Record<string, unknown>) => api.post("/live/publish/kpi", data),
    task: (data: Record<string, unknown>) => api.post("/live/publish/task", data),
    escalation: (data: Record<string, unknown>) => api.post("/live/publish/escalation", data),
    compliance: (data: Record<string, unknown>) => api.post("/live/publish/compliance", data),
    onboarding: (data: Record<string, unknown>) => api.post("/live/publish/onboarding", data),
    recruitment: (data: Record<string, unknown>) => api.post("/live/publish/recruitment", data),
    forecast: (data: Record<string, unknown>) => api.post("/live/publish/forecast", data),
    staffing: (data: Record<string, unknown>) => api.post("/live/publish/staffing", data),
    sla: (data: Record<string, unknown>) => api.post("/live/publish/sla", data),
    poll: (data: Record<string, unknown>) => api.post("/live/publish/poll", data),
    emergency: (data: Record<string, unknown>) => api.post("/live/publish/emergency", data),
    incident: (data: Record<string, unknown>) => api.post("/live/publish/incident", data),
    chat: (data: Record<string, unknown>) => api.post("/live/publish/chat", data),
  },
};

export const aiApi = {
  copilot: (persona: string, query: string, context?: Record<string, unknown>) =>
    api.post(`/ai/${persona}/copilot`, { query, context }),
  reporting: {
    generate: (data: { query: string; department?: string; timeframe?: string; format?: string }) =>
      api.post("/ai/natural-language-reporting", data),
  },
  dashboard: {
    generate: (data: { focus: string; department?: string; role?: string }) =>
      api.post("/ai/ai-dashboard", data),
  },
  predictions: {
    attrition: (data: { employee_id?: string; department?: string; timeframe_months?: number; include_factors?: boolean }) =>
      api.post("/ai/attrition-prediction", data),
    burnout: (data: { employee_id?: string; department?: string; timeframe_months?: number }) =>
      api.post("/ai/burnout-prediction", data),
    promotion: (data: { employee_id?: string; department?: string; timeframe_months?: number }) =>
      api.post("/ai/promotion-prediction", data),
  },
  salary: {
    recommend: (data: { employee_id: string; role: string; experience_years: number; performance_score?: number; location?: string; department?: string }) =>
      api.post("/ai/salary-recommendation", data),
  },
  forecasting: {
    workforce: (data: { department?: string; horizon_months?: number; include_attrition?: boolean; include_hiring?: boolean }) =>
      api.post("/ai/workforce-forecasting", data),
    budget: (data: { department: string; current_budget: number; forecast_months?: number }) =>
      api.post("/ai/budget-forecasting", data),
  },
  assistants: {
    policy: (data: { query: string; policy_area?: string }) =>
      api.post("/ai/policy-assistant", data),
    leave: (data: { employee_id: string; leave_type: string; requested_dates: string[]; department?: string }) =>
      api.post("/ai/leave-assistant", data),
    recruitment: (data: { job_requirements: string; candidate_pool?: string[]; screening_criteria?: Record<string, unknown> }) =>
      api.post("/ai/recruitment-assistant", data),
    onboarding: (data: { employee_role: string; department: string; experience_level: string }) =>
      api.post("/ai/onboarding-assistant", data),
    training: (data: { employee_id: string; current_skills?: string[]; target_role?: string; performance_gaps?: string[] }) =>
      api.post("/ai/training-assistant", data),
    compliance: (data: { action: string; department: string; employee_role: string; region?: string }) =>
      api.post("/ai/compliance-assistant", data),
  },
  knowledge: {
    search: (data: { query: string; filters?: Record<string, unknown>; max_results?: number }) =>
      api.post("/ai/knowledge-search", data),
  },
  advisory: {
    org: (data: { query: string; org_context?: Record<string, unknown> }) =>
      api.post("/ai/org-advisor", data),
  },
  risk: {
    detect: (data: { department?: string; employee_id?: string; risk_categories?: string[] }) =>
      api.post("/ai/risk-detection", data),
    anomalies: (data: { data_source: string; metric?: string; department?: string; sensitivity?: number }) =>
      api.post("/ai/anomaly-detection", data),
  },
  operations: {
    shifts: (data: { department: string; date_range: string[]; constraints?: Record<string, unknown> }) =>
      api.post("/ai/shift-optimization", data),
  },
  planning: {
    succession: (data: { position: string; department: string; required_skills: string[]; timeline_months?: number }) =>
      api.post("/ai/succession-planning", data),
  },
  summaries: {
    performance: (data: { employee_id: string; period?: string; include_metrics?: string[] }) =>
      api.post("/ai/performance-summaries", data),
    meeting: (data: { transcript: string; meeting_type?: string; attendees?: string[] }) =>
      api.post("/ai/meeting-summaries", data),
  },
  automation: {
    workflow: (data: { process_name: string; department: string; description: string; constraints?: Record<string, unknown> }) =>
      api.post("/ai/workflow-generation", data),
    build: (data: { trigger: string; actions: string[]; conditions?: string[]; department: string }) =>
      api.post("/ai/automation-builder", data),
  },
  agentic: {
    hr: (data: { goal: string; context?: Record<string, unknown>; autonomy_level?: string }) =>
      api.post("/ai/agentic-hr", data),
  },
  autonomous: {
    intelligence: (data: { scope?: string; metrics?: string[]; generate_recommendations?: boolean }) =>
      api.post("/ai/autonomous-intelligence", data),
  },
};
