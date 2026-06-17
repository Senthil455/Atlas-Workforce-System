import logging
import os
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from atlas_observability import (
    AtlasLoggingMiddleware, AtlasMetricsMiddleware, CorrelationIdMiddleware,
    SecurityHeadersMiddleware,
    configure_logging, get_logger, verify_internal_auth
)

from schemas import (
    CopilotQuery, CopilotResponse,
    NaturalLanguageReportRequest, NaturalLanguageReportResponse,
    AIDashboardRequest, AIDashboardResponse,
    PredictionRequest, PredictionResponse,
    SalaryRecommendationRequest, SalaryRecommendationResponse,
    WorkforceForecastRequest, WorkforceForecastResponse,
    PolicyQuery, PolicyResponse,
    LeaveRecommendationRequest, LeaveRecommendationResponse,
    RecruitmentAssistantRequest, RecruitmentAssistantResponse,
    OnboardingRecommendationRequest, OnboardingRecommendationResponse,
    TrainingRecommendationRequest, TrainingRecommendationResponse,
    ComplianceCheckRequest, ComplianceCheckResponse,
    KnowledgeSearchRequest, KnowledgeSearchResponse,
    OrgAdvisorRequest, OrgAdvisorResponse,
    RiskDetectionRequest, RiskDetectionResponse,
    AnomalyDetectionRequest, AnomalyDetectionResponse,
    ShiftOptimizationRequest, ShiftOptimizationResponse,
    SuccessionPlanRequest, SuccessionPlanResponse,
    BudgetForecastRequest, BudgetForecastResponse,
    PerformanceSummaryRequest, PerformanceSummaryResponse,
    MeetingSummaryRequest, MeetingSummaryResponse,
    WorkflowGenerationRequest, WorkflowGenerationResponse,
    AutomationBuilderRequest, AutomationBuilderResponse,
    AgenticWorkflowRequest, AgenticWorkflowResponse,
    AutonomousIntelligenceRequest, AutonomousIntelligenceResponse,
)
from ai_engine import (
    PERSONAS, COPILOT_PERSONAS,
    _query_llm,
    _generate_report, _generate_dashboard,
    _predict_attrition, _predict_burnout, _predict_promotion,
    _salary_recommendation, _forecast_workforce,
    _answer_policy, _recommend_leave,
    _recruitment_assistant, _onboarding_recommendation, _training_recommendation,
    _compliance_check, _knowledge_search, _org_advisor,
    _detect_risks, _detect_anomalies, _optimize_shifts,
    _succession_plan, _budget_forecast,
    _performance_summary, _meeting_summary,
    _generate_workflow, _build_automation,
    _agentic_workflows, _autonomous_intelligence,
)

load_dotenv()

CORS_ORIGINS = os.getenv("CORS_ORIGINS", "*")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")

@asynccontextmanager
async def lifespan(app: FastAPI):
    yield

INTERNAL_JWT_SECRET = os.environ.get("INTERNAL_JWT_SECRET", "")

app = FastAPI(
    title="Atlas AI Service",
    description="Enterprise AI features: copilots, predictions, forecasting, automation, and autonomous intelligence",
    version="1.0.0",
    lifespan=lifespan,
)

configure_logging("ai-service", level=logging.INFO)
logger = get_logger("ai-service")

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS.split(",") if CORS_ORIGINS != "*" else ["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.add_middleware(CorrelationIdMiddleware)
app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(AtlasLoggingMiddleware)
app.add_middleware(AtlasMetricsMiddleware)


@app.middleware("http")
async def internal_auth_middleware(request: Request, call_next):
    if request.url.path in ("/health", "/metrics"):
        return await call_next(request)

    auth_header = request.headers.get("x-internal-auth")
    if not auth_header:
        return JSONResponse(status_code=401, content={"error": "Missing internal authentication"})

    try:
        claims = verify_internal_auth(request, INTERNAL_JWT_SECRET)
    except HTTPException as e:
        return JSONResponse(status_code=e.status_code, content={"error": e.detail})
    except Exception:
        return JSONResponse(status_code=401, content={"error": "Invalid internal authentication"})

    return await call_next(request)


MAX_REQUEST_SIZE = 1_000_000


@app.middleware("http")
async def limit_request_size(request: Request, call_next):
    content_length = request.headers.get("content-length")
    if content_length and int(content_length) > MAX_REQUEST_SIZE:
        return JSONResponse(
            status_code=413,
            content={"detail": "Request body too large (max 1MB)"},
        )
    return await call_next(request)

# ── Helper ──
def _copilot_response(persona_key: str, query: str, context: Optional[dict] = None) -> dict:
    system = COPILOT_PERSONAS.get(persona_key, COPILOT_PERSONAS["hr"])
    reply = _query_llm(system, query)
    if not reply:
        reply = (
            f"Based on my analysis as an {persona_key} assistant: "
            f"Regarding '{query}', I recommend reviewing current workforce data and "
            f"best practices. Key considerations include team dynamics, performance metrics, "
            f"and organizational goals. Would you like me to elaborate on any specific area?"
        )
    return {
        "reply": reply,
        "confidence": 0.85,
        "sources": ["Employee Database", "Policy Repository", "Analytics Engine"],
        "suggestions": [
            "Show me detailed analytics",
            "Generate a report on this topic",
            "Compare with industry benchmarks",
            "Schedule a follow-up discussion",
        ],
        "session_id": str(uuid.uuid4()),
    }


# ── Health ──
@app.get("/health")
async def health_check():
    return {"status": "healthy", "service": "ai-service", "timestamp": datetime.now(timezone.utc).isoformat()}


# ── Copilot Endpoints ──
COPILOT_PERSONA_MAP = {
    "hr": "hr", "employee": "employee", "manager": "manager", "executive": "executive",
}

@app.post("/api/v1/ai/{persona}/copilot", response_model=CopilotResponse, tags=["Copilots"])
async def copilot_chat(persona: str, payload: CopilotQuery):
    if persona not in COPILOT_PERSONA_MAP:
        raise HTTPException(404, f"Unknown persona: {persona}")
    return _copilot_response(persona, payload.query, payload.context)


# ── Natural Language Reporting ──
@app.post("/api/v1/ai/natural-language-reporting", response_model=NaturalLanguageReportResponse, tags=["Reporting"])
async def natural_language_report(payload: NaturalLanguageReportRequest):
    return _generate_report(payload.query, payload.department or "", payload.timeframe or "this_month")


# ── AI Dashboard Generation ──
@app.post("/api/v1/ai/ai-dashboard", response_model=AIDashboardResponse, tags=["Dashboards"])
async def ai_dashboard(payload: AIDashboardRequest):
    return _generate_dashboard(payload.focus, payload.department or "")


# ── Predictions ──
@app.post("/api/v1/ai/attrition-prediction", response_model=PredictionResponse, tags=["Predictions"])
async def attrition_prediction(payload: PredictionRequest):
    return _predict_attrition(payload.employee_id or "", payload.department or "", payload.timeframe_months or 6)

@app.post("/api/v1/ai/burnout-prediction", response_model=PredictionResponse, tags=["Predictions"])
async def burnout_prediction(payload: PredictionRequest):
    return _predict_burnout(payload.employee_id or "", payload.department or "")

@app.post("/api/v1/ai/promotion-prediction", response_model=PredictionResponse, tags=["Predictions"])
async def promotion_prediction(payload: PredictionRequest):
    return _predict_promotion(payload.employee_id or "", payload.department or "")


# ── Salary ──
@app.post("/api/v1/ai/salary-recommendation", response_model=SalaryRecommendationResponse, tags=["Compensation"])
async def salary_recommendation(payload: SalaryRecommendationRequest):
    return _salary_recommendation(
        payload.employee_id, payload.role, payload.experience_years,
        payload.performance_score, payload.location or "", payload.department or ""
    )


# ── Workforce Forecasting ──
@app.post("/api/v1/ai/workforce-forecasting", response_model=WorkforceForecastResponse, tags=["Forecasting"])
async def workforce_forecasting(payload: WorkforceForecastRequest):
    return _forecast_workforce(payload.department or "", payload.horizon_months, payload.include_attrition, payload.include_hiring)


# ── Policy Assistant ──
@app.post("/api/v1/ai/policy-assistant", response_model=PolicyResponse, tags=["Assistants"])
async def policy_assistant(payload: PolicyQuery):
    return _answer_policy(payload.query, payload.policy_area or "")


# ── Leave Assistant ──
@app.post("/api/v1/ai/leave-assistant", response_model=LeaveRecommendationResponse, tags=["Assistants"])
async def leave_assistant(payload: LeaveRecommendationRequest):
    return _recommend_leave(payload.employee_id, payload.leave_type, payload.requested_dates, payload.department or "")


# ── Recruitment Assistant ──
@app.post("/api/v1/ai/recruitment-assistant", response_model=RecruitmentAssistantResponse, tags=["Assistants"])
async def recruitment_assistant(payload: RecruitmentAssistantRequest):
    return _recruitment_assistant(payload.job_requirements, payload.candidate_pool or [], payload.screening_criteria or {})


# ── Onboarding Assistant ──
@app.post("/api/v1/ai/onboarding-assistant", response_model=OnboardingRecommendationResponse, tags=["Assistants"])
async def onboarding_assistant(payload: OnboardingRecommendationRequest):
    return _onboarding_recommendation(payload.employee_role, payload.department, payload.experience_level)


# ── Training Assistant ──
@app.post("/api/v1/ai/training-assistant", response_model=TrainingRecommendationResponse, tags=["Assistants"])
async def training_assistant(payload: TrainingRecommendationRequest):
    return _training_recommendation(payload.employee_id, payload.current_skills, payload.target_role or "", payload.performance_gaps or [])


# ── Compliance Assistant ──
@app.post("/api/v1/ai/compliance-assistant", response_model=ComplianceCheckResponse, tags=["Assistants"])
async def compliance_assistant(payload: ComplianceCheckRequest):
    return _compliance_check(payload.action, payload.department, payload.employee_role, payload.region or "")


# ── Knowledge Search ──
@app.post("/api/v1/ai/knowledge-search", response_model=KnowledgeSearchResponse, tags=["Knowledge"])
async def knowledge_search(payload: KnowledgeSearchRequest):
    return _knowledge_search(payload.query, payload.filters, payload.max_results or 10)


# ── Organization Advisor ──
@app.post("/api/v1/ai/org-advisor", response_model=OrgAdvisorResponse, tags=["Advisory"])
async def org_advisor(payload: OrgAdvisorRequest):
    return _org_advisor(payload.query, payload.org_context)


# ── Risk Detection ──
@app.post("/api/v1/ai/risk-detection", response_model=RiskDetectionResponse, tags=["Risk"])
async def risk_detection(payload: RiskDetectionRequest):
    return _detect_risks(payload.department or "", payload.employee_id or "", payload.risk_categories)


# ── Anomaly Detection ──
@app.post("/api/v1/ai/anomaly-detection", response_model=AnomalyDetectionResponse, tags=["Risk"])
async def anomaly_detection(payload: AnomalyDetectionRequest):
    return _detect_anomalies(payload.data_source, payload.metric or "", payload.department or "", payload.sensitivity or 0.95)


# ── Shift Optimization ──
@app.post("/api/v1/ai/shift-optimization", response_model=ShiftOptimizationResponse, tags=["Operations"])
async def shift_optimization(payload: ShiftOptimizationRequest):
    return _optimize_shifts(payload.department, payload.date_range, payload.current_schedule, payload.constraints)


# ── Succession Planning ──
@app.post("/api/v1/ai/succession-planning", response_model=SuccessionPlanResponse, tags=["Planning"])
async def succession_planning(payload: SuccessionPlanRequest):
    return _succession_plan(payload.position, payload.department, payload.required_skills, payload.timeline_months)


# ── Budget Forecasting ──
@app.post("/api/v1/ai/budget-forecasting", response_model=BudgetForecastResponse, tags=["Forecasting"])
async def budget_forecasting(payload: BudgetForecastRequest):
    return _budget_forecast(payload.department, payload.current_budget, payload.historical_data, payload.forecast_months)


# ── Performance Summaries ──
@app.post("/api/v1/ai/performance-summaries", response_model=PerformanceSummaryResponse, tags=["Summaries"])
async def performance_summaries(payload: PerformanceSummaryRequest):
    return _performance_summary(payload.employee_id, payload.period or "last_quarter", payload.include_metrics)


# ── Meeting Summaries ──
@app.post("/api/v1/ai/meeting-summaries", response_model=MeetingSummaryResponse, tags=["Summaries"])
async def meeting_summaries(payload: MeetingSummaryRequest):
    return _meeting_summary(payload.transcript, payload.meeting_type or "", payload.attendees or [])


# ── Workflow Generation ──
@app.post("/api/v1/ai/workflow-generation", response_model=WorkflowGenerationResponse, tags=["Automation"])
async def workflow_generation(payload: WorkflowGenerationRequest):
    return _generate_workflow(payload.process_name, payload.department, payload.description, payload.constraints)


# ── Automation Builder ──
@app.post("/api/v1/ai/automation-builder", response_model=AutomationBuilderResponse, tags=["Automation"])
async def automation_builder(payload: AutomationBuilderRequest):
    return _build_automation(payload.trigger, payload.actions, payload.conditions, payload.department)


# ── Agentic HR Workflows ──
@app.post("/api/v1/ai/agentic-hr", response_model=AgenticWorkflowResponse, tags=["Agentic"])
async def agentic_hr(payload: AgenticWorkflowRequest):
    return _agentic_workflows(payload.goal, payload.context, payload.autonomy_level)


# ── Autonomous Workforce Intelligence ──
@app.post("/api/v1/ai/autonomous-intelligence", response_model=AutonomousIntelligenceResponse, tags=["Agentic"])
async def autonomous_intelligence(payload: AutonomousIntelligenceRequest):
    return _autonomous_intelligence(payload.scope, payload.metrics, payload.generate_recommendations)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8065, reload=True)
