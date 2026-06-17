import logging
import os
import uuid
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Optional
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from atlas_observability import (
    AtlasLoggingMiddleware, AtlasMetricsMiddleware, CorrelationIdMiddleware,
    SecurityHeadersMiddleware,
    configure_logging, get_logger, verify_internal_auth
)

from crud import (
    add_session_event, approve_privileged_access, assess_risk,
    check_data_residency, classify_resource, create_ca_policy,
    create_data_classification, create_data_residency, create_dlp_policy,
    create_encryption_key, create_privileged_role, create_zt_policy,
    delete_ca_policy, delete_zt_policy, evaluate_ca_policy, evaluate_zt_policy,
    get_ca_policy, get_data_classification, get_dlp_policy, get_privileged_role,
    get_zt_policy, list_ca_policies, list_data_classifications, list_data_residency_policies,
    list_dlp_incidents, list_dlp_policies, list_encryption_keys, list_privileged_access,
    list_privileged_roles, list_risk_assessments, list_session_recordings,
    list_zt_policies, report_dlp_incident, request_privileged_access,
    revoke_privileged_access, rotate_encryption_key, start_session_recording,
    stop_session_recording, update_ca_policy, update_dlp_incident, update_zt_policy,
    get_security_dashboard,
)
from models import Base, PrivilegedAccess
from schemas import (
    CAPaginated, ConditionalAccessCreate, ConditionalAccessResponse,
    DataClassificationCreate, DataClassificationResponse,
    DataResidencyCreate, DataResidencyResponse, DLPPolicyCreate,
    DLPPolicyResponse, DLPIncidentResponse, DLPPaginated,
    EncryptionKeyCreate, EncryptionKeyResponse,
    HealthResponse, PrivilegedAccessRequest, PrivilegedAccessResponse,
    PrivilegedRoleCreate, PrivilegedRoleResponse,
    RiskAssessmentRequest, RiskAssessmentResponse, RiskPaginated,
    SecurityDashboard, SessionRecordingEvent, SessionRecordingResponse,
    ZeroTrustPolicyCreate, ZeroTrustPolicyResponse, ZTAPaginated,
)

load_dotenv()

DATABASE_URL = os.environ["DATABASE_URL"]
INTERNAL_API_KEY = os.environ["INTERNAL_API_KEY"]
MAX_PAGE_SIZE = int(os.getenv("MAX_PAGE_SIZE", "100"))
CORS_ORIGINS = os.getenv("CORS_ORIGINS", "http://localhost:3000")

engine = create_engine(DATABASE_URL, pool_pre_ping=True)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

def get_db() -> Session:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

INTERNAL_JWT_SECRET = os.environ.get("INTERNAL_JWT_SECRET", "")

async def verify_internal_key(x_internal_key: str = Header(...)):
    if x_internal_key != INTERNAL_API_KEY:
        raise HTTPException(status_code=403, detail="Invalid internal API key")
    return True

async def clamp_page_size(page_size: int = Query(50, ge=1, le=MAX_PAGE_SIZE)) -> int:
    return min(page_size, MAX_PAGE_SIZE)

@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
    yield

app = FastAPI(
    title="Atlas Security Service",
    description="NASA-Level Security: Zero-Trust, Conditional Access, Risk-Based Auth, PAM, DLP, Data Classification, Encryption Key Rotation, Data Residency, Session Recording",
    version="1.0.0",
    lifespan=lifespan,
    servers=[{"url": "http://localhost:8050", "description": "Local Development"}],
    openapi_tags=[
        {"name": "Zero Trust", "description": "Zero-trust policy engine for continuous verification"},
        {"name": "Conditional Access", "description": "Conditional access policies for contextual auth"},
        {"name": "Risk Assessment", "description": "Risk-based authentication engine"},
        {"name": "PAM", "description": "Privileged Access Management with JIT permissions"},
        {"name": "Data Classification", "description": "Data classification and labeling"},
        {"name": "DLP", "description": "Data Loss Prevention policies and incidents"},
        {"name": "Encryption Keys", "description": "Encryption key lifecycle and rotation"},
        {"name": "Data Residency", "description": "Data residency and sovereignty controls"},
        {"name": "Session Recording", "description": "Session recording for audit trails"},
        {"name": "Dashboard", "description": "Security operations dashboard"},
        {"name": "Health", "description": "Service health checks"},
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


# ── Health ──────────────────────────────────────────────────────────────────

@app.get("/health", response_model=HealthResponse, tags=["Health"])
async def health_check():
    return HealthResponse(status="healthy", service="security-service", version="1.0.0")

# ── Dashboard ───────────────────────────────────────────────────────────────

@app.get("/api/v1/security/dashboard", response_model=SecurityDashboard, tags=["Dashboard"])
async def security_dashboard(tenant_id: str = Query(...), db: Session = Depends(get_db)):
    return get_security_dashboard(db, tenant_id)

# ── Zero Trust Policies ─────────────────────────────────────────────────────

@app.get("/api/v1/security/zero-trust", response_model=ZTAPaginated, tags=["Zero Trust"])
async def list_zt(tenant_id: Optional[str] = Query(None), enabled: Optional[bool] = Query(None), page: int = Query(1, ge=1), page_size: int = Depends(clamp_page_size), db: Session = Depends(get_db)):
    return list_zt_policies(db, tenant_id, enabled, page, page_size)

@app.post("/api/v1/security/zero-trust", response_model=ZeroTrustPolicyResponse, status_code=201, tags=["Zero Trust"])
async def create_zt(payload: ZeroTrustPolicyCreate, db: Session = Depends(get_db)):
    return create_zt_policy(db, payload.model_dump())

@app.get("/api/v1/security/zero-trust/{policy_id}", response_model=ZeroTrustPolicyResponse, tags=["Zero Trust"])
async def get_zt(policy_id: uuid.UUID, db: Session = Depends(get_db)):
    policy = get_zt_policy(db, policy_id)
    if not policy:
        raise HTTPException(status_code=404, detail="Policy not found")
    return policy

@app.put("/api/v1/security/zero-trust/{policy_id}", response_model=ZeroTrustPolicyResponse, tags=["Zero Trust"])
async def update_zt(policy_id: uuid.UUID, payload: dict, db: Session = Depends(get_db)):
    updated = update_zt_policy(db, policy_id, payload)
    if not updated:
        raise HTTPException(status_code=404, detail="Policy not found")
    return updated

@app.delete("/api/v1/security/zero-trust/{policy_id}", tags=["Zero Trust"])
async def delete_zt(policy_id: uuid.UUID, db: Session = Depends(get_db)):
    if not delete_zt_policy(db, policy_id):
        raise HTTPException(status_code=404, detail="Policy not found")
    return {"message": "Policy deleted"}

@app.post("/api/v1/security/zero-trust/{policy_id}/evaluate", tags=["Zero Trust"])
async def evaluate_zt(policy_id: uuid.UUID, context: dict, db: Session = Depends(get_db)):
    policy = get_zt_policy(db, policy_id)
    if not policy:
        raise HTTPException(status_code=404, detail="Policy not found")
    return evaluate_zt_policy(policy, context)

# ── Conditional Access ──────────────────────────────────────────────────────

@app.get("/api/v1/security/conditional-access", response_model=CAPaginated, tags=["Conditional Access"])
async def list_ca(tenant_id: Optional[str] = Query(None), enabled: Optional[bool] = Query(None), page: int = Query(1, ge=1), page_size: int = Depends(clamp_page_size), db: Session = Depends(get_db)):
    return list_ca_policies(db, tenant_id, enabled, page, page_size)

@app.post("/api/v1/security/conditional-access", response_model=ConditionalAccessResponse, status_code=201, tags=["Conditional Access"])
async def create_ca(payload: ConditionalAccessCreate, db: Session = Depends(get_db)):
    return create_ca_policy(db, payload.model_dump())

@app.get("/api/v1/security/conditional-access/{policy_id}", response_model=ConditionalAccessResponse, tags=["Conditional Access"])
async def get_ca(policy_id: uuid.UUID, db: Session = Depends(get_db)):
    policy = get_ca_policy(db, policy_id)
    if not policy:
        raise HTTPException(status_code=404, detail="Policy not found")
    return policy

@app.put("/api/v1/security/conditional-access/{policy_id}", response_model=ConditionalAccessResponse, tags=["Conditional Access"])
async def update_ca(policy_id: uuid.UUID, payload: dict, db: Session = Depends(get_db)):
    updated = update_ca_policy(db, policy_id, payload)
    if not updated:
        raise HTTPException(status_code=404, detail="Policy not found")
    return updated

@app.delete("/api/v1/security/conditional-access/{policy_id}", tags=["Conditional Access"])
async def delete_ca(policy_id: uuid.UUID, db: Session = Depends(get_db)):
    if not delete_ca_policy(db, policy_id):
        raise HTTPException(status_code=404, detail="Policy not found")
    return {"message": "Policy deleted"}

@app.post("/api/v1/security/conditional-access/evaluate", tags=["Conditional Access"])
async def evaluate_all_ca(context: dict, tenant_id: str = Query(...), db: Session = Depends(get_db)):
    policies = list_ca_policies(db, tenant_id=tenant_id, enabled=True, page=1, page_size=100)
    results = []
    for p in policies["items"]:
        result = evaluate_ca_policy(p, context)
        if result["matched"]:
            results.append({"policy_id": str(p.id), "policy_name": p.name, **result})
    return {"matched_policies": results, "total_matched": len(results)}

# ── Risk-Based Authentication ───────────────────────────────────────────────

@app.post("/api/v1/security/risk/assess", response_model=RiskAssessmentResponse, tags=["Risk Assessment"])
async def assess_risk_endpoint(payload: RiskAssessmentRequest, db: Session = Depends(get_db)):
    result = assess_risk(db, payload.model_dump())
    return result

@app.get("/api/v1/security/risk/assessments", response_model=RiskPaginated, tags=["Risk Assessment"])
async def list_risk(tenant_id: Optional[str] = Query(None), user_id: Optional[str] = Query(None), page: int = Query(1, ge=1), page_size: int = Depends(clamp_page_size), db: Session = Depends(get_db)):
    return list_risk_assessments(db, tenant_id, user_id, page, page_size)

# ── Privileged Access Management ────────────────────────────────────────────

@app.get("/api/v1/security/pam/roles", tags=["PAM"])
async def list_pam_roles(tenant_id: Optional[str] = Query(None), db: Session = Depends(get_db)):
    return list_privileged_roles(db, tenant_id)

@app.post("/api/v1/security/pam/roles", response_model=PrivilegedRoleResponse, status_code=201, tags=["PAM"])
async def create_pam_role(payload: PrivilegedRoleCreate, db: Session = Depends(get_db)):
    return create_privileged_role(db, payload.model_dump())

@app.get("/api/v1/security/pam/roles/{role_id}", response_model=PrivilegedRoleResponse, tags=["PAM"])
async def get_pam_role(role_id: uuid.UUID, db: Session = Depends(get_db)):
    role = get_privileged_role(db, role_id)
    if not role:
        raise HTTPException(status_code=404, detail="Role not found")
    return role

@app.post("/api/v1/security/pam/requests", response_model=PrivilegedAccessResponse, tags=["PAM"])
async def request_pam(payload: PrivilegedAccessRequest, db: Session = Depends(get_db)):
    role = get_privileged_role(db, payload.role_id)
    if not role:
        raise HTTPException(status_code=404, detail="Role not found")
    if role.allowed_requester_roles and payload.requester_role not in role.allowed_requester_roles:
        logger.warning("pam.role_escalation_denied", extra={"user_id": payload.user_id, "role_id": str(payload.role_id), "requester_role": payload.requester_role})
        raise HTTPException(status_code=403, detail="Your role is not authorized to request this privileged access")
    return request_privileged_access(db, payload.model_dump())

@app.get("/api/v1/security/pam/requests", tags=["PAM"])
async def list_pam_requests(tenant_id: Optional[str] = Query(None), user_id: Optional[str] = Query(None), status: Optional[str] = Query(None), page: int = Query(1, ge=1), page_size: int = Depends(clamp_page_size), db: Session = Depends(get_db)):
    return list_privileged_access(db, tenant_id, user_id, status, page, page_size)

@app.post("/api/v1/security/pam/requests/{grant_id}/approve", response_model=PrivilegedAccessResponse, tags=["PAM"])
async def approve_pam(grant_id: uuid.UUID, approved_by: str = Query(...), db: Session = Depends(get_db)):
    grant = db.query(PrivilegedAccess).filter(PrivilegedAccess.id == grant_id).first()
    if not grant:
        raise HTTPException(status_code=404, detail="Grant not found")
    if grant.user_id == approved_by:
        logger.warning("pam.self_approval_denied", extra={"grant_id": str(grant_id), "user_id": grant.user_id})
        raise HTTPException(status_code=403, detail="Cannot approve your own privileged access request")
    return approve_privileged_access(db, grant_id, approved_by)

@app.post("/api/v1/security/pam/requests/{grant_id}/revoke", tags=["PAM"])
async def revoke_pam(grant_id: uuid.UUID, db: Session = Depends(get_db)):
    if not revoke_privileged_access(db, grant_id):
        raise HTTPException(status_code=404, detail="Grant not found")
    return {"message": "Access revoked"}

# ── Data Classification ─────────────────────────────────────────────────────

@app.get("/api/v1/security/data-classification", tags=["Data Classification"])
async def list_data_class(tenant_id: Optional[str] = Query(None), classification_level: Optional[str] = Query(None), db: Session = Depends(get_db)):
    return list_data_classifications(db, tenant_id, classification_level)

@app.post("/api/v1/security/data-classification", response_model=DataClassificationResponse, status_code=201, tags=["Data Classification"])
async def create_data_class(payload: DataClassificationCreate, db: Session = Depends(get_db)):
    return create_data_classification(db, payload.model_dump())

@app.get("/api/v1/security/data-classification/{dc_id}", response_model=DataClassificationResponse, tags=["Data Classification"])
async def get_data_class(dc_id: uuid.UUID, db: Session = Depends(get_db)):
    dc = get_data_classification(db, dc_id)
    if not dc:
        raise HTTPException(status_code=404, detail="Classification not found")
    return dc

@app.post("/api/v1/security/data-classification/{dc_id}/classify", tags=["Data Classification"])
async def classify_resource_endpoint(dc_id: uuid.UUID, resource_data: dict, db: Session = Depends(get_db)):
    dc = get_data_classification(db, dc_id)
    if not dc:
        raise HTTPException(status_code=404, detail="Classification not found")
    return classify_resource(dc, resource_data)

# ── DLP ─────────────────────────────────────────────────────────────────────

@app.get("/api/v1/security/dlp/policies", tags=["DLP"])
async def list_dlp(tenant_id: Optional[str] = Query(None), enabled: Optional[bool] = Query(None), db: Session = Depends(get_db)):
    return list_dlp_policies(db, tenant_id, enabled)

@app.post("/api/v1/security/dlp/policies", response_model=DLPPolicyResponse, status_code=201, tags=["DLP"])
async def create_dlp_policy_endpoint(payload: DLPPolicyCreate, db: Session = Depends(get_db)):
    return create_dlp_policy(db, payload.model_dump())

@app.get("/api/v1/security/dlp/policies/{policy_id}", response_model=DLPPolicyResponse, tags=["DLP"])
async def get_dlp_policy_endpoint(policy_id: uuid.UUID, db: Session = Depends(get_db)):
    policy = get_dlp_policy(db, policy_id)
    if not policy:
        raise HTTPException(status_code=404, detail="Policy not found")
    return policy

@app.get("/api/v1/security/dlp/incidents", response_model=DLPPaginated, tags=["DLP"])
async def list_dlp_incidents_endpoint(tenant_id: Optional[str] = Query(None), status: Optional[str] = Query(None), severity: Optional[str] = Query(None), page: int = Query(1, ge=1), page_size: int = Depends(clamp_page_size), db: Session = Depends(get_db)):
    return list_dlp_incidents(db, tenant_id, status, severity, page, page_size)

@app.post("/api/v1/security/dlp/incidents", response_model=DLPIncidentResponse, status_code=201, tags=["DLP"])
async def report_dlp_incident_endpoint(payload: dict, db: Session = Depends(get_db)):
    return report_dlp_incident(db, payload)

@app.put("/api/v1/security/dlp/incidents/{incident_id}/status", response_model=DLPIncidentResponse, tags=["DLP"])
async def update_dlp_incident_endpoint(incident_id: uuid.UUID, status: str = Query(...), db: Session = Depends(get_db)):
    updated = update_dlp_incident(db, incident_id, status)
    if not updated:
        raise HTTPException(status_code=404, detail="Incident not found")
    return updated

# ── Encryption Key Rotation ─────────────────────────────────────────────────

@app.get("/api/v1/security/encryption-keys", tags=["Encryption Keys"])
async def list_keys(tenant_id: Optional[str] = Query(None), status: Optional[str] = Query(None), db: Session = Depends(get_db)):
    return list_encryption_keys(db, tenant_id, status)

@app.post("/api/v1/security/encryption-keys", response_model=EncryptionKeyResponse, status_code=201, tags=["Encryption Keys"])
async def create_key(payload: EncryptionKeyCreate, db: Session = Depends(get_db)):
    return create_encryption_key(db, payload.model_dump())

@app.post("/api/v1/security/encryption-keys/{key_id}/rotate", tags=["Encryption Keys"])
async def rotate_key(key_id: str, payload: dict, db: Session = Depends(get_db)):
    result = rotate_encryption_key(db, key_id, payload)
    if "error" in result:
        raise HTTPException(status_code=404, detail=result["error"])
    return result

# ── Data Residency ──────────────────────────────────────────────────────────

@app.get("/api/v1/security/data-residency", tags=["Data Residency"])
async def list_residency(tenant_id: Optional[str] = Query(None), db: Session = Depends(get_db)):
    return list_data_residency_policies(db, tenant_id)

@app.post("/api/v1/security/data-residency", response_model=DataResidencyResponse, status_code=201, tags=["Data Residency"])
async def create_residency(payload: DataResidencyCreate, db: Session = Depends(get_db)):
    try:
        return create_data_residency(db, payload.model_dump())
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.post("/api/v1/security/data-residency/{policy_id}/check", tags=["Data Residency"])
async def check_residency(policy_id: uuid.UUID, target_region: str = Query(...), db: Session = Depends(get_db)):
    from crud import get_data_residency
    policy = get_data_residency(db, policy_id)
    if not policy:
        raise HTTPException(status_code=404, detail="Policy not found")
    return check_data_residency(policy, target_region)

# ── Session Recording ───────────────────────────────────────────────────────

@app.post("/api/v1/security/session-recordings/start", response_model=SessionRecordingResponse, status_code=201, tags=["Session Recording"])
async def start_recording(payload: dict, db: Session = Depends(get_db)):
    return start_session_recording(db, payload)

@app.post("/api/v1/security/session-recordings/{recording_id}/stop", response_model=SessionRecordingResponse, tags=["Session Recording"])
async def stop_recording(recording_id: uuid.UUID, db: Session = Depends(get_db)):
    recording = stop_session_recording(db, recording_id)
    if not recording:
        raise HTTPException(status_code=404, detail="Recording not found")
    return recording

@app.post("/api/v1/security/session-recordings/{recording_id}/events", response_model=SessionRecordingResponse, tags=["Session Recording"])
async def add_event(recording_id: uuid.UUID, event: SessionRecordingEvent, db: Session = Depends(get_db)):
    recording = add_session_event(db, recording_id, event.model_dump())
    if not recording:
        raise HTTPException(status_code=404, detail="Recording not found")
    return recording

@app.get("/api/v1/security/session-recordings", tags=["Session Recording"])
async def list_recordings(tenant_id: Optional[str] = Query(None), user_id: Optional[str] = Query(None), status: Optional[str] = Query(None), page: int = Query(1, ge=1), page_size: int = Depends(clamp_page_size), db: Session = Depends(get_db)):
    return list_session_recordings(db, tenant_id, user_id, status, page, page_size)
