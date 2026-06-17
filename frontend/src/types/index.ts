export type UserRole = "admin" | "hr" | "manager" | "employee";

export interface User {
  id: number;
  email: string;
  name: string;
  role: UserRole;
  department?: string;
  position?: string;
}

export interface AuthResponse {
  message: string;
  token: string;
  refreshToken?: string;
  user: User;
}

export interface Employee {
  _id?: string;
  name: string;
  department: string;
  position: string;
  email: string;
}

export interface PaginatedEmployees {
  items: Employee[];
  total: number;
  page: number;
  pageSize?: number;
  page_size?: number;
  totalPages?: number;
  total_pages?: number;
}

export interface KpiMetric {
  label: string;
  value: number;
  change: number;
  trend: "up" | "down" | "neutral";
}

export interface AttendanceRecord {
  id: string;
  employeeName: string;
  date: string;
  checkIn: string;
  checkOut: string;
  status: "present" | "late" | "absent" | "remote";
  hours: number;
}

// === Module 4 — Advanced Attendance Types ===

export interface AttendanceRecordV2 {
  id: number;
  employeeId: string;
  tenantId: string;
  date: string;
  clockIn: string;
  clockOut: string | null;
  status: string;
  overtime: number;
  method: string;
  shiftId: number | null;
  latitude: number | null;
  longitude: number | null;
  geoVerified: boolean;
  geoFenceId: number | null;
  faceVerified: boolean;
  biometricHash: string;
  nfcUid: string;
  qrToken: string;
  deviceId: string;
  ipAddress: string;
  userAgent: string;
  isRemote: boolean;
  isWfh: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface GeoFence {
  id: number;
  tenantId: string;
  name: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  address: string;
  isActive: boolean;
}

export interface GeoVerifyResult {
  verified: boolean;
  distance: number;
  fenceName: string;
  fenceLatitude: number;
  fenceLongitude: number;
  radiusMeters: number;
}

export interface Shift {
  id: number;
  tenantId: string;
  name: string;
  startTime: string;
  endTime: string;
  graceMinutes: number;
  maxOvertime: number;
  isNightShift: boolean;
  isActive: boolean;
  daysOfWeek: string;
}

export interface EmployeeShift {
  id: number;
  tenantId: string;
  employeeId: string;
  shiftId: number;
  shift?: Shift;
  startDate: string;
  endDate?: string;
  isActive: boolean;
}

export interface Roster {
  id: number;
  tenantId: string;
  employeeId: string;
  date: string;
  shiftId: number;
  shift?: Shift;
  isPublished: boolean;
  notes?: string;
}

export interface QRAttendance {
  id: number;
  tenantId: string;
  token: string;
  geoFenceId: number | null;
  createdBy: string;
  expiresAt: string;
  isUsed: boolean;
}

export interface NFCRegistration {
  id: number;
  tenantId: string;
  employeeId: string;
  nfcUid: string;
  deviceName: string;
  isActive: boolean;
  lastUsedAt: string | null;
}

export interface BiometricDevice {
  id: number;
  tenantId: string;
  employeeId: string;
  deviceType: string;
  deviceUid: string;
  isActive: boolean;
  lastUsedAt: string | null;
}

export interface FaceEnrollment {
  id: number;
  tenantId: string;
  employeeId: string;
  imageUrl: string;
  isActive: boolean;
}

export interface AnomalyLog {
  id: number;
  tenantId: string;
  employeeId: string;
  recordId: number | null;
  anomalyType: string;
  severity: string;
  description: string;
  isResolved: boolean;
  detectedAt: string;
  resolvedAt: string | null;
}

export interface WFHTracking {
  id: number;
  tenantId: string;
  employeeId: string;
  date: string;
  isWfh: boolean;
  isRemote: boolean;
  location: string;
  productivityScore: number;
  approvedBy: string;
  notes: string;
}

export interface HeatmapDay {
  date: string;
  statuses: Record<string, number>;
  total: number;
  overtime: number;
}

export interface HeatmapData {
  data: HeatmapDay[];
  period: string;
}

export interface LateArrivalPrediction {
  prediction: boolean;
  confidence: number;
  lateRate: number;
  avgClockIn: string;
  totalDays: number;
  lateDays: number;
  reason: string;
}

export interface AttendanceAIInsight {
  type: string;
  value?: number;
  description: string;
  severity?: string;
  avgOvertime?: number;
  maxOvertime?: number;
  totalOvertime?: number;
  remoteRate?: number;
  wfhRate?: number;
}

export interface AttendanceAIChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

export interface AttendanceDashboardSummary {
  presentToday: number;
  lateToday: number;
  absentToday: number;
  wfhToday: number;
  remoteToday: number;
  totalToday: number;
  avgOvertime: number;
  anomaliesCount: number;
}

export interface LeaveRequest {
  id: string;
  employeeName: string;
  type: string;
  startDate: string;
  endDate: string;
  status: "pending" | "approved" | "rejected";
  days: number;
}

export interface PayrollRecord {
  id: number;
  employeeId: string;
  tenantId: string;
  period: string;
  baseSalary: number;
  allowances: number;
  deductions: number;
  tax: number;
  netSalary: number;
  status: string;
  processedDate: string;
}

export interface PayrollSummary {
  id: string;
  period: string;
  totalAmount: number;
  employeeCount: number;
  status: "draft" | "processing" | "completed";
}

export interface Notification {
  id: string;
  title: string;
  message: string;
  read: boolean;
  createdAt: string;
}

export type JobType = "full-time" | "part-time" | "contract" | "internship" | "temporary";
export type JobStatus = "draft" | "open" | "closed" | "on-hold";
export type CandidateStatus = "active" | "passive" | "hired" | "rejected";
export type ApplicationStatus =
  | "applied"
  | "screening"
  | "interview"
  | "offer"
  | "hired"
  | "rejected";
export type InterviewStatus = "scheduled" | "completed" | "cancelled";
export type OfferStatus = "draft" | "sent" | "accepted" | "declined";

export interface Job {
  id: string;
  title: string;
  department: string;
  location: string;
  type: JobType;
  status: JobStatus;
  description: string;
  requirements: string;
  salaryMin: number;
  salaryMax: number;
  applicationsCount: number;
  postedDate: string;
  closingDate: string;
  createdAt: string;
  updatedAt: string;
}

export interface Candidate {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  currentCompany: string;
  currentPosition: string;
  skills: string[];
  status: CandidateStatus;
  source: string;
  appliedDate: string;
  resumeUrl: string;
  experience: Experience[];
  education: Education[];
  createdAt: string;
  updatedAt: string;
}

export interface Experience {
  id: string;
  company: string;
  position: string;
  startDate: string;
  endDate: string;
  description: string;
}

export interface Education {
  id: string;
  institution: string;
  degree: string;
  field: string;
  startDate: string;
  endDate: string;
}

export interface Application {
  id: string;
  jobId: string;
  candidateId: string;
  status: ApplicationStatus;
  appliedDate: string;
  notes: string;
  job?: Job;
  candidate?: Candidate;
  createdAt: string;
  updatedAt: string;
}

export interface Interview {
  id: string;
  applicationId: string;
  jobId: string;
  candidateId: string;
  type: string;
  scheduledDate: string;
  duration: number;
  location: string;
  meetingLink: string;
  status: InterviewStatus;
  feedback: string;
  rating: number;
  job?: Job;
  candidate?: Candidate;
  createdAt: string;
  updatedAt: string;
}

export interface Offer {
  id: string;
  applicationId: string;
  jobId: string;
  candidateId: string;
  status: OfferStatus;
  salaryOffered: number;
  startDate: string;
  expiresAt: string;
  notes: string;
  job?: Job;
  candidate?: Candidate;
  createdAt: string;
  updatedAt: string;
}

export interface AtsDashboardStats {
  openPositions: number;
  totalCandidates: number;
  interviewsToday: number;
  offersPending: number;
  candidatesByStage: { stage: string; count: number }[];
}

export type CourseLevel = "beginner" | "intermediate" | "advanced";
export type CourseStatus = "draft" | "published" | "archived";
export type EnrollmentStatus = "active" | "completed" | "dropped";
export type CertStatus = "active" | "expired" | "revoked";

export interface Course {
  id: string;
  title: string;
  description: string;
  category: string;
  level: CourseLevel;
  duration: string;
  instructor: string;
  status: CourseStatus;
  thumbnail?: string;
  prerequisites?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Enrollment {
  id: string;
  employeeId: string;
  employeeName?: string;
  courseId: string;
  courseTitle?: string;
  progress: number;
  status: EnrollmentStatus;
  enrolledAt: string;
  completedAt?: string;
  dueDate?: string;
  grade?: number;
}

export interface Certification {
  id: string;
  name: string;
  employeeId: string;
  employeeName?: string;
  issuer: string;
  issueDate: string;
  expiryDate: string;
  credentialUrl?: string;
  status: CertStatus;
  verified: boolean;
}

export interface Assessment {
  id: string;
  courseId: string;
  title: string;
  description?: string;
  passingScore: number;
  maxScore: number;
  questions?: AssessmentQuestion[];
  attempts?: AssessmentAttempt[];
}

export interface AssessmentQuestion {
  id: string;
  question: string;
  options: string[];
  correctAnswer: number;
}

export interface AssessmentAttempt {
  id: string;
  assessmentId: string;
  employeeId: string;
  employeeName?: string;
  score: number;
  passed: boolean;
  attemptedAt: string;
}

export interface LearningPath {
  id: string;
  name: string;
  description: string;
  courses: string[];
  duration?: string;
  status: "active" | "inactive";
}

export interface SkillRating {
  skill: string;
  level: number;
  category: string;
  lastAssessed: string;
}

export interface SkillMatrix {
  employeeId: string;
  employeeName: string;
  role: string;
  skills: SkillRating[];
}

export interface SkillGap {
  role: string;
  skill: string;
  requiredLevel: number;
  employeeLevel: number;
  gap: number;
}

export interface LmsDashboardStats {
  totalCourses: number;
  activeEnrollments: number;
  completionRate: number;
  totalCertifications: number;
  expiringCertifications: number;
}

export type GoalStatus = "on-track" | "at-risk" | "behind" | "completed" | "draft";
export type ReviewStatus = "pending" | "in-progress" | "completed" | "cancelled";
export type FeedbackVisibility = "public" | "private" | "anonymous";
export type SuccessionStatus = "ready-now" | "ready-in-1-2" | "ready-in-3-5" | "not-ready";

export interface PerformanceGoal {
  id: string;
  title: string;
  description: string;
  ownerId: string;
  ownerName: string;
  department: string;
  category: string;
  keyResults: { title: string; current: number; target: number }[];
  progress: number;
  status: GoalStatus;
  startDate: string;
  endDate: string;
  createdAt: string;
  updatedAt: string;
}

export interface PerformanceReview {
  id: string;
  employeeId: string;
  employeeName: string;
  reviewerId: string;
  reviewerName: string;
  period: string;
  type: "quarterly" | "annual" | "probation" | "peer";
  ratings: { category: string; score: number; comment?: string }[];
  overallScore: number;
  summary: string;
  status: ReviewStatus;
  dueDate: string;
  completedAt?: string;
  createdAt: string;
}

export interface Feedback360 {
  id: string;
  fromId: string;
  fromName: string;
  fromAvatar?: string;
  toId: string;
  toName: string;
  message: string;
  category: "kudos" | "innovation" | "leadership" | "teamwork" | "customer";
  visibility: FeedbackVisibility;
  createdAt: string;
}

export interface SuccessionPlan {
  id: string;
  position: string;
  department: string;
  currentHolder: string;
  candidates: { employeeId: string; employeeName: string; readiness: SuccessionStatus; notes?: string }[];
  riskLevel: "low" | "medium" | "high";
  lastReviewed: string;
}

export type ComplianceStatus = "compliant" | "non-compliant" | "at-risk";

export interface CompliancePolicy {
  id: string;
  name: string;
  description: string;
  framework: "SOC2" | "GDPR" | "ISO27001" | "HIPAA" | "PCI-DSS" | "internal";
  status: ComplianceStatus;
  lastReviewed: string;
  nextReview: string;
  owner: string;
  version: string;
}

export interface ComplianceViolation {
  id: string;
  policyId: string;
  policyName: string;
  severity: "critical" | "high" | "medium" | "low";
  description: string;
  affectedEntity: string;
  reportedBy: string;
  reportedAt: string;
  status: "open" | "investigating" | "resolved" | "mitigated";
  resolvedAt?: string;
}

export interface AuditLogEntry {
  id: string;
  action: string;
  actor: string;
  resource: string;
  details: string;
  ipAddress: string;
  timestamp: string;
}

export interface CopilotMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  actions?: { label: string; action: string }[];
}

export interface CopilotSession {
  id: string;
  title: string;
  messages: CopilotMessage[];
  context?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CommandCenterMetrics {
  totalHeadcount: number;
  payrollMtd: number;
  openPositions: number;
  trainingCompletion: number;
  satisfactionScore: number;
  orgHealth: number;
  attritionRate: number;
  avgTenure: number;
}

export interface OrgHealthMetric {
  category: string;
  score: number;
  change: number;
}

export interface DepartmentPerformance {
  department: string;
  productivity: number;
  engagement: number;
  headcount: number;
  attrition: number;
  budgetUtilization: number;
}

export interface ActivityEvent {
  id: string;
  type: "hire" | "promotion" | "departure" | "training" | "achievement" | "leave";
  actor: string;
  description: string;
  timestamp: string;
}

export interface AIInsight {
  id: string;
  type: "opportunity" | "risk" | "recommendation" | "trend";
  title: string;
  description: string;
  impact: "high" | "medium" | "low";
  category: string;
  timestamp: string;
}

// Module 1 — Executive Command Center Types
export interface CommandCenterOverview {
  totalHeadcount: number;
  headcountChange: number;
  payrollMtd: number;
  payrollChange: number;
  openPositions: number;
  positionsChange: number;
  trainingCompletion: number;
  trainingChange: number;
  satisfactionScore: number;
  satisfactionChange: number;
  orgHealthScore: number;
  productivityScore: number;
  riskScore: number;
  newHiresThisMonth: number;
  departuresThisMonth: number;
  avgTenure: number;
  avgTimeToHire: number;
}

export interface OrgHealthDetail {
  overall: number;
  dimensions: OrgHealthDimension[];
  trend: OrgHealthTrend[];
}

export interface OrgHealthDimension {
  name: string;
  score: number;
  change: number;
  status: "healthy" | "moderate" | "needs-attention";
}

export interface OrgHealthTrend {
  month: string;
  score: number;
}

export interface DepartmentHeatmap {
  departments: DepartmentHeatmapItem[];
  avgProductivity: number;
  avgEngagement: number;
  overallHealth: string;
}

export interface DepartmentHeatmapItem {
  name: string;
  metrics: Record<string, number>;
  headcount: number;
  attrition: number;
  budgetUtilization: number;
  health: string;
}

export interface WorkforceCost {
  totalPayroll: number;
  totalBenefits: number;
  totalTaxes: number;
  totalCost: number;
  byDepartment: CostByDepartment[];
  costPerEmployee: number;
  costTrend: CostTrend[];
}

export interface CostByDepartment {
  department: string;
  headcount: number;
  payroll: number;
  benefits: number;
  total: number;
  percentOfTotal: number;
}

export interface CostTrend {
  month: string;
  cost: number;
}

export interface AttritionRiskMap {
  overallRiskScore: number;
  atRiskCount: number;
  highRiskCount: number;
  byDepartment: RiskByDepartment[];
  highRiskEmployees: HighRiskEmployee[];
  trend: RiskTrend[];
}

export interface RiskByDepartment {
  department: string;
  riskScore: number;
  atRisk: number;
  highRisk: number;
  avgTenure: number;
  avgSatisfaction: number;
}

export interface HighRiskEmployee {
  name: string;
  department: string;
  risk: number;
  role: string;
  reason: string;
}

export interface RiskTrend {
  month: string;
  rate: number;
}

export interface HiringPipeline {
  openPositions: number;
  activeCandidates: number;
  interviewsThisWeek: number;
  offersOutstanding: number;
  timeToHireAvg: number;
  acceptanceRate: number;
  pipelineStages: PipelineStage[];
  byDepartment: HiringByDept[];
  upcomingInterviews: UpcomingInterview[];
}

export interface PipelineStage {
  stage: string;
  count: number;
}

export interface HiringByDept {
  department: string;
  openings: number;
  candidates: number;
  interviews: number;
  offers: number;
}

export interface UpcomingInterview {
  candidate: string;
  position: string;
  date: string;
  interviewer: string;
}

export interface BudgetForecast {
  totalBudget: number;
  totalSpent: number;
  remainingBudget: number;
  burnRate: number;
  projectedOverspend: boolean;
  byDepartment: BudgetDept[];
  monthlyBurn: MonthlyBurn[];
}

export interface BudgetDept {
  department: string;
  budget: number;
  spent: number;
  remaining: number;
  utilization: number;
  forecast: number;
  onTrack: boolean;
}

export interface MonthlyBurn {
  month: string;
  budget: number;
  actual: number;
}

export interface WorkforceUtilization {
  overallUtilization: number;
  billableUtilization: number;
  byDepartment: UtilizationDept[];
  trend: UtilizationTrend[];
}

export interface UtilizationDept {
  department: string;
  utilization: number;
  billable: number;
  capacity: number;
  active: number;
  idle: number;
}

export interface UtilizationTrend {
  month: string;
  utilization: number;
}

export interface DepartmentBenchmarking {
  companyAvg: BenchmarkMetrics;
  industryAvg: BenchmarkMetrics;
  departments: BenchmarkDept[];
}

export interface BenchmarkMetrics {
  productivity: number;
  engagement: number;
  retention: number;
  attrition: number;
  costPerEmployee: number;
}

export interface BenchmarkDept {
  name: string;
  productivity: number;
  engagement: number;
  retention: number;
  attrition: number;
  costPerHead: number;
  benchmark: "above" | "match" | "below";
}

export interface AiBriefing {
  generatedAt: string;
  executiveSummary: string;
  keyFindings: AiFinding[];
  recommendations: AiRecommendation[];
  riskFlags: AiRiskFlag[];
}

export interface AiFinding {
  severity: "positive" | "warning" | "critical";
  area: string;
  message: string;
  metric: string;
}

export interface AiRecommendation {
  priority: "high" | "medium" | "low";
  action: string;
  impact: string;
  timeline: string;
}

export interface AiRiskFlag {
  type: string;
  severity: string;
  message: string;
  affectedDept: string;
}

export interface RiskDashboard {
  overallRiskScore: number;
  riskLevel: string;
  categories: RiskCategory[];
  trend: RiskTrendItem[];
}

export interface RiskCategory {
  name: string;
  score: number;
  level: string;
  trend: string;
}

export interface RiskTrendItem {
  month: string;
  score: number;
}

export interface IntegrationWebhook {
  id: string;
  name: string;
  url: string;
  event_types: string[];
  retry_count: number;
  timeout_sec: number;
  enabled: boolean;
  last_triggered_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface IntegrationWebhookDeliveryLog {
  id: string;
  webhook_id: string;
  event_type: string;
  status: string;
  status_code: number | null;
  response_body: string | null;
  attempts: number;
  max_attempts: number;
  next_retry_at: string | null;
  delivered_at: string | null;
  created_at: string;
}

export interface IntegrationEventSubscription {
  id: string;
  event_type: string;
  source_service: string | null;
  kafka_topic: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface IntegrationDashboard {
  total_webhooks: number;
  active_webhooks: number;
  total_subscriptions: number;
  total_deliveries: number;
  successful_deliveries: number;
  failed_deliveries: number;
  pending_deliveries: number;
  outbox_pending: number;
  outbox_failed: number;
}

export interface LifecycleDashboard {
  onboarding_pending: number;
  onboarding_active: number;
  offboarding_pending: number;
  probations_active: number;
  promotions_pending: number;
  transfers_pending: number;
  total_documents: number;
  total_achievements: number;
  total_career_roadmaps: number;
}

export interface OnboardingTemplate {
  id: string;
  name: string;
  description: string | null;
  department: string | null;
  stages: Record<string, unknown>[];
  is_active: boolean;
  created_at: string;
}

export interface OnboardingAssignment {
  id: string;
  employee_id: string;
  template_id: string | null;
  status: string;
  current_stage: string | null;
  stages_completed: unknown[];
  tasks: unknown[];
  start_date: string | null;
  expected_completion_date: string | null;
  completed_at: string | null;
  assigned_to: string | null;
  notes: string | null;
  created_at: string;
}

export interface OffboardingRecord {
  id: string;
  employee_id: string;
  resignation_date: string | null;
  last_working_date: string | null;
  reason: string | null;
  status: string;
  clearance_checklist: unknown[];
  asset_return_checklist: unknown[];
  exit_interview_completed: boolean;
  eligible_for_rehire: boolean;
  created_at: string;
}

export interface ProbationRecord {
  id: string;
  employee_id: string;
  start_date: string;
  end_date: string;
  probation_length_days: number;
  status: string;
  extended: boolean;
  overall_rating: string | null;
  result: string | null;
  created_at: string;
}

export interface InternalJobPosting {
  id: string;
  title: string;
  department: string | null;
  location: string | null;
  employment_type: string | null;
  level: string | null;
  status: string;
  posted_at: string | null;
  closes_at: string | null;
  hiring_manager: string | null;
  created_at: string;
}

export interface PromotionRequest {
  id: string;
  employee_id: string;
  current_title: string | null;
  current_level: string | null;
  proposed_title: string;
  proposed_level: string | null;
  status: string;
  effective_date: string | null;
  created_at: string;
}

export interface TransferRequest {
  id: string;
  employee_id: string;
  from_department: string | null;
  to_department: string;
  from_position: string | null;
  to_position: string;
  status: string;
  effective_date: string | null;
  created_at: string;
}

export interface EmployeeDocument {
  id: string;
  employee_id: string;
  name: string;
  category: string;
  file_url: string | null;
  version: number;
  tags: string[];
  is_confidential: boolean;
  expiry_date: string | null;
  status: string;
  created_at: string;
}

export interface EmployeeAchievement {
  id: string;
  employee_id: string;
  title: string;
  category: string;
  description: string | null;
  date_awarded: string | null;
  issuer: string | null;
  badge_url: string | null;
  is_public: boolean;
  created_at: string;
}

export interface CareerFramework {
  id: string;
  name: string;
  description: string | null;
  levels: Record<string, unknown>[];
  is_active: boolean;
}

export interface CareerPath {
  id: string;
  name: string;
  description: string | null;
  job_family_id: string | null;
  steps: Record<string, unknown>[];
  typical_duration_months: number | null;
  is_active: boolean;
}

export interface CareerRoadmap {
  id: string;
  employee_id: string;
  career_path_id: string | null;
  milestones: Record<string, unknown>[];
  current_step: number;
  target_role: string | null;
  target_level: string | null;
  progress_percentage: number;
  is_active: boolean;
  created_at: string;
}

export interface EmployeeProfile {
  employee_id: string;
  personal_info: Record<string, unknown>;
  contact_info: Record<string, unknown>;
  employment_info: Record<string, unknown>;
  education: unknown[];
  certifications: unknown[];
  work_history: unknown[];
  skills_summary: Record<string, unknown>;
  profile_completeness: number;
  updated_at: string;
}

export interface TimelineEvent {
  id: string;
  employee_id: string;
  event_type: string;
  title: string;
  description: string | null;
  event_date: string;
  created_at: string;
}

// === Module 5 — Payroll Enterprise Types ===

export interface EnhancedPayrollRecord {
  id: number;
  employeeId: string;
  tenantId: string;
  period: string;
  country: string;
  currency: string;
  baseSalary: number;
  allowances: number;
  deductions: number;
  tax: number;
  socialSecurity: number;
  medicare: number;
  netSalary: number;
  grossSalary: number;
  paymentMethod: string;
  bankAccount: string;
  bankRouting: string;
  status: string;
  processedDate: string;
}

export interface CountryTaxConfig {
  id: number;
  tenantId: string;
  country: string;
  currency: string;
  taxYear: string;
  standardDeduction: number;
  socialSecurityRate: number;
  medicareRate: number;
  corporateTaxRate: number;
  hasProgressiveTax: boolean;
}

export interface TaxBracket {
  id: number;
  tenantId: string;
  country: string;
  taxYear: string;
  minIncome: number;
  maxIncome: number;
  rate: number;
  flatAmount: number;
  bracketOrder: number;
}

export interface TaxSimulationResult {
  grossSalary: number;
  country: string;
  taxYear: string;
  tax: number;
  effectiveTaxRate: number;
  socialSecurity: number;
  medicare: number;
  totalDeductions: number;
  netSalary: number;
  brackets: { range: string; rate: string; flatAmount: number }[];
}

export interface PayrollForecast {
  id: number;
  tenantId: string;
  period: string;
  projectedGrossPayroll: number;
  projectedNetPayroll: number;
  projectedTax: number;
  projectedBenefits: number;
  confidence: number;
  factors: string;
  status: string;
  generatedAt: string;
}

export interface PayrollAudit {
  id: number;
  payrollId: number;
  tenantId: string;
  action: string;
  changedBy: string;
  fieldName: string;
  oldValue: string;
  newValue: string;
  changedAt: string;
}

export interface ExpenseReport {
  id: number;
  employeeId: string;
  tenantId: string;
  category: string;
  amount: number;
  description: string;
  receiptUrl: string;
  expenseDate: string;
  status: string;
  approvedBy: string;
  rejectedReason: string;
  submittedAt: string;
}

export interface BenefitPlan {
  id: number;
  tenantId: string;
  name: string;
  type: string;
  description: string;
  employerContribution: number;
  employeeContribution: number;
  maxBenefitAmount: number;
  isActive: boolean;
}

export interface BenefitEnrollment {
  id: number;
  employeeId: string;
  tenantId: string;
  planId: number;
  enrollmentDate: string;
  effectiveDate: string;
  status: string;
  employeeContribution: number;
  employerContribution: number;
}

export interface Bonus {
  id: number;
  employeeId: string;
  tenantId: string;
  amount: number;
  type: string;
  reason: string;
  awardDate: string;
  payoutDate: string;
  currency: string;
  status: string;
  approvedBy: string;
}

export interface EquityGrant {
  id: number;
  employeeId: string;
  tenantId: string;
  shares: number;
  strikePrice: number;
  fairMarketValue: number;
  grantDate: string;
  vestingStart: string;
  vestingEnd: string;
  vestingSchedule: string;
  equityType: string;
  status: string;
}

export interface CompensationPlan {
  id: number;
  employeeId: string;
  tenantId: string;
  currentBaseSalary: number;
  proposedBaseSalary: number;
  currency: string;
  effectiveDate: string;
  reason: string;
  status: string;
  reviewCycle: string;
}

export interface SalaryBenchmark {
  id: number;
  tenantId: string;
  role: string;
  experience: string;
  location: string;
  industry: string;
  percentile10: number;
  percentile25: number;
  percentile50: number;
  percentile75: number;
  percentile90: number;
  currency: string;
  source: string;
  year: string;
}

export interface BenchmarkComparison {
  role: string;
  experience: string;
  location: string;
  currentSalary: number;
  p25: number;
  p50: number;
  p75: number;
  position: string;
  vsMedianPercent: number;
  currency: string;
}

export interface BankTransaction {
  id: number;
  employeeId: string;
  tenantId: string;
  payrollId: number;
  amount: number;
  accountNumber: string;
  routingNumber: string;
  bankName: string;
  accountType: string;
  transactionType: string;
  reference: string;
  status: string;
  processedAt: string;
}

export interface PayrollComplianceReport {
  id: number;
  tenantId: string;
  reportType: string;
  period: string;
  country: string;
  summary: string;
  details: string;
  status: string;
  generatedAt: string;
}

export interface PayrollAnomaly {
  id: number;
  tenantId: string;
  payrollId: number;
  employeeId: string;
  anomalyType: string;
  severity: string;
  description: string;
  isResolved: boolean;
  detectedAt: string;
  resolvedAt: string | null;
}

export interface Payslip {
  id: number;
  payrollId: number;
  employeeId: string;
  tenantId: string;
  period: string;
  pdfContent: string;
  pdfUrl: string;
  generatedAt: string;
}

export interface PayrollDashboardSummary {
  totalPayrollRecords: number;
  totalGrossPayroll: number;
  totalNetPayroll: number;
  totalTaxWithheld: number;
  pendingExpenses: number;
  unresolvedAnomalies: number;
  pendingBonuses: number;
}

// === Module 6 — Workforce Planning Types ===

export interface WorkforceDashboard {
  total_headcount: number;
  total_capacity: number;
  total_allocated: number;
  bench_count: number;
  open_requirements: number;
  attrition_rate: number;
  utilization_rate: number;
  skill_gap_count: number;
  hiring_urgent: number;
  department_summary: WorkforceDeptSummary[];
  trends: Record<string, unknown>;
}

export interface WorkforceDeptSummary {
  department: string;
  total_capacity: number;
  allocated: number;
  open_roles: number;
}

export interface WorkforceDemandForecast {
  id: string;
  tenant_id: string;
  department: string;
  role: string;
  current_headcount: number;
  projected_headcount: number;
  gap: number;
  period: string;
  confidence_level: number;
  factors: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface CapacityPlan {
  id: string;
  tenant_id: string;
  department: string;
  role: string;
  total_capacity: number;
  allocated: number;
  available: number;
  utilization_rate: number;
  period: string;
  created_at: string;
  updated_at: string;
}

export interface WorkforceAllocation {
  id: string;
  tenant_id: string;
  employee_id: string;
  employee_name: string;
  department: string;
  role: string;
  project_name: string;
  allocation_percentage: number;
  start_date: string;
  end_date: string;
  status: string;
  notes: string;
  created_at: string;
  updated_at: string;
}

export interface ProjectStaffing {
  id: string;
  tenant_id: string;
  project_name: string;
  project_code: string;
  department: string;
  required_roles: { role: string; count: number; skills: string[] }[];
  actual_staffing: { role: string; count: number; employees: string[] }[];
  budget: number;
  actual_cost: number;
  status: string;
  start_date: string;
  end_date: string;
  created_at: string;
  updated_at: string;
}

export interface SkillGapAnalysis {
  id: string;
  tenant_id: string;
  department: string;
  role: string;
  skill_name: string;
  required_level: number;
  current_avg_level: number;
  gap_score: number;
  employee_count: number;
  priority: string;
  period: string;
  created_at: string;
  updated_at: string;
}

export interface ResourceForecast {
  id: string;
  tenant_id: string;
  department: string;
  role: string;
  current_headcount: number;
  projected_hires: number;
  projected_attrition: number;
  net_headcount: number;
  period: string;
  confidence: number;
  created_at: string;
  updated_at: string;
}

export interface BenchManagement {
  id: string;
  tenant_id: string;
  employee_id: string;
  employee_name: string;
  department: string;
  role: string;
  skills: { skill: string; level: number }[];
  bench_start_date: string;
  bench_duration_days: number;
  billable_status: string;
  status: string;
  notes: string;
  created_at: string;
  updated_at: string;
}

export interface TalentForecast {
  id: string;
  tenant_id: string;
  department: string;
  role: string;
  current_talent_pool: number;
  projected_needs: number;
  gap: number;
  period: string;
  risk_level: string;
  created_at: string;
  updated_at: string;
}

export interface AttritionForecast {
  id: string;
  tenant_id: string;
  department: string;
  role: string;
  current_headcount: number;
  projected_attrition_rate: number;
  projected_attrition_count: number;
  confidence: number;
  risk_factors: Record<string, unknown>;
  period: string;
  created_at: string;
  updated_at: string;
}

export interface RetirementForecast {
  id: string;
  tenant_id: string;
  department: string;
  role: string;
  eligible_count: number;
  projected_retirements: number;
  avg_age: number;
  risk_level: string;
  period: string;
  created_at: string;
  updated_at: string;
}

export interface HiringRecommendation {
  id: string;
  tenant_id: string;
  department: string;
  role: string;
  priority: string;
  recommended_count: number;
  current_gap: number;
  urgency: string;
  business_impact: string;
  justification: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface WorkforceSimulation {
  id: string;
  tenant_id: string;
  name: string;
  description: string;
  simulation_type: string;
  parameters: Record<string, unknown>;
  results: Record<string, unknown>;
  status: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface SimulationRunResult {
  simulation_id: string;
  results: Record<string, unknown>;
  summary: string;
}

export interface WhatIfAnalysis {
  id: string;
  tenant_id: string;
  simulation_id: string;
  scenario_name: string;
  assumptions: Record<string, unknown>;
  projected_impact: Record<string, unknown>;
  confidence: number;
  created_at: string;
  updated_at: string;
}

export interface OrgRedesignSimulator {
  id: string;
  tenant_id: string;
  name: string;
  description: string;
  current_structure: Record<string, unknown>;
  proposed_structure: Record<string, unknown>;
  impact_analysis: Record<string, unknown>;
  status: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface StrategicPlan {
  id: string;
  tenant_id: string;
  name: string;
  period: string;
  objectives: StrategicObjective[];
  kpis: StrategicKPI[];
  initiatives: StrategicInitiative[];
  status: string;
  progress: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface StrategicObjective {
  title: string;
  description: string;
  target_date: string;
  status: string;
  progress: number;
}

export interface StrategicKPI {
  name: string;
  current_value: number;
  target_value: number;
  unit: string;
  trend: string;
}

export interface StrategicInitiative {
	name: string;
	description: string;
	owner: string;
	budget: number;
	start_date: string;
	end_date: string;
	status: string;
	progress: number;
}

// === Module 7 — Learning & Development Types ===

export interface ComplianceTraining {
	id: string;
	tenant_id: string;
	course_id: string;
	employee_id: string;
	policy_name: string;
	policy_category: string;
	due_date: string | null;
	completed_date: string | null;
	status: string;
	score: number | null;
	attempts: number;
	is_mandatory: boolean;
	course?: Course;
	created_at: string;
	updated_at: string;
}

export interface ComplianceDashboard {
	total: number;
	completed: number;
	overdue: number;
	pending: number;
	in_progress: number;
	compliance_rate: number;
	by_policy: { policy_name: string; total: number; completed: number }[];
}

export interface LearningRecommendation {
	id: string;
	tenant_id: string;
	employee_id: string;
	skill_name: string;
	gap_score: number;
	recommended_type: string;
	recommended_id: string;
	title: string;
	description: string;
	priority: string;
	reason: string;
	status: string;
	created_at: string;
	updated_at: string;
}

export interface MentorProfile {
	id: string;
	tenant_id: string;
	employee_id: string;
	full_name: string;
	department: string;
	role: string;
	bio: string;
	expertise: string[];
	max_mentees: number;
	current_mentees: number;
	is_available: boolean;
	rating: number;
	created_at: string;
	updated_at: string;
}

export interface MentorSession {
	id: string;
	tenant_id: string;
	mentor_id: string;
	mentee_id: string;
	topic: string;
	scheduled_at: string | null;
	duration_mins: number;
	status: string;
	notes: string;
	feedback: string;
	rating: number;
	mentor?: MentorProfile;
	created_at: string;
	updated_at: string;
}

export interface MarketplaceListing {
	id: string;
	tenant_id: string;
	title: string;
	description: string;
	provider: string;
	category: string;
	type: string;
	skills: string[];
	duration_hours: number;
	cost: number;
	currency: string;
	max_participants: number;
	enrolled_count: number;
	rating: number;
	status: string;
	created_at: string;
	updated_at: string;
}

export interface KnowledgeArticle {
	id: string;
	tenant_id: string;
	title: string;
	summary: string;
	content: string;
	category: string;
	tags: string[];
	author_id: string;
	author_name: string;
	content_type: string;
	content_url: string;
	view_count: number;
	useful_count: number;
	status: string;
	created_at: string;
	updated_at: string;
}

export interface SkillEndorsement {
	id: string;
	tenant_id: string;
	skill_id: string;
	employee_id: string;
	endorsed_by: string;
	endorser_name: string;
	skill_name: string;
	proficiency: string;
	comment: string;
	created_at: string;
}

export interface CompetencyFramework {
	id: string;
	tenant_id: string;
	name: string;
	role: string;
	level: string;
	competencies: Record<string, unknown>;
	required_score: number;
	status: string;
	created_at: string;
	updated_at: string;
}

export interface CompetencyMatrixResult {
	framework: CompetencyFramework;
	employee_count: number;
	avg_score: number;
	qualified_count: number;
}

export interface LearningJourney {
	id: string;
	tenant_id: string;
	employee_id: string;
	name: string;
	target_role: string;
	steps: Record<string, unknown>;
	current_step: number;
	progress_pct: number;
	status: string;
	started_at: string | null;
	completed_at: string | null;
	created_at: string;
	updated_at: string;
}

export interface LearningAnalyticsOverview {
	courses: { total: number; published: number };
	enrollments: { total: number; completed: number; in_progress: number };
	completion_rate: number;
	certifications: { total: number; active: number; expiring_30d: number };
	assessments: { total: number; attempts: number; passed: number };
	pass_rate: number;
	skills: { total: number };
	journeys: { total: number };
	compliance: { total: number; completed: number; rate: number };
	knowledge_articles: number;
	marketplace_listings: number;
	mentors: number;
}

// === Module 8 — Performance Management Types ===

export type KpiDirection = "up" | "down" | "neutral";

export interface KpiTarget {
  id: string;
  name: string;
  category: string;
  currentValue: number;
  targetValue: number;
  unit: string;
  direction: KpiDirection;
  owner: string;
  frequency: "daily" | "weekly" | "monthly" | "quarterly" | "yearly";
  trend: { date: string; value: number }[];
}

export interface GoalAlignment {
  id: string;
  goalId: string;
  goalTitle: string;
  alignedWith: string;
  alignmentType: "company" | "department" | "team" | "individual";
  alignmentScore: number;
  notes: string;
  createdAt: string;
}

export interface ContinuousFeedback {
  id: string;
  fromId: string;
  fromName: string;
  toId: string;
  toName: string;
  message: string;
  type: "praise" | "constructive" | "suggestion" | "one-on-one";
  context: string;
  isAcknowledged: boolean;
  acknowledgedAt?: string;
  createdAt: string;
}

export interface ManagerReview {
  id: string;
  employeeId: string;
  employeeName: string;
  managerId: string;
  managerName: string;
  period: string;
  ratings: { category: string; score: number; comment: string }[];
  overallScore: number;
  strengths: string[];
  improvements: string[];
  status: "draft" | "submitted" | "acknowledged";
  createdAt: string;
}

export interface PeerReview {
  id: string;
  revieweeId: string;
  revieweeName: string;
  reviewerId: string;
  reviewerName: string;
  project: string;
  collaboration: number;
  communication: number;
  technicalSkills: number;
  reliability: number;
  overallScore: number;
  strengths: string;
  improvements: string;
  status: "pending" | "completed";
  createdAt: string;
}

export interface PerformanceCalibration {
  id: string;
  name: string;
  period: string;
  participants: { employeeId: string; employeeName: string; department: string; rating: number; calibratedRating?: number }[];
  facilitators: string[];
  status: "draft" | "in-progress" | "completed";
  createdAt: string;
  completedAt?: string;
}

// === NASA-Level Security Types (121-145) ===

export interface ZeroTrustPolicy {
  id: string;
  tenant_id: string;
  name: string;
  description?: string;
  enabled: boolean;
  priority: number;
  conditions: Record<string, unknown>;
  actions: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ConditionalAccessPolicy {
  id: string;
  tenant_id: string;
  name: string;
  description?: string;
  enabled: boolean;
  conditions: Record<string, unknown>;
  grant_controls: Record<string, unknown>;
  session_controls: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface RiskAssessment {
  id: string;
  tenant_id: string;
  user_id: string;
  session_id?: string;
  risk_score: number;
  risk_level: "low" | "medium" | "high" | "critical";
  factors: Record<string, unknown>;
  ip_address?: string;
  user_agent?: string;
  device_id?: string;
  location?: Record<string, unknown>;
  assessed_at: string;
}

export interface PrivilegedRole {
  id: string;
  tenant_id: string;
  name: string;
  description?: string;
  permissions: string[];
  risk_level: string;
  requires_approval: boolean;
  max_duration_minutes: number;
  created_at: string;
  updated_at: string;
}

export interface PrivilegedAccess {
  id: string;
  tenant_id: string;
  user_id: string;
  role_id: string;
  role_name?: string;
  granted_by?: string;
  justification?: string;
  jit_enabled: boolean;
  start_time?: string;
  end_time?: string;
  status: "pending" | "approved" | "revoked" | "expired";
  approved_by?: string;
  approved_at?: string;
  created_at: string;
}

export interface DataClassification {
  id: string;
  tenant_id: string;
  resource_type: string;
  resource_pattern?: string;
  classification_level: string;
  category?: string;
  owner?: string;
  retention_days?: number;
  encryption_required: boolean;
  masking_rules?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface DLPPolicy {
  id: string;
  tenant_id: string;
  name: string;
  description?: string;
  enabled: boolean;
  severity: string;
  rules: Record<string, unknown>;
  actions: string[];
  created_at: string;
  updated_at: string;
}

export interface DLPIncident {
  id: string;
  tenant_id: string;
  policy_id?: string;
  user_id?: string;
  resource_type?: string;
  resource_id?: string;
  action?: string;
  data_classification?: string;
  description?: string;
  severity?: string;
  status: string;
  detected_at: string;
  remediated_at?: string;
  evidence?: Record<string, unknown>;
}

export interface EncryptionKey {
  id: string;
  tenant_id: string;
  key_id: string;
  algorithm: string;
  purpose: string;
  status: string;
  version: number;
  rotated_from?: string;
  activated_at: string;
  expires_at?: string;
  rotated_at?: string;
  created_at: string;
}

export interface DataResidencyPolicy {
  id: string;
  tenant_id: string;
  region: string;
  resource_type: string;
  data_classification?: string;
  allowed_regions: string[];
  restricted_regions: string[];
  enforcement_mode: string;
  enabled: boolean;
  created_at: string;
}

export interface SessionRecording {
  id: string;
  tenant_id: string;
  user_id: string;
  session_id?: string;
  user_role?: string;
  recording_type: string;
  events: Record<string, unknown>[];
  duration_seconds?: number;
  ip_address?: string;
  user_agent?: string;
  status: string;
  started_at: string;
  ended_at?: string;
}

export interface SecurityDashboard {
  zero_trust_policies: number;
  active_zt_policies: number;
  conditional_access_policies: number;
  active_ca_policies: number;
  pending_risk_assessments: number;
  high_risk_sessions: number;
  active_privileged_grants: number;
  pending_pam_requests: number;
  data_classifications: number;
  dlp_policies: number;
  open_dlp_incidents: number;
  encryption_keys: number;
  active_encryption_keys: number;
  data_residency_rules: number;
  session_recordings_active: number;
  overall_risk_score: number;
  compliance_status: string;
}

export interface WebAuthnCredential {
  id: number;
  credential_id: string;
  device_name: string;
  device_type: string;
  counter: number;
  is_active: boolean;
  created_at: string;
  last_used_at?: string;
}

export interface OAuthProvider {
  id: number;
  provider: string;
  client_id: string;
  redirect_uri?: string;
  scopes?: string;
  enabled: boolean;
}

export interface OAuthLink {
  provider: string;
  provider_user_id: string;
  created_at: string;
}

export interface SecurityComplianceReport {
  category: string;
  generated_at: string;
  tenant_id: string;
  score: number;
  total_policies: number;
  enabled_policies: number;
  total_violations: number;
  open_violations: number;
  remediated_violations: number;
  status: string;
  findings: { title: string; severity: string; description: string; recommendation: string }[];
  recommendations: string[];
}

export interface PromotionReadiness {
  id: string;
  employeeId: string;
  employeeName: string;
  currentRole: string;
  targetRole: string;
  readinessScore: number;
  criteria: { name: string; score: number; weight: number }[];
  overallRating: "ready-now" | "ready-in-6-months" | "ready-in-1-year" | "not-ready";
  recommendations: string;
  createdAt: string;
}

export interface TalentReviewBoard {
  id: string;
  name: string;
  date: string;
  participants: string[];
  employees: {
    employeeId: string;
    employeeName: string;
    department: string;
    performance: number;
    potential: number;
    box: "star" | "core" | "underperformer" | "high-potential" | "question-mark";
    notes: string;
  }[];
  decisions: { employeeId: string; decision: string; actionItems: string }[];
  status: "scheduled" | "in-progress" | "completed";
  createdAt: string;
}

export interface HiPoEmployee {
  id: string;
  employeeId: string;
  employeeName: string;
  department: string;
  currentRole: string;
  performanceScore: number;
  potentialScore: number;
  reason: string[];
  nominatedBy: string;
  program: string;
  status: "identified" | "in-program" | "graduated" | "exited";
  mentorId?: string;
  mentorName?: string;
  createdAt: string;
}

export interface LeadershipReadiness {
  id: string;
  employeeId: string;
  employeeName: string;
  currentRole: string;
  readinessScore: number;
  dimensions: { name: string; score: number; maxScore: number; comments: string }[];
  overallReadiness: "ready" | "development-needed" | "not-ready";
  recommendedDevelopment: string[];
  targetRole: string;
  assessedBy: string;
  assessedAt: string;
}

export interface AiPerformanceInsight {
  id: string;
  employeeId: string;
  employeeName: string;
  insightType: "strength" | "growth-area" | "pattern" | "prediction" | "anomaly";
  category: string;
  title: string;
  description: string;
  confidence: number;
  supportingData: Record<string, unknown>;
  recommendation: string;
  createdAt: string;
}

export interface CoachingRecommendation {
  id: string;
  employeeId: string;
  employeeName: string;
  focusArea: string;
  recommendation: string;
  suggestedApproach: string;
  resources: { title: string; type: "article" | "course" | "video" | "book" | "mentor"; url?: string }[];
  priority: "critical" | "high" | "medium" | "low";
  status: "pending" | "in-progress" | "completed";
  createdAt: string;
}

export interface DevelopmentPlan {
  id: string;
  employeeId: string;
  employeeName: string;
  title: string;
  goals: { title: string; category: string; targetDate: string; status: "not-started" | "in-progress" | "completed" }[];
  skills: string[];
  mentorship: { mentorId: string; mentorName: string; focus: string }[];
  milestones: { title: string; dueDate: string; completed: boolean }[];
  progress: number;
  status: "draft" | "active" | "completed";
  startDate: string;
  endDate: string;
  createdAt: string;
}

// === Real-Time Event Types (146-170) ===
export interface RealTimeEventBase {
  channel: string;
  event: string;
  timestamp: string;
}

export interface PresencePayload {
  user_id: string;
  name: string;
  status: string;
  department?: string;
  role?: string;
  last_active?: string;
}

export interface AlertPayload {
  title: string;
  message: string;
  severity: "critical" | "high" | "medium" | "low";
  category?: string;
  source?: string;
}

export interface AnnouncementPayload {
  title: string;
  message: string;
  priority?: string;
  author?: string;
  department?: string;
}

export interface ActivityPayload {
  actor: string;
  action: string;
  resource: string;
  details?: string;
  department?: string;
}

export interface AttendancePayload {
  employee_id: string;
  name: string;
  action: string;
  department?: string;
  location?: string;
}

export interface PayrollPayload {
  batch_id?: string;
  status: string;
  processed: number;
  total: number;
  department?: string;
}

export interface LeavePayload {
  employee_name: string;
  leave_type: string;
  status: string;
  department?: string;
}

export interface KPIPayload {
  metric: string;
  value: number;
  target: number;
  unit?: string;
  department?: string;
  trend?: string;
}

export interface TaskPayload {
  task_id: string;
  title: string;
  assignee?: string;
  status: string;
  priority?: string;
}

export interface EscalationPayload {
  case_id: string;
  title: string;
  level: number;
  status: string;
  sla_remaining_minutes?: number;
}

export interface CompliancePayload {
  policy: string;
  status: string;
  score?: number;
  violations?: number;
}

export interface OnboardingPayload {
  employee_name: string;
  stage: string;
  progress: number;
  department?: string;
}

export interface RecruitmentPayload {
  candidate_name: string;
  position: string;
  stage: string;
  score?: number;
}

export interface ForecastPayload {
  metric: string;
  value: number;
  prediction: number;
  unit?: string;
  confidence?: number;
}

export interface StaffingPayload {
  department: string;
  filled: number;
  required: number;
  shift?: string;
  status: string;
}

export interface SLAPayload {
  service: string;
  status: string;
  response_time_ms?: number;
  threshold_ms?: number;
}

export interface PollPayload {
  poll_id: string;
  question: string;
  options: { label: string; votes: number }[];
  total_votes: number;
  status: string;
}

export interface EmergencyPayload {
  title: string;
  message: string;
  severity: string;
  source?: string;
}

export interface IncidentPayload {
  incident_id: string;
  title: string;
  severity: string;
  status: string;
  assignee?: string;
  resolution_progress?: number;
}

export interface ChatMessagePayload {
  id: string;
  sender: string;
  message: string;
  message_type: string;
  room: string;
  timestamp: string;
}

// === AI Features Types (171-200) ===
export interface AICopilotResponse {
  reply: string;
  confidence: number;
  sources: string[];
  suggestions: string[];
  session_id: string;
}

export interface AICopilotQuery {
  query: string;
  context?: Record<string, unknown>;
  session_id?: string;
}

export interface NLReportRequest {
  query: string;
  department?: string;
  timeframe?: string;
  format?: string;
}

export interface NLReportResponse {
  title: string;
  summary: string;
  data: { label: string; value: number; change: number }[];
  chart_config?: Record<string, unknown>;
  insights: string[];
}

export interface AIDashboardResponse {
  title: string;
  description: string;
  widgets: { type: string; title: string; metric: string; color?: string; chart_type?: string }[];
  layout: { widget: number; x: number; y: number; w: number; h: number }[];
}

export interface AIPredictionResponse {
  prediction: string;
  probability: number;
  risk_factors: { factor: string; weight?: number; severity?: string; impact?: number; trend?: string; value?: number }[];
  recommendations: string[];
  confidence_interval?: { lower: number; upper: number };
  factors?: { factor: string; weight: string; value: number }[];
  suggested_roles?: string[];
}

export interface AISalaryResponse {
  current_salary: number;
  recommended_salary: number;
  percentile: string;
  market_data: { role: string; location: string; p10: number; p25: number; p50: number; p75: number; p90: number };
  factors: { name: string; impact: string }[];
}

export interface AIForecastResponse {
  forecasts: { metric: string; current: number; projected: number; change_pct: number }[];
  total_headcount_projection: { month: string; headcount: number; hires: number; attrition: number }[];
  key_insights: string[];
  confidence: number;
}

export interface AIPolicyResponse {
  answer: string;
  policy_citations: { policy: string; relevance: string; section: string }[];
  related_policies: string[];
}

export interface AILeaveResponse {
  recommended: boolean;
  reason: string;
  coverage_suggestions: string[];
  pattern_insights?: { total_days_used: number; remaining_days: number; department_coverage: string; previous_approvals: number };
}

export interface AIRecruitmentResponse {
  recommended_sources: string[];
  screening_questions: string[];
  interview_tips: string[];
  estimated_time_to_hire: string;
}

export interface AIOnboardingResponse {
  recommended_plan: { week: number; focus: string; activities: string[] }[];
  estimated_ramp_up: string;
  key_milestones: string[];
  mentor_suggestion: string;
}

export interface AITrainingResponse {
  recommended_courses: { title: string; category: string; duration: string; relevance: number }[];
  skill_gaps: { skill: string; current: string; required: string; priority: string }[];
  learning_path: string[];
  estimated_time: string;
}

export interface AIComplianceResponse {
  compliant: boolean;
  risks: { type: string; severity: string; description: string; mitigation: string }[];
  required_actions: string[];
  policy_references: string[];
}

export interface AIKnowledgeResponse {
  results: { id: string; title: string; category: string; relevance: number; snippet: string; url: string }[];
  total: number;
  suggested_queries: string[];
}

export interface AIOrgAdvisorResponse {
  answer: string;
  recommendations: string[];
  impact_analysis?: { communication_efficiency: string; decision_speed: string; collaboration_score: string; suggested_improvements: string[] };
}

export interface AIRiskResponse {
  risks: { category: string; risk: string; severity: string; probability: number; impact: string; affected_employees: number }[];
  overall_risk_score: number;
  trend: string;
  mitigation_priorities: string[];
}

export interface AIAnomalyResponse {
  anomalies: { timestamp: string; expected: number; actual: number; deviation: string; severity: string }[];
  baseline: { mean: number; std: number; period: string };
  alert_level: string;
}

export interface AIShiftResponse {
  optimized_schedule: { date: string; shift: string; staff_required: number; staff_assigned: number; gap: number }[];
  coverage_gaps: { date: string; shift: string; staff_required: number; staff_assigned: number; gap: number }[];
  cost_savings: number;
  efficiency_gain: number;
}

export interface AISuccessionResponse {
  internal_candidates: { name: string; current_role: string; readiness: string; overlap_score: number }[];
  readiness_levels: { ready_now: number; ready_1_2_years: number; ready_3_5_years: number; not_ready: number };
  development_plans: string[];
  risk_of_vacancy: string;
}

export interface AIBudgetResponse {
  monthly_projections: { month: string; budgeted: number; projected: number; remaining: number }[];
  total_forecast: number;
  variance_analysis: { budgeted_total: number; projected_total: number; variance: number; variance_pct: number };
  recommendations: string[];
}

export interface AIPerformanceSummaryResponse {
  summary: string;
  highlights: string[];
  areas_for_improvement: string[];
  overall_score: number;
  trend: string;
}

export interface AIMeetingSummaryResponse {
  summary: string;
  key_points: string[];
  action_items: string[];
  decisions: string[];
  follow_ups: string[];
}

export interface AIWorkflowResponse {
  workflow: { step: number; name: string; role: string; estimated_time: string; automation_potential: string }[];
  estimated_time: string;
  required_roles: string[];
  automation_opportunities: string[];
}

export interface AIAutomationResponse {
  automation_script: string;
  integration_points: string[];
  estimated_savings: string;
  validation_steps: string[];
}

export interface AIAgenticResponse {
  plan: { phase: number; name: string; agent: string; autonomous: boolean; human_required: boolean }[];
  sub_agents: { name: string; role: string; capabilities: string[] }[];
  estimated_steps: number;
  estimated_duration: string;
  human_touchpoints: string[];
}

export interface AIAutonomousResponse {
  analysis: string;
  insights: { type: string; description: string; confidence: number; auto_actionable: boolean }[];
  predictions: { metric: string; current: number; projected_30d: number; projected_90d: number }[];
  auto_actions: { action: string; trigger: string; priority: string; auto_execute: boolean }[];
  dashboard_suggestions: string[];
}
