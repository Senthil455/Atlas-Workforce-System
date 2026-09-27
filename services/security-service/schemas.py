from datetime import datetime
from typing import Any, Generic, Optional, TypeVar
from uuid import UUID
from pydantic import BaseModel, Field

T = TypeVar("T")

class ZeroTrustPolicyCreate(BaseModel):
    tenant_id: str = Field(..., max_length=50)
    name: str = Field(..., max_length=200)
    description: Optional[str] = None
    enabled: bool = True
    priority: int = 100
    conditions: dict[str, Any] = {}
    actions: dict[str, Any] = {}

class ZeroTrustPolicyResponse(BaseModel):
    id: UUID
    tenant_id: str
    name: str
    description: Optional[str]
    enabled: bool
    priority: int
    conditions: dict[str, Any]
    actions: dict[str, Any]
    created_at: datetime
    updated_at: datetime
    model_config = {"from_attributes": True}

class ConditionalAccessCreate(BaseModel):
    tenant_id: str = Field(..., max_length=50)
    name: str = Field(..., max_length=200)
    description: Optional[str] = None
    enabled: bool = True
    conditions: dict[str, Any] = {}
    grant_controls: dict[str, Any] = {}
    session_controls: dict[str, Any] = {}

class ConditionalAccessResponse(BaseModel):
    id: UUID
    tenant_id: str
    name: str
    description: Optional[str]
    enabled: bool
    conditions: dict[str, Any]
    grant_controls: dict[str, Any]
    session_controls: dict[str, Any]
    created_at: datetime
    updated_at: datetime
    model_config = {"from_attributes": True}

class RiskAssessmentRequest(BaseModel):
    tenant_id: str = Field(..., max_length=50)
    user_id: str = Field(..., max_length=100)
    session_id: Optional[str] = None
    ip_address: Optional[str] = None
    user_agent: Optional[str] = None
    device_id: Optional[str] = None
    location: Optional[dict[str, Any]] = None
    factors: dict[str, Any] = {}

class RiskAssessmentResponse(BaseModel):
    id: UUID
    tenant_id: str
    user_id: str
    session_id: Optional[str]
    risk_score: int
    risk_level: str
    factors: dict[str, Any]
    ip_address: Optional[str]
    user_agent: Optional[str]
    device_id: Optional[str]
    location: Optional[dict[str, Any]]
    assessed_at: datetime
    model_config = {"from_attributes": True}

class PrivilegedRoleCreate(BaseModel):
    tenant_id: str = Field(..., max_length=50)
    name: str = Field(..., max_length=200)
    description: Optional[str] = None
    permissions: list[str] = []
    risk_level: str = "high"
    requires_approval: bool = True
    max_duration_minutes: int = 480
    allowed_requester_roles: list[str] = []

class PrivilegedRoleResponse(BaseModel):
    id: UUID
    tenant_id: str
    name: str
    description: Optional[str]
    permissions: list[str]
    risk_level: str
    requires_approval: bool
    max_duration_minutes: int
    allowed_requester_roles: list[str] = []
    created_at: datetime
    updated_at: datetime
    model_config = {"from_attributes": True}

class PrivilegedAccessRequest(BaseModel):
    tenant_id: str = Field(..., max_length=50)
    user_id: str = Field(..., max_length=100)
    role_id: UUID
    justification: Optional[str] = None
    jit_enabled: bool = True
    duration_minutes: Optional[int] = None
    requester_role: Optional[str] = Field(None, max_length=100)

class PrivilegedAccessResponse(BaseModel):
    id: UUID
    tenant_id: str
    user_id: str
    role_id: UUID
    role_name: Optional[str] = None
    granted_by: Optional[str]
    justification: Optional[str]
    jit_enabled: bool
    start_time: Optional[datetime]
    end_time: Optional[datetime]
    status: str
    approved_by: Optional[str]
    approved_at: Optional[datetime]
    created_at: datetime
    model_config = {"from_attributes": True}

class DataClassificationCreate(BaseModel):
    tenant_id: str = Field(..., max_length=50)
    resource_type: str = Field(..., max_length=100)
    resource_pattern: Optional[str] = None
    classification_level: str = Field(..., max_length=50)
    category: Optional[str] = None
    owner: Optional[str] = None
    retention_days: Optional[int] = None
    encryption_required: bool = True
    masking_rules: Optional[dict[str, Any]] = None

class DataClassificationResponse(BaseModel):
    id: UUID
    tenant_id: str
    resource_type: str
    resource_pattern: Optional[str]
    classification_level: str
    category: Optional[str]
    owner: Optional[str]
    retention_days: Optional[int]
    encryption_required: bool
    masking_rules: Optional[dict[str, Any]]
    created_at: datetime
    updated_at: datetime
    model_config = {"from_attributes": True}

class DLPPolicyCreate(BaseModel):
    tenant_id: str = Field(..., max_length=50)
    name: str = Field(..., max_length=200)
    description: Optional[str] = None
    enabled: bool = True
    severity: str = "medium"
    rules: dict[str, Any] = {}
    actions: list[str] = []

class DLPPolicyResponse(BaseModel):
    id: UUID
    tenant_id: str
    name: str
    description: Optional[str]
    enabled: bool
    severity: str
    rules: dict[str, Any]
    actions: list[str]
    created_at: datetime
    updated_at: datetime
    model_config = {"from_attributes": True}

class DLPIncidentCreate(BaseModel):
    tenant_id: str = Field(..., max_length=50)
    policy_id: Optional[UUID] = None
    user_id: Optional[str] = Field(None, max_length=100)
    resource_type: Optional[str] = Field(None, max_length=100)
    resource_id: Optional[str] = Field(None, max_length=200)
    action: Optional[str] = Field(None, max_length=50)
    data_classification: Optional[str] = Field(None, max_length=50)
    description: Optional[str] = None
    severity: Optional[str] = Field(None, max_length=20)
    evidence: Optional[dict[str, Any]] = None

class DLPIncidentResponse(BaseModel):
    id: UUID
    tenant_id: str
    policy_id: Optional[UUID]
    user_id: Optional[str]
    resource_type: Optional[str]
    resource_id: Optional[str]
    action: Optional[str]
    data_classification: Optional[str]
    description: Optional[str]
    severity: Optional[str]
    status: str
    detected_at: datetime
    remediated_at: Optional[datetime]
    evidence: Optional[dict[str, Any]]
    model_config = {"from_attributes": True}

class EncryptionKeyCreate(BaseModel):
    tenant_id: str = Field(..., max_length=50)
    key_id: str = Field(..., max_length=100)
    algorithm: str = "AES-256-GCM"
    purpose: str = Field(..., max_length=100)
    version: int = 1

class EncryptionKeyResponse(BaseModel):
    id: UUID
    tenant_id: str
    key_id: str
    algorithm: str
    purpose: str
    status: str
    version: int
    rotated_from: Optional[str]
    activated_at: datetime
    expires_at: Optional[datetime]
    rotated_at: Optional[datetime]
    created_at: datetime
    model_config = {"from_attributes": True}

class DataResidencyCreate(BaseModel):
    tenant_id: str = Field(..., max_length=50)
    region: str = Field(..., max_length=100)
    resource_type: str = Field(..., max_length=100)
    data_classification: Optional[str] = None
    allowed_regions: list[str] = []
    restricted_regions: list[str] = []
    enforcement_mode: str = "strict"
    enabled: bool = True

class DataResidencyResponse(BaseModel):
    id: UUID
    tenant_id: str
    region: str
    resource_type: str
    data_classification: Optional[str]
    allowed_regions: list[str]
    restricted_regions: list[str]
    enforcement_mode: str
    enabled: bool
    created_at: datetime
    model_config = {"from_attributes": True}

class SessionRecordingCreate(BaseModel):
    tenant_id: str = Field(..., max_length=50)
    user_id: str = Field(..., max_length=100)
    session_id: Optional[str] = Field(None, max_length=100)
    user_role: Optional[str] = Field(None, max_length=50)
    recording_type: str = Field("keystroke", max_length=50)
    events: list[dict[str, Any]] = []
    ip_address: Optional[str] = Field(None, max_length=45)
    user_agent: Optional[str] = None

class SessionRecordingEvent(BaseModel):
    event_type: str = Field(..., max_length=50)
    timestamp: str
    details: dict[str, Any] = {}
    ip_address: Optional[str] = None

class SessionRecordingResponse(BaseModel):
    id: UUID
    tenant_id: str
    user_id: str
    session_id: Optional[str]
    user_role: Optional[str]
    recording_type: str
    events: list[dict[str, Any]]
    duration_seconds: Optional[int]
    ip_address: Optional[str]
    user_agent: Optional[str]
    status: str
    started_at: datetime
    ended_at: Optional[datetime]
    model_config = {"from_attributes": True}

class PaginatedResponse(BaseModel, Generic[T]):
    items: list[T]
    total: int
    page: int
    page_size: int
    total_pages: int

class ZTAPaginated(PaginatedResponse[ZeroTrustPolicyResponse]):
    pass

class CAPaginated(PaginatedResponse[ConditionalAccessResponse]):
    pass

class RiskPaginated(PaginatedResponse[RiskAssessmentResponse]):
    pass

class DLPPaginated(PaginatedResponse[DLPIncidentResponse]):
    pass

class SecurityDashboard(BaseModel):
    zero_trust_policies: int
    active_zt_policies: int
    conditional_access_policies: int
    active_ca_policies: int
    pending_risk_assessments: int
    high_risk_sessions: int
    active_privileged_grants: int
    pending_pam_requests: int
    data_classifications: int
    dlp_policies: int
    open_dlp_incidents: int
    encryption_keys: int
    active_encryption_keys: int
    data_residency_rules: int
    session_recordings_active: int
    overall_risk_score: int
    compliance_status: str

class HealthResponse(BaseModel):
    status: str
    service: str
    version: str
