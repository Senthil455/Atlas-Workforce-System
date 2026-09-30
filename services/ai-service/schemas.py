from pydantic import BaseModel
from typing import Optional, Any
from datetime import datetime


class CopilotQuery(BaseModel):
    query: str
    context: Optional[dict] = None
    session_id: Optional[str] = None

class CopilotResponse(BaseModel):
    reply: str
    confidence: float
    sources: list[str] = []
    suggestions: list[str] = []
    session_id: str

class NaturalLanguageReportRequest(BaseModel):
    query: str
    department: Optional[str] = None
    timeframe: Optional[str] = "this_month"
    format: Optional[str] = "summary"

class NaturalLanguageReportResponse(BaseModel):
    title: str
    summary: str
    data: list[dict] = []
    chart_config: Optional[dict] = None
    insights: list[str] = []

class AIDashboardRequest(BaseModel):
    focus: str
    department: Optional[str] = None
    role: Optional[str] = None

class AIDashboardResponse(BaseModel):
    title: str
    description: str
    widgets: list[dict] = []
    layout: list[dict] = []

class PredictionRequest(BaseModel):
    employee_id: Optional[str] = None
    department: Optional[str] = None
    timeframe_months: Optional[int] = 6
    include_factors: Optional[bool] = True

class PredictionResponse(BaseModel):
    prediction: str
    probability: float
    risk_factors: list[dict] = []
    recommendations: list[str] = []
    confidence_interval: Optional[dict] = None

class SalaryRecommendationRequest(BaseModel):
    employee_id: str
    role: str
    experience_years: int
    performance_score: Optional[float] = None
    location: Optional[str] = None
    department: Optional[str] = None

class SalaryRecommendationResponse(BaseModel):
    current_salary: float
    recommended_salary: float
    percentile: str
    market_data: dict
    factors: list[dict]

class WorkforceForecastRequest(BaseModel):
    department: Optional[str] = None
    horizon_months: int = 12
    include_attrition: bool = True
    include_hiring: bool = True

class WorkforceForecastResponse(BaseModel):
    forecasts: list[dict] = []
    total_headcount_projection: list[dict] = []
    key_insights: list[str] = []
    confidence: float

class PolicyQuery(BaseModel):
    query: str
    policy_area: Optional[str] = None

class PolicyResponse(BaseModel):
    answer: str
    policy_citations: list[dict] = []
    related_policies: list[str] = []

class LeaveRecommendationRequest(BaseModel):
    employee_id: str
    leave_type: str
    requested_dates: list[str]
    department: Optional[str] = None

class LeaveRecommendationResponse(BaseModel):
    recommended: bool
    reason: str
    coverage_suggestions: list[str] = []
    pattern_insights: Optional[dict] = None

class RecruitmentAssistantRequest(BaseModel):
    job_requirements: str
    candidate_pool: Optional[list[str]] = None
    screening_criteria: Optional[dict] = None

class RecruitmentAssistantResponse(BaseModel):
    recommended_sources: list[str] = []
    screening_questions: list[str] = []
    interview_tips: list[str] = []
    estimated_time_to_hire: str

class OnboardingRecommendationRequest(BaseModel):
    employee_role: str
    department: str
    experience_level: str
    previous_company: Optional[str] = None

class OnboardingRecommendationResponse(BaseModel):
    recommended_plan: list[dict] = []
    estimated_ramp_up: str
    key_milestones: list[str] = []
    mentor_suggestion: Optional[str] = None

class TrainingRecommendationRequest(BaseModel):
    employee_id: str
    current_skills: list[str] = []
    target_role: Optional[str] = None
    performance_gaps: Optional[list[str]] = None

class TrainingRecommendationResponse(BaseModel):
    recommended_courses: list[dict] = []
    skill_gaps: list[dict] = []
    learning_path: list[str] = []
    estimated_time: str

class ComplianceCheckRequest(BaseModel):
    action: str
    department: str
    employee_role: str
    region: Optional[str] = None

class ComplianceCheckResponse(BaseModel):
    compliant: bool
    risks: list[dict] = []
    required_actions: list[str] = []
    policy_references: list[str] = []

class KnowledgeSearchRequest(BaseModel):
    query: str
    filters: Optional[dict] = None
    max_results: Optional[int] = 10

class KnowledgeSearchResponse(BaseModel):
    results: list[dict] = []
    total: int
    suggested_queries: list[str] = []

class OrgAdvisorRequest(BaseModel):
    query: str
    org_context: Optional[dict] = None

class OrgAdvisorResponse(BaseModel):
    answer: str
    recommendations: list[str] = []
    impact_analysis: Optional[dict] = None

class RiskDetectionRequest(BaseModel):
    department: Optional[str] = None
    employee_id: Optional[str] = None
    risk_categories: Optional[list[str]] = None

class RiskDetectionResponse(BaseModel):
    risks: list[dict] = []
    overall_risk_score: float
    trend: str
    mitigation_priorities: list[str] = []

class AnomalyDetectionRequest(BaseModel):
    data_source: str
    metric: Optional[str] = None
    department: Optional[str] = None
    sensitivity: Optional[float] = 0.95

class AnomalyDetectionResponse(BaseModel):
    anomalies: list[dict] = []
    baseline: dict
    alert_level: str

class ShiftOptimizationRequest(BaseModel):
    department: str
    date_range: list[str]
    current_schedule: Optional[list[dict]] = None
    constraints: Optional[dict] = None

class ShiftOptimizationResponse(BaseModel):
    optimized_schedule: list[dict] = []
    coverage_gaps: list[dict] = []
    cost_savings: float
    efficiency_gain: float

class SuccessionPlanRequest(BaseModel):
    position: str
    department: str
    required_skills: list[str]
    timeline_months: int = 12

class SuccessionPlanResponse(BaseModel):
    internal_candidates: list[dict] = []
    readiness_levels: dict
    development_plans: list[str] = []
    risk_of_vacancy: str

class BudgetForecastRequest(BaseModel):
    department: str
    current_budget: float
    historical_data: Optional[list[dict]] = None
    forecast_months: int = 12

class BudgetForecastResponse(BaseModel):
    monthly_projections: list[dict] = []
    total_forecast: float
    variance_analysis: dict
    recommendations: list[str] = []

class PerformanceSummaryRequest(BaseModel):
    employee_id: str
    period: Optional[str] = "last_quarter"
    include_metrics: Optional[list[str]] = None

class PerformanceSummaryResponse(BaseModel):
    summary: str
    highlights: list[str] = []
    areas_for_improvement: list[str] = []
    overall_score: float = 0.0
    trend: str = "stable"

class MeetingSummaryRequest(BaseModel):
    transcript: str
    meeting_type: Optional[str] = None
    attendees: Optional[list[str]] = None

class MeetingSummaryResponse(BaseModel):
    summary: str
    key_points: list[str] = []
    action_items: list[str] = []
    decisions: list[str] = []
    follow_ups: list[str] = []
    sample_data: bool = False

class WorkflowGenerationRequest(BaseModel):
    process_name: str
    department: str
    description: str
    constraints: Optional[dict] = None

class WorkflowGenerationResponse(BaseModel):
    workflow: list[dict] = []
    estimated_time: str
    required_roles: list[str] = []
    automation_opportunities: list[str] = []
    sample_data: bool = False

class AutomationBuilderRequest(BaseModel):
    trigger: str
    actions: list[str]
    conditions: Optional[list[str]] = None
    department: str

class AutomationBuilderResponse(BaseModel):
    automation_script: str
    automation_definition: dict = {}
    requires_review: bool = True
    invalid_conditions: list[str] = []
    integration_points: list[str] = []
    estimated_savings: str
    validation_steps: list[str] = []

class AgenticWorkflowRequest(BaseModel):
    goal: str
    context: Optional[dict] = None
    autonomy_level: str = "semi_autonomous"

class AgenticWorkflowResponse(BaseModel):
    plan: list[dict] = []
    sub_agents: list[dict] = []
    estimated_steps: int
    estimated_duration: str
    human_touchpoints: list[str] = []

class AutonomousIntelligenceRequest(BaseModel):
    scope: str = "organization"
    metrics: Optional[list[str]] = None
    generate_recommendations: bool = True

class AutonomousIntelligenceResponse(BaseModel):
    analysis: str
    insights: list[dict] = []
    predictions: list[dict] = []
    auto_actions: list[dict] = []
    dashboard_suggestions: list[str] = []
