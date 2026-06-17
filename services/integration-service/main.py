import logging
import os
import threading
import time
from contextlib import asynccontextmanager
from uuid import UUID

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from atlas_observability import (
    AtlasLoggingMiddleware, AtlasMetricsMiddleware, CorrelationIdMiddleware,
    SecurityHeadersMiddleware,
    configure_logging, get_logger, verify_internal_auth
)

from crud import (
    create_event_subscription,
    create_integration_config,
    create_webhook,
    delete_event_subscription,
    delete_integration_config,
    delete_webhook,
    get_dashboard_stats,
    get_event_subscription,
    get_integration_config,
    get_webhook,
    list_event_outbox,
    list_event_subscriptions,
    list_integration_configs,
    list_webhook_delivery_logs,
    list_webhooks,
    update_event_subscription,
    update_integration_config,
    update_webhook,
)
from event_router import (
    process_outbox,
    retry_failed_deliveries,
    route_event,
    set_db_session_factory,
    start_rabbitmq_consumer,
)
from models import Base
from schemas import (
    EventOutboxResponse,
    EventPublishRequest,
    EventSubscriptionCreate,
    EventSubscriptionResponse,
    EventSubscriptionUpdate,
    HealthResponse,
    IntegrationConfigCreate,
    IntegrationConfigResponse,
    IntegrationConfigUpdate,
    IntegrationDashboardResponse,
    MessageResponse,
    WebhookCreate,
    WebhookDeliveryLogResponse,
    WebhookResponse,
    WebhookUpdate,
)

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://atlas_user:atlas_password@postgres:5432/atlas_db")
INTERNAL_API_KEY = os.getenv("INTERNAL_API_KEY", "svc-integration-key-change-in-production")
CORS_ORIGINS = os.getenv("CORS_ORIGINS", "http://localhost:3000")
MAX_PAGE_SIZE = 100

engine = create_engine(DATABASE_URL, pool_pre_ping=True)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
set_db_session_factory(SessionLocal)


def get_db() -> Session:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()



async def verify_internal_key(x_internal_key: str = Header(...)):
    if x_internal_key != INTERNAL_API_KEY:
        raise HTTPException(status_code=403, detail="Invalid internal API key")
    return True


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
    start_rabbitmq_consumer()

    def _background_loop():
        while True:
            try:
                process_outbox()
                retry_failed_deliveries()
            except Exception as e:
                pass
            time.sleep(15)

    bg_thread = threading.Thread(target=_background_loop, daemon=True)
    bg_thread.start()

    yield


app = FastAPI(
    title="Atlas Integration Service",
    description="Enterprise Integration Hub — Webhook engine, Kafka event bridge, RabbitMQ consumer, "
    "and event outbox pattern for the Atlas Workforce Intelligence Platform.\n\n"
    "Routes events from internal services to external systems via webhooks and Kafka topics.",
    version="1.0.0",
    lifespan=lifespan,
    contact={"name": "Atlas Platform Team", "email": "platform@atlas-workforce.io"},
    license_info={"name": "Proprietary", "url": "https://atlas-workforce.io/license"},
    servers=[
        {"url": "http://localhost:8016", "description": "Local Development"},
        {"url": "https://integration.atlas-workforce.io", "description": "Production"},
    ],
    openapi_tags=[
        {"name": "Webhooks", "description": "Webhook management — register, list, update, delete webhook endpoints. Events are delivered via HTTP POST with retry logic."},
        {"name": "Webhook Delivery Logs", "description": "View webhook delivery history, status, and retry information."},
        {"name": "Event Subscriptions", "description": "Subscribe internal events → Kafka topics with optional payload transformation."},
        {"name": "Event Outbox", "description": "Transactional outbox for reliable event publishing."},
        {"name": "Event Publishing", "description": "Publish internal events to the integration engine (routed to webhooks + Kafka)."},
        {"name": "Integration Config", "description": "Key-value configuration store for integration settings."},
        {"name": "Dashboard", "description": "Integration service dashboard statistics."},
        {"name": "Health", "description": "Service health and readiness checks."},
    ],
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS.split(",") if CORS_ORIGINS != "*" else ["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.add_middleware(SecurityHeadersMiddleware)
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


# ── Health ──────────────────────────────────────────────────────

@app.get("/health", response_model=HealthResponse, tags=["Health"])
async def health_check():
    return HealthResponse(status="healthy", service="integration-service", version="1.0.0")


# ── Dashboard ───────────────────────────────────────────────────

@app.get("/api/v1/integration/dashboard", response_model=IntegrationDashboardResponse, tags=["Dashboard"])
async def integration_dashboard(
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    return get_dashboard_stats(db, x_tenant_id)


# ── Webhooks ────────────────────────────────────────────────────

@app.get("/api/v1/integration/webhooks", tags=["Webhooks"])
async def list_integration_webhooks(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=MAX_PAGE_SIZE),
    enabled: bool | None = Query(None),
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    return list_webhooks(db, x_tenant_id, page, page_size, enabled)


@app.post("/api/v1/integration/webhooks", response_model=WebhookResponse, status_code=201, tags=["Webhooks"])
async def create_integration_webhook(
    payload: WebhookCreate,
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    return create_webhook(db, x_tenant_id, payload.model_dump())


@app.get("/api/v1/integration/webhooks/{webhook_id}", response_model=WebhookResponse, tags=["Webhooks"])
async def get_integration_webhook(
    webhook_id: UUID,
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    wh = get_webhook(db, webhook_id, x_tenant_id)
    if not wh:
        raise HTTPException(status_code=404, detail="Webhook not found")
    return wh


@app.put("/api/v1/integration/webhooks/{webhook_id}", response_model=WebhookResponse, tags=["Webhooks"])
async def update_integration_webhook(
    webhook_id: UUID,
    payload: WebhookUpdate,
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    wh = update_webhook(db, webhook_id, x_tenant_id, payload.model_dump(exclude_unset=True))
    if not wh:
        raise HTTPException(status_code=404, detail="Webhook not found")
    return wh


@app.delete("/api/v1/integration/webhooks/{webhook_id}", tags=["Webhooks"])
async def delete_integration_webhook(
    webhook_id: UUID,
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    if not delete_webhook(db, webhook_id, x_tenant_id):
        raise HTTPException(status_code=404, detail="Webhook not found")
    return MessageResponse(message="Webhook deleted successfully")


# ── Webhook Delivery Logs ───────────────────────────────────────

@app.get("/api/v1/integration/webhooks/{webhook_id}/deliveries", tags=["Webhook Delivery Logs"])
async def list_webhook_deliveries(
    webhook_id: UUID,
    status: str | None = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=MAX_PAGE_SIZE),
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    return list_webhook_delivery_logs(db, x_tenant_id, webhook_id, status, page, page_size)


# ── Event Subscriptions ─────────────────────────────────────────

@app.get("/api/v1/integration/subscriptions", tags=["Event Subscriptions"])
async def list_integration_subscriptions(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=MAX_PAGE_SIZE),
    enabled: bool | None = Query(None),
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    return list_event_subscriptions(db, x_tenant_id, page, page_size, enabled)


@app.post("/api/v1/integration/subscriptions", response_model=EventSubscriptionResponse, status_code=201, tags=["Event Subscriptions"])
async def create_integration_subscription(
    payload: EventSubscriptionCreate,
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    return create_event_subscription(db, x_tenant_id, payload.model_dump())


@app.get("/api/v1/integration/subscriptions/{sub_id}", response_model=EventSubscriptionResponse, tags=["Event Subscriptions"])
async def get_integration_subscription(
    sub_id: UUID,
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    sub = get_event_subscription(db, sub_id, x_tenant_id)
    if not sub:
        raise HTTPException(status_code=404, detail="Subscription not found")
    return sub


@app.put("/api/v1/integration/subscriptions/{sub_id}", response_model=EventSubscriptionResponse, tags=["Event Subscriptions"])
async def update_integration_subscription(
    sub_id: UUID,
    payload: EventSubscriptionUpdate,
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    sub = update_event_subscription(db, sub_id, x_tenant_id, payload.model_dump(exclude_unset=True))
    if not sub:
        raise HTTPException(status_code=404, detail="Subscription not found")
    return sub


@app.delete("/api/v1/integration/subscriptions/{sub_id}", tags=["Event Subscriptions"])
async def delete_integration_subscription(
    sub_id: UUID,
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    if not delete_event_subscription(db, sub_id, x_tenant_id):
        raise HTTPException(status_code=404, detail="Subscription not found")
    return MessageResponse(message="Subscription deleted successfully")


# ── Event Outbox ────────────────────────────────────────────────

@app.get("/api/v1/integration/outbox", tags=["Event Outbox"])
async def list_integration_outbox(
    status: str | None = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=MAX_PAGE_SIZE),
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    return list_event_outbox(db, x_tenant_id, status, page, page_size)


# ── Event Publishing ────────────────────────────────────────────

@app.post("/api/v1/integration/events", status_code=202, tags=["Event Publishing"])
async def publish_internal_event(
    payload: EventPublishRequest,
    db: Session = Depends(get_db),
    _: bool = Depends(verify_internal_key),
):
    route_event(payload.event_type, payload.tenant_id, payload.payload, payload.source_service)
    return {"message": "Event accepted for routing", "event_type": payload.event_type, "tenant_id": payload.tenant_id}


# ── Integration Config ──────────────────────────────────────────

@app.get("/api/v1/integration/config", tags=["Integration Config"])
async def list_integration_configs_endpoint(
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    return list_integration_configs(db, x_tenant_id)


@app.post("/api/v1/integration/config", response_model=IntegrationConfigResponse, status_code=201, tags=["Integration Config"])
async def create_integration_config_endpoint(
    payload: IntegrationConfigCreate,
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    try:
        return create_integration_config(db, x_tenant_id, payload.model_dump())
    except Exception as e:
        if "unique" in str(e).lower():
            raise HTTPException(status_code=409, detail="Config key already exists")
        raise


@app.get("/api/v1/integration/config/{key}", response_model=IntegrationConfigResponse, tags=["Integration Config"])
async def get_integration_config_endpoint(
    key: str,
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    config = get_integration_config(db, x_tenant_id, key)
    if not config:
        raise HTTPException(status_code=404, detail="Config not found")
    return config


@app.put("/api/v1/integration/config/{key}", response_model=IntegrationConfigResponse, tags=["Integration Config"])
async def update_integration_config_endpoint(
    key: str,
    payload: IntegrationConfigUpdate,
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    config = update_integration_config(db, x_tenant_id, key, payload.model_dump())
    if not config:
        raise HTTPException(status_code=404, detail="Config not found")
    return config


@app.delete("/api/v1/integration/config/{key}", tags=["Integration Config"])
async def delete_integration_config_endpoint(
    key: str,
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    if not delete_integration_config(db, x_tenant_id, key):
        raise HTTPException(status_code=404, detail="Config not found")
    return MessageResponse(message="Config deleted successfully")


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8016))
    uvicorn.run(app, host="0.0.0.0", port=port)
