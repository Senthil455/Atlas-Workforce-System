from datetime import datetime
from typing import Any, Optional
from uuid import UUID
from pydantic import BaseModel, Field, field_validator


class HealthResponse(BaseModel):
    status: str
    service: str
    version: str


class MessageResponse(BaseModel):
    message: str


class WebhookCreate(BaseModel):
    model_config = {"extra": "forbid"}

    name: str = Field(..., max_length=200)
    url: str = Field(..., max_length=500)
    secret: Optional[str] = None
    event_types: list[str] = Field(default_factory=list)
    headers: Optional[dict[str, str]] = None
    retry_count: int = Field(default=3, ge=0, le=10)
    retry_interval_sec: int = Field(default=60, ge=10, le=3600)
    timeout_sec: int = Field(default=30, ge=5, le=120)

    @field_validator("url")
    @classmethod
    def _check_url(cls, v: str) -> str:
        from ssrf_guard import SSRFBlockedError, validate_webhook_url

        try:
            return validate_webhook_url(v)
        except SSRFBlockedError as e:
            raise ValueError(str(e))

    @field_validator("headers")
    @classmethod
    def _check_headers(cls, v: Optional[dict[str, str]]) -> Optional[dict[str, str]]:
        if v is None:
            return v
        from ssrf_guard import SSRFBlockedError, validate_webhook_headers

        try:
            return validate_webhook_headers(v)
        except SSRFBlockedError as e:
            raise ValueError(str(e))


class WebhookUpdate(BaseModel):
    model_config = {"extra": "forbid"}

    name: Optional[str] = Field(None, max_length=200)
    url: Optional[str] = Field(None, max_length=500)
    secret: Optional[str] = None
    event_types: Optional[list[str]] = None
    headers: Optional[dict[str, str]] = None
    retry_count: Optional[int] = Field(None, ge=0, le=10)
    retry_interval_sec: Optional[int] = Field(None, ge=10, le=3600)
    timeout_sec: Optional[int] = Field(None, ge=5, le=120)
    enabled: Optional[bool] = None

    @field_validator("url")
    @classmethod
    def _check_url(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        from ssrf_guard import SSRFBlockedError, validate_webhook_url

        try:
            return validate_webhook_url(v)
        except SSRFBlockedError as e:
            raise ValueError(str(e))

    @field_validator("headers")
    @classmethod
    def _check_headers(cls, v: Optional[dict[str, str]]) -> Optional[dict[str, str]]:
        if v is None:
            return v
        from ssrf_guard import SSRFBlockedError, validate_webhook_headers

        try:
            return validate_webhook_headers(v)
        except SSRFBlockedError as e:
            raise ValueError(str(e))


class WebhookResponse(BaseModel):
    id: UUID
    tenant_id: str
    name: str
    url: str
    event_types: list[Any]
    headers: Optional[dict[Any, Any]]
    retry_count: int
    retry_interval_sec: int
    timeout_sec: int
    enabled: bool
    last_triggered_at: Optional[datetime]
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class WebhookDeliveryLogResponse(BaseModel):
    id: UUID
    webhook_id: UUID
    tenant_id: str
    event_type: str
    status: str
    status_code: Optional[int]
    response_body: Optional[str]
    attempts: int
    max_attempts: int
    next_retry_at: Optional[datetime]
    delivered_at: Optional[datetime]
    created_at: datetime

    class Config:
        from_attributes = True


class EventSubscriptionCreate(BaseModel):
    model_config = {"extra": "forbid"}

    event_type: str = Field(..., max_length=100)
    source_service: Optional[str] = None
    kafka_topic: Optional[str] = Field(None, max_length=200)
    transform_template: Optional[dict[str, Any]] = None


class EventSubscriptionUpdate(BaseModel):
    model_config = {"extra": "forbid"}

    event_type: Optional[str] = Field(None, max_length=100)
    source_service: Optional[str] = None
    kafka_topic: Optional[str] = Field(None, max_length=200)
    transform_template: Optional[dict[str, Any]] = None
    enabled: Optional[bool] = None


class EventSubscriptionResponse(BaseModel):
    id: UUID
    tenant_id: str
    event_type: str
    source_service: Optional[str]
    kafka_topic: Optional[str]
    transform_template: Optional[dict[Any, Any]]
    enabled: bool
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class EventOutboxResponse(BaseModel):
    id: UUID
    tenant_id: str
    event_type: str
    source_service: str
    status: str
    published_at: Optional[datetime]
    error_message: Optional[str]
    retry_count: int
    created_at: datetime

    class Config:
        from_attributes = True


class IntegrationConfigCreate(BaseModel):
    model_config = {"extra": "forbid"}

    key: str = Field(..., max_length=200)
    value: Any
    description: Optional[str] = None


class IntegrationConfigUpdate(BaseModel):
    model_config = {"extra": "forbid"}

    value: Any
    description: Optional[str] = None


class IntegrationConfigResponse(BaseModel):
    id: UUID
    tenant_id: str
    key: str
    value: Any
    description: Optional[str]
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class EventPublishRequest(BaseModel):
    event_type: str = Field(..., max_length=100)
    tenant_id: str = Field(default="default", max_length=50)
    source_service: str = Field(..., max_length=100)
    payload: dict[str, Any]


class IntegrationDashboardResponse(BaseModel):
    total_webhooks: int
    active_webhooks: int
    total_subscriptions: int
    total_deliveries: int
    successful_deliveries: int
    failed_deliveries: int
    pending_deliveries: int
    outbox_pending: int
    outbox_failed: int
