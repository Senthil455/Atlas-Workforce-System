import pytest
from pydantic import ValidationError

from crud import (
    MassAssignmentError,
    apply_updates,
    filter_create_data,
    WEBHOOK_CREATE_FIELDS,
    WEBHOOK_UPDATE_FIELDS,
    EVENT_SUB_UPDATE_FIELDS,
)
from schemas import WebhookUpdate, EventSubscriptionUpdate


class FakeWebhook:
    def __init__(self):
        self.name = "old"
        self.tenant_id = "tenant-a"
        self.id = "orig-id"
        self.enabled = True


def test_update_rejects_tenant_id_and_id():
    wh = FakeWebhook()
    with pytest.raises(MassAssignmentError):
        apply_updates(wh, {"tenant_id": "other-tenant"}, WEBHOOK_UPDATE_FIELDS)
    with pytest.raises(MassAssignmentError):
        apply_updates(wh, {"id": "00000000-0000-0000-0000-000000000001"}, WEBHOOK_UPDATE_FIELDS)
    with pytest.raises(MassAssignmentError):
        apply_updates(wh, {"created_at": "2024-01-01"}, WEBHOOK_UPDATE_FIELDS)
    assert wh.tenant_id == "tenant-a"
    assert wh.id == "orig-id"


def test_update_allows_valid_fields():
    wh = FakeWebhook()
    apply_updates(wh, {"name": "new-name", "enabled": False}, WEBHOOK_UPDATE_FIELDS)
    assert wh.name == "new-name"
    assert wh.enabled is False


def test_create_rejects_read_only_fields():
    with pytest.raises(MassAssignmentError):
        filter_create_data({"name": "n", "url": "u", "tenant_id": "other"}, WEBHOOK_CREATE_FIELDS)
    with pytest.raises(MassAssignmentError):
        filter_create_data({"name": "n", "url": "u", "id": "x"}, WEBHOOK_CREATE_FIELDS)


def test_webhook_update_schema_rejects_extra():
    with pytest.raises(ValidationError):
        WebhookUpdate(name="x", tenant_id="other-tenant")
    with pytest.raises(ValidationError):
        WebhookUpdate(name="x", id="00000000-0000-0000-0000-000000000001")


def test_event_sub_update_schema_rejects_extra():
    with pytest.raises(ValidationError):
        EventSubscriptionUpdate(event_type="x", tenant_id="other-tenant")


def test_allowlists_exclude_protected_fields():
    assert "tenant_id" not in WEBHOOK_UPDATE_FIELDS
    assert "id" not in WEBHOOK_UPDATE_FIELDS
    assert "name" in WEBHOOK_UPDATE_FIELDS
    assert "tenant_id" not in EVENT_SUB_UPDATE_FIELDS
