import csv
import hashlib
import io
import json
from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from uuid import UUID

from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session, joinedload

from models import (
    AuditLog,
    CompliancePolicy,
    ComplianceViolation,
    DataRetentionPolicy,
    GDPRConsentRecord,
)


HASH_SALT: str = ""


def configure_hash_salt(salt: str) -> None:
    global HASH_SALT
    HASH_SALT = salt


def _compute_hash(
    previous_hash: str,
    event_type: str,
    actor_id: str,
    action: Optional[str],
    resource_type: Optional[str],
    resource_id: Optional[str],
    created_at: datetime,
) -> str:
    raw = (
        str(previous_hash or "")
        + str(event_type or "")
        + str(actor_id or "")
        + str(action or "")
        + str(resource_type or "")
        + str(resource_id or "")
        + created_at.isoformat()
        + HASH_SALT
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _get_latest_hash_for_tenant(db: Session, tenant_id: str) -> Optional[str]:
    entry = (
        db.query(AuditLog.hash)
        .filter(AuditLog.tenant_id == tenant_id)
        .order_by(AuditLog.created_at.desc())
        .first()
    )
    return entry[0] if entry else None


def _paginate_query(query, page: int, page_size: int):
    total = query.count()
    items = query.offset((page - 1) * page_size).limit(page_size).all()
    return {
        "items": items,
        "total": total,
        "page": page,
        "page_size": page_size,
        "total_pages": max(1, (total + page_size - 1) // page_size),
    }


def _build_date_filter(model_field, start_date: Optional[datetime], end_date: Optional[datetime]):
    clauses = []
    if start_date:
        clauses.append(model_field >= start_date)
    if end_date:
        clauses.append(model_field <= end_date)
    return clauses


def require_fields(data: dict, fields: list) -> None:
    if not isinstance(data, dict):
        raise ValueError("Request body must be a JSON object")
    missing = [f for f in fields if data.get(f) in (None, "")]
    if missing:
        raise ValueError(f"Missing required fields: {', '.join(missing)}")


def resolve_tenant(data: dict, context_tenant: Optional[str] = None) -> str:
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


def apply_updates(obj, data: dict[str, Any], allowed_fields: set):
    unknown = [k for k in data.keys() if k not in allowed_fields]
    if unknown:
        raise MassAssignmentError(f"Unknown or read-only fields: {', '.join(sorted(unknown))}")
    for key in allowed_fields:
        if key in data and data[key] is not None:
            setattr(obj, key, data[key])
    return obj


COMPLIANCE_POLICY_UPDATE_FIELDS = frozenset({"name", "description", "category", "severity", "rules", "enabled"})


# ── Audit Logs ──────────────────────────────────────────────────────────────

def create_audit_log(db: Session, data: dict[str, Any], salt: str) -> AuditLog:
    require_fields(data, ["tenant_id", "event_type", "actor_id"])
    previous_hash = _get_latest_hash_for_tenant(db, data["tenant_id"]) or ""
    now = datetime.now(timezone.utc)

    entry_hash = _compute_hash(
        previous_hash=previous_hash,
        event_type=data["event_type"],
        actor_id=data["actor_id"],
        action=data.get("action"),
        resource_type=data.get("resource_type"),
        resource_id=data.get("resource_id"),
        created_at=now,
    )

    log = AuditLog(
        tenant_id=data["tenant_id"],
        event_type=data["event_type"],
        actor_id=data["actor_id"],
        actor_email=data.get("actor_email"),
        action=data.get("action"),
        resource_type=data.get("resource_type"),
        resource_id=data.get("resource_id"),
        old_value=data.get("old_value"),
        new_value=data.get("new_value"),
        ip_address=data.get("ip_address"),
        user_agent=data.get("user_agent"),
        session_id=data.get("session_id"),
        device_fingerprint=data.get("device_fingerprint"),
        hash=entry_hash,
        previous_hash=previous_hash or None,
        metadata=data.get("metadata"),
        created_at=now,
    )
    db.add(log)
    db.commit()
    db.refresh(log)
    return log


def get_audit_log(db: Session, log_id: UUID) -> Optional[AuditLog]:
    return db.query(AuditLog).filter(AuditLog.id == log_id).first()


def list_audit_logs(
    db: Session,
    tenant_id: Optional[str] = None,
    event_type: Optional[str] = None,
    actor_id: Optional[str] = None,
    resource_type: Optional[str] = None,
    action: Optional[str] = None,
    start_date: Optional[datetime] = None,
    end_date: Optional[datetime] = None,
    page: int = 1,
    page_size: int = 50,
):
    q = db.query(AuditLog)

    filters = []
    if tenant_id:
        filters.append(AuditLog.tenant_id == tenant_id)
    if event_type:
        filters.append(AuditLog.event_type == event_type)
    if actor_id:
        filters.append(AuditLog.actor_id == actor_id)
    if resource_type:
        filters.append(AuditLog.resource_type == resource_type)
    if action:
        filters.append(AuditLog.action == action)

    date_filters = _build_date_filter(AuditLog.created_at, start_date, end_date)
    filters.extend(date_filters)

    if filters:
        q = q.filter(and_(*filters))

    q = q.order_by(AuditLog.created_at.desc())
    return _paginate_query(q, page, page_size)


def export_audit_logs_csv(
    db: Session,
    tenant_id: Optional[str] = None,
    event_type: Optional[str] = None,
    actor_id: Optional[str] = None,
    resource_type: Optional[str] = None,
    start_date: Optional[datetime] = None,
    end_date: Optional[datetime] = None,
) -> str:
    q = db.query(AuditLog)
    filters = []
    if tenant_id:
        filters.append(AuditLog.tenant_id == tenant_id)
    if event_type:
        filters.append(AuditLog.event_type == event_type)
    if actor_id:
        filters.append(AuditLog.actor_id == actor_id)
    if resource_type:
        filters.append(AuditLog.resource_type == resource_type)
    date_filters = _build_date_filter(AuditLog.created_at, start_date, end_date)
    filters.extend(date_filters)
    if filters:
        q = q.filter(and_(*filters))
    q = q.order_by(AuditLog.created_at.asc())

    logs = q.all()

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow([
        "id", "tenant_id", "event_type", "actor_id", "actor_email",
        "action", "resource_type", "resource_id", "ip_address",
        "session_id", "hash", "previous_hash", "created_at",
    ])
    for log in logs:
        writer.writerow([
            str(log.id), log.tenant_id, log.event_type, log.actor_id,
            log.actor_email or "", log.action or "", log.resource_type or "",
            log.resource_id or "", log.ip_address or "", log.session_id or "",
            log.hash, log.previous_hash or "",
            log.created_at.isoformat() if log.created_at else "",
        ])
    return output.getvalue()


def export_audit_logs_json(
    db: Session,
    tenant_id: Optional[str] = None,
    event_type: Optional[str] = None,
    actor_id: Optional[str] = None,
    resource_type: Optional[str] = None,
    start_date: Optional[datetime] = None,
    end_date: Optional[datetime] = None,
) -> str:
    q = db.query(AuditLog)
    filters = []
    if tenant_id:
        filters.append(AuditLog.tenant_id == tenant_id)
    if event_type:
        filters.append(AuditLog.event_type == event_type)
    if actor_id:
        filters.append(AuditLog.actor_id == actor_id)
    if resource_type:
        filters.append(AuditLog.resource_type == resource_type)
    date_filters = _build_date_filter(AuditLog.created_at, start_date, end_date)
    filters.extend(date_filters)
    if filters:
        q = q.filter(and_(*filters))
    q = q.order_by(AuditLog.created_at.asc())

    logs = q.all()
    result = []
    for log in logs:
        result.append({
            "id": str(log.id),
            "tenant_id": log.tenant_id,
            "event_type": log.event_type,
            "actor_id": log.actor_id,
            "actor_email": log.actor_email,
            "action": log.action,
            "resource_type": log.resource_type,
            "resource_id": log.resource_id,
            "ip_address": log.ip_address,
            "user_agent": log.user_agent,
            "session_id": log.session_id,
            "device_fingerprint": log.device_fingerprint,
            "hash": log.hash,
            "previous_hash": log.previous_hash,
            "created_at": log.created_at.isoformat() if log.created_at else None,
        })
    return json.dumps(result, indent=2, default=str)


# ── Compliance Policies ─────────────────────────────────────────────────────

def list_policies(
    db: Session,
    tenant_id: Optional[str] = None,
    category: Optional[str] = None,
    enabled: Optional[bool] = None,
    page: int = 1,
    page_size: int = 50,
):
    q = db.query(CompliancePolicy)
    filters = []
    if tenant_id:
        filters.append(CompliancePolicy.tenant_id == tenant_id)
    if category:
        filters.append(CompliancePolicy.category == category)
    if enabled is not None:
        filters.append(CompliancePolicy.enabled == enabled)
    if filters:
        q = q.filter(and_(*filters))
    q = q.order_by(CompliancePolicy.created_at.desc())
    return _paginate_query(q, page, page_size)


def get_policy(db: Session, policy_id: UUID) -> Optional[CompliancePolicy]:
    return db.query(CompliancePolicy).filter(CompliancePolicy.id == policy_id).first()


def create_policy(db: Session, data: dict[str, Any]) -> CompliancePolicy:
    require_fields(data, ["tenant_id", "name"])
    policy = CompliancePolicy(
        tenant_id=data["tenant_id"],
        name=data["name"],
        description=data.get("description"),
        category=data.get("category"),
        severity=data.get("severity"),
        rules=data.get("rules"),
        enabled=data.get("enabled", True),
    )
    db.add(policy)
    db.commit()
    db.refresh(policy)
    return policy


def update_policy(db: Session, policy_id: UUID, data: dict[str, Any]) -> Optional[CompliancePolicy]:
    policy = get_policy(db, policy_id)
    if not policy:
        return None
    apply_updates(policy, data, COMPLIANCE_POLICY_UPDATE_FIELDS)
    policy.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(policy)
    return policy


def delete_policy(db: Session, policy_id: UUID) -> bool:
    policy = get_policy(db, policy_id)
    if not policy:
        return False
    db.delete(policy)
    db.commit()
    return True


# ── Compliance Violations ───────────────────────────────────────────────────

def list_violations(
    db: Session,
    tenant_id: Optional[str] = None,
    policy_id: Optional[UUID] = None,
    employee_id: Optional[str] = None,
    severity: Optional[str] = None,
    status: Optional[str] = None,
    start_date: Optional[datetime] = None,
    end_date: Optional[datetime] = None,
    page: int = 1,
    page_size: int = 50,
):
    q = db.query(ComplianceViolation)
    filters = []
    if tenant_id:
        filters.append(ComplianceViolation.tenant_id == tenant_id)
    if policy_id:
        filters.append(ComplianceViolation.policy_id == policy_id)
    if employee_id:
        filters.append(ComplianceViolation.employee_id == employee_id)
    if severity:
        filters.append(ComplianceViolation.severity == severity)
    if status:
        filters.append(ComplianceViolation.status == status)
    date_filters = _build_date_filter(ComplianceViolation.detected_at, start_date, end_date)
    filters.extend(date_filters)
    if filters:
        q = q.filter(and_(*filters))
    q = q.order_by(ComplianceViolation.detected_at.desc())
    return _paginate_query(q, page, page_size)


def create_violation(db: Session, data: dict[str, Any]) -> ComplianceViolation:
    require_fields(data, ["tenant_id", "description"])
    violation = ComplianceViolation(
        tenant_id=data["tenant_id"],
        policy_id=data.get("policy_id"),
        employee_id=data.get("employee_id"),
        description=data["description"],
        severity=data.get("severity"),
        evidence=data.get("evidence"),
        assigned_to=data.get("assigned_to"),
    )
    db.add(violation)
    db.commit()
    db.refresh(violation)
    return violation


def update_violation_status(
    db: Session, violation_id: UUID, status: str
) -> Optional[ComplianceViolation]:
    violation = db.query(ComplianceViolation).filter(ComplianceViolation.id == violation_id).first()
    if not violation:
        return None
    violation.status = status
    if status == "REMEDIATED":
        violation.remediated_at = datetime.now(timezone.utc)
    else:
        violation.remediated_at = None
    db.commit()
    db.refresh(violation)
    return violation


# ── Compliance Summary ──────────────────────────────────────────────────────

def get_compliance_summary(db: Session, tenant_id: str) -> dict:
    total = db.query(ComplianceViolation).filter(
        ComplianceViolation.tenant_id == tenant_id
    ).count()
    open_count = db.query(ComplianceViolation).filter(
        ComplianceViolation.tenant_id == tenant_id,
        ComplianceViolation.status.in_(["OPEN", "INVESTIGATING"]),
    ).count()

    severity_rows = (
        db.query(ComplianceViolation.severity, func.count(ComplianceViolation.id))
        .filter(ComplianceViolation.tenant_id == tenant_id)
        .group_by(ComplianceViolation.severity)
        .all()
    )
    by_severity = {row[0] or "UNKNOWN": row[1] for row in severity_rows}

    status_rows = (
        db.query(ComplianceViolation.status, func.count(ComplianceViolation.id))
        .filter(ComplianceViolation.tenant_id == tenant_id)
        .group_by(ComplianceViolation.status)
        .all()
    )
    by_status = {row[0]: row[1] for row in status_rows}

    policy_rows = (
        db.query(
            CompliancePolicy.name, func.count(ComplianceViolation.id)
        )
        .join(ComplianceViolation, ComplianceViolation.policy_id == CompliancePolicy.id)
        .filter(ComplianceViolation.tenant_id == tenant_id)
        .group_by(CompliancePolicy.name)
        .all()
    )
    by_policy = {row[0]: row[1] for row in policy_rows}

    seven_days_ago = datetime.now(timezone.utc) - timedelta(days=7)
    trend_rows = (
        db.query(
            func.date_trunc("day", ComplianceViolation.detected_at).label("day"),
            func.count(ComplianceViolation.id),
        )
        .filter(
            ComplianceViolation.tenant_id == tenant_id,
            ComplianceViolation.detected_at >= seven_days_ago,
        )
        .group_by(func.date_trunc("day", ComplianceViolation.detected_at))
        .order_by(func.date_trunc("day", ComplianceViolation.detected_at).asc())
        .all()
    )
    recent_trend = [
        {"date": str(row[0]), "count": row[1]} for row in trend_rows
    ]

    return {
        "total_violations": total,
        "open_violations": open_count,
        "by_severity": by_severity,
        "by_policy": by_policy,
        "by_status": by_status,
        "recent_trend": recent_trend,
    }


# ── Compliance Scan ─────────────────────────────────────────────────────────

def trigger_compliance_scan(db: Session, tenant_id: str) -> list[ComplianceViolation]:
    policies = (
        db.query(CompliancePolicy)
        .filter(
            CompliancePolicy.tenant_id == tenant_id,
            CompliancePolicy.enabled == True,
        )
        .all()
    )
    new_violations: list[ComplianceViolation] = []

    for policy in policies:
        if not policy.rules:
            continue
        rules = policy.rules if isinstance(policy.rules, dict) else {}

        conditions = rules.get("conditions", [])
        for condition in conditions:
            violation = _evaluate_condition(db, tenant_id, policy, condition)
            if violation:
                db.add(violation)
                new_violations.append(violation)

    if new_violations:
        db.commit()
        for v in new_violations:
            db.refresh(v)

    return new_violations


def _evaluate_condition(
    db: Session, tenant_id: str, policy: CompliancePolicy, condition: dict
) -> Optional[ComplianceViolation]:
    field = condition.get("field", "")
    operator = condition.get("operator", "eq")
    value = condition.get("value")

    if field == "audit.action" and operator == "eq":
        count = (
            db.query(AuditLog)
            .filter(
                AuditLog.tenant_id == tenant_id,
                AuditLog.action == value,
            )
            .count()
        )
        threshold = condition.get("threshold", 0)
        if count > threshold:
            return ComplianceViolation(
                tenant_id=tenant_id,
                policy_id=policy.id,
                description=condition.get(
                    "message", f"Policy '{policy.name}' violated: {condition}"
                ),
                severity=policy.severity or "MEDIUM",
                evidence={"condition": condition, "triggered_count": count},
            )

    if field == "audit.event_type" and operator == "exists":
        count = (
            db.query(AuditLog)
            .filter(
                AuditLog.tenant_id == tenant_id,
                AuditLog.event_type == value,
            )
            .count()
        )
        if count > 0:
            return ComplianceViolation(
                tenant_id=tenant_id,
                policy_id=policy.id,
                description=condition.get(
                    "message", f"Policy '{policy.name}' violated: {condition}"
                ),
                severity=policy.severity or "MEDIUM",
                evidence={"condition": condition, "triggered_count": count},
            )

    if field == "consent" and operator == "missing":
        employee_id = condition.get("employee_id")
        consent_type = condition.get("consent_type")
        if employee_id and consent_type:
            existing = (
                db.query(GDPRConsentRecord)
                .filter(
                    GDPRConsentRecord.employee_id == employee_id,
                    GDPRConsentRecord.consent_type == consent_type,
                    GDPRConsentRecord.granted == True,
                )
                .first()
            )
            if not existing:
                return ComplianceViolation(
                    tenant_id=tenant_id,
                    policy_id=policy.id,
                    employee_id=employee_id,
                    description=condition.get(
                        "message",
                        f"Missing {consent_type} consent for employee {employee_id}",
                    ),
                    severity=policy.severity or "HIGH",
                    evidence={"condition": condition},
                )

    return None


# ── Compliance Reports ──────────────────────────────────────────────────────

def generate_compliance_report(
    db: Session, tenant_id: str, report_type: str
) -> dict:
    policies = (
        db.query(CompliancePolicy)
        .filter(CompliancePolicy.tenant_id == tenant_id)
        .all()
    )
    violations = (
        db.query(ComplianceViolation)
        .filter(ComplianceViolation.tenant_id == tenant_id)
        .all()
    )

    total_policies = len(policies)
    enabled_policies = sum(1 for p in policies if p.enabled)
    total_violations = len(violations)
    open_violations = sum(
        1 for v in violations if v.status in ("OPEN", "INVESTIGATING")
    )
    remediated_violations = sum(1 for v in violations if v.status == "REMEDIATED")

    findings = []
    recommendations = []

    if report_type.upper() == "SOC2":
        security_policies = [p for p in policies if p.category == "SOC2"]
        if not security_policies:
            recommendations.append(
                "Define SOC2-specific security policies"
            )
        for v in violations:
            if v.status in ("OPEN", "INVESTIGATING"):
                findings.append({
                    "type": "SOC2 Security",
                    "description": v.description,
                    "severity": v.severity,
                    "status": v.status,
                })
        if open_violations > 0:
            recommendations.append(
                f"Remediate {open_violations} open violations to achieve SOC2 compliance"
            )
        recommendations.append("Implement access controls and monitoring (CC6)")
        recommendations.append("Establish change management procedures (CC8)")

    elif report_type.upper() == "GDPR":
        consent_count = (
            db.query(GDPRConsentRecord)
            .filter(GDPRConsentRecord.tenant_id == tenant_id)
            .count()
        )
        if consent_count == 0:
            findings.append({
                "type": "GDPR Consent",
                "description": "No GDPR consent records found",
                "severity": "HIGH",
                "status": "OPEN",
            })
            recommendations.append("Implement consent management system")
        recommendations.append("Ensure Data Processing Agreements are in place")
        recommendations.append("Verify Right to be Forgotten mechanism")
        recommendations.append("Review data retention policies")

    elif report_type.upper() == "ISO27001":
        if total_policies == 0:
            recommendations.append("Define ISMS policies and controls")
        recommendations.append("Implement risk assessment framework (Clause 6.1)")
        recommendations.append("Establish internal audit program (Clause 9.2)")
        recommendations.append("Define corrective action process (Clause 10.1)")
        if open_violations > 0:
            findings.append({
                "type": "ISO27001 Non-conformity",
                "description": f"{open_violations} open non-conformities detected",
                "severity": "HIGH",
                "status": "OPEN",
            })

    status = "NON_COMPLIANT" if open_violations > 0 else "COMPLIANT"

    return {
        "category": report_type.upper(),
        "generated_at": datetime.now(timezone.utc),
        "tenant_id": tenant_id,
        "total_policies": total_policies,
        "enabled_policies": enabled_policies,
        "total_violations": total_violations,
        "open_violations": open_violations,
        "remediated_violations": remediated_violations,
        "status": status,
        "findings": findings,
        "recommendations": recommendations,
    }


# ── Data Retention Policies ─────────────────────────────────────────────────

def list_retention_policies(db: Session, tenant_id: Optional[str] = None):
    q = db.query(DataRetentionPolicy)
    if tenant_id:
        q = q.filter(DataRetentionPolicy.tenant_id == tenant_id)
    return q.all()


def create_retention_policy(db: Session, data: dict[str, Any]) -> DataRetentionPolicy:
    require_fields(data, ["resource_type", "retention_days"])
    policy = DataRetentionPolicy(
        tenant_id=data.get("tenant_id"),
        resource_type=data["resource_type"],
        retention_days=data["retention_days"],
        action=data.get("action"),
        enabled=data.get("enabled", True),
    )
    db.add(policy)
    db.commit()
    db.refresh(policy)
    return policy


# ── GDPR ────────────────────────────────────────────────────────────────────

def get_consents(
    db: Session, employee_id: str, tenant_id: Optional[str] = None
) -> list[GDPRConsentRecord]:
    q = db.query(GDPRConsentRecord).filter(
        GDPRConsentRecord.employee_id == employee_id
    )
    if tenant_id:
        q = q.filter(GDPRConsentRecord.tenant_id == tenant_id)
    return q.order_by(GDPRConsentRecord.granted_at.desc()).all()


def record_consent(db: Session, data: dict[str, Any]) -> GDPRConsentRecord:
    require_fields(data, ["employee_id", "consent_type"])
    if data.get("granted") is None:
        raise ValueError("Missing required fields: granted")
    if data.get("granted"):
        revoked_at = None
    else:
        revoked_at = datetime.now(timezone.utc)

    consent = GDPRConsentRecord(
        tenant_id=data.get("tenant_id"),
        employee_id=data["employee_id"],
        consent_type=data["consent_type"],
        granted=data["granted"],
        revoked_at=revoked_at,
        ip_address=data.get("ip_address"),
    )
    db.add(consent)
    db.commit()
    db.refresh(consent)
    return consent


def right_to_be_forgotten(
    db: Session, employee_id: str, tenant_id: Optional[str] = None
) -> dict:
    base_filters = [GDPRConsentRecord.employee_id == employee_id]
    if tenant_id:
        base_filters.append(GDPRConsentRecord.tenant_id == tenant_id)

    consent_records = (
        db.query(GDPRConsentRecord)
        .filter(and_(*base_filters))
        .all()
    )
    deleted_consent_count = len(consent_records)
    for record in consent_records:
        db.delete(record)

    audit_filters = [AuditLog.actor_id == employee_id]
    if tenant_id:
        audit_filters.append(AuditLog.tenant_id == tenant_id)

    audit_logs = (
        db.query(AuditLog)
        .filter(and_(*audit_filters))
        .all()
    )
    deleted_audit_count = len(audit_logs)
    for log in audit_logs:
        db.delete(log)

    db.commit()

    return {
        "employee_id": employee_id,
        "deleted_consent_records": deleted_consent_count,
        "deleted_audit_logs": deleted_audit_count,
        "anonymized_audit_logs": 0,
        "message": "Right to be forgotten executed successfully",
    }


def data_portability(
    db: Session, employee_id: str, tenant_id: Optional[str] = None
) -> dict:
    consents = get_consents(db, employee_id, tenant_id)

    v_filters = [ComplianceViolation.employee_id == employee_id]
    if tenant_id:
        v_filters.append(ComplianceViolation.tenant_id == tenant_id)
    violations = (
        db.query(ComplianceViolation)
        .filter(and_(*v_filters))
        .all()
    )

    a_filters = [AuditLog.actor_id == employee_id]
    if tenant_id:
        a_filters.append(AuditLog.tenant_id == tenant_id)

    from schemas import AuditLogResponse, ComplianceViolationResponse, GDPRConsentResponse

    audit_events_raw = (
        db.query(AuditLog)
        .filter(and_(*a_filters))
        .order_by(AuditLog.created_at.desc())
        .limit(500)
        .all()
    )

    return {
        "employee_id": employee_id,
        "consents": [
            {
                "id": str(c.id),
                "tenant_id": c.tenant_id,
                "employee_id": c.employee_id,
                "consent_type": c.consent_type,
                "granted": c.granted,
                "granted_at": c.granted_at.isoformat() if c.granted_at else None,
                "revoked_at": c.revoked_at.isoformat() if c.revoked_at else None,
                "ip_address": c.ip_address,
            }
            for c in consents
        ],
        "violations": [
            {
                "id": str(v.id),
                "tenant_id": v.tenant_id,
                "policy_id": str(v.policy_id) if v.policy_id else None,
                "employee_id": v.employee_id,
                "description": v.description,
                "severity": v.severity,
                "status": v.status,
                "detected_at": v.detected_at.isoformat() if v.detected_at else None,
                "remediated_at": v.remediated_at.isoformat() if v.remediated_at else None,
                "evidence": v.evidence,
                "assigned_to": v.assigned_to,
            }
            for v in violations
        ],
        "audit_events": [
            {
                "id": str(a.id),
                "tenant_id": a.tenant_id,
                "event_type": a.event_type,
                "actor_id": a.actor_id,
                "actor_email": a.actor_email,
                "action": a.action,
                "resource_type": a.resource_type,
                "resource_id": a.resource_id,
                "ip_address": a.ip_address,
                "user_agent": a.user_agent,
                "session_id": a.session_id,
                "hash": a.hash,
                "previous_hash": a.previous_hash,
                "created_at": a.created_at.isoformat() if a.created_at else None,
                "metadata": a.metadata,
            }
            for a in audit_events_raw
        ],
        "exported_at": datetime.now(timezone.utc).isoformat(),
    }
