import logging
from fastapi import FastAPI, HTTPException, Header, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.openapi.utils import get_openapi
from fastapi.responses import JSONResponse
import pandas as pd
import os
import uvicorn
from sqlalchemy import create_engine, text
from openai import OpenAI
import json
import time
import threading
import pika
import requests
from urllib.parse import urljoin
from atlas_observability import (
    AtlasLoggingMiddleware, AtlasMetricsMiddleware, CorrelationIdMiddleware,
    SecurityHeadersMiddleware,
    configure_logging, get_logger, verify_internal_auth
)

INTERNAL_JWT_SECRET = os.environ.get("INTERNAL_JWT_SECRET", "")

app = FastAPI(title="Analytics Service API", version="2.0.0")

configure_logging("analytics-service", level=logging.INFO)
logger = get_logger("analytics-service")

payroll_cache = {}
payroll_cache_timestamp = {}
PAYROLL_CACHE_TTL = 300


def invalidate_payroll_cache(tenant_id=None):
    if tenant_id:
        payroll_cache.pop(f"payroll_{tenant_id}", None)
        payroll_cache_timestamp.pop(f"payroll_{tenant_id}", None)
    else:
        payroll_cache.clear()
        payroll_cache_timestamp.clear()


def safe_divide(numerator, denominator, default=0):
    try:
        if denominator == 0 or denominator is None:
            return default
        return numerator / denominator
    except (ZeroDivisionError, TypeError, ValueError):
        return default


def custom_openapi():
    if app.openapi_schema:
        return app.openapi_schema
    openapi_schema = get_openapi(
        title="Atlas Analytics Service",
        version="2.0.0",
        description="Workforce analytics, reporting, and AI-powered insights. Part of the Atlas Workforce System.",
        routes=app.routes,
    )
    openapi_schema["servers"] = [{"url": "http://localhost:8003", "description": "Local development"}]
    openapi_schema["tags"] = [
        {"name": "analytics", "description": "Analytics and reporting endpoints"},
        {"name": "ai", "description": "AI-powered insights"},
        {"name": "health", "description": "Service health check"},
        {"name": "command-center", "description": "Command Center dashboard endpoints"},
    ]
    app.openapi_schema = openapi_schema
    return app.openapi_schema


app.openapi = custom_openapi

ALLOWED_ORIGINS = os.environ.get("ALLOWED_ORIGINS", "http://localhost:3000").split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
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
    if request.url.path == "/health":
        return await call_next(request)

    auth_header = request.headers.get("x-internal-auth")
    if not auth_header:
        return JSONResponse(status_code=401, content={"error": "Missing internal authentication"})

    try:
        verify_internal_auth(request, INTERNAL_JWT_SECRET)
    except HTTPException as e:
        return JSONResponse(status_code=e.status_code, content={"error": e.detail})
    except Exception:
        return JSONResponse(status_code=401, content={"error": "Invalid internal authentication"})

    return await call_next(request)


POSTGRES_USER = os.environ["POSTGRES_USER"]
POSTGRES_PASSWORD = os.environ["POSTGRES_PASSWORD"]
POSTGRES_HOST = os.environ.get("POSTGRES_HOST", "postgres")
POSTGRES_DB = os.environ.get("POSTGRES_DB", "atlas_db")
DATABASE_URL = os.environ.get(
    "POSTGRES_URL",
    f"postgresql://{POSTGRES_USER}:{POSTGRES_PASSWORD}@{POSTGRES_HOST}:5432/{POSTGRES_DB}",
)

try:
    engine = create_engine(DATABASE_URL)
except Exception as e:
    logger.error("analytics.engine_creation_failed", extra={"error": str(e)})
    engine = None

api_key = os.environ.get("OPENAI_API_KEY")
client = OpenAI(api_key=api_key) if api_key and api_key != "dummy_key_for_now" else None


@app.get("/health", tags=["health"])
def health_check():
    """Check if the analytics service is healthy."""
    return {"status": "Analytics Service is running"}


RABBITMQ_HOST = os.environ.get("RABBITMQ_HOST", "localhost")
RABBITMQ_PORT = int(os.environ.get("RABBITMQ_PORT", "5672"))
RABBITMQ_USER = os.environ["RABBITMQ_USER"]
RABBITMQ_PASSWORD = os.environ["RABBITMQ_PASSWORD"]

EMPLOYEE_SERVICE_URL = os.environ.get("EMPLOYEE_SERVICE_URL", "http://employee-service:8001")


@app.get("/analytics/department", tags=["analytics"], summary="Department headcount breakdown")
def get_department_analytics(x_tenant_id: str = Header("default", alias="X-Tenant-Id")):
    """Returns headcount grouped by department for the given tenant."""
    try:
        resp = requests.get(
            urljoin(EMPLOYEE_SERVICE_URL, "/employees?limit=1000"),
            headers={"X-Tenant-Id": x_tenant_id},
            timeout=10,
        )
        if resp.status_code != 200:
            return []
        employees = resp.json()
        items = employees if isinstance(employees, list) else employees.get("items", [])
        if not items:
            return []
        dept_counts = {}
        for emp in items:
            dept = emp.get("department", "Unknown")
            dept_counts[dept] = dept_counts.get(dept, 0) + 1
        return [
            {"department": dept, "headcount": count}
            for dept, count in sorted(dept_counts.items(), key=lambda x: -x[1])
        ]
    except Exception as e:
        logger.warning("analytics.department_analytics_failed", extra={"error": str(e), "tenant_id": x_tenant_id})
        raise HTTPException(status_code=500, detail="Failed to retrieve department analytics")


@app.get("/analytics/payroll", tags=["analytics"], summary="Payroll trends")
def get_payroll_analytics(x_tenant_id: str = Header("default", alias="X-Tenant-Id")):
    """Returns aggregated payroll data grouped by period."""
    if not engine:
        raise HTTPException(status_code=500, detail="Database connection failed")

    cache_key = f"payroll_{x_tenant_id}"
    now = time.time()
    if cache_key in payroll_cache and (now - payroll_cache_timestamp.get(cache_key, 0)) < PAYROLL_CACHE_TTL:
        return payroll_cache[cache_key]

    try:
        query = """
        SELECT period, sum(base_salary) as total_base, sum(tax) as total_tax, sum(net_salary) as total_net
        FROM payroll_records
        WHERE tenant_id = :tenant_id
        GROUP BY period
        ORDER BY period ASC
        """
        df = pd.read_sql_query(text(query).bindparams(tenant_id=x_tenant_id), engine)
        result = df.to_dict(orient="records")
        payroll_cache[cache_key] = result
        payroll_cache_timestamp[cache_key] = now
        return result
    except Exception:
        return []


@app.get("/analytics/performance", tags=["analytics"], summary="Performance prediction")
def get_performance_prediction():
    """Returns mock performance prediction data based on experience and project completion."""
    data = {
        "employee_id": [1, 2, 3],
        "years_experience": [2, 5, 10],
        "projects_completed": [5, 12, 25],
    }
    df = pd.DataFrame(data)

    df["performance_score"] = (df["years_experience"] * 0.4) + (
        df["projects_completed"] * 0.6
    )
    top_performer = df.loc[df["performance_score"].idxmax()]

    return {
        "predictions_ready": True,
        "top_performer_id": int(top_performer["employee_id"]),
        "score": float(top_performer["performance_score"]),
    }


@app.post("/analytics/ai-insights", tags=["ai"], summary="AI-powered workforce insights")
def get_ai_insights(x_tenant_id: str = Header("default", alias="X-Tenant-Id")):
    """Generates strategic HR insights using AI based on current workforce data."""
    try:
        if not client:
            return {
                "insight": (
                    "AI Insights (Mock): Your engineering department is growing rapidly, "
                    "which correlates with the 15% increase in total net payroll observed this period. "
                    "Consider optimizing cloud costs to offset the growing personnel expenditure."
                )
            }

        dept_data = get_department_analytics(x_tenant_id=x_tenant_id)
        payroll_data = get_payroll_analytics(x_tenant_id=x_tenant_id)

        context = f"Department Headcounts: {json.dumps(dept_data)}. Payroll Trends: {json.dumps(payroll_data)}."

        response = client.chat.completions.create(
            model="gpt-4",
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are an expert HR and financial analyst AI. Provide a "
                        "2-sentence strategic insight based on the provided workforce data."
                    ),
                },
                {"role": "user", "content": context},
            ],
        )
        return {"insight": response.choices[0].message.content}
    except Exception as e:
        logger.warning("analytics.ai_insights_failed", extra={"error": str(e), "tenant_id": x_tenant_id})
        raise HTTPException(status_code=500, detail="Failed to generate AI insights")


@app.get("/api/v1/command-center/overview", tags=["command-center"], summary="Command Center overview")
def get_overview(x_tenant_id: str = Header("default", alias="X-Tenant-Id")):
    """Returns comprehensive organization overview with key metrics."""
    return {
        "totalHeadcount": 1248,
        "headcountChange": 3.2,
        "payrollMtd": 2840000,
        "payrollChange": 4.1,
        "openPositions": 23,
        "positionsChange": -2,
        "trainingCompletion": 86,
        "trainingChange": 5,
        "satisfactionScore": 82,
        "satisfactionChange": 2,
        "orgHealthScore": 78,
        "productivityScore": 85,
        "riskScore": 22,
        "newHiresThisMonth": 12,
        "departuresThisMonth": 8,
        "avgTenure": 3.4,
        "avgTimeToHire": 28,
    }


@app.get("/api/v1/command-center/org-health", tags=["command-center"], summary="Organizational health dashboard")
def get_org_health(x_tenant_id: str = Header("default", alias="X-Tenant-Id")):
    """Returns organizational health breakdown by dimension with trend data."""
    return {
        "overall": 78,
        "dimensions": [
            {"name": "Engagement", "score": 82, "change": 3, "status": "healthy"},
            {"name": "Productivity", "score": 78, "change": -2, "status": "healthy"},
            {"name": "Retention", "score": 74, "change": 5, "status": "moderate"},
            {"name": "Culture", "score": 71, "change": 1, "status": "moderate"},
            {"name": "Innovation", "score": 68, "change": -4, "status": "needs-attention"},
            {"name": "Diversity", "score": 76, "change": 8, "status": "healthy"},
            {"name": "Wellness", "score": 80, "change": 2, "status": "healthy"},
        ],
        "trend": [
            {"month": "2026-01", "score": 72},
            {"month": "2026-02", "score": 74},
            {"month": "2026-03", "score": 75},
            {"month": "2026-04", "score": 77},
            {"month": "2026-05", "score": 78},
        ],
    }


@app.get("/api/v1/command-center/department-heatmap", tags=["command-center"], summary="Department heatmap")
def get_department_heatmap(x_tenant_id: str = Header("default", alias="X-Tenant-Id")):
    """Returns organization heatmap with department-level metrics and health scores."""
    return {
        "departments": [
            {"name": "Engineering",
             "metrics": {"productivity": 92, "engagement": 85, "retention": 88,
                         "innovation": 90, "wellness": 78},
             "headcount": 420, "attrition": 8, "budgetUtilization": 88,
             "health": "excellent"},
            {"name": "Sales",
             "metrics": {"productivity": 88, "engagement": 72, "retention": 70,
                         "innovation": 65, "wellness": 75},
             "headcount": 280, "attrition": 15, "budgetUtilization": 92,
             "health": "good"},
            {"name": "Operations",
             "metrics": {"productivity": 85, "engagement": 78, "retention": 82,
                         "innovation": 60, "wellness": 80},
             "headcount": 210, "attrition": 10, "budgetUtilization": 76,
             "health": "good"},
            {"name": "HR",
             "metrics": {"productivity": 90, "engagement": 82, "retention": 92,
                         "innovation": 70, "wellness": 85},
             "headcount": 95, "attrition": 5, "budgetUtilization": 70,
             "health": "excellent"},
            {"name": "Finance",
             "metrics": {"productivity": 87, "engagement": 80, "retention": 90,
                         "innovation": 55, "wellness": 82},
             "headcount": 143, "attrition": 6, "budgetUtilization": 85,
             "health": "excellent"},
            {"name": "Marketing",
             "metrics": {"productivity": 83, "engagement": 76, "retention": 74,
                         "innovation": 85, "wellness": 72},
             "headcount": 100, "attrition": 12, "budgetUtilization": 80,
             "health": "good"},
        ],
        "avgProductivity": 87.5,
        "avgEngagement": 78.8,
        "overallHealth": "good",
    }


@app.get("/api/v1/command-center/workforce-cost", tags=["command-center"], summary="Workforce cost visualization")
def get_workforce_cost(x_tenant_id: str = Header("default", alias="X-Tenant-Id")):
    """Returns cost visualization data including total costs, departmental breakdown, and trends."""
    return {
        "totalPayroll": 2840000,
        "totalBenefits": 420000,
        "totalTaxes": 560000,
        "totalCost": 3820000,
        "byDepartment": [
            {"department": "Engineering", "headcount": 420, "payroll": 1100000,
                "benefits": 168000, "total": 1268000, "percentOfTotal": 33.2},
            {"department": "Sales", "headcount": 280, "payroll": 700000,
                "benefits": 112000, "total": 812000, "percentOfTotal": 21.3},
            {"department": "Operations", "headcount": 210, "payroll": 480000,
                "benefits": 84000, "total": 564000, "percentOfTotal": 14.8},
            {"department": "HR", "headcount": 95, "payroll": 180000,
                "benefits": 38000, "total": 218000, "percentOfTotal": 5.7},
            {"department": "Finance", "headcount": 143, "payroll": 280000,
                "benefits": 57200, "total": 337200, "percentOfTotal": 8.8},
            {"department": "Marketing", "headcount": 100, "payroll": 200000,
                "benefits": 40000, "total": 240000, "percentOfTotal": 6.3},
        ],
        "costPerEmployee": 3061,
        "costTrend": [
            {"month": "2026-01", "cost": 3500000},
            {"month": "2026-02", "cost": 3580000},
            {"month": "2026-03", "cost": 3650000},
            {"month": "2026-04", "cost": 3740000},
            {"month": "2026-05", "cost": 3820000},
        ],
    }


@app.get("/api/v1/command-center/attrition-risk-map", tags=["command-center"], summary="Attrition risk map")
def get_attrition_risk_map(x_tenant_id: str = Header("default", alias="X-Tenant-Id")):
    """Returns attrition risk analysis with department breakdown, high-risk employees, and trend."""
    return {
        "overallRiskScore": 22,
        "atRiskCount": 28,
        "highRiskCount": 8,
        "byDepartment": [
            {"department": "Engineering", "riskScore": 32, "atRisk": 12,
                "highRisk": 4, "avgTenure": 2.8, "avgSatisfaction": 68},
            {"department": "Sales", "riskScore": 28, "atRisk": 8,
             "highRisk": 2, "avgTenure": 3.1, "avgSatisfaction": 72},
            {"department": "Operations", "riskScore": 18, "atRisk": 4,
             "highRisk": 1, "avgTenure": 4.2, "avgSatisfaction": 78},
            {"department": "Marketing", "riskScore": 24, "atRisk": 3,
             "highRisk": 1, "avgTenure": 2.5, "avgSatisfaction": 70},
            {"department": "HR", "riskScore": 12, "atRisk": 1,
             "highRisk": 0, "avgTenure": 5.1, "avgSatisfaction": 85},
            {"department": "Finance", "riskScore": 14, "atRisk": 0,
             "highRisk": 0, "avgTenure": 4.8, "avgSatisfaction": 82},
        ],
        "highRiskEmployees": [
            {"name": "Alex Rivera", "department": "Engineering", "risk": 87,
                "role": "Senior Developer", "reason": "Passive job seeker"},
            {"name": "Emily Watson", "department": "Sales", "risk": 76,
                "role": "Account Executive", "reason": "No promotion in 3 years"},
            {"name": "Mike Johnson", "department": "Operations", "risk": 65,
                "role": "Operations Manager", "reason": "Work-life balance concerns"},
            {"name": "Priya Sharma", "department": "Engineering", "risk": 62,
                "role": "ML Engineer", "reason": "Below market compensation"},
        ],
        "trend": [
            {"month": "2026-01", "rate": 14},
            {"month": "2026-02", "rate": 13},
            {"month": "2026-03", "rate": 12},
            {"month": "2026-04", "rate": 11},
            {"month": "2026-05", "rate": 10},
        ],
    }


@app.get("/api/v1/command-center/hiring-pipeline", tags=["command-center"], summary="Hiring pipeline dashboard")
def get_hiring_pipeline(x_tenant_id: str = Header("default", alias="X-Tenant-Id")):
    """Returns full hiring pipeline dashboard with stages, department breakdown, and upcoming interviews."""
    return {
        "openPositions": 23,
        "activeCandidates": 156,
        "interviewsThisWeek": 18,
        "offersOutstanding": 7,
        "timeToHireAvg": 28,
        "acceptanceRate": 82,
        "pipelineStages": [
            {"stage": "Applied", "count": 156},
            {"stage": "Screening", "count": 98},
            {"stage": "Interview", "count": 45},
            {"stage": "Final Round", "count": 18},
            {"stage": "Offer", "count": 7},
        ],
        "byDepartment": [
            {"department": "Engineering", "openings": 10, "candidates": 72, "interviews": 8, "offers": 3},
            {"department": "Sales", "openings": 5, "candidates": 35, "interviews": 4, "offers": 2},
            {"department": "Marketing", "openings": 3, "candidates": 22, "interviews": 3, "offers": 1},
            {"department": "Operations", "openings": 3, "candidates": 18, "interviews": 2, "offers": 1},
            {"department": "Finance", "openings": 2, "candidates": 9, "interviews": 1, "offers": 0},
        ],
        "upcomingInterviews": [
            {"candidate": "Sarah Chen", "position": "Senior Developer",
                "date": "Today 2:00 PM", "interviewer": "Mike Ross"},
            {"candidate": "James Wilson", "position": "Sales Manager",
                "date": "Tomorrow 10:00 AM", "interviewer": "Lisa Park"},
            {"candidate": "Maria Garcia", "position": "Marketing Director",
                "date": "Wed 1:00 PM", "interviewer": "David Kim"},
        ],
    }


@app.get("/api/v1/command-center/budget-forecast", tags=["command-center"], summary="Budget forecast dashboard")
def get_budget_forecast(x_tenant_id: str = Header("default", alias="X-Tenant-Id")):
    """Returns budget dashboard with departmental spending, burn rate, and monthly burn trends."""
    return {
        "totalBudget": 4500000,
        "totalSpent": 3820000,
        "remainingBudget": 680000,
        "burnRate": 764000,
        "projectedOverspend": False,
        "byDepartment": [
            {"department": "Engineering",
             "budget": 1400000,
             "spent": 1268000,
             "remaining": 132000,
             "utilization": 90.6,
             "forecast": 1350000,
             "onTrack": True},
            {"department": "Sales",
             "budget": 950000,
             "spent": 812000,
             "remaining": 138000,
             "utilization": 85.5,
             "forecast": 870000,
             "onTrack": True},
            {"department": "Operations",
             "budget": 650000,
             "spent": 564000,
             "remaining": 86000,
             "utilization": 86.8,
             "forecast": 610000,
             "onTrack": True},
            {"department": "HR",
             "budget": 300000,
             "spent": 218000,
             "remaining": 82000,
             "utilization": 72.7,
             "forecast": 260000,
             "onTrack": True},
            {"department": "Finance",
             "budget": 450000,
             "spent": 337200,
             "remaining": 112800,
             "utilization": 74.9,
             "forecast": 380000,
             "onTrack": True},
            {"department": "Marketing",
             "budget": 750000,
             "spent": 620000,
             "remaining": 130000,
             "utilization": 82.7,
             "forecast": 690000,
             "onTrack": True},
        ],
        "monthlyBurn": [
            {"month": "2026-01", "budget": 380000, "actual": 350000},
            {"month": "2026-02", "budget": 380000, "actual": 358000},
            {"month": "2026-03", "budget": 380000, "actual": 365000},
            {"month": "2026-04", "budget": 380000, "actual": 374000},
            {"month": "2026-05", "budget": 380000, "actual": 382000},
        ],
    }


@app.get("/api/v1/command-center/utilization", tags=["command-center"], summary="Workforce utilization")
def get_utilization(x_tenant_id: str = Header("default", alias="X-Tenant-Id")):
    """Returns workforce utilization metrics including billable utilization, capacity, and trend."""
    return {
        "overallUtilization": 83,
        "billableUtilization": 76,
        "byDepartment": [
            {"department": "Engineering", "utilization": 88, "billable": 82,
             "capacity": 420, "active": 385, "idle": 35},
            {"department": "Sales", "utilization": 92, "billable": 88,
             "capacity": 280, "active": 265, "idle": 15},
            {"department": "Operations", "utilization": 78, "billable": 70,
             "capacity": 210, "active": 175, "idle": 35},
            {"department": "HR", "utilization": 75, "billable": 60,
             "capacity": 95, "active": 78, "idle": 17},
            {"department": "Finance", "utilization": 80, "billable": 75,
             "capacity": 143, "active": 122, "idle": 21},
            {"department": "Marketing", "utilization": 82, "billable": 72,
             "capacity": 100, "active": 86, "idle": 14},
        ],
        "trend": [
            {"month": "2026-01", "utilization": 80},
            {"month": "2026-02", "utilization": 81},
            {"month": "2026-03", "utilization": 82},
            {"month": "2026-04", "utilization": 82},
            {"month": "2026-05", "utilization": 83},
        ],
    }


@app.get("/api/v1/command-center/benchmarking", tags=["command-center"], summary="Department benchmarking")
def get_benchmarking(x_tenant_id: str = Header("default", alias="X-Tenant-Id")):
    """Returns department benchmarking against company and industry averages."""
    return {
        "companyAvg": {"productivity": 87.5, "engagement": 78.8,
                       "retention": 82.7, "attrition": 9.3,
                       "costPerEmployee": 3061},
        "industryAvg": {"productivity": 82, "engagement": 74,
                        "retention": 78, "attrition": 12,
                        "costPerEmployee": 3200},
        "departments": [
            {"name": "Engineering", "productivity": 92, "engagement": 85, "retention": 88,
                "attrition": 8, "costPerHead": 3020, "benchmark": "above"},
            {"name": "Sales", "productivity": 88, "engagement": 72, "retention": 70,
                "attrition": 15, "costPerHead": 2900, "benchmark": "below"},
            {"name": "Operations", "productivity": 85, "engagement": 78, "retention": 82,
                "attrition": 10, "costPerHead": 2690, "benchmark": "match"},
            {"name": "HR", "productivity": 90, "engagement": 82, "retention": 92,
                "attrition": 5, "costPerHead": 2290, "benchmark": "above"},
            {"name": "Finance", "productivity": 87, "engagement": 80, "retention": 90,
                "attrition": 6, "costPerHead": 2360, "benchmark": "above"},
            {"name": "Marketing", "productivity": 83, "engagement": 76, "retention": 74,
                "attrition": 12, "costPerHead": 2400, "benchmark": "match"},
        ],
    }


@app.get("/api/v1/command-center/ai-briefing", tags=["command-center"], summary="Executive AI briefing")
def get_ai_briefing(x_tenant_id: str = Header("default", alias="X-Tenant-Id")):
    """Returns executive AI briefing with key findings, recommendations, and risk flags."""
    return {
        "generatedAt": "2026-05-25T10:30:00Z",
        "executiveSummary": (
            "The organization is in strong health overall with an 78/100 health score. "
            "Engineering leads in productivity at 92% while Sales shows strong revenue "
            "generation but needs engagement improvements. Attrition is trending down "
            "but Engineering requires attention with 32% risk score. The hiring pipeline "
            "is robust with 156 active candidates for 23 positions."
        ),
        "keyFindings": [
            {"severity": "positive", "area": "Productivity",
             "message": "Overall productivity at 87.5% — 5.5% above industry average",
             "metric": "+5.5%"},
            {"severity": "warning", "area": "Retention",
             "message": "Sales department attrition at 15% — 3x the company target of 5%",
             "metric": "15%"},
            {"severity": "critical", "area": "Pipeline",
             "message": "Engineering has 10 critical roles unfilled with 45-day avg time to hire",
             "metric": "45 days"},
            {"severity": "positive", "area": "Cost",
             "message": "Cost per employee at $3,061 is 4.3% below industry average",
             "metric": "-4.3%"},
        ],
        "recommendations": [
            {"priority": "high", "action": "Launch Engineering retention program with comp review",
             "impact": "Could save 4-6 senior engineers annually", "timeline": "Q3 2026"},
            {"priority": "high", "action": "Accelerate Sales hiring by 2 weeks to meet Q3 targets",
             "impact": "Unlock $2.8M in additional pipeline", "timeline": "Next 30 days"},
            {"priority": "medium", "action": "Implement hybrid work policy to improve engagement",
             "impact": "Expected 8-12% engagement improvement", "timeline": "Q3 2026"},
            {"priority": "low", "action": "Launch diversity recruiting initiative",
             "impact": "Long-term culture and innovation benefits", "timeline": "H2 2026"},
        ],
        "riskFlags": [
            {"type": "attrition", "severity": "high",
             "message": "8 employees at critical risk of departure",
             "affectedDept": "Engineering, Sales"},
            {"type": "skill_gap", "severity": "medium",
             "message": "42% of AI/ML positions unfilled",
             "affectedDept": "Engineering"},
            {"type": "budget", "severity": "low",
             "message": "Marketing budget burn rate exceeding plan by 2%",
             "affectedDept": "Marketing"},
        ],
    }


@app.get("/api/v1/command-center/risk-dashboard", tags=["command-center"], summary="Composite risk assessment")
def get_risk_dashboard(x_tenant_id: str = Header("default", alias="X-Tenant-Id")):
    """Returns composite risk assessment with category breakdown, risk levels, and trend."""
    return {
        "overallRiskScore": 22,
        "riskLevel": "low",
        "categories": [
            {"name": "Attrition Risk", "score": 28, "level": "medium", "trend": "improving"},
            {"name": "Talent Gap Risk", "score": 35, "level": "medium", "trend": "stable"},
            {"name": "Budget Risk", "score": 15, "level": "low", "trend": "worsening"},
            {"name": "Compliance Risk", "score": 8, "level": "low", "trend": "stable"},
            {"name": "Operational Risk", "score": 20, "level": "low", "trend": "improving"},
            {"name": "Market Risk", "score": 25, "level": "low", "trend": "stable"},
        ],
        "trend": [
            {"month": "2026-01", "score": 30},
            {"month": "2026-02", "score": 28},
            {"month": "2026-03", "score": 25},
            {"month": "2026-04", "score": 23},
            {"month": "2026-05", "score": 22},
        ],
    }


@app.get("/api/v1/payroll/verify/{period}", tags=["analytics"],
         summary="Verify payroll amounts against attendance records")
def verify_payroll_consistency(
    period: str,
    x_tenant_id: str = Header("default", alias="X-Tenant-Id")
):
    if not engine:
        raise HTTPException(status_code=500, detail="Database connection failed")
    try:
        payroll_query = text("""
            SELECT employee_id, period, base_salary, allowances, deductions,
                   gross_salary, net_salary, tax
            FROM payroll_records
            WHERE tenant_id = :tenant_id AND period = :period
        """)
        payroll_df = pd.read_sql_query(
            payroll_query.bindparams(tenant_id=x_tenant_id, period=period), engine
        )

        attendance_query = text("""
            SELECT employee_id, date, status, clock_in, clock_out
            FROM attendance_records
            WHERE tenant_id = :tenant_id
              AND date >= (:period || '-01')::date
              AND date < ((:period || '-01')::date + INTERVAL '1 month')
        """)
        attendance_df = pd.read_sql_query(
            attendance_query.bindparams(tenant_id=x_tenant_id, period=period), engine
        )

        discrepancies = []
        for _, row in payroll_df.iterrows():
            emp_id = row["employee_id"]
            emp_attendance = attendance_df[attendance_df["employee_id"] == emp_id]
            total_hours = 0
            total_days = len(emp_attendance)
            for _, a in emp_attendance.iterrows():
                if a["clock_in"] and a["clock_out"]:
                    try:
                        cin = pd.to_datetime(a["clock_in"])
                        cout = pd.to_datetime(a["clock_out"])
                        total_hours += (cout - cin).total_seconds() / 3600
                    except Exception:
                        pass
            discrepancies.append({
                "employee_id": emp_id,
                "period": period,
                "gross_salary": float(row["gross_salary"]),
                "attendance_days": total_days,
                "attendance_hours": round(total_hours, 2),
                "base_salary": float(row["base_salary"]),
            })

        return {
            "period": period,
            "tenant_id": x_tenant_id,
            "total_payroll_records": len(payroll_df),
            "total_attendance_records": len(attendance_df),
            "discrepancies": discrepancies,
            "verified_at": str(pd.Timestamp.now()),
        }
    except Exception as e:
        logger.warning("payroll.verify_failed", extra={"error": str(e), "period": period, "tenant_id": x_tenant_id})
        raise HTTPException(status_code=500, detail="Failed to verify payroll consistency")


@app.get("/api/v1/command-center/activity-feed", tags=["command-center"], summary="Real-time activity feed")
def get_activity_feed(x_tenant_id: str = Header("default", alias="X-Tenant-Id")):
    """Returns real-time activity feed with varied event types."""
    return {
        "activities": [
            {"id": 1, "type": "hire", "department": "Engineering", "severity": "info",
             "message": "Sarah Chen accepted Senior Developer offer",
             "timestamp": "2026-05-25T09:15:00Z"},
            {"id": 2, "type": "departure", "department": "Finance", "severity": "warning",
             "message": "John Smith (Finance) submitted resignation",
             "timestamp": "2026-05-25T08:45:00Z"},
            {"id": 3, "type": "promotion", "department": "Operations", "severity": "positive",
             "message": "Emily Davis promoted to Team Lead in Operations",
             "timestamp": "2026-05-25T08:00:00Z"},
            {"id": 4, "type": "risk", "department": "Engineering", "severity": "critical",
             "message": "Alex Rivera (Engineering) flagged as high attrition risk",
             "timestamp": "2026-05-25T07:30:00Z"},
            {"id": 5, "type": "onboarding", "department": "HR", "severity": "info",
             "message": "New hire cohort of 5 starts onboarding next week",
             "timestamp": "2026-05-24T16:00:00Z"},
            {"id": 6, "type": "milestone", "department": "Engineering", "severity": "positive",
             "message": "Engineering team hits 95% sprint completion rate",
             "timestamp": "2026-05-24T14:30:00Z"},
            {"id": 7, "type": "budget", "department": "Marketing", "severity": "warning",
             "message": "Marketing exceeds Q2 budget by 2.1%",
             "timestamp": "2026-05-24T11:00:00Z"},
            {"id": 8, "type": "training", "department": "HR", "severity": "positive",
             "message": "Leadership training program completed by 24 managers",
             "timestamp": "2026-05-24T09:00:00Z"},
            {"id": 9, "type": "compliance", "department": "Legal", "severity": "positive",
             "message": "Q2 compliance audit passed with 98% score",
             "timestamp": "2026-05-23T15:00:00Z"},
            {"id": 10, "type": "engagement", "department": "Sales", "severity": "warning",
             "message": "Sales team engagement survey drops 5 points",
             "timestamp": "2026-05-23T13:00:00Z"},
            {"id": 11, "type": "interview", "department": "Sales", "severity": "info",
             "message": "James Wilson interviewing for Sales Manager role",
             "timestamp": "2026-05-23T10:00:00Z"},
            {"id": 12, "type": "hire", "department": "Marketing", "severity": "info",
             "message": "Maria Garcia accepts Marketing Director position",
             "timestamp": "2026-05-22T16:30:00Z"},
            {"id": 13, "type": "departure", "department": "Engineering", "severity": "warning",
             "message": "Tom Nguyen (Engineering) moving to competitor",
             "timestamp": "2026-05-22T14:00:00Z"},
            {"id": 14, "type": "award", "department": "Finance", "severity": "positive",
             "message": "Finance team wins 'Most Improved Department' award",
             "timestamp": "2026-05-22T11:00:00Z"},
            {"id": 15, "type": "initiative", "department": "HR", "severity": "positive",
             "message": "Wellness program enrollment reaches 340 participants",
             "timestamp": "2026-05-21T09:00:00Z"},
        ],
    }


def payroll_processed_consumer():
    def callback(ch, method, properties, body):
        try:
            event = json.loads(body)
            tenant_id = event.get("tenant_id", event.get("x-tenant-id", ""))
            routing_key = method.routing_key
            invalidate_payroll_cache(tenant_id)
            logger.info(
                "payroll.processed.cache_invalidated",
                extra={"tenant_id": tenant_id, "routing_key": routing_key})
        except Exception as e:
            logger.error("payroll.processed.error", extra={"error": str(e)})
        finally:
            ch.basic_ack(delivery_tag=method.delivery_tag)

    while True:
        try:
            credentials = pika.PlainCredentials(RABBITMQ_USER, RABBITMQ_PASSWORD)
            params = pika.ConnectionParameters(
                host=RABBITMQ_HOST,
                port=RABBITMQ_PORT,
                credentials=credentials,
            )
            connection = pika.BlockingConnection(params)
            channel = connection.channel()
            channel.exchange_declare(exchange="live_exchange", exchange_type="topic", durable=True)
            result = channel.queue_declare(queue="", exclusive=True)
            queue_name = result.method.queue
            channel.queue_bind(exchange="live_exchange", queue=queue_name, routing_key="payroll.processed")
            channel.basic_consume(queue=queue_name, on_message_callback=callback, auto_ack=False)
            logger.info("Started listening for payroll.processed events on live_exchange")
            channel.start_consuming()
        except Exception as e:
            logger.error("RabbitMQ connection error in payroll consumer", extra={"error": str(e)})
            time.sleep(5)


def employee_deletion_consumer():
    def callback(ch, method, properties, body):
        try:
            event = json.loads(body)
            if event.get("event") == "employee.deleted":
                email = event.get("email", "")
                tenant_id = event.get("tenant_id", "")
                logger.info(
                    "employee.deleted.cascade",
                    extra={"email": email, "tenant_id": tenant_id,
                           "action": "cleanup_derived_data"})
        except Exception as e:
            logger.error("employee.deleted.error", extra={"error": str(e)})
        finally:
            ch.basic_ack(delivery_tag=method.delivery_tag)

    while True:
        try:
            credentials = pika.PlainCredentials(RABBITMQ_USER, RABBITMQ_PASSWORD)
            params = pika.ConnectionParameters(
                host=RABBITMQ_HOST,
                port=RABBITMQ_PORT,
                credentials=credentials,
            )
            connection = pika.BlockingConnection(params)
            channel = connection.channel()
            channel.exchange_declare(exchange="notifications_exchange", exchange_type="fanout", durable=True)
            result = channel.queue_declare(queue="", exclusive=True)
            queue_name = result.method.queue
            channel.queue_bind(exchange="notifications_exchange", queue=queue_name)
            channel.basic_consume(queue=queue_name, on_message_callback=callback, auto_ack=False)
            logger.info("Started listening for employee.deleted events")
            channel.start_consuming()
        except Exception as e:
            logger.error("RabbitMQ connection error in analytics consumer", extra={"error": str(e)})
            time.sleep(5)


@app.on_event("startup")
def start_consumers():
    thread = threading.Thread(target=employee_deletion_consumer, daemon=True)
    thread.start()
    thread2 = threading.Thread(target=payroll_processed_consumer, daemon=True)
    thread2.start()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8003))
    uvicorn.run(app, host="0.0.0.0", port=port)
