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


from routers import forecasting, capacity, skills, simulations, recommendations


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
    yield
    engine.dispose()


INTERNAL_JWT_SECRET = os.environ.get("INTERNAL_JWT_SECRET", "")

app = FastAPI(title="Workforce Planning Service API", version="1.0.0", lifespan=lifespan)

configure_logging("workforce-planning-service", level=logging.INFO)
logger = get_logger("workforce-planning-service")

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
        title="Atlas Workforce Planning Service",
        version="1.0.0",
        description="Workforce Planning and AI-driven workforce insights service. Manages demand forecasting, "
        "capacity planning, workforce allocation, project staffing, skills gap analysis, resource forecasting, "
        "bench management, talent forecasting, attrition forecasting, retirement forecasting, hiring recommendations, "
        "workforce simulation engine, what-if analysis, organization redesign simulator, and strategic planning dashboard. "
        "Part of the Atlas Workforce System.",
        routes=app.routes,
    )
    openapi_schema["servers"] = [{"url": "http://localhost:8017", "description": "Local development"}]
    openapi_schema["tags"] = [
        {"name": "Forecasting", "description": "Workforce demand, resource, talent, attrition, and retirement forecasting"},
        {"name": "Capacity & Staffing", "description": "Capacity planning, workforce allocation, project staffing, and bench management"},
        {"name": "Skills", "description": "Skills gap analysis and assessment"},
        {"name": "Simulations", "description": "Workforce simulation engine, what-if analysis, and organization redesign simulator"},
        {"name": "Recommendations", "description": "AI-driven hiring recommendations"},
        {"name": "Dashboard", "description": "Strategic planning dashboard and overview statistics"},
        {"name": "Health", "description": "Service health check"},
    ]
    app.openapi_schema = openapi_schema
    return app.openapi_schema


app.openapi = custom_openapi

app.include_router(forecasting.router, prefix="/api/v1")
app.include_router(capacity.router, prefix="/api/v1")
app.include_router(skills.router, prefix="/api/v1")
app.include_router(simulations.router, prefix="/api/v1")
app.include_router(recommendations.router, prefix="/api/v1")


@app.get("/api/v1/workforce/dashboard", tags=["Dashboard"])
def workforce_dashboard(x_tenant_id: str = Header("default", alias="X-Tenant-Id"), db: Session = Depends(get_db)):
    return crud.get_dashboard_stats(db, x_tenant_id)


@app.get("/api/v1/workforce/strategic-plans", tags=["Dashboard"])
def list_strategic_plans(page: int = 1, page_size: int = 20, status: str = None, x_tenant_id: str = Header("default", alias="X-Tenant-Id"), db: Session = Depends(get_db)):
    return crud.list_strategic_plans(db, x_tenant_id, page, page_size, status)


@app.get("/api/v1/workforce/strategic-plans/{plan_id}", tags=["Dashboard"])
def get_strategic_plan(plan_id, x_tenant_id: str = Header("default", alias="X-Tenant-Id"), db: Session = Depends(get_db)):
    from uuid import UUID
    result = crud.get_strategic_plan(db, UUID(plan_id), x_tenant_id)
    if not result:
        from fastapi import HTTPException
        raise HTTPException(404, detail="Strategic plan not found")
    return result


@app.post("/api/v1/workforce/strategic-plans", tags=["Dashboard"], status_code=201)
def create_strategic_plan(payload: dict, x_tenant_id: str = Header("default", alias="X-Tenant-Id"), db: Session = Depends(get_db)):
    from schemas import StrategicPlanCreate
    validated = StrategicPlanCreate(**payload)
    return crud.create_strategic_plan(db, x_tenant_id, validated.model_dump())


@app.put("/api/v1/workforce/strategic-plans/{plan_id}", tags=["Dashboard"])
def update_strategic_plan(plan_id, payload: dict, x_tenant_id: str = Header("default", alias="X-Tenant-Id"), db: Session = Depends(get_db)):
    from uuid import UUID
    from schemas import StrategicPlanUpdate
    validated = StrategicPlanUpdate(**payload)
    result = crud.update_strategic_plan(db, UUID(plan_id), x_tenant_id, validated.model_dump(exclude_unset=True))
    if not result:
        from fastapi import HTTPException
        raise HTTPException(404, detail="Strategic plan not found")
    return result


@app.delete("/api/v1/workforce/strategic-plans/{plan_id}", tags=["Dashboard"])
def delete_strategic_plan(plan_id, x_tenant_id: str = Header("default", alias="X-Tenant-Id"), db: Session = Depends(get_db)):
    from uuid import UUID
    if not crud.delete_strategic_plan(db, UUID(plan_id), x_tenant_id):
        from fastapi import HTTPException
        raise HTTPException(404, detail="Strategic plan not found")
    return {"message": "Strategic plan deleted"}


@app.get("/health", tags=["Health"])
def health_check():
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
            db_status = "connected"
    except Exception:
        db_status = "disconnected"
    return {"status": "Workforce Planning Service is running", "database": db_status}


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8017))
    uvicorn.run(app, host="0.0.0.0", port=port)
