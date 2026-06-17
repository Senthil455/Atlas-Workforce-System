import os
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from atlas_observability import (
    AtlasLoggingMiddleware, AtlasMetricsMiddleware, CorrelationIdMiddleware,
    SecurityHeadersMiddleware,
    configure_logging, get_logger, verify_internal_auth
)

from models import SessionStore
from schemas import (
    ChatRequest, ChatResponse, SessionHistory,
    AttritionRiskRequest, AttritionRiskResponse,
    PerformancePredictionRequest, PerformancePredictionResponse,
    RetentionDriversResponse,
    HiringDemandRequest, HiringDemandResponse,
    SkillGapRequest, SkillGapResponse,
    DepartmentGrowthResponse,
    ResumeScoreRequest, ResumeScoreResponse,
    ResumeAnalyzeRequest, ResumeAnalyzeResponse,
    SentimentAnalyzeRequest, SentimentAnalyzeResponse,
    SurveyRequest, SurveyAnalysisResponse,
    OrgHealthResponse,
    StrategicRecommendationRequest, StrategicRecommendationResponse,
)
from chat_handler import handle_chat_message
from predictive_models import (
    compute_attrition_risk, predict_performance, get_retention_drivers,
)
from resume_parser import score_resume, parse_resume
from sentiment_analyzer import analyze_sentiment, analyze_survey
from forecaster import (
    forecast_hiring_demand, analyze_skill_gaps, project_department_growth,
)
from ai_engine import generate_org_health, generate_strategic_recommendations

# ── Logging ──────────────────────────────────
logging.basicConfig(
    level=getattr(logging, os.environ.get("LOG_LEVEL", "INFO").upper(), logging.INFO),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

# ── App lifespan ─────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    ttl = int(os.environ.get("SESSION_TTL_MINUTES", "60"))
    SessionStore.set_ttl(ttl)
    logger.info("AI Copilot Service starting on port %s", os.environ.get("SERVICE_PORT", "8015"))
    yield
    expired = SessionStore.cleanup_expired()
    logger.info("AI Copilot Service shutdown — cleaned %d expired sessions", expired)


INTERNAL_JWT_SECRET = os.environ.get("INTERNAL_JWT_SECRET", "")

app = FastAPI(
    title="Atlas AI Copilot Service",
    description="Workforce Intelligence — AI Copilot, Predictive Analytics, "
                "Resume Screening, Sentiment Analysis, Forecasting, and Strategic Insights",
    version="1.0.0",
    lifespan=lifespan,
)

configure_logging("ai-copilot-service", level=logging.INFO)
logger = get_logger("ai-copilot-service")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
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


# ──────────────────────────────────────────────
#  Health check
# ──────────────────────────────────────────────

@app.get("/health", tags=["system"])
async def health_check():
    return {"status": "healthy", "service": "ai-copilot-service", "version": "1.0.0"}


# ══════════════════════════════════════════════
#  1. AI Copilot / Chat
# ══════════════════════════════════════════════

@app.post("/api/v1/copilot/chat", response_model=ChatResponse, tags=["Copilot"])
async def chat_endpoint(req: ChatRequest):
    ctx = req.context
    result = await handle_chat_message(
        message=req.message,
        session_id=req.session_id,
        employee_id=ctx.employee_id if ctx else None,
        department=ctx.department if ctx else None,
    )
    return ChatResponse(**result)


@app.get("/api/v1/copilot/sessions/{session_id}", response_model=SessionHistory, tags=["Copilot"])
async def get_session(session_id: str):
    session = SessionStore.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found or expired")
    return SessionHistory(
        session_id=session.session_id,
        messages=session.messages,
    )


@app.delete("/api/v1/copilot/sessions/{session_id}", tags=["Copilot"])
async def delete_session(session_id: str):
    deleted = SessionStore.delete(session_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Session not found")
    return {"status": "deleted", "session_id": session_id}


# ══════════════════════════════════════════════
#  2. Predictive Analytics
# ══════════════════════════════════════════════

@app.post("/api/v1/predict/attrition-risk", response_model=AttritionRiskResponse, tags=["Predictive Analytics"])
async def attrition_risk_endpoint(req: AttritionRiskRequest):
    predictions = [compute_attrition_risk(e.model_dump()) for e in req.employees]
    return AttritionRiskResponse(predictions=predictions)


@app.post("/api/v1/predict/performance", response_model=PerformancePredictionResponse, tags=["Predictive Analytics"])
async def performance_prediction_endpoint(req: PerformancePredictionRequest):
    result = predict_performance(req.historical_scores, req.months_ahead)
    return PerformancePredictionResponse(**result)


@app.get("/api/v1/predict/retention-drivers", response_model=RetentionDriversResponse, tags=["Predictive Analytics"])
async def retention_drivers_endpoint():
    drivers = get_retention_drivers()
    return RetentionDriversResponse(drivers=drivers)


# ══════════════════════════════════════════════
#  3. Workforce Forecasting
# ══════════════════════════════════════════════

@app.post("/api/v1/forecast/hiring-demand", response_model=HiringDemandResponse, tags=["Forecasting"])
async def hiring_demand_endpoint(req: HiringDemandRequest):
    forecast = forecast_hiring_demand(
        current_headcount=req.current_headcount,
        growth_rate=req.growth_rate,
        attrition_rate=req.attrition_rate,
        months=req.months,
        department_breakdown=req.department_breakdown,
    )
    return HiringDemandResponse(forecast=forecast)


@app.post("/api/v1/forecast/skill-gap", response_model=SkillGapResponse, tags=["Forecasting"])
async def skill_gap_endpoint(req: SkillGapRequest):
    result = analyze_skill_gaps(dict(req.current_skills), dict(req.target_skills))
    return SkillGapResponse(**result)


@app.get("/api/v1/forecast/department-growth", response_model=DepartmentGrowthResponse, tags=["Forecasting"])
async def department_growth_endpoint(months: int = 12):
    departments = project_department_growth(months)
    return DepartmentGrowthResponse(departments=departments)


# ══════════════════════════════════════════════
#  4. Resume Screening
# ══════════════════════════════════════════════

@app.post("/api/v1/resume/score", response_model=ResumeScoreResponse, tags=["Resume Screening"])
async def resume_score_endpoint(req: ResumeScoreRequest):
    result = score_resume(req.resume_text, req.job_description, req.job_requirements)
    return ResumeScoreResponse(**result)


@app.post("/api/v1/resume/analyze", response_model=ResumeAnalyzeResponse, tags=["Resume Screening"])
async def resume_analyze_endpoint(req: ResumeAnalyzeRequest):
    result = parse_resume(req.resume_text)
    return ResumeAnalyzeResponse(**result)


# ══════════════════════════════════════════════
#  5. Sentiment Analysis
# ══════════════════════════════════════════════

@app.post("/api/v1/sentiment/analyze", response_model=SentimentAnalyzeResponse, tags=["Sentiment Analysis"])
async def sentiment_analyze_endpoint(req: SentimentAnalyzeRequest):
    result = analyze_sentiment(req.text, req.context)
    return SentimentAnalyzeResponse(**result)


@app.post("/api/v1/sentiment/survey", response_model=SurveyAnalysisResponse, tags=["Sentiment Analysis"])
async def survey_endpoint(req: SurveyRequest):
    result = analyze_survey([r.model_dump() for r in req.responses])
    return SurveyAnalysisResponse(**result)


# ══════════════════════════════════════════════
#  6. Strategic Insights
# ══════════════════════════════════════════════

@app.get("/api/v1/insights/organizational-health", response_model=OrgHealthResponse, tags=["Insights"])
async def org_health_endpoint():
    result = generate_org_health()
    return OrgHealthResponse(**result)


@app.post("/api/v1/insights/strategic-recommendations", response_model=StrategicRecommendationResponse, tags=["Insights"])
async def strategic_recommendations_endpoint(req: StrategicRecommendationRequest):
    recs = generate_strategic_recommendations(req.context.model_dump())
    return StrategicRecommendationResponse(recommendations=recs)
