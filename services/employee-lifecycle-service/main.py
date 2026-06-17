import logging
import os
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI, Depends, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.openapi.utils import get_openapi
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker, Session
from atlas_observability import (
    AtlasLoggingMiddleware, AtlasMetricsMiddleware, CorrelationIdMiddleware,
    SecurityHeadersMiddleware,
    configure_logging, get_logger, verify_internal_auth
)

from models import Base
import crud

load_dotenv()

DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql://atlas_user:atlas_password@postgres:5432/atlas_db")

engine = create_engine(DATABASE_URL, pool_pre_ping=True)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def get_db():
    db: Session = SessionLocal()
    try:
        yield db
    finally:
        db.close()


from routers import onboarding, offboarding, probation, career, mobility, promotions, timeline, documents, profile, achievements, roadmaps


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
    yield
    engine.dispose()


INTERNAL_JWT_SECRET = os.environ.get("INTERNAL_JWT_SECRET", "")

app = FastAPI(title="Employee Lifecycle Service API", version="1.0.0", lifespan=lifespan)

configure_logging("employee-lifecycle-service", level=logging.INFO)
logger = get_logger("employee-lifecycle-service")

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


def custom_openapi():
    if app.openapi_schema:
        return app.openapi_schema
    openapi_schema = get_openapi(
        title="Atlas Employee Lifecycle Service",
        version="1.0.0",
        description="Employee Lifecycle Management service. Manages onboarding, offboarding, probation, career paths, "
        "internal mobility, promotions, employee timeline, documents, profile, achievements, and career roadmaps. "
        "Part of the Atlas Workforce System.",
        routes=app.routes,
    )
    openapi_schema["servers"] = [{"url": "http://localhost:8020", "description": "Local development"}]
    openapi_schema["tags"] = [
        {"name": "Onboarding", "description": "Onboarding templates and assignments for new hires"},
        {"name": "Offboarding", "description": "Offboarding records, clearance checklists, and exit interviews"},
        {"name": "Probation", "description": "Probation tracking with milestones and assessments"},
        {"name": "Career", "description": "Career frameworks, job families, and career paths"},
        {"name": "Internal Mobility", "description": "Internal job postings, applications, and transfer requests"},
        {"name": "Promotions", "description": "Promotion requests and approval workflows"},
        {"name": "Employee Timeline", "description": "Chronological timeline of employee lifecycle events"},
        {"name": "Employee Documents", "description": "Document vault for employee files and records"},
        {"name": "Employee Profile", "description": "Extended digital employee profile"},
        {"name": "Employee Achievements", "description": "Awards, accomplishments, and recognitions"},
        {"name": "Career Roadmaps", "description": "Visual career progression roadmaps"},
        {"name": "Dashboard", "description": "Lifecycle dashboard statistics"},
        {"name": "Health", "description": "Service health check"},
    ]
    app.openapi_schema = openapi_schema
    return app.openapi_schema


app.openapi = custom_openapi

app.include_router(onboarding.router, prefix="/api/v1")
app.include_router(offboarding.router, prefix="/api/v1")
app.include_router(probation.router, prefix="/api/v1")
app.include_router(career.router, prefix="/api/v1")
app.include_router(mobility.router, prefix="/api/v1")
app.include_router(promotions.router, prefix="/api/v1")
app.include_router(timeline.router, prefix="/api/v1")
app.include_router(documents.router, prefix="/api/v1")
app.include_router(profile.router, prefix="/api/v1")
app.include_router(achievements.router, prefix="/api/v1")
app.include_router(roadmaps.router, prefix="/api/v1")


@app.get("/api/v1/lifecycle/dashboard", tags=["Dashboard"])
def lifecycle_dashboard(x_tenant_id: str = Header("default", alias="X-Tenant-Id"), db: Session = Depends(get_db)):
    return crud.get_dashboard_stats(db, x_tenant_id)


@app.get("/health", tags=["Health"])
def health_check():
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
            db_status = "connected"
    except Exception:
        db_status = "disconnected"
    return {"status": "Employee Lifecycle Service is running", "database": db_status}


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8020))
    uvicorn.run(app, host="0.0.0.0", port=port)
