import base64
import hashlib
import hmac
import json
import os
import time
from datetime import datetime, timezone
from typing import Any
from uuid import UUID, uuid4

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session, sessionmaker

os.environ.setdefault("INTERNAL_JWT_SECRET", "test-secret")

from crud import configure_hash_salt, _compute_hash
from models import Base, AuditLog, CompliancePolicy, ComplianceViolation
from main import (
    HASH_SALT,
    MAX_PAGE_SIZE,
    app,
    get_db,
)

TEST_DB_URL = os.getenv(
    "TEST_DATABASE_URL", "postgresql://atlas:atlas_pass@localhost:5432/atlas_audit_test"
)

engine = create_engine(TEST_DB_URL)
TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


@pytest.fixture(scope="session", autouse=True)
def setup_database():
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    yield
    Base.metadata.drop_all(bind=engine)


@pytest.fixture
def db_session():
    db = TestingSessionLocal()
    try:
        yield db
    finally:
        db.close()


@pytest.fixture
def override_get_db(db_session: Session):
    def _get_db():
        yield db_session

    return _get_db


@pytest.fixture
def client(override_get_db):
    app.dependency_overrides[get_db] = override_get_db
    transport = ASGITransport(app=app)

    async def _auto_auth(request):
        # Reads and non-audit writes go through the global x-internal-auth
        # middleware, so attach a tenant-matching writer token unless the test
        # set one explicitly. Audit-write POSTs are left alone so the
        # negative auth tests exercise the real checks.
        if request.url.path == "/api/v1/audit/log" and request.method == "POST":
            return
        if "x-internal-auth" not in request.headers:
            tenant = request.url.params.get("tenant_id", "default")
            request.headers["x-internal-auth"] = _mint_audit_writer_token(tenant_id=tenant)

    client = AsyncClient(
        transport=transport, base_url="http://test", event_hooks={"request": [_auto_auth]}
    )
    yield client
    app.dependency_overrides.clear()


INTERNAL_JWT_SECRET = os.environ.get("INTERNAL_JWT_SECRET", "test-secret")


def _mint_audit_writer_token(secret: str = None, audience="audit-writer", tenant_id: str = "default") -> str:
    secret = secret if secret is not None else INTERNAL_JWT_SECRET
    header = base64.urlsafe_b64encode(json.dumps({"alg": "HS256"}).encode()).rstrip(b"=").decode()
    payload = {
        "sub": "test-writer",
        "service": "test-writer",
        "tenant_id": tenant_id,
        "aud": audience,
        "exp": int(time.time()) + 3600,
    }
    payload_b64 = base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b"=").decode()
    signing_input = f"{header}.{payload_b64}"
    signature = base64.urlsafe_b64encode(
        hmac.new(secret.encode(), signing_input.encode(), hashlib.sha256).digest()
    ).rstrip(b"=").decode()
    return f"{signing_input}.{signature}"


def _auth_headers(tenant: str = "default", audience: str = "audit-writer") -> dict:
    return {"x-internal-auth": _mint_audit_writer_token(audience=audience, tenant_id=tenant)}


INTERNAL_HEADERS = {"x-internal-auth": _mint_audit_writer_token()}
TENANT_ID = "test-tenant-001"


# ── Helper ──────────────────────────────────────────────────────────────────

def _create_audit_payload(**overrides: Any) -> dict:
    payload = {
        "tenant_id": TENANT_ID,
        "event_type": "employee.created",
        "actor_id": "user-001",
        "actor_email": "admin@test.com",
        "action": "CREATE",
        "resource_type": "employee",
        "resource_id": "emp-001",
        "old_value": None,
        "new_value": {"name": "John Doe", "role": "Engineer"},
        "ip_address": "192.168.1.1",
        "user_agent": "pytest/1.0",
        "session_id": "sess-001",
        "device_fingerprint": "fp-001",
        "metadata": {"source": "pytest"},
    }
    payload.update(overrides)
    return payload


# ── Health ──────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_health_check(client: AsyncClient):
    resp = await client.get("/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "healthy"
    assert data["service"] == "audit-compliance-service"


# ── Audit Logs ──────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_create_audit_log(client: AsyncClient, db_session: Session):
    db_session.query(AuditLog).filter(AuditLog.tenant_id == TENANT_ID).delete()
    db_session.commit()

    payload = _create_audit_payload()
    resp = await client.post("/api/v1/audit/log", json=payload, headers=INTERNAL_HEADERS)
    assert resp.status_code == 201
    data = resp.json()
    assert data["event_type"] == "employee.created"
    assert data["actor_id"] == "user-001"
    assert data["hash"] is not None
    assert len(data["hash"]) == 64
    assert data["previous_hash"] is None
    assert data["id"] is not None
    UUID(data["id"])


@pytest.mark.asyncio
async def test_create_audit_log_requires_internal_auth(client: AsyncClient):
    payload = _create_audit_payload()
    resp = await client.post("/api/v1/audit/log", json=payload)
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_create_audit_log_with_wrong_key(client: AsyncClient):
    payload = _create_audit_payload()
    resp = await client.post(
        "/api/v1/audit/log",
        json=payload,
        headers={"x-internal-auth": _mint_audit_writer_token(secret="wrong-secret")},
    )
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_create_audit_log_requires_writer_audience(client: AsyncClient):
    payload = _create_audit_payload()
    resp = await client.post(
        "/api/v1/audit/log",
        json=payload,
        headers={"x-internal-auth": _mint_audit_writer_token(audience="someone-else")},
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_create_audit_log_accepts_service_shape(client: AsyncClient, db_session: Session):
    tenant = "test-service-shape"
    db_session.query(AuditLog).filter(AuditLog.tenant_id == tenant).delete()
    db_session.commit()

    resp = await client.post(
        "/api/v1/audit/log",
        json={
            "event_type": "auth.login",
            "user_id": 42,
            "email": "user@test.com",
            "timestamp": "2026-01-01T00:00:00+00:00",
            "details": {"session_id": "sess-1"},
            "service": "auth-service",
        },
        headers={"x-internal-auth": _mint_audit_writer_token(tenant_id=tenant)},
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["tenant_id"] == tenant
    assert data["actor_id"] == "42"


@pytest.mark.asyncio
async def test_create_audit_log_rejects_missing_event_type(client: AsyncClient):
    resp = await client.post(
        "/api/v1/audit/log", json={"user_id": 1}, headers=INTERNAL_HEADERS
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_hash_chain_two_entries(client: AsyncClient, db_session: Session):
    db_session.query(AuditLog).filter(AuditLog.tenant_id == "test-hash-chain").delete()
    db_session.commit()

    p1 = _create_audit_payload(tenant_id="test-hash-chain", event_type="first.entry")
    r1 = await client.post("/api/v1/audit/log", json=p1, headers=INTERNAL_HEADERS)
    assert r1.status_code == 201
    d1 = r1.json()
    assert d1["previous_hash"] is None

    p2 = _create_audit_payload(
        tenant_id="test-hash-chain", event_type="second.entry"
    )
    r2 = await client.post("/api/v1/audit/log", json=p2, headers=INTERNAL_HEADERS)
    assert r2.status_code == 201
    d2 = r2.json()
    assert d2["previous_hash"] == d1["hash"]


@pytest.mark.asyncio
async def test_list_audit_logs(client: AsyncClient, db_session: Session):
    tenant = "test-list-logs"
    db_session.query(AuditLog).filter(AuditLog.tenant_id == tenant).delete()
    db_session.commit()

    for i in range(3):
        p = _create_audit_payload(
            tenant_id=tenant,
            event_type=f"test.event.{i}",
            actor_id=f"user-{i:03d}",
        )
        r = await client.post("/api/v1/audit/log", json=p, headers=INTERNAL_HEADERS)
        assert r.status_code == 201

    resp = await client.get(f"/api/v1/audit/logs?tenant_id={tenant}&page_size=10")
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 3
    assert data["page"] == 1
    assert data["total_pages"] == 1
    assert len(data["items"]) == 3


@pytest.mark.asyncio
async def test_list_audit_logs_filter_event_type(client: AsyncClient, db_session: Session):
    tenant = "test-filter-etype"
    db_session.query(AuditLog).filter(AuditLog.tenant_id == tenant).delete()
    db_session.commit()

    await client.post(
        "/api/v1/audit/log",
        json=_create_audit_payload(tenant_id=tenant, event_type="alpha.event"),
        headers=INTERNAL_HEADERS,
    )
    await client.post(
        "/api/v1/audit/log",
        json=_create_audit_payload(tenant_id=tenant, event_type="beta.event"),
        headers=INTERNAL_HEADERS,
    )

    resp = await client.get(
        f"/api/v1/audit/logs?tenant_id={tenant}&event_type=alpha.event"
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 1


@pytest.mark.asyncio
async def test_get_audit_log_by_id(client: AsyncClient, db_session: Session):
    tenant = "test-get-by-id"
    db_session.query(AuditLog).filter(AuditLog.tenant_id == tenant).delete()
    db_session.commit()

    p = _create_audit_payload(tenant_id=tenant)
    create_resp = await client.post("/api/v1/audit/log", json=p, headers=INTERNAL_HEADERS)
    log_id = create_resp.json()["id"]

    resp = await client.get(f"/api/v1/audit/logs/{log_id}")
    assert resp.status_code == 200
    assert resp.json()["id"] == log_id


@pytest.mark.asyncio
async def test_get_audit_log_not_found(client: AsyncClient):
    resp = await client.get(f"/api/v1/audit/logs/{uuid4()}")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_export_audit_logs_json(client: AsyncClient, db_session: Session):
    tenant = "test-export-json"
    db_session.query(AuditLog).filter(AuditLog.tenant_id == tenant).delete()
    db_session.commit()

    await client.post(
        "/api/v1/audit/log",
        json=_create_audit_payload(tenant_id=tenant),
        headers=INTERNAL_HEADERS,
    )

    resp = await client.get(f"/api/v1/audit/logs/export?tenant_id={tenant}&format=json")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "application/json"
    data = json.loads(resp.content)
    assert len(data) >= 1


@pytest.mark.asyncio
async def test_export_audit_logs_csv(client: AsyncClient, db_session: Session):
    tenant = "test-export-csv"
    db_session.query(AuditLog).filter(AuditLog.tenant_id == tenant).delete()
    db_session.commit()

    await client.post(
        "/api/v1/audit/log",
        json=_create_audit_payload(tenant_id=tenant),
        headers=INTERNAL_HEADERS,
    )

    resp = await client.get(f"/api/v1/audit/logs/export?tenant_id={tenant}&format=csv")
    assert resp.status_code == 200
    assert "text/csv" in resp.headers["content-type"]


# ── Compliance Policies ─────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_create_compliance_policy(client: AsyncClient, db_session: Session):
    db_session.query(CompliancePolicy).filter(
        CompliancePolicy.tenant_id == TENANT_ID
    ).delete()
    db_session.commit()

    payload = {
        "tenant_id": TENANT_ID,
        "name": "SOC2 Access Control",
        "description": "Ensure proper access controls",
        "category": "SOC2",
        "severity": "HIGH",
        "rules": {
            "conditions": [
                {
                    "field": "audit.action",
                    "operator": "eq",
                    "value": "DELETE",
                    "threshold": 0,
                    "message": "Unauthorized DELETE operation detected",
                }
            ]
        },
        "enabled": True,
    }
    resp = await client.post("/api/v1/compliance/policies", json=payload)
    assert resp.status_code == 201
    data = resp.json()
    assert data["name"] == "SOC2 Access Control"
    assert data["category"] == "SOC2"
    UUID(data["id"])


@pytest.mark.asyncio
async def test_list_compliance_policies(client: AsyncClient, db_session: Session):
    tenant = "test-list-policies"
    db_session.query(CompliancePolicy).filter(
        CompliancePolicy.tenant_id == tenant
    ).delete()
    db_session.commit()

    for i in range(2):
        await client.post(
            "/api/v1/compliance/policies",
            json={
                "tenant_id": tenant,
                "name": f"Policy {i}",
                "category": "SOC2",
                "severity": "MEDIUM",
                "rules": {},
            },
        )

    resp = await client.get(f"/api/v1/compliance/policies?tenant_id={tenant}")
    assert resp.status_code == 200
    assert resp.json()["total"] == 2


@pytest.mark.asyncio
async def test_update_compliance_policy(client: AsyncClient, db_session: Session):
    tenant = "test-update-policy"
    db_session.query(CompliancePolicy).filter(
        CompliancePolicy.tenant_id == tenant
    ).delete()
    db_session.commit()

    create_resp = await client.post(
        "/api/v1/compliance/policies",
        json={
            "tenant_id": tenant,
            "name": "Original Policy",
            "category": "SOC2",
            "severity": "LOW",
            "rules": {},
        },
    )
    policy_id = create_resp.json()["id"]

    resp = await client.put(
        f"/api/v1/compliance/policies/{policy_id}",
        json={"name": "Updated Policy", "severity": "CRITICAL"},
    )
    assert resp.status_code == 200
    assert resp.json()["name"] == "Updated Policy"
    assert resp.json()["severity"] == "CRITICAL"


@pytest.mark.asyncio
async def test_delete_compliance_policy(client: AsyncClient, db_session: Session):
    tenant = "test-delete-policy"
    db_session.query(CompliancePolicy).filter(
        CompliancePolicy.tenant_id == tenant
    ).delete()
    db_session.commit()

    create_resp = await client.post(
        "/api/v1/compliance/policies",
        json={
            "tenant_id": tenant,
            "name": "Policy to Delete",
            "category": "GDPR",
            "severity": "HIGH",
            "rules": {},
        },
    )
    policy_id = create_resp.json()["id"]

    resp = await client.delete(f"/api/v1/compliance/policies/{policy_id}")
    assert resp.status_code == 200

    get_resp = await client.get(
        f"/api/v1/compliance/policies?tenant_id={tenant}"
    )
    assert get_resp.json()["total"] == 0


# ── Compliance Violations ───────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_create_compliance_violation(client: AsyncClient, db_session: Session):
    tenant = "test-create-violation"
    db_session.query(ComplianceViolation).filter(
        ComplianceViolation.tenant_id == tenant
    ).delete()
    db_session.commit()

    payload = {
        "tenant_id": tenant,
        "description": "Unauthorized access detected",
        "severity": "HIGH",
        "evidence": {"source": "test", "details": "Simulated violation"},
    }
    resp = await client.post("/api/v1/compliance/violations", json=payload)
    assert resp.status_code == 201
    data = resp.json()
    assert data["description"] == "Unauthorized access detected"
    assert data["status"] == "OPEN"
    UUID(data["id"])


@pytest.mark.asyncio
async def test_list_violations_with_filters(client: AsyncClient, db_session: Session):
    tenant = "test-list-violations"
    db_session.query(ComplianceViolation).filter(
        ComplianceViolation.tenant_id == tenant
    ).delete()
    db_session.commit()

    for sev in ["LOW", "MEDIUM", "HIGH"]:
        await client.post(
            "/api/v1/compliance/violations",
            json={
                "tenant_id": tenant,
                "description": f"{sev} severity violation",
                "severity": sev,
            },
        )

    resp = await client.get(
        f"/api/v1/compliance/violations?tenant_id={tenant}&severity=HIGH"
    )
    assert resp.status_code == 200
    assert resp.json()["total"] == 1


@pytest.mark.asyncio
async def test_update_violation_status(client: AsyncClient, db_session: Session):
    tenant = "test-update-vstatus"
    db_session.query(ComplianceViolation).filter(
        ComplianceViolation.tenant_id == tenant
    ).delete()
    db_session.commit()

    create_resp = await client.post(
        "/api/v1/compliance/violations",
        json={
            "tenant_id": tenant,
            "description": "Violation to remediate",
            "severity": "MEDIUM",
        },
    )
    viol_id = create_resp.json()["id"]

    resp = await client.put(
        f"/api/v1/compliance/violations/{viol_id}/status",
        json={"status": "REMEDIATED"},
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "REMEDIATED"
    assert resp.json()["remediated_at"] is not None


# ── Compliance Summary & Scan ──────────────────────────────────────────────

@pytest.mark.asyncio
async def test_compliance_summary(client: AsyncClient, db_session: Session):
    tenant = "test-summary"
    db_session.query(ComplianceViolation).filter(
        ComplianceViolation.tenant_id == tenant
    ).delete()
    db_session.commit()

    for sev in ["LOW", "LOW", "HIGH"]:
        await client.post(
            "/api/v1/compliance/violations",
            json={
                "tenant_id": tenant,
                "description": f"{sev} issue",
                "severity": sev,
            },
        )

    resp = await client.get(f"/api/v1/compliance/summary?tenant_id={tenant}")
    assert resp.status_code == 200
    data = resp.json()
    assert data["total_violations"] == 3
    assert data["open_violations"] == 3
    assert data["by_severity"].get("LOW", 0) == 2
    assert data["by_severity"].get("HIGH", 0) == 1


@pytest.mark.asyncio
async def test_compliance_scan(client: AsyncClient, db_session: Session):
    tenant = "test-scan"
    db_session.query(CompliancePolicy).filter(
        CompliancePolicy.tenant_id == tenant
    ).delete()
    db_session.commit()

    await client.post(
        "/api/v1/compliance/policies",
        json={
            "tenant_id": tenant,
            "name": "No Deletes",
            "category": "SOC2",
            "severity": "HIGH",
            "enabled": True,
            "rules": {
                "conditions": [
                    {
                        "field": "audit.action",
                        "operator": "eq",
                        "value": "DELETE",
                        "threshold": -1,
                        "message": "DELETE operations tracked",
                    }
                ]
            },
        },
    )

    resp = await client.post(f"/api/v1/compliance/scan?tenant_id={tenant}")
    assert resp.status_code == 200
    data = resp.json()
    assert "violations_count" in data


# ── Compliance Reports ──────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_compliance_report_soc2(client: AsyncClient, db_session: Session):
    tenant = "test-report-soc2"
    db_session.query(CompliancePolicy).filter(
        CompliancePolicy.tenant_id == tenant
    ).delete()
    db_session.commit()

    await client.post(
        "/api/v1/compliance/policies",
        json={
            "tenant_id": tenant,
            "name": "SOC2 Test Policy",
            "category": "SOC2",
            "severity": "HIGH",
            "rules": {},
        },
    )

    resp = await client.get(
        f"/api/v1/compliance/reports/SOC2?tenant_id={tenant}"
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["category"] == "SOC2"
    assert "total_policies" in data
    assert "findings" in data
    assert "recommendations" in data


@pytest.mark.asyncio
async def test_compliance_report_gdpr(client: AsyncClient):
    resp = await client.get(
        f"/api/v1/compliance/reports/GDPR?tenant_id=test-gdpr-report"
    )
    assert resp.status_code == 200
    assert resp.json()["category"] == "GDPR"


@pytest.mark.asyncio
async def test_compliance_report_invalid_type(client: AsyncClient):
    resp = await client.get(
        f"/api/v1/compliance/reports/INVALID?tenant_id=test"
    )
    assert resp.status_code == 400


# ── GDPR ────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_record_consent(client: AsyncClient, db_session: Session):
    payload = {
        "tenant_id": TENANT_ID,
        "employee_id": "emp-consent-001",
        "consent_type": "DATA_PROCESSING",
        "granted": True,
        "ip_address": "10.0.0.1",
    }
    resp = await client.post("/api/v1/gdpr/consents", json=payload)
    assert resp.status_code == 201
    data = resp.json()
    assert data["employee_id"] == "emp-consent-001"
    assert data["consent_type"] == "DATA_PROCESSING"
    assert data["granted"] is True
    assert data["revoked_at"] is None


@pytest.mark.asyncio
async def test_record_consent_revoked(client: AsyncClient):
    payload = {
        "tenant_id": TENANT_ID,
        "employee_id": "emp-consent-002",
        "consent_type": "MARKETING",
        "granted": False,
        "ip_address": "10.0.0.2",
    }
    resp = await client.post("/api/v1/gdpr/consents", json=payload)
    assert resp.status_code == 201
    data = resp.json()
    assert data["granted"] is False
    assert data["revoked_at"] is not None


@pytest.mark.asyncio
async def test_get_consents(client: AsyncClient, db_session: Session):
    emp_id = "emp-get-consents"
    await client.post(
        "/api/v1/gdpr/consents",
        json={
            "tenant_id": TENANT_ID,
            "employee_id": emp_id,
            "consent_type": "ANALYTICS",
            "granted": True,
        },
    )

    resp = await client.get(f"/api/v1/gdpr/consents/{emp_id}")
    assert resp.status_code == 200
    data = resp.json()
    assert isinstance(data, list)
    assert any(c["employee_id"] == emp_id for c in data)


@pytest.mark.asyncio
async def test_right_to_be_forgotten(client: AsyncClient, db_session: Session):
    emp_id = "emp-forget-001"

    await client.post(
        "/api/v1/gdpr/consents",
        json={
            "tenant_id": TENANT_ID,
            "employee_id": emp_id,
            "consent_type": "DATA_PROCESSING",
            "granted": True,
        },
    )
    await client.post(
        "/api/v1/gdpr/consents",
        json={
            "tenant_id": TENANT_ID,
            "employee_id": emp_id,
            "consent_type": "BIOMETRIC",
            "granted": True,
        },
    )

    resp = await client.post(f"/api/v1/gdpr/forget/{emp_id}")
    assert resp.status_code == 200
    data = resp.json()
    assert data["employee_id"] == emp_id
    assert data["deleted_consent_records"] >= 2
    assert data["message"] == "Right to be forgotten executed successfully"


@pytest.mark.asyncio
async def test_data_portability(client: AsyncClient, db_session: Session):
    emp_id = "emp-port-001"

    await client.post(
        "/api/v1/gdpr/consents",
        json={
            "tenant_id": TENANT_ID,
            "employee_id": emp_id,
            "consent_type": "DATA_PROCESSING",
            "granted": True,
        },
    )

    resp = await client.get(f"/api/v1/gdpr/data-portability/{emp_id}")
    assert resp.status_code == 200
    data = resp.json()
    assert data["employee_id"] == emp_id
    assert "consents" in data
    assert "violations" in data
    assert "audit_events" in data
    assert "exported_at" in data


# ── Hash Chain Integrity ────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_verify_chain_integrity_intact(client: AsyncClient, db_session: Session):
    tenant = "test-verify-intact"
    db_session.query(AuditLog).filter(AuditLog.tenant_id == tenant).delete()
    db_session.commit()

    for i in range(3):
        await client.post(
            "/api/v1/audit/log",
            json=_create_audit_payload(tenant_id=tenant, event_type=f"chain.event.{i}"),
            headers=INTERNAL_HEADERS,
        )

    resp = await client.get(f"/api/v1/audit/verify-chain?tenant_id={tenant}")
    assert resp.status_code == 200
    data = resp.json()
    assert data["chain_intact"] is True
    assert data["total_entries"] == 3
    assert len(data["issues"]) == 0


@pytest.mark.asyncio
async def test_verify_chain_integrity_tampered(client: AsyncClient, db_session: Session):
    tenant = "test-verify-tampered"
    db_session.query(AuditLog).filter(AuditLog.tenant_id == tenant).delete()
    db_session.commit()

    await client.post(
        "/api/v1/audit/log",
        json=_create_audit_payload(tenant_id=tenant, event_type="original.event"),
        headers=INTERNAL_HEADERS,
    )

    db_session.query(AuditLog).filter(
        AuditLog.tenant_id == tenant
    ).update({"event_type": "tampered.event"})
    db_session.commit()

    resp = await client.get(f"/api/v1/audit/verify-chain?tenant_id={tenant}")
    assert resp.status_code == 200
    data = resp.json()
    assert data["chain_intact"] is False
    assert len(data["issues"]) > 0


# ── Retryreceiveion Policies ──────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_create_retention_policy(client: AsyncClient, db_session: Session):
    payload = {
        "tenant_id": TENANT_ID,
        "resource_type": "employee_records",
        "retention_days": 365,
        "action": "ARCHIVE",
        "enabled": True,
    }
    resp = await client.post("/api/v1/compliance/retention-policies", json=payload)
    assert resp.status_code == 201
    data = resp.json()
    assert data["resource_type"] == "employee_records"
    assert data["retention_days"] == 365
    UUID(data["id"])


@pytest.mark.asyncio
async def test_list_retention_policies(client: AsyncClient, db_session: Session):
    resp = await client.get(
        f"/api/v1/compliance/retention-policies?tenant_id={TENANT_ID}"
    )
    assert resp.status_code == 200
    data = resp.json()
    assert isinstance(data, list)


# ── Page Size Clamping ──────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_page_size_clamping(client: AsyncClient):
    resp = await client.get(
        f"/api/v1/audit/logs?tenant_id=test-clamp&page_size={MAX_PAGE_SIZE + 100}"
    )
    assert resp.status_code == 200


# ── _compute_hash Unit Test ─────────────────────────────────────────────────

def test_compute_hash_deterministic():
    configure_hash_salt("test-salt")
    ts = datetime(2025, 1, 1, 0, 0, 0, tzinfo=timezone.utc)
    h1 = _compute_hash("prevhash", "event", "actor", "CREATE", "emp", "123", ts)
    h2 = _compute_hash("prevhash", "event", "actor", "CREATE", "emp", "123", ts)
    assert h1 == h2

    h3 = _compute_hash("different", "event", "actor", "CREATE", "emp", "123", ts)
    assert h1 != h3


def test_compute_hash_length():
    configure_hash_salt("test-salt")
    ts = datetime.now(timezone.utc)
    h = _compute_hash("", "evt", "act", None, None, None, ts)
    assert len(h) == 64
    assert isinstance(h, str)
