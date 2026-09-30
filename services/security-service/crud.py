import hashlib
import hmac
import json
import math
import re
import uuid
from datetime import datetime, timezone
from typing import Optional
from sqlalchemy.orm import Session
from sqlalchemy import desc
import logging

logger = logging.getLogger("security-service")

MAX_REGEX_LENGTH = 1000


def safe_re_match(pattern: str, text: str, *args, **kwargs):
    if len(pattern) > MAX_REGEX_LENGTH:
        logger.warning("dlp.regex_pattern_too_long", extra={"pattern_length": len(pattern)})
        return None
    try:
        return re.match(pattern, text, *args, **kwargs)
    except re.error as e:
        logger.warning("dlp.regex_error", extra={"error": str(e)})
        return None


def safe_re_search(pattern: str, text: str, *args, **kwargs):
    if len(pattern) > MAX_REGEX_LENGTH:
        logger.warning("dlp.regex_pattern_too_long", extra={"pattern_length": len(pattern)})
        return None
    try:
        return re.search(pattern, text, *args, **kwargs)
    except re.error as e:
        logger.warning("dlp.regex_error", extra={"error": str(e)})
        return None


def safe_re_findall(pattern: str, text: str, *args, **kwargs):
    if len(pattern) > MAX_REGEX_LENGTH:
        logger.warning("dlp.regex_pattern_too_long", extra={"pattern_length": len(pattern)})
        return []
    try:
        return re.findall(pattern, text, *args, **kwargs)
    except re.error as e:
        logger.warning("dlp.regex_error", extra={"error": str(e)})
        return []

from models import (
    ZeroTrustPolicy, ConditionalAccessPolicy, RiskAssessment,
    PrivilegedRole, PrivilegedAccess, DataClassification,
    DLPPolicy, DLPIncident, EncryptionKey, DataResidencyPolicy,
    SessionRecording,
)

PAGE_SIZE = 50

def _require_tenant(tenant_id) -> str:
    if not tenant_id or not str(tenant_id).strip():
        raise ValueError("tenant_id is required")
    return str(tenant_id).strip()

def require_fields(data: dict, fields: list) -> None:
    if not isinstance(data, dict):
        raise ValueError("Request body must be a JSON object")
    missing = [f for f in fields if data.get(f) in (None, "")]
    if missing:
        raise ValueError(f"Missing required fields: {', '.join(missing)}")

def resolve_tenant(data: dict, context_tenant=None) -> str:
    body_tenant = data.get("tenant_id") if isinstance(data, dict) else None
    if context_tenant:
        if body_tenant and body_tenant != context_tenant:
            raise ValueError("Tenant mismatch between context and body")
        return context_tenant
    if not body_tenant:
        raise ValueError("Missing required fields: tenant_id")
    return body_tenant


class MassAssignmentError(ValueError):
    pass


def apply_updates(obj, data: dict, allowed_fields: set):
    unknown = [k for k in data.keys() if k not in allowed_fields]
    if unknown:
        raise MassAssignmentError(f"Unknown or read-only fields: {', '.join(sorted(unknown))}")
    for key in allowed_fields:
        if key in data:
            setattr(obj, key, data[key])
    return obj


def filter_create_data(data: dict, allowed_fields: set) -> dict:
    unknown = [k for k in data.keys() if k not in allowed_fields]
    if unknown:
        raise MassAssignmentError(f"Unknown or read-only fields: {', '.join(sorted(unknown))}")
    return {k: data[k] for k in allowed_fields if k in data}


ZT_CREATE_FIELDS = frozenset({"tenant_id", "name", "description", "enabled", "priority", "conditions", "actions"})
ZT_UPDATE_FIELDS = frozenset({"name", "description", "enabled", "priority", "conditions", "actions"})

CA_CREATE_FIELDS = frozenset({"tenant_id", "name", "description", "enabled", "conditions", "grant_controls", "session_controls"})
CA_UPDATE_FIELDS = frozenset({"name", "description", "enabled", "conditions", "grant_controls", "session_controls"})

PRIVILEGED_ROLE_CREATE_FIELDS = frozenset({"tenant_id", "name", "description", "permissions", "risk_level", "requires_approval", "max_duration_minutes", "allowed_requester_roles"})
DATA_CLASSIFICATION_CREATE_FIELDS = frozenset({"tenant_id", "resource_type", "resource_pattern", "classification_level", "category", "owner", "retention_days", "encryption_required", "masking_rules"})
DLP_POLICY_CREATE_FIELDS = frozenset({"tenant_id", "name", "description", "enabled", "severity", "rules", "actions"})
DLP_INCIDENT_CREATE_FIELDS = frozenset({"tenant_id", "policy_id", "user_id", "resource_type", "resource_id", "action", "data_classification", "description", "severity", "evidence"})
ENCRYPTION_KEY_CREATE_FIELDS = frozenset({"tenant_id", "key_id", "algorithm", "purpose", "version"})
DATA_RESIDENCY_CREATE_FIELDS = frozenset({"tenant_id", "region", "resource_type", "data_classification", "allowed_regions", "restricted_regions", "enforcement_mode", "enabled"})
SESSION_RECORDING_CREATE_FIELDS = frozenset({"tenant_id", "user_id", "session_id", "user_role", "recording_type", "events", "ip_address", "user_agent"})

def _paginate(query, page, page_size):
    total = query.count()
    items = query.offset((page - 1) * page_size).limit(page_size).all()
    return {
        "items": items,
        "total": total,
        "page": page,
        "page_size": page_size,
        "total_pages": math.ceil(total / page_size) if total > 0 else 1,
    }

# ── Zero Trust Policies ─────────────────────────────────────────────────────

def list_zt_policies(db: Session, tenant_id: str, enabled: bool = None, page: int = 1, page_size: int = PAGE_SIZE):
    tenant_id = _require_tenant(tenant_id)
    q = db.query(ZeroTrustPolicy).filter(ZeroTrustPolicy.tenant_id == tenant_id)
    if enabled is not None:
        q = q.filter(ZeroTrustPolicy.enabled == enabled)
    q = q.order_by(ZeroTrustPolicy.priority.asc())
    return _paginate(q, page, page_size)

def get_zt_policy(db: Session, policy_id: uuid.UUID):
    return db.query(ZeroTrustPolicy).filter(ZeroTrustPolicy.id == policy_id).first()

def create_zt_policy(db: Session, data: dict):
    policy = ZeroTrustPolicy(**filter_create_data(data, ZT_CREATE_FIELDS))
    db.add(policy)
    db.commit()
    db.refresh(policy)
    return policy

def update_zt_policy(db: Session, policy_id: uuid.UUID, data: dict):
    policy = db.query(ZeroTrustPolicy).filter(ZeroTrustPolicy.id == policy_id).first()
    if not policy:
        return None
    apply_updates(policy, data, ZT_UPDATE_FIELDS)
    policy.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(policy)
    return policy

def delete_zt_policy(db: Session, policy_id: uuid.UUID):
    policy = db.query(ZeroTrustPolicy).filter(ZeroTrustPolicy.id == policy_id).first()
    if not policy:
        return False
    db.delete(policy)
    db.commit()
    return True

def evaluate_zt_policy(policy: ZeroTrustPolicy, context: dict) -> dict:
    result = {"matched": False, "decision": "deny", "actions": []}
    conditions = policy.conditions
    user_risk = context.get("risk_score", 50)
    device_trusted = context.get("device_trusted", False)
    location = context.get("location", "unknown")
    ip_reputation = context.get("ip_reputation", "unknown")

    matched = True
    if "max_risk_score" in conditions and user_risk > conditions["max_risk_score"]:
        matched = False
    if "require_trusted_device" in conditions and conditions["require_trusted_device"] and not device_trusted:
        matched = False
    if "allowed_locations" in conditions and location not in conditions["allowed_locations"]:
        matched = False
    if "blocked_locations" in conditions and location in conditions["blocked_locations"]:
        matched = False
    if "allowed_ip_reputation" in conditions and ip_reputation not in conditions["allowed_ip_reputation"]:
        matched = False

    if matched:
        result["matched"] = True
        result["decision"] = policy.actions.get("decision", "allow")
        result["actions"] = policy.actions.get("enforce", [])
    return result

# ── Conditional Access ──────────────────────────────────────────────────────

def list_ca_policies(db: Session, tenant_id: str, enabled: bool = None, page: int = 1, page_size: int = PAGE_SIZE):
    tenant_id = _require_tenant(tenant_id)
    q = db.query(ConditionalAccessPolicy).filter(ConditionalAccessPolicy.tenant_id == tenant_id)
    if enabled is not None:
        q = q.filter(ConditionalAccessPolicy.enabled == enabled)
    q = q.order_by(ConditionalAccessPolicy.created_at.desc())
    return _paginate(q, page, page_size)

def get_ca_policy(db: Session, policy_id: uuid.UUID):
    return db.query(ConditionalAccessPolicy).filter(ConditionalAccessPolicy.id == policy_id).first()

def create_ca_policy(db: Session, data: dict):
    policy = ConditionalAccessPolicy(**filter_create_data(data, CA_CREATE_FIELDS))
    db.add(policy)
    db.commit()
    db.refresh(policy)
    return policy

def update_ca_policy(db: Session, policy_id: uuid.UUID, data: dict):
    policy = db.query(ConditionalAccessPolicy).filter(ConditionalAccessPolicy.id == policy_id).first()
    if not policy:
        return None
    apply_updates(policy, data, CA_UPDATE_FIELDS)
    policy.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(policy)
    return policy

def delete_ca_policy(db: Session, policy_id: uuid.UUID):
    policy = db.query(ConditionalAccessPolicy).filter(ConditionalAccessPolicy.id == policy_id).first()
    if not policy:
        return False
    db.delete(policy)
    db.commit()
    return True

def evaluate_ca_policy(policy: ConditionalAccessPolicy, context: dict) -> dict:
    result = {"matched": False, "grant_controls": [], "session_controls": []}
    conditions = policy.conditions
    matched = True

    user_groups = context.get("user_groups", [])
    if "include_groups" in conditions and conditions["include_groups"]:
        if not any(g in user_groups for g in conditions["include_groups"]):
            matched = False
    if "exclude_groups" in conditions and conditions["exclude_groups"]:
        if any(g in user_groups for g in conditions["exclude_groups"]):
            matched = False

    locations = context.get("locations", [])
    if "include_locations" in conditions and conditions["include_locations"]:
        if not any(l in locations for l in conditions["include_locations"]):
            matched = False
    if "exclude_locations" in conditions and conditions["exclude_locations"]:
        if any(l in locations for l in conditions["exclude_locations"]):
            matched = False

    platforms = context.get("device_platforms", [])
    if "include_platforms" in conditions and conditions["include_platforms"]:
        if not any(p in platforms for p in conditions["include_platforms"]):
            matched = False

    risk = context.get("risk_level", "low")
    if "max_risk_level" in conditions:
        levels = {"low": 1, "medium": 2, "high": 3, "critical": 4}
        if levels.get(risk, 0) > levels.get(conditions["max_risk_level"], 4):
            matched = False

    if matched:
        result["matched"] = True
        result["grant_controls"] = policy.grant_controls
        result["session_controls"] = policy.session_controls
    return result

# ── Risk-Based Authentication ───────────────────────────────────────────────

def assess_risk(db: Session, data: dict) -> dict:
    require_fields(data, ["tenant_id", "user_id"])
    score = 0
    factors = data.get("factors", {})

    if data.get("ip_address"):
        score += 10
        factors["ip_analyzed"] = True

    if not data.get("device_id"):
        score += 15
        factors["no_device_id"] = True

    login_hour = factors.get("login_hour")
    if login_hour is not None and (login_hour < 6 or login_hour > 22):
        score += 10
        factors["unusual_hour"] = True

    geo_velocity = factors.get("geo_velocity_kmh", 0)
    if geo_velocity > 800:
        score += 20
        factors["high_geo_velocity"] = True

    failed_attempts = factors.get("recent_failed_attempts", 0)
    if failed_attempts > 3:
        score += 15
        factors["multiple_failures"] = True

    new_country = factors.get("new_country", False)
    if new_country:
        score += 15
        factors["new_country"] = True

    unknown_browser = factors.get("unknown_browser", False)
    if unknown_browser:
        score += 10
        factors["unknown_browser"] = True

    vpn_usage = factors.get("vpn_usage", False)
    if vpn_usage:
        score += 5
        factors["vpn_detected"] = True

    anon_proxy = factors.get("anonymous_proxy", False)
    if anon_proxy:
        score += 20
        factors["anonymous_proxy"] = True

    if score > 100:
        score = 100
    if score < 0:
        score = 0

    if score <= 20:
        level = "low"
    elif score <= 50:
        level = "medium"
    elif score <= 75:
        level = "high"
    else:
        level = "critical"

    assessment = RiskAssessment(
        tenant_id=data["tenant_id"],
        user_id=data["user_id"],
        session_id=data.get("session_id"),
        risk_score=score,
        risk_level=level,
        factors=factors,
        ip_address=data.get("ip_address"),
        user_agent=data.get("user_agent"),
        device_id=data.get("device_id"),
        location=data.get("location"),
    )
    db.add(assessment)
    db.commit()
    db.refresh(assessment)

    return {
        "id": assessment.id,
        "risk_score": score,
        "risk_level": level,
        "factors": factors,
        "assessed_at": assessment.assessed_at.isoformat(),
    }

def list_risk_assessments(db: Session, tenant_id: str, user_id: str = None, page: int = 1, page_size: int = PAGE_SIZE):
    tenant_id = _require_tenant(tenant_id)
    q = db.query(RiskAssessment).filter(RiskAssessment.tenant_id == tenant_id)
    if user_id:
        q = q.filter(RiskAssessment.user_id == user_id)
    q = q.order_by(desc(RiskAssessment.assessed_at))
    return _paginate(q, page, page_size)

# ── Privileged Access Management ────────────────────────────────────────────

def list_privileged_roles(db: Session, tenant_id: str):
    tenant_id = _require_tenant(tenant_id)
    q = db.query(PrivilegedRole).filter(PrivilegedRole.tenant_id == tenant_id)
    return q.order_by(PrivilegedRole.name).all()

def create_privileged_role(db: Session, data: dict):
    role = PrivilegedRole(**filter_create_data(data, PRIVILEGED_ROLE_CREATE_FIELDS))
    db.add(role)
    db.commit()
    db.refresh(role)
    return role

def get_privileged_role(db: Session, role_id: uuid.UUID):
    return db.query(PrivilegedRole).filter(PrivilegedRole.id == role_id).first()

def request_privileged_access(db: Session, data: dict):
    require_fields(data, ["tenant_id", "user_id", "role_id"])
    grant = PrivilegedAccess(
        tenant_id=data["tenant_id"],
        user_id=data["user_id"],
        role_id=data["role_id"],
        justification=data.get("justification"),
        jit_enabled=data.get("jit_enabled", True),
        status="pending" if data.get("requires_approval", True) else "approved",
        start_time=datetime.now(timezone.utc),
    )
    if data.get("duration_minutes"):
        from datetime import timedelta
        grant.end_time = datetime.now(timezone.utc) + timedelta(minutes=data["duration_minutes"])
    db.add(grant)
    db.commit()
    db.refresh(grant)
    return grant

def list_privileged_access(db: Session, tenant_id: str, user_id: str = None, status: str = None, page: int = 1, page_size: int = PAGE_SIZE):
    tenant_id = _require_tenant(tenant_id)
    q = db.query(PrivilegedAccess).join(PrivilegedRole, PrivilegedAccess.role_id == PrivilegedRole.id, isouter=True).filter(PrivilegedAccess.tenant_id == tenant_id)
    if user_id:
        q = q.filter(PrivilegedAccess.user_id == user_id)
    if status:
        q = q.filter(PrivilegedAccess.status == status)
    q = q.order_by(desc(PrivilegedAccess.created_at))
    return _paginate(q, page, page_size)

def approve_privileged_access(db: Session, grant_id: uuid.UUID, approved_by: str):
    grant = db.query(PrivilegedAccess).filter(PrivilegedAccess.id == grant_id).first()
    if not grant:
        return None
    grant.status = "approved"
    grant.approved_by = approved_by
    grant.approved_at = datetime.now(timezone.utc)
    grant.start_time = datetime.now(timezone.utc)
    db.commit()
    db.refresh(grant)
    return grant

def revoke_privileged_access(db: Session, grant_id: uuid.UUID):
    grant = db.query(PrivilegedAccess).filter(PrivilegedAccess.id == grant_id).first()
    if not grant:
        return False
    grant.status = "revoked"
    grant.end_time = datetime.now(timezone.utc)
    db.commit()
    return True

# ── Data Classification ─────────────────────────────────────────────────────

def list_data_classifications(db: Session, tenant_id: str, classification_level: str = None):
    tenant_id = _require_tenant(tenant_id)
    q = db.query(DataClassification).filter(DataClassification.tenant_id == tenant_id)
    if classification_level:
        q = q.filter(DataClassification.classification_level == classification_level)
    return q.order_by(DataClassification.resource_type).all()

def create_data_classification(db: Session, data: dict):
    dc = DataClassification(**filter_create_data(data, DATA_CLASSIFICATION_CREATE_FIELDS))
    db.add(dc)
    db.commit()
    db.refresh(dc)
    return dc

def get_data_classification(db: Session, dc_id: uuid.UUID):
    return db.query(DataClassification).filter(DataClassification.id == dc_id).first()

def classify_resource(classification: DataClassification, resource_data: dict) -> dict:
    result = {
        "resource_type": classification.resource_type,
        "classification_level": classification.classification_level,
        "category": classification.category,
        "encryption_required": classification.encryption_required,
        "retention_days": classification.retention_days,
        "masking_rules": classification.masking_rules or {},
    }
    return result

# ── DLP ─────────────────────────────────────────────────────────────────────

def list_dlp_policies(db: Session, tenant_id: str, enabled: bool = None):
    tenant_id = _require_tenant(tenant_id)
    q = db.query(DLPPolicy).filter(DLPPolicy.tenant_id == tenant_id)
    if enabled is not None:
        q = q.filter(DLPPolicy.enabled == enabled)
    return q.order_by(DLPPolicy.created_at.desc()).all()

def create_dlp_policy(db: Session, data: dict):
    policy = DLPPolicy(**filter_create_data(data, DLP_POLICY_CREATE_FIELDS))
    db.add(policy)
    db.commit()
    db.refresh(policy)
    return policy

def get_dlp_policy(db: Session, policy_id: uuid.UUID):
    return db.query(DLPPolicy).filter(DLPPolicy.id == policy_id).first()

def list_dlp_incidents(db: Session, tenant_id: str, status: str = None, severity: str = None, page: int = 1, page_size: int = PAGE_SIZE):
    tenant_id = _require_tenant(tenant_id)
    q = db.query(DLPIncident).filter(DLPIncident.tenant_id == tenant_id)
    if status:
        q = q.filter(DLPIncident.status == status)
    if severity:
        q = q.filter(DLPIncident.severity == severity)
    q = q.order_by(desc(DLPIncident.detected_at))
    return _paginate(q, page, page_size)

def report_dlp_incident(db: Session, data: dict):
    require_fields(data, ["tenant_id"])
    incident = DLPIncident(**filter_create_data(data, DLP_INCIDENT_CREATE_FIELDS))
    db.add(incident)
    db.commit()
    db.refresh(incident)
    return incident

def update_dlp_incident(db: Session, incident_id: uuid.UUID, status: str):
    incident = db.query(DLPIncident).filter(DLPIncident.id == incident_id).first()
    if not incident:
        return None
    incident.status = status
    if status in ("resolved", "remediated"):
        incident.remediated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(incident)
    return incident

# ── Encryption Key Rotation ─────────────────────────────────────────────────

def list_encryption_keys(db: Session, tenant_id: str, status: str = None):
    tenant_id = _require_tenant(tenant_id)
    q = db.query(EncryptionKey).filter(EncryptionKey.tenant_id == tenant_id)
    if status:
        q = q.filter(EncryptionKey.status == status)
    return q.order_by(desc(EncryptionKey.version)).all()

def create_encryption_key(db: Session, data: dict):
    key = EncryptionKey(**filter_create_data(data, ENCRYPTION_KEY_CREATE_FIELDS))
    db.add(key)
    db.commit()
    db.refresh(key)
    return key

def rotate_encryption_key(db: Session, key_id_str: str, new_data: dict) -> dict:
    old_key = db.query(EncryptionKey).filter(
        EncryptionKey.key_id == key_id_str,
        EncryptionKey.status == "active"
    ).first()
    if not old_key:
        return {"error": "No active key found with that key_id"}
    old_key.status = "rotated"
    old_key.rotated_at = datetime.now(timezone.utc)
    # Generate a fresh unique key_id for the new key to avoid UNIQUE constraint violation.
    # The old implementation reused the same key_id which always fails because key_id is unique.
    # If the caller explicitly provides a different key_id, respect it; otherwise generate a new UUID.
    provided_key_id = new_data.get("key_id")
    if provided_key_id and provided_key_id != key_id_str:
        new_key_id = provided_key_id
    else:
        new_key_id = str(uuid.uuid4())
    new_key = EncryptionKey(
        tenant_id=old_key.tenant_id,
        key_id=new_key_id,
        algorithm=new_data.get("algorithm", old_key.algorithm),
        purpose=new_data.get("purpose", old_key.purpose),
        version=old_key.version + 1,
        rotated_from=str(old_key.id),
        expires_at=new_data.get("expires_at"),
    )
    db.add(new_key)
    try:
        db.commit()
    except Exception:
        db.rollback()
        raise
    db.refresh(new_key)
    return {"old_key_id": str(old_key.id), "new_key_id": str(new_key.id), "new_key_key_id": new_key.key_id, "version": new_key.version}

COUNTRY_CODES = {
    "US", "CA", "GB", "DE", "FR", "IT", "ES", "NL", "BE", "CH", "AT", "SE", "NO", "DK", "FI",
    "AU", "NZ", "JP", "CN", "KR", "SG", "IN", "BR", "MX", "AR", "ZA", "AE", "SA", "IL",
    "IE", "PT", "GR", "PL", "CZ", "HU", "RO", "RU", "TR", "BG", "HR", "LT", "LV", "EE",
    "SK", "SI", "MY", "TH", "VN", "PH", "ID", "HK", "TW", "CL", "CO", "PE", "EG", "NG",
    "KE", "MA", "QA", "KW", "BH", "OM", "UY", "CR", "PA", "DO",
}


def validate_country_code(country: str) -> bool:
    return country.upper() in COUNTRY_CODES


# ── Data Residency ──────────────────────────────────────────────────────────

def list_data_residency_policies(db: Session, tenant_id: str):
    tenant_id = _require_tenant(tenant_id)
    q = db.query(DataResidencyPolicy).filter(DataResidencyPolicy.tenant_id == tenant_id)
    return q.order_by(DataResidencyPolicy.region).all()

def create_data_residency(db: Session, data: dict):
    for region in data.get("allowed_regions", []) + data.get("restricted_regions", []) + [data.get("region", "")]:
        if region and not validate_country_code(region):
            raise ValueError(f"Invalid country code: {region}")
    policy = DataResidencyPolicy(**filter_create_data(data, DATA_RESIDENCY_CREATE_FIELDS))
    db.add(policy)
    db.commit()
    db.refresh(policy)
    return policy

def check_data_residency(policy: DataResidencyPolicy, target_region: str) -> dict:
    result = {
        "allowed": False,
        "enforcement_mode": policy.enforcement_mode,
        "policy_region": policy.region,
        "target_region": target_region,
        "resource_type": policy.resource_type,
        "valid_country": validate_country_code(target_region),
    }
    if not validate_country_code(target_region):
        result["allowed"] = False
        result["reason"] = "Unrecognized country code"
        return result
    if policy.allowed_regions:
        if target_region in policy.allowed_regions:
            result["allowed"] = True
    elif policy.restricted_regions:
        if target_region not in policy.restricted_regions:
            result["allowed"] = True
    else:
        if target_region == policy.region:
            result["allowed"] = True
    return result

# ── Session Recording ───────────────────────────────────────────────────────

def start_session_recording(db: Session, data: dict):
    require_fields(data, ["tenant_id", "user_id"])
    filtered = filter_create_data(data, SESSION_RECORDING_CREATE_FIELDS)
    recording = SessionRecording(
        tenant_id=filtered["tenant_id"],
        user_id=filtered["user_id"],
        session_id=filtered.get("session_id"),
        user_role=filtered.get("user_role"),
        recording_type=filtered.get("recording_type", "keystroke"),
        events=filtered.get("events", []),
        ip_address=filtered.get("ip_address"),
        user_agent=filtered.get("user_agent"),
        status="recording",
        started_at=datetime.now(timezone.utc),
    )
    db.add(recording)
    db.commit()
    db.refresh(recording)
    return recording

def stop_session_recording(db: Session, recording_id: uuid.UUID):
    recording = db.query(SessionRecording).filter(SessionRecording.id == recording_id).first()
    if not recording:
        return None
    recording.status = "completed"
    recording.ended_at = datetime.now(timezone.utc)
    if recording.started_at:
        recording.duration_seconds = int((recording.ended_at - recording.started_at).total_seconds())
    db.commit()
    db.refresh(recording)
    return recording

def add_session_event(db: Session, recording_id: uuid.UUID, event: dict):
    recording = db.query(SessionRecording).filter(SessionRecording.id == recording_id).first()
    if not recording:
        return None
    events = recording.events or []
    events.append(event)
    recording.events = events
    db.commit()
    db.refresh(recording)
    return recording

def list_session_recordings(db: Session, tenant_id: str, user_id: str = None, status: str = None, page: int = 1, page_size: int = PAGE_SIZE):
    tenant_id = _require_tenant(tenant_id)
    q = db.query(SessionRecording).filter(SessionRecording.tenant_id == tenant_id)
    if user_id:
        q = q.filter(SessionRecording.user_id == user_id)
    if status:
        q = q.filter(SessionRecording.status == status)
    q = q.order_by(desc(SessionRecording.started_at))
    return _paginate(q, page, page_size)

# ── Dashboard ───────────────────────────────────────────────────────────────

def get_security_dashboard(db: Session, tenant_id: str) -> dict:
    zt_total = db.query(ZeroTrustPolicy).filter(ZeroTrustPolicy.tenant_id == tenant_id).count()
    zt_active = db.query(ZeroTrustPolicy).filter(ZeroTrustPolicy.tenant_id == tenant_id, ZeroTrustPolicy.enabled == True).count()
    ca_total = db.query(ConditionalAccessPolicy).filter(ConditionalAccessPolicy.tenant_id == tenant_id).count()
    ca_active = db.query(ConditionalAccessPolicy).filter(ConditionalAccessPolicy.tenant_id == tenant_id, ConditionalAccessPolicy.enabled == True).count()
    risk_count = db.query(RiskAssessment).filter(RiskAssessment.tenant_id == tenant_id).count()
    high_risk = db.query(RiskAssessment).filter(RiskAssessment.tenant_id == tenant_id, RiskAssessment.risk_level.in_(["high", "critical"])).count()
    pam_active = db.query(PrivilegedAccess).filter(PrivilegedAccess.tenant_id == tenant_id, PrivilegedAccess.status == "approved").count()
    pam_pending = db.query(PrivilegedAccess).filter(PrivilegedAccess.tenant_id == tenant_id, PrivilegedAccess.status == "pending").count()
    dc_count = db.query(DataClassification).filter(DataClassification.tenant_id == tenant_id).count()
    dlp_pol_count = db.query(DLPPolicy).filter(DLPPolicy.tenant_id == tenant_id).count()
    dlp_open = db.query(DLPIncident).filter(DLPIncident.tenant_id == tenant_id, DLPIncident.status == "open").count()
    ek_total = db.query(EncryptionKey).filter(EncryptionKey.tenant_id == tenant_id).count()
    ek_active = db.query(EncryptionKey).filter(EncryptionKey.tenant_id == tenant_id, EncryptionKey.status == "active").count()
    dr_count = db.query(DataResidencyPolicy).filter(DataResidencyPolicy.tenant_id == tenant_id).count()
    sr_active = db.query(SessionRecording).filter(SessionRecording.tenant_id == tenant_id, SessionRecording.status == "recording").count()

    overall_risk = 0
    if risk_count > 0:
        avg_risk = db.query(RiskAssessment.risk_score).filter(RiskAssessment.tenant_id == tenant_id).order_by(desc(RiskAssessment.assessed_at)).limit(100).all()
        if avg_risk:
            overall_risk = sum(r[0] for r in avg_risk) // len(avg_risk)

    compliance_score = "healthy"
    if high_risk > 10 or dlp_open > 5:
        compliance_score = "needs_attention"
    if high_risk > 25 or dlp_open > 15:
        compliance_score = "critical"

    return {
        "zero_trust_policies": zt_total,
        "active_zt_policies": zt_active,
        "conditional_access_policies": ca_total,
        "active_ca_policies": ca_active,
        "pending_risk_assessments": risk_count,
        "high_risk_sessions": high_risk,
        "active_privileged_grants": pam_active,
        "pending_pam_requests": pam_pending,
        "data_classifications": dc_count,
        "dlp_policies": dlp_pol_count,
        "open_dlp_incidents": dlp_open,
        "encryption_keys": ek_total,
        "active_encryption_keys": ek_active,
        "data_residency_rules": dr_count,
        "session_recordings_active": sr_active,
        "overall_risk_score": overall_risk,
        "compliance_status": compliance_score,
    }
