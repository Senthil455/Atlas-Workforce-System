from datetime import datetime
from typing import Any, Generic, Optional, TypeVar
from uuid import UUID

from pydantic import BaseModel, Field

T = TypeVar("T")


class AuditLogCreate(BaseModel):
    tenant_id: str = Field(..., max_length=50)
    event_type: str = Field(..., max_length=100)
    actor_id: str = Field(..., max_length=100)
    actor_email: Optional[str] = Field(None, max_length=255)
    action: Optional[str] = Field(None, max_length=50)
    resource_type: Optional[str] = Field(None, max_length=100)
    resource_id: Optional[str] = Field(None, max_length=100)
    old_value: Optional[Any] = None
    new_value: Optional[Any] = None
    ip_address: Optional[str] = Field(None, max_length=45)
    user_agent: Optional[str] = None
    session_id: Optional[str] = Field(None, max_length=100)
    device_fingerprint: Optional[str] = Field(None, max_length=255)
    metadata: Optional[dict[str, Any]] = None


class AuditLogResponse(BaseModel):
    id: UUID
    tenant_id: str
    event_type: str
    actor_id: str
    actor_email: Optional[str] = None
    action: Optional[str] = None
    resource_type: Optional[str] = None
    resource_id: Optional[str] = None
    old_value: Optional[Any] = None
    new_value: Optional[Any] = None
    ip_address: Optional[str] = None
    user_agent: Optional[str] = None
    session_id: Optional[str] = None
    device_fingerprint: Optional[str] = None
    hash: str
    previous_hash: Optional[str] = None
    metadata: Optional[dict[str, Any]] = None
    created_at: datetime

    model_config = {"from_attributes": True}


class PaginatedResponse(BaseModel, Generic[T]):
    items: list[T]
    total: int
    page: int
    page_size: int
    total_pages: int


class AuditLogPaginated(PaginatedResponse[AuditLogResponse]):
    pass



class CompliancePolicyCreate(BaseModel):
    model_config = {"extra": "forbid"}

    tenant_id: str = Field(..., max_length=50)
    name: str = Field(..., max_length=200)
    description: Optional[str] = None
    category: Optional[str] = Field(None, max_length=50)
    severity: Optional[str] = Field(None, max_length=20)
    rules: Optional[Any] = None
    enabled: bool = True


class CompliancePolicyUpdate(BaseModel):
    model_config = {"extra": "forbid"}

    name: Optional[str] = Field(None, max_length=200)
    description: Optional[str] = None
    category: Optional[str] = Field(None, max_length=50)
    severity: Optional[str] = Field(None, max_length=20)
    rules: Optional[Any] = None
    enabled: Optional[bool] = None


class CompliancePolicyResponse(BaseModel):
    id: UUID
    tenant_id: str
    name: str
    description: Optional[str] = None
    category: Optional[str] = None
    severity: Optional[str] = None
    rules: Optional[Any] = None
    enabled: bool
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class ComplianceViolationCreate(BaseModel):
    tenant_id: str = Field(..., max_length=50)
    policy_id: Optional[UUID] = None
    employee_id: Optional[str] = Field(None, max_length=100)
    description: str
    severity: Optional[str] = Field(None, max_length=20)
    evidence: Optional[Any] = None
    assigned_to: Optional[str] = Field(None, max_length=100)


class ComplianceViolationStatusUpdate(BaseModel):
    status: str = Field(..., max_length=20)


class ComplianceViolationResponse(BaseModel):
    id: UUID
    tenant_id: str
    policy_id: Optional[UUID] = None
    employee_id: Optional[str] = None
    description: str
    severity: Optional[str] = None
    status: str
    detected_at: datetime
    remediated_at: Optional[datetime] = None
    evidence: Optional[Any] = None
    assigned_to: Optional[str] = None

    model_config = {"from_attributes": True}


class ComplianceViolationPaginated(PaginatedResponse[ComplianceViolationResponse]):
    pass


class DataRetentionPolicyCreate(BaseModel):
    tenant_id: Optional[str] = Field(None, max_length=50)
    resource_type: str = Field(..., max_length=100)
    retention_days: int
    action: Optional[str] = Field(None, max_length=20)
    enabled: bool = True


class DataRetentionPolicyResponse(BaseModel):
    id: UUID
    tenant_id: Optional[str] = None
    resource_type: str
    retention_days: int
    action: Optional[str] = None
    enabled: bool

    model_config = {"from_attributes": True}


class GDPRConsentCreate(BaseModel):
    tenant_id: Optional[str] = Field(None, max_length=50)
    employee_id: str = Field(..., max_length=100)
    consent_type: str = Field(..., max_length=50)
    granted: bool
    ip_address: Optional[str] = Field(None, max_length=45)


class GDPRConsentResponse(BaseModel):
    id: UUID
    tenant_id: Optional[str] = None
    employee_id: str
    consent_type: str
    granted: bool
    granted_at: datetime
    revoked_at: Optional[datetime] = None
    ip_address: Optional[str] = None

    model_config = {"from_attributes": True}


class ComplianceSummary(BaseModel):
    total_violations: int
    open_violations: int
    by_severity: dict[str, int]
    by_policy: dict[str, int]
    by_status: dict[str, int]
    recent_trend: list[dict[str, Any]]


class ComplianceReport(BaseModel):
    category: str
    generated_at: datetime
    tenant_id: str
    total_policies: int
    enabled_policies: int
    total_violations: int
    open_violations: int
    remediated_violations: int
    status: str
    findings: list[dict[str, Any]]
    recommendations: list[str]


class ForgetResponse(BaseModel):
    employee_id: str
    deleted_consent_records: int
    deleted_audit_logs: int
    anonymized_audit_logs: int
    message: str


class DataPortabilityResponse(BaseModel):
    employee_id: str
    consents: list[GDPRConsentResponse]
    violations: list[ComplianceViolationResponse]
    audit_events: list[AuditLogResponse]
    exported_at: datetime


class MessageResponse(BaseModel):
    message: str


class HealthResponse(BaseModel):
    status: str
    service: str
    version: str
