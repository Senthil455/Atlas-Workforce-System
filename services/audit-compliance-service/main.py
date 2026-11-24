import logging
import os
import threading
import time
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Optional
from uuid import UUID

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse, Response, JSONResponse
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from atlas_observability import (
    AtlasLoggingMiddleware, AtlasMetricsMiddleware, CorrelationIdMiddleware,
    SecurityHeadersMiddleware,
    configure_logging, get_logger, verify_internal_auth, AUDIT_WRITER_AUDIENCE
)

from crud import (
    MassAssignmentError,
    backfill_audit_sequences,
    configure_anchor_signing_key,
    configure_hash_salt,
    create_audit_log,
    create_policy,
    create_report_definition,
    create_retention_policy,
    create_violation,
    data_portability,
    delete_policy,
    delete_report_definition,
    export_audit_logs_csv,
    export_audit_logs_json,
    generate_compliance_report,
    get_audit_log,
    get_compliance_summary,
    get_consents,
    get_policy,
    get_report_definition,
    get_report_run,
    list_audit_logs,
    list_policies,
    list_report_definitions,
    list_report_runs,
    list_retention_policies,
    list_violations,
    record_consent,
    right_to_be_forgotten,
    set_report_definition_next_run,
    sync_chain_anchors,
    trigger_compliance_scan,
    update_policy,
    update_report_definition,
    update_violation_status,
    verify_audit_chain,
)
from models import AuditLog, Base
from reporting import (
    CANNED_REPORTS,
    DATASET_FETCHERS,
    compute_next_run,
    execute_report_definition,
    install_canned_report,
    run_due_report_definitions,
)
from schemas import (
    AuditLogCreate,
    AuditLogPaginated,
    AuditLogResponse,
    CannedReportInstall,
    CannedReportInstallResponse,
    CannedReportResponse,
    CompliancePolicyCreate,
    CompliancePolicyResponse,
    CompliancePolicyUpdate,
    ComplianceReport,
    ComplianceSummary,
    ComplianceViolationCreate,
    ComplianceViolationPaginated,
    ComplianceViolationResponse,
    ComplianceViolationStatusUpdate,
    DataPortabilityResponse,
    DataRetentionPolicyCreate,
    DataRetentionPolicyResponse,
    ForgetResponse,
    GDPRConsentCreate,
    GDPRConsentResponse,
    HealthResponse,
    MessageResponse,
    ReportDefinitionCreate,
    ReportDefinitionPage,
    ReportDefinitionResponse,
    ReportDefinitionUpdate,
    ReportRunPage,
    ReportRunResponse,
)

load_dotenv()

DATABASE_URL = os.getenv(
    "DATABASE_URL", "postgresql://atlas:atlas_pass@localhost:5432/atlas_audit"
)
HASH_SALT = os.getenv(
    "HASH_SALT", "a8f3b2c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0"
)
ANCHOR_SIGNING_KEY = os.getenv("ANCHOR_SIGNING_KEY", HASH_SALT)
MAX_PAGE_SIZE = int(os.getenv("MAX_AUDIT_PAGE_SIZE", "100"))
CORS_ORIGINS = os.getenv("CORS_ORIGINS", "http://localhost:3000")

engine = create_engine(DATABASE_URL, pool_pre_ping=True)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

configure_hash_salt(HASH_SALT)
configure_anchor_signing_key(ANCHOR_SIGNING_KEY)


def get_db() -> Session:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _report_scheduler_enabled() -> bool:
    return os.getenv("REPORT_SCHEDULER_ENABLED", "true").lower() not in ("0", "false", "no")


def _report_scheduler_loop(interval_seconds: int) -> None:
    while True:
        try:
            db = SessionLocal()
            try:
                runs = run_due_report_definitions(db)
                if runs:
                    logger.info("report.scheduler_ran", extra={"runs": len(runs)})
            finally:
                db.close()
        except Exception:
            logger.exception("report.scheduler_failed")
        time.sleep(interval_seconds)


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
    # One-time, idempotent maintenance for databases written before the
    # sequence column / anchor table existed: number legacy rows and record a
    # signed baseline anchor so tail deletions become detectable.
    try:
        db = SessionLocal()
        try:
            backfilled = backfill_audit_sequences(db)
            anchored = sync_chain_anchors(db)
            if backfilled or anchored:
                logger.info(
                    "audit.chain_metadata_backfill",
                    extra={"sequences_backfilled": backfilled, "anchors_created": anchored},
                )
        finally:
            db.close()
    except Exception:
        logger.exception("audit.chain_metadata_backfill_failed")
    if _report_scheduler_enabled():
        try:
            interval = max(5, int(os.getenv("REPORT_SCHEDULER_INTERVAL_SEC", "60")))
        except ValueError:
            interval = 60
        threading.Thread(
            target=_report_scheduler_loop,
            args=(interval,),
            daemon=True,
            name="report-scheduler",
        ).start()
    yield


app = FastAPI(
    title="Atlas Audit & Compliance Service",
    description="Immutable Audit Log and Compliance Engine for the Atlas Workforce Intelligence Platform.\n\n"
    "Provides append-only audit logging with SHA-256 hash chain integrity verification, "
    "compliance policy management, violation detection, GDPR consent management, "
    "and regulatory reporting (SOC2, GDPR, ISO27001).",
    version="1.0.0",
    lifespan=lifespan,
    contact={
        "name": "Atlas Platform Team",
        "email": "platform@atlas-workforce.io",
    },
    license_info={
        "name": "Proprietary",
        "url": "https://atlas-workforce.io/license",
    },
    servers=[
        {"url": "http://localhost:8011", "description": "Local Development"},
        {"url": "https://audit.atlas-workforce.io", "description": "Production"},
    ],
    openapi_tags=[
        {
            "name": "Audit Logs",
            "description": "Immutable append-only audit log operations. Create, query, and export audit entries. "
            "All entries are cryptographically chained using SHA-256 hashes.",
        },
        {
            "name": "Compliance",
            "description": "Compliance policy management, violation detection, scanning, and regulatory reporting.",
        },
        {
            "name": "GDPR",
            "description": "GDPR compliance operations: consent management, right to be forgotten, data portability.",
        },
        {
            "name": "Reports",
            "description": "Scheduled report definitions, canned templates (headcount, payroll totals, "
            "compliance posture), manual and scheduled execution, and run history.",
        },
        {
            "name": "Health",
            "description": "Service health and readiness checks.",
        },
    ],
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS.split(",") if CORS_ORIGINS != "*" else ["*"],
    allow_credentials=CORS_ORIGINS != "*",
    allow_methods=["*"],
    allow_headers=["*"],
)

app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(AtlasMetricsMiddleware)

INTERNAL_JWT_SECRET = os.environ.get("INTERNAL_JWT_SECRET", "")

logger = get_logger("audit-compliance-service")

@app.middleware("http")
async def internal_auth_middleware(request: Request, call_next):
    if request.url.path in ("/health", "/metrics"):
        return await call_next(request)

    auth_header = request.headers.get("x-internal-auth")
    if not auth_header:
        return JSONResponse(status_code=401, content={"error": "Missing internal authentication"})

    try:
        claims = verify_internal_auth(request, INTERNAL_JWT_SECRET)
        verified_tenant = str(claims.get("tenant_id", "default")).strip()
        if not verified_tenant:
            return JSONResponse(status_code=403, content={"error": "Missing tenant context"})
        request.state.tenant_id = verified_tenant
        request.state.user_id = claims.get("user_id", "")
        request.state.user_role = claims.get("user_role", "employee")
        request.state.claims = claims
        # Reject an explicitly empty tenant header or query value. An empty
        # string is falsy in Python, so without this check it would silently
        # disable the tenant filter downstream.
        if "x-tenant-id" in request.headers:
            header_tenant = request.headers.get("x-tenant-id")
            if header_tenant is not None and not str(header_tenant).strip():
                return JSONResponse(status_code=400, content={"error": "Empty tenant header"})
            if header_tenant and header_tenant != request.state.tenant_id:
                return JSONResponse(status_code=403, content={"error": "Tenant mismatch"})
        else:
            header_tenant = request.headers.get("X-Tenant-Id")
            if header_tenant is not None and not str(header_tenant).strip():
                return JSONResponse(status_code=400, content={"error": "Empty tenant header"})
            if header_tenant and header_tenant != request.state.tenant_id:
                return JSONResponse(status_code=403, content={"error": "Tenant mismatch"})
        if "tenant_id" in request.query_params:
            query_tenant = request.query_params.get("tenant_id")
            if query_tenant is not None and not str(query_tenant).strip():
                return JSONResponse(status_code=400, content={"error": "Empty tenant_id"})
            if query_tenant and query_tenant != request.state.tenant_id:
                return JSONResponse(status_code=403, content={"error": "Tenant mismatch"})
        # Overwrite tenant header/query with verified claim so downstream code cannot use spoofed value
        try:
            headers = list(request.scope.get("headers", []))
            found = False
            for idx, (k, v) in enumerate(headers):
                if k.lower() == b"x-tenant-id":
                    headers[idx] = (k, request.state.tenant_id.encode())
                    found = True
            if not found:
                headers.append((b"x-tenant-id", request.state.tenant_id.encode()))
            request.scope["headers"] = headers
            # For query-based services, ensure tenant_id query param matches claim
            from urllib.parse import parse_qs, urlencode
            qs = request.scope.get("query_string", b"").decode()
            if qs:
                params = parse_qs(qs)
                if "tenant_id" in params:
                    params["tenant_id"] = [request.state.tenant_id]
                    request.scope["query_string"] = urlencode(params, doseq=True).encode()
        except (AttributeError, TypeError, ValueError, UnicodeError) as e:
            logger.warning("auth.tenant_scope_rewrite_failed", extra={"error": str(e)})
    except HTTPException as e:
        return JSONResponse(status_code=e.status_code, content={"error": e.detail})
    except (ValueError, KeyError, AttributeError, TypeError, UnicodeError) as e:
        logger.warning("auth.unexpected_claims_shape", extra={"error": str(e), "error_type": type(e).__name__})
        return JSONResponse(status_code=401, content={"error": "Invalid internal authentication"})
    except Exception:
        logger.exception("auth.middleware_unexpected_error")
        return JSONResponse(status_code=401, content={"error": "Invalid internal authentication"})

    return await call_next(request)



async def require_audit_writer(request: Request):
    claims = getattr(request.state, "claims", None) or {}
    aud = claims.get("aud")
    if isinstance(aud, list):
        ok = AUDIT_WRITER_AUDIENCE in aud
    else:
        ok = aud == AUDIT_WRITER_AUDIENCE
    if not ok:
        raise HTTPException(status_code=403, detail="Audit writer audience required")
    return True


def normalize_audit_payload(payload: dict, claims: dict) -> dict:
    # Accept both the canonical audit shape and the compact service shape
    # ({event_type, user_id, email, details, service}) that the Node and
    # Python writers send, so authenticated writes are not lost to 422s.
    # Missing tenant/actor fall back to the verified JWT claims.
    if not isinstance(payload, dict) or not payload.get("event_type"):
        raise HTTPException(status_code=422, detail="event_type is required")
    claims = claims or {}
    details = payload.get("details")
    metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
    if isinstance(details, dict):
        metadata = {**details, **metadata}
    elif details is not None:
        metadata = {**metadata, "details": details}
    for extra in ("service", "path", "method", "user_email", "user_role",
                  "status_code", "correlation_id", "device_id"):
        if extra in payload and extra not in metadata:
            metadata[extra] = payload[extra]
    return {
        "tenant_id": payload.get("tenant_id") or claims.get("tenant_id", "default"),
        "event_type": payload.get("event_type"),
        "actor_id": str(
            payload.get("actor_id")
            or payload.get("user_id")
            or payload.get("user_email")
            or payload.get("email")
            or "system"
        ),
        "actor_email": payload.get("actor_email") or payload.get("email"),
        "action": payload.get("action"),
        "resource_type": payload.get("resource_type"),
        "resource_id": payload.get("resource_id"),
        "old_value": payload.get("old_value"),
        "new_value": payload.get("new_value"),
        "ip_address": payload.get("ip_address"),
        "user_agent": payload.get("user_agent"),
        "session_id": payload.get("session_id"),
        "device_fingerprint": payload.get("device_fingerprint"),
        "metadata": metadata,
    }


async def clamp_page_size(page_size: int = Query(50, ge=1, le=MAX_PAGE_SIZE)) -> int:
    return min(page_size, MAX_PAGE_SIZE)


def get_tenant(request: Request) -> str:
    tenant = getattr(request.state, "tenant_id", None)
    if not tenant or not str(tenant).strip():
        raise HTTPException(status_code=403, detail="Missing tenant context")
    return str(tenant).strip()


def resolve_tenant(query_tenant: Optional[str], verified_tenant: str) -> str:
    if query_tenant is not None and not str(query_tenant).strip():
        raise HTTPException(status_code=400, detail="Empty tenant_id")
    if query_tenant is not None and str(query_tenant) != verified_tenant:
        raise HTTPException(status_code=403, detail="Tenant mismatch")
    return verified_tenant


def check_body_tenant(request: Request, body_tenant: Optional[str]) -> None:
    context_tenant = getattr(request.state, "tenant_id", None)
    if context_tenant and body_tenant and body_tenant != context_tenant:
        raise HTTPException(status_code=403, detail="Tenant mismatch between context and body")


# ── Health ──────────────────────────────────────────────────────────────────

@app.get("/health", response_model=HealthResponse, tags=["Health"])
async def health_check():
    return HealthResponse(
        status="healthy",
        service="audit-compliance-service",
        version="1.0.0",
    )


# ── Audit Logs ──────────────────────────────────────────────────────────────

@app.post(
    "/api/v1/audit/log",
    response_model=AuditLogResponse,
    status_code=201,
    tags=["Audit Logs"],
    summary="Create audit log entry",
    description="Creates an immutable audit log entry with hash chain integrity. "
    "Requires x-internal-auth JWT with the audit-writer audience.",
)
async def create_audit_entry(
    request: Request,
    db: Session = Depends(get_db),
    _: bool = Depends(require_audit_writer),
):
    try:
        raw = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")
    if not isinstance(raw, dict):
        raise HTTPException(status_code=400, detail="Request body must be a JSON object")
    claims = getattr(request.state, "claims", None) or {}
    check_body_tenant(request, raw.get("tenant_id"))
    data = normalize_audit_payload(raw, claims)
    try:
        validated = AuditLogCreate(**data)
    except Exception:
        raise HTTPException(status_code=422, detail="Invalid audit entry")
    try:
        log = create_audit_log(db, validated.model_dump(), HASH_SALT)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return log


@app.get(
    "/api/v1/audit/logs",
    response_model=AuditLogPaginated,
    tags=["Audit Logs"],
    summary="List audit logs",
    description="Paginated list of audit log entries with filtering by tenant, event type, "
    "actor, resource, action, and date range.",
)
async def list_audit_entries(
    request: Request,
    tenant_id: Optional[str] = Query(None),
    event_type: Optional[str] = Query(None),
    actor_id: Optional[str] = Query(None),
    resource_type: Optional[str] = Query(None),
    action: Optional[str] = Query(None),
    start_date: Optional[datetime] = Query(None),
    end_date: Optional[datetime] = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Depends(clamp_page_size),
    verified_tenant: str = Depends(get_tenant),
    db: Session = Depends(get_db),
):
    return list_audit_logs(
        db,
        tenant_id=resolve_tenant(tenant_id, verified_tenant),
        event_type=event_type,
        actor_id=actor_id,
        resource_type=resource_type,
        action=action,
        start_date=start_date,
        end_date=end_date,
        page=page,
        page_size=page_size,
    )


@app.get(
    "/api/v1/audit/logs/{log_id}",
    response_model=AuditLogResponse,
    tags=["Audit Logs"],
    summary="Get audit log entry",
)
async def get_audit_entry(log_id: UUID, request: Request, verified_tenant: str = Depends(get_tenant), db: Session = Depends(get_db)):
    log = get_audit_log(db, log_id)
    if not log:
        raise HTTPException(status_code=404, detail="Audit log entry not found")
    if log.tenant_id != verified_tenant:
        raise HTTPException(status_code=404, detail="Audit log entry not found")
    return log


@app.get(
    "/api/v1/audit/logs/export",
    tags=["Audit Logs"],
    summary="Export audit logs",
    description="Export audit logs as CSV or JSON. Defaults to JSON. "
    "Set `format` query parameter to 'csv' for CSV export.",
)
async def export_audit_entries(
    request: Request,
    format: str = Query("json", pattern="^(json|csv)$"),
    tenant_id: Optional[str] = Query(None),
    event_type: Optional[str] = Query(None),
    actor_id: Optional[str] = Query(None),
    resource_type: Optional[str] = Query(None),
    start_date: Optional[datetime] = Query(None),
    end_date: Optional[datetime] = Query(None),
    verified_tenant: str = Depends(get_tenant),
    db: Session = Depends(get_db),
):
    effective_tenant = resolve_tenant(tenant_id, verified_tenant)
    if format == "csv":
        csv_data = export_audit_logs_csv(
            db,
            tenant_id=effective_tenant,
            event_type=event_type,
            actor_id=actor_id,
            resource_type=resource_type,
            start_date=start_date,
            end_date=end_date,
        )
        return Response(
            content=csv_data,
            media_type="text/csv",
            headers={"Content-Disposition": "attachment; filename=audit_logs.csv"},
        )
    else:
        json_data = export_audit_logs_json(
            db,
            tenant_id=effective_tenant,
            event_type=event_type,
            actor_id=actor_id,
            resource_type=resource_type,
            start_date=start_date,
            end_date=end_date,
        )
        return Response(
            content=json_data,
            media_type="application/json",
            headers={"Content-Disposition": "attachment; filename=audit_logs.json"},
        )


# ── Compliance Policies ─────────────────────────────────────────────────────

@app.get(
    "/api/v1/compliance/policies",
    tags=["Compliance"],
    summary="List compliance policies",
)
async def list_compliance_policies(
    request: Request,
    tenant_id: Optional[str] = Query(None),
    category: Optional[str] = Query(None),
    enabled: Optional[bool] = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Depends(clamp_page_size),
    verified_tenant: str = Depends(get_tenant),
    db: Session = Depends(get_db),
):
    return list_policies(
        db,
        tenant_id=resolve_tenant(tenant_id, verified_tenant),
        category=category,
        enabled=enabled,
        page=page,
        page_size=page_size,
    )


@app.post(
    "/api/v1/compliance/policies",
    response_model=CompliancePolicyResponse,
    status_code=201,
    tags=["Compliance"],
    summary="Create compliance policy",
)
async def create_compliance_policy(
    payload: CompliancePolicyCreate, request: Request, db: Session = Depends(get_db)
):
    check_body_tenant(request, payload.tenant_id)
    try:
        return create_policy(db, payload.model_dump())
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.put(
    "/api/v1/compliance/policies/{policy_id}",
    response_model=CompliancePolicyResponse,
    tags=["Compliance"],
    summary="Update compliance policy",
)
async def update_compliance_policy(
    policy_id: UUID,
    payload: CompliancePolicyUpdate,
    db: Session = Depends(get_db),
):
    try:
        updated = update_policy(db, policy_id, payload.model_dump(exclude_unset=True))
    except MassAssignmentError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if not updated:
        raise HTTPException(status_code=404, detail="Policy not found")
    return updated


@app.delete(
    "/api/v1/compliance/policies/{policy_id}",
    tags=["Compliance"],
    summary="Delete compliance policy",
)
async def delete_compliance_policy(
    policy_id: UUID,
    db: Session = Depends(get_db),
):
    if not delete_policy(db, policy_id):
        raise HTTPException(status_code=404, detail="Policy not found")
    return MessageResponse(message="Policy deleted successfully")


# ── Compliance Violations ───────────────────────────────────────────────────

@app.get(
    "/api/v1/compliance/violations",
    response_model=ComplianceViolationPaginated,
    tags=["Compliance"],
    summary="List compliance violations",
)
async def list_compliance_violations(
    request: Request,
    tenant_id: Optional[str] = Query(None),
    policy_id: Optional[UUID] = Query(None),
    employee_id: Optional[str] = Query(None),
    severity: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    start_date: Optional[datetime] = Query(None),
    end_date: Optional[datetime] = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Depends(clamp_page_size),
    verified_tenant: str = Depends(get_tenant),
    db: Session = Depends(get_db),
):
    return list_violations(
        db,
        tenant_id=resolve_tenant(tenant_id, verified_tenant),
        policy_id=policy_id,
        employee_id=employee_id,
        severity=severity,
        status=status,
        start_date=start_date,
        end_date=end_date,
        page=page,
        page_size=page_size,
    )


@app.post(
    "/api/v1/compliance/violations",
    response_model=ComplianceViolationResponse,
    status_code=201,
    tags=["Compliance"],
    summary="Report a compliance violation",
)
async def report_compliance_violation(
    payload: ComplianceViolationCreate, request: Request, db: Session = Depends(get_db)
):
    check_body_tenant(request, payload.tenant_id)
    try:
        return create_violation(db, payload.model_dump())
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.put(
    "/api/v1/compliance/violations/{violation_id}/status",
    response_model=ComplianceViolationResponse,
    tags=["Compliance"],
    summary="Update violation status",
)
async def update_violation_status_endpoint(
    violation_id: UUID,
    payload: ComplianceViolationStatusUpdate,
    db: Session = Depends(get_db),
):
    updated = update_violation_status(db, violation_id, payload.status)
    if not updated:
        raise HTTPException(status_code=404, detail="Violation not found")
    return updated


# ── Compliance Summary / Scan / Reports ─────────────────────────────────────

@app.get(
    "/api/v1/compliance/summary",
    response_model=ComplianceSummary,
    tags=["Compliance"],
    summary="Compliance dashboard summary",
)
async def compliance_summary(
    request: Request,
    tenant_id: Optional[str] = Query(None),
    verified_tenant: str = Depends(get_tenant),
    db: Session = Depends(get_db),
):
    return get_compliance_summary(db, resolve_tenant(tenant_id, verified_tenant))


@app.post(
    "/api/v1/compliance/scan",
    tags=["Compliance"],
    summary="Trigger compliance scan",
    description="Evaluates all active compliance policies against the current data "
    "and generates violations for any rule breaches.",
)
async def compliance_scan(
    request: Request,
    tenant_id: Optional[str] = Query(None),
    verified_tenant: str = Depends(get_tenant),
    db: Session = Depends(get_db),
):
    violations = trigger_compliance_scan(db, resolve_tenant(tenant_id, verified_tenant))
    return {
        "message": f"Scan completed. {len(violations)} violations detected.",
        "violations_count": len(violations),
    }


@app.get(
    "/api/v1/compliance/reports/{report_type}",
    response_model=ComplianceReport,
    tags=["Compliance"],
    summary="Generate compliance report",
    description="Generates a readiness report for SOC2, GDPR, or ISO27001 compliance.",
)
async def compliance_report(
    report_type: str,
    request: Request,
    tenant_id: Optional[str] = Query(None),
    verified_tenant: str = Depends(get_tenant),
    db: Session = Depends(get_db),
):
    valid_types = {"SOC2", "GDPR", "ISO27001"}
    if report_type.upper() not in valid_types:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid report type. Must be one of: {', '.join(valid_types)}",
        )
    return generate_compliance_report(db, resolve_tenant(tenant_id, verified_tenant), report_type)


# ── Data Retention ──────────────────────────────────────────────────────────

@app.get(
    "/api/v1/compliance/retention-policies",
    tags=["Compliance"],
    summary="List data retention policies",
)
async def list_retention_policies_endpoint(
    request: Request,
    tenant_id: Optional[str] = Query(None),
    verified_tenant: str = Depends(get_tenant),
    db: Session = Depends(get_db),
):
    return list_retention_policies(db, resolve_tenant(tenant_id, verified_tenant))


@app.post(
    "/api/v1/compliance/retention-policies",
    status_code=201,
    tags=["Compliance"],
    summary="Create data retention policy",
)
async def create_retention_policy_endpoint(
    payload: DataRetentionPolicyCreate, request: Request, db: Session = Depends(get_db)
):
    check_body_tenant(request, payload.tenant_id)
    try:
        return create_retention_policy(db, payload.model_dump())
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


# ── GDPR ────────────────────────────────────────────────────────────────────

@app.get(
    "/api/v1/gdpr/consents/{employee_id}",
    tags=["GDPR"],
    summary="Get consent records for an employee",
)
async def get_employee_consents(
    employee_id: str,
    request: Request,
    tenant_id: Optional[str] = Query(None),
    verified_tenant: str = Depends(get_tenant),
    db: Session = Depends(get_db),
):
    consents = get_consents(db, employee_id, resolve_tenant(tenant_id, verified_tenant))
    return consents


@app.post(
    "/api/v1/gdpr/consents",
    response_model=GDPRConsentResponse,
    status_code=201,
    tags=["GDPR"],
    summary="Record employee consent",
)
async def record_employee_consent(
    payload: GDPRConsentCreate, request: Request, db: Session = Depends(get_db)
):
    check_body_tenant(request, payload.tenant_id)
    try:
        return record_consent(db, payload.model_dump())
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post(
    "/api/v1/gdpr/forget/{employee_id}",
    response_model=ForgetResponse,
    tags=["GDPR"],
    summary="Right to be forgotten",
    description="Permanently deletes all consent records and audit logs for an employee. "
    "Returns a summary of what was deleted.",
)
async def right_to_be_forgotten_endpoint(
    employee_id: str,
    request: Request,
    tenant_id: Optional[str] = Query(None),
    verified_tenant: str = Depends(get_tenant),
    db: Session = Depends(get_db),
):
    return right_to_be_forgotten(db, employee_id, resolve_tenant(tenant_id, verified_tenant))


@app.get(
    "/api/v1/gdpr/data-portability/{employee_id}",
    response_model=DataPortabilityResponse,
    tags=["GDPR"],
    summary="Export all data for an employee",
    description="Exports all consent records, compliance violations, and audit events "
    "for the specified employee in a portable format.",
)
async def data_portability_endpoint(
    employee_id: str,
    request: Request,
    tenant_id: Optional[str] = Query(None),
    verified_tenant: str = Depends(get_tenant),
    db: Session = Depends(get_db),
):
    return data_portability(db, employee_id, resolve_tenant(tenant_id, verified_tenant))


# ── Reports ─────────────────────────────────────────────────────────────────

@app.get(
    "/api/v1/reports/canned",
    response_model=list[CannedReportResponse],
    tags=["Reports"],
    summary="List canned report templates",
    description="Built-in report templates (headcount, payroll totals, compliance posture) "
    "that can be installed as tenant report definitions.",
)
async def list_canned_reports(request: Request):
    return [
        CannedReportResponse(
            key=template["key"],
            name=template["name"],
            dataset=template["dataset"],
            description=template["description"],
            default_filters=template["filters"],
            default_columns=template["columns"],
            default_schedule=template["schedule"],
        )
        for template in CANNED_REPORTS.values()
    ]


@app.post(
    "/api/v1/reports/canned/{key}/install",
    response_model=CannedReportInstallResponse,
    tags=["Reports"],
    summary="Install a canned report definition",
    description="Creates the tenant's definition for a canned report. Idempotent on "
    "tenant+name: returns the existing definition with `created: false` if already installed.",
)
async def install_canned_report_endpoint(
    key: str,
    payload: CannedReportInstall,
    request: Request,
    verified_tenant: str = Depends(get_tenant),
    db: Session = Depends(get_db),
):
    if key not in CANNED_REPORTS:
        raise HTTPException(status_code=404, detail="Unknown canned report")
    user_id = getattr(request.state, "user_id", None) or None
    try:
        definition, created = install_canned_report(
            db,
            verified_tenant,
            key,
            recipients=payload.recipients,
            created_by=user_id,
            schedule=payload.schedule,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"definition": definition, "created": created}


@app.get(
    "/api/v1/reports/definitions",
    response_model=ReportDefinitionPage,
    tags=["Reports"],
    summary="List report definitions",
)
async def list_report_definition_endpoint(
    request: Request,
    tenant_id: Optional[str] = Query(None),
    enabled: Optional[bool] = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Depends(clamp_page_size),
    verified_tenant: str = Depends(get_tenant),
    db: Session = Depends(get_db),
):
    return list_report_definitions(
        db,
        tenant_id=resolve_tenant(tenant_id, verified_tenant),
        enabled=enabled,
        page=page,
        page_size=page_size,
    )


@app.post(
    "/api/v1/reports/definitions",
    response_model=ReportDefinitionResponse,
    status_code=201,
    tags=["Reports"],
    summary="Create a report definition",
    description="Defines dataset, filters, columns, schedule, recipients, and the minimum "
    "role required to receive the rows.",
)
async def create_report_definition_endpoint(
    payload: ReportDefinitionCreate,
    request: Request,
    verified_tenant: str = Depends(get_tenant),
    db: Session = Depends(get_db),
):
    effective_tenant = resolve_tenant(payload.tenant_id, verified_tenant)
    if payload.dataset not in DATASET_FETCHERS:
        raise HTTPException(status_code=400, detail=f"Unknown dataset: {payload.dataset}")
    user_id = getattr(request.state, "user_id", None) or None
    data = payload.model_dump(exclude={"tenant_id"})
    try:
        return create_report_definition(
            db,
            effective_tenant,
            data,
            created_by=user_id,
            next_run_at=compute_next_run(data.get("schedule")),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get(
    "/api/v1/reports/definitions/{definition_id}",
    response_model=ReportDefinitionResponse,
    tags=["Reports"],
    summary="Get a report definition",
)
async def get_report_definition_endpoint(
    definition_id: UUID,
    request: Request,
    verified_tenant: str = Depends(get_tenant),
    db: Session = Depends(get_db),
):
    definition = get_report_definition(db, definition_id, verified_tenant)
    if not definition:
        raise HTTPException(status_code=404, detail="Report definition not found")
    return definition


@app.put(
    "/api/v1/reports/definitions/{definition_id}",
    response_model=ReportDefinitionResponse,
    tags=["Reports"],
    summary="Update a report definition",
)
async def update_report_definition_endpoint(
    definition_id: UUID,
    payload: ReportDefinitionUpdate,
    request: Request,
    verified_tenant: str = Depends(get_tenant),
    db: Session = Depends(get_db),
):
    data = payload.model_dump(exclude_unset=True)
    if "dataset" in data and data["dataset"] not in DATASET_FETCHERS:
        raise HTTPException(status_code=400, detail=f"Unknown dataset: {data['dataset']}")
    try:
        definition = update_report_definition(db, definition_id, data, tenant_id=verified_tenant)
    except MassAssignmentError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if not definition:
        raise HTTPException(status_code=404, detail="Report definition not found")
    if "schedule" in data:
        definition = set_report_definition_next_run(
            db, definition, compute_next_run(definition.schedule)
        )
    return definition


@app.delete(
    "/api/v1/reports/definitions/{definition_id}",
    response_model=MessageResponse,
    tags=["Reports"],
    summary="Delete a report definition",
)
async def delete_report_definition_endpoint(
    definition_id: UUID,
    request: Request,
    verified_tenant: str = Depends(get_tenant),
    db: Session = Depends(get_db),
):
    if not delete_report_definition(db, definition_id, tenant_id=verified_tenant):
        raise HTTPException(status_code=404, detail="Report definition not found")
    return MessageResponse(message="Report definition deleted")


@app.post(
    "/api/v1/reports/definitions/{definition_id}/run",
    response_model=ReportRunResponse,
    tags=["Reports"],
    summary="Run a report definition now",
    description="Executes the definition with the calling user's role. Always returns the "
    "finished run record; check `status` (SUCCEEDED, FAILED, SUPPRESSED) and `delivery_status`.",
)
async def run_report_definition_endpoint(
    definition_id: UUID,
    request: Request,
    verified_tenant: str = Depends(get_tenant),
    db: Session = Depends(get_db),
):
    definition = get_report_definition(db, definition_id, verified_tenant)
    if not definition:
        raise HTTPException(status_code=404, detail="Report definition not found")
    run_as_role = getattr(request.state, "user_role", None) or "employee"
    return execute_report_definition(
        db, definition, trigger="manual", run_as_role=run_as_role
    )


@app.post(
    "/api/v1/reports/scheduler/run-due",
    response_model=list[ReportRunResponse],
    tags=["Reports"],
    summary="Run due report definitions for the caller's tenant",
)
async def run_due_reports_endpoint(
    request: Request,
    verified_tenant: str = Depends(get_tenant),
    db: Session = Depends(get_db),
):
    return run_due_report_definitions(db, tenant_id=verified_tenant)


@app.get(
    "/api/v1/reports/runs",
    response_model=ReportRunPage,
    tags=["Reports"],
    summary="List report runs",
)
async def list_report_runs_endpoint(
    request: Request,
    definition_id: Optional[UUID] = Query(None),
    status: Optional[str] = Query(None, pattern="^(RUNNING|SUCCEEDED|FAILED|SUPPRESSED)$"),
    page: int = Query(1, ge=1),
    page_size: int = Depends(clamp_page_size),
    verified_tenant: str = Depends(get_tenant),
    db: Session = Depends(get_db),
):
    return list_report_runs(
        db,
        verified_tenant,
        definition_id=definition_id,
        status=status,
        page=page,
        page_size=page_size,
    )


@app.get(
    "/api/v1/reports/definitions/{definition_id}/runs",
    response_model=ReportRunPage,
    tags=["Reports"],
    summary="List runs for a report definition",
)
async def list_definition_runs_endpoint(
    definition_id: UUID,
    request: Request,
    page: int = Query(1, ge=1),
    page_size: int = Depends(clamp_page_size),
    verified_tenant: str = Depends(get_tenant),
    db: Session = Depends(get_db),
):
    definition = get_report_definition(db, definition_id, verified_tenant)
    if not definition:
        raise HTTPException(status_code=404, detail="Report definition not found")
    return list_report_runs(
        db, verified_tenant, definition_id=definition_id, page=page, page_size=page_size
    )


@app.get(
    "/api/v1/reports/runs/{run_id}",
    response_model=ReportRunResponse,
    tags=["Reports"],
    summary="Get a report run",
)
async def get_report_run_endpoint(
    run_id: UUID,
    request: Request,
    verified_tenant: str = Depends(get_tenant),
    db: Session = Depends(get_db),
):
    run = get_report_run(db, run_id, verified_tenant)
    if not run:
        raise HTTPException(status_code=404, detail="Report run not found")
    return run


# ── Verify Chain Integrity ──────────────────────────────────────────────────

@app.get(
    "/api/v1/audit/verify-chain",
    tags=["Audit Logs"],
    summary="Verify hash chain integrity",
    description="Verifies the integrity of the audit log hash chain for a given tenant, "
    "including the signed head anchor that detects entries removed from the end. "
    "Requires x-internal-auth JWT with the audit-writer audience.",
)
async def verify_chain_integrity(
    request: Request,
    tenant_id: Optional[str] = Query(None),
    verified_tenant: str = Depends(get_tenant),
    _: bool = Depends(require_audit_writer),
    db: Session = Depends(get_db),
):
    effective_tenant = resolve_tenant(tenant_id, verified_tenant)
    return verify_audit_chain(db, effective_tenant)
