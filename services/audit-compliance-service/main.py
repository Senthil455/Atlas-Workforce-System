import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Optional
from uuid import UUID

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse, Response, JSONResponse
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from atlas_observability import (
    AtlasLoggingMiddleware, AtlasMetricsMiddleware, CorrelationIdMiddleware,
    SecurityHeadersMiddleware,
    configure_logging, get_logger, verify_internal_auth
)

from crud import (
    configure_hash_salt,
    create_audit_log,
    create_policy,
    create_retention_policy,
    create_violation,
    data_portability,
    delete_policy,
    export_audit_logs_csv,
    export_audit_logs_json,
    generate_compliance_report,
    get_audit_log,
    get_compliance_summary,
    get_consents,
    get_policy,
    list_audit_logs,
    list_policies,
    list_retention_policies,
    list_violations,
    record_consent,
    right_to_be_forgotten,
    trigger_compliance_scan,
    update_policy,
    update_violation_status,
)
from models import Base
from schemas import (
    AuditLogCreate,
    AuditLogPaginated,
    AuditLogResponse,
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
)

load_dotenv()

DATABASE_URL = os.getenv(
    "DATABASE_URL", "postgresql://atlas:atlas_pass@localhost:5432/atlas_audit"
)
INTERNAL_API_KEY = os.getenv(
    "INTERNAL_API_KEY", "svc-audit-compliance-secret-key-change-in-production"
)
HASH_SALT = os.getenv(
    "HASH_SALT", "a8f3b2c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0"
)
MAX_PAGE_SIZE = int(os.getenv("MAX_AUDIT_PAGE_SIZE", "100"))
CORS_ORIGINS = os.getenv("CORS_ORIGINS", "http://localhost:3000")

engine = create_engine(DATABASE_URL, pool_pre_ping=True)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

configure_hash_salt(HASH_SALT)


def get_db() -> Session:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
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
            "name": "Health",
            "description": "Service health and readiness checks.",
        },
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


INTERNAL_JWT_SECRET = os.environ.get("INTERNAL_JWT_SECRET", "")

async def verify_internal_key(x_internal_key: str = Header(...)):
    if x_internal_key != INTERNAL_API_KEY:
        raise HTTPException(status_code=403, detail="Invalid internal API key")
    return True


async def clamp_page_size(page_size: int = Query(50, ge=1, le=MAX_PAGE_SIZE)) -> int:
    return min(page_size, MAX_PAGE_SIZE)


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
    "Requires X-Internal-Key header for service-to-service authentication.",
)
async def create_audit_entry(
    payload: AuditLogCreate,
    db: Session = Depends(get_db),
    _: bool = Depends(verify_internal_key),
):
    log = create_audit_log(db, payload.model_dump(), HASH_SALT)
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
    tenant_id: Optional[str] = Query(None),
    event_type: Optional[str] = Query(None),
    actor_id: Optional[str] = Query(None),
    resource_type: Optional[str] = Query(None),
    action: Optional[str] = Query(None),
    start_date: Optional[datetime] = Query(None),
    end_date: Optional[datetime] = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Depends(clamp_page_size),
    db: Session = Depends(get_db),
):
    return list_audit_logs(
        db,
        tenant_id=tenant_id,
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
async def get_audit_entry(log_id: UUID, db: Session = Depends(get_db)):
    log = get_audit_log(db, log_id)
    if not log:
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
    format: str = Query("json", pattern="^(json|csv)$"),
    tenant_id: Optional[str] = Query(None),
    event_type: Optional[str] = Query(None),
    actor_id: Optional[str] = Query(None),
    resource_type: Optional[str] = Query(None),
    start_date: Optional[datetime] = Query(None),
    end_date: Optional[datetime] = Query(None),
    db: Session = Depends(get_db),
):
    if format == "csv":
        csv_data = export_audit_logs_csv(
            db,
            tenant_id=tenant_id,
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
            tenant_id=tenant_id,
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
    tenant_id: Optional[str] = Query(None),
    category: Optional[str] = Query(None),
    enabled: Optional[bool] = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Depends(clamp_page_size),
    db: Session = Depends(get_db),
):
    return list_policies(
        db,
        tenant_id=tenant_id,
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
    payload: CompliancePolicyCreate, db: Session = Depends(get_db)
):
    return create_policy(db, payload.model_dump())


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
    updated = update_policy(db, policy_id, payload.model_dump(exclude_unset=True))
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
    tenant_id: Optional[str] = Query(None),
    policy_id: Optional[UUID] = Query(None),
    employee_id: Optional[str] = Query(None),
    severity: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    start_date: Optional[datetime] = Query(None),
    end_date: Optional[datetime] = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Depends(clamp_page_size),
    db: Session = Depends(get_db),
):
    return list_violations(
        db,
        tenant_id=tenant_id,
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
    payload: ComplianceViolationCreate, db: Session = Depends(get_db)
):
    return create_violation(db, payload.model_dump())


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
    tenant_id: str = Query(...), db: Session = Depends(get_db)
):
    return get_compliance_summary(db, tenant_id)


@app.post(
    "/api/v1/compliance/scan",
    tags=["Compliance"],
    summary="Trigger compliance scan",
    description="Evaluates all active compliance policies against the current data "
    "and generates violations for any rule breaches.",
)
async def compliance_scan(
    tenant_id: str = Query(...), db: Session = Depends(get_db)
):
    violations = trigger_compliance_scan(db, tenant_id)
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
    tenant_id: str = Query(...),
    db: Session = Depends(get_db),
):
    valid_types = {"SOC2", "GDPR", "ISO27001"}
    if report_type.upper() not in valid_types:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid report type. Must be one of: {', '.join(valid_types)}",
        )
    return generate_compliance_report(db, tenant_id, report_type)


# ── Data Retention ──────────────────────────────────────────────────────────

@app.get(
    "/api/v1/compliance/retention-policies",
    tags=["Compliance"],
    summary="List data retention policies",
)
async def list_retention_policies_endpoint(
    tenant_id: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    return list_retention_policies(db, tenant_id)


@app.post(
    "/api/v1/compliance/retention-policies",
    status_code=201,
    tags=["Compliance"],
    summary="Create data retention policy",
)
async def create_retention_policy_endpoint(
    payload: DataRetentionPolicyCreate, db: Session = Depends(get_db)
):
    return create_retention_policy(db, payload.model_dump())


# ── GDPR ────────────────────────────────────────────────────────────────────

@app.get(
    "/api/v1/gdpr/consents/{employee_id}",
    tags=["GDPR"],
    summary="Get consent records for an employee",
)
async def get_employee_consents(
    employee_id: str,
    tenant_id: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    consents = get_consents(db, employee_id, tenant_id)
    return consents


@app.post(
    "/api/v1/gdpr/consents",
    response_model=GDPRConsentResponse,
    status_code=201,
    tags=["GDPR"],
    summary="Record employee consent",
)
async def record_employee_consent(
    payload: GDPRConsentCreate, db: Session = Depends(get_db)
):
    return record_consent(db, payload.model_dump())


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
    tenant_id: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    return right_to_be_forgotten(db, employee_id, tenant_id)


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
    tenant_id: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    return data_portability(db, employee_id, tenant_id)


# ── Verify Chain Integrity ──────────────────────────────────────────────────

@app.get(
    "/api/v1/audit/verify-chain",
    tags=["Audit Logs"],
    summary="Verify hash chain integrity",
    description="Verifies the integrity of the audit log hash chain for a given tenant. "
    "Returns whether the chain is intact and details of any break.",
)
async def verify_chain_integrity(
    tenant_id: str = Query(...),
    db: Session = Depends(get_db),
):
    from crud import _compute_hash

    entries = (
        db.query(AuditLog)
        .filter(AuditLog.tenant_id == tenant_id)
        .order_by(AuditLog.created_at.asc())
        .all()
    )

    issues = []
    for i, entry in enumerate(entries):
        expected_prev_hash = entries[i - 1].hash if i > 0 else ""
        if (entry.previous_hash or "") != expected_prev_hash:
            issues.append({
                "index": i,
                "id": str(entry.id),
                "issue": "previous_hash mismatch",
                "expected": expected_prev_hash,
                "found": entry.previous_hash or "",
            })

        expected_hash = _compute_hash(
            previous_hash=expected_prev_hash,
            event_type=entry.event_type,
            actor_id=entry.actor_id,
            action=entry.action,
            resource_type=entry.resource_type,
            resource_id=entry.resource_id,
            created_at=entry.created_at,
        )
        if entry.hash != expected_hash:
            issues.append({
                "index": i,
                "id": str(entry.id),
                "issue": "hash mismatch — entry has been tampered with",
                "expected": expected_hash,
                "found": entry.hash,
            })

    return {
        "tenant_id": tenant_id,
        "total_entries": len(entries),
        "chain_intact": len(issues) == 0,
        "issues": issues,
    }
