import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.openapi.utils import get_openapi
from fastapi.responses import JSONResponse
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker, Session
from atlas_observability import (
    AtlasLoggingMiddleware, AtlasMetricsMiddleware, CorrelationIdMiddleware,
    SecurityHeadersMiddleware,
    configure_logging, get_logger, verify_internal_auth
)

from models import Base
from file_security import validate_file, get_secure_path, MAX_FILE_SIZE

_PG_USER = os.environ.get("POSTGRES_USER", "atlas_user")
_PG_PASS = os.environ.get("POSTGRES_PASSWORD", "atlas_password")
_PG_HOST = os.environ.get("POSTGRES_HOST", "localhost")
_PG_DB = os.environ.get("POSTGRES_DB", "atlas_db")
DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    f"postgresql://{_PG_USER}:{_PG_PASS}@{_PG_HOST}:5432/{_PG_DB}",
)

engine = create_engine(DATABASE_URL, pool_pre_ping=True)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def get_db():
    db: Session = SessionLocal()
    try:
        yield db
    finally:
        db.close()


configure_logging("ats-service", level=logging.INFO)
logger = get_logger("ats-service")


from routers import (
    jobs, candidates, applications, interviews, offers, analytics,
    career_portal, resume_parser, offer_letters, campus_recruitment,
    referral_management, recruitment_chatbot, recruitment_analytics,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
    yield
    engine.dispose()


INTERNAL_JWT_SECRET = os.environ.get("INTERNAL_JWT_SECRET", "")

app = FastAPI(title="ATS Service API", version="1.0.0", lifespan=lifespan)

MAX_UPLOAD_SIZE = 10 * 1024 * 1024  # 10MB

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


@app.middleware("http")
async def limit_upload_size(request: Request, call_next):
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > MAX_UPLOAD_SIZE:
                raise HTTPException(status_code=413, detail="File too large. Maximum size is 10MB.")
        except ValueError:
            pass
    response = await call_next(request)
    return response


def custom_openapi():
    if app.openapi_schema:
        return app.openapi_schema
    openapi_schema = get_openapi(
        title="Atlas ATS Service",
        version="1.0.0",
        description="Applicant Tracking System service. Manages jobs, candidates, applications, interviews, and offers. Part of the Atlas Workforce System.",
        routes=app.routes,
    )
    openapi_schema["servers"] = [{"url": "http://localhost:8012", "description": "Local development"}]
    openapi_schema["tags"] = [
        {"name": "jobs", "description": "Job posting management"},
        {"name": "candidates", "description": "Candidate profile management"},
        {"name": "applications", "description": "Job application management"},
        {"name": "interviews", "description": "Interview scheduling and feedback"},
        {"name": "offers", "description": "Offer letter management"},
        {"name": "analytics", "description": "ATS pipeline analytics"},
        {"name": "health", "description": "Service health check"},
    ]
    app.openapi_schema = openapi_schema
    return app.openapi_schema


app.openapi = custom_openapi

app.include_router(jobs.router, prefix="/api/v1")
app.include_router(candidates.router, prefix="/api/v1")
app.include_router(applications.router, prefix="/api/v1")
app.include_router(interviews.router, prefix="/api/v1")
app.include_router(offers.router, prefix="/api/v1")
app.include_router(analytics.router, prefix="/api/v1")
app.include_router(career_portal.router, prefix="/api/v1")
app.include_router(resume_parser.router, prefix="/api/v1")
app.include_router(offer_letters.router, prefix="/api/v1")
app.include_router(campus_recruitment.router, prefix="/api/v1")
app.include_router(referral_management.router, prefix="/api/v1")
app.include_router(recruitment_chatbot.router, prefix="/api/v1")
app.include_router(recruitment_analytics.router, prefix="/api/v1")


@app.get("/health", tags=["health"])
def health_check():
    try:
        with engine.connect() as conn:
            conn.execute(
                engine.dialect.statement_compiler(
                    engine.dialect,
                    None).__class__.__module__ and text("SELECT 1"))
            db_status = "connected"
    except Exception:
        db_status = "disconnected"
    return {"status": "ATS Service is running", "database": db_status}


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", 8012))
    uvicorn.run(app, host="0.0.0.0", port=port)
