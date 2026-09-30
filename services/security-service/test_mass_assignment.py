import pytest
from pydantic import ValidationError

from crud import (
    MassAssignmentError,
    apply_updates,
    filter_create_data,
    ZT_UPDATE_FIELDS,
    CA_UPDATE_FIELDS,
)
from schemas import ZeroTrustPolicyUpdate, ConditionalAccessUpdate, DLPIncidentCreate, SessionRecordingCreate


class FakeObj:
    def __init__(self):
        self.name = "old"
        self.tenant_id = "tenant-a"
        self.id = "orig-id"


def test_apply_updates_rejects_id_and_tenant():
    obj = FakeObj()
    with pytest.raises(MassAssignmentError):
        apply_updates(obj, {"tenant_id": "other-tenant"}, ZT_UPDATE_FIELDS)
    with pytest.raises(MassAssignmentError):
        apply_updates(obj, {"id": "00000000-0000-0000-0000-000000000001"}, ZT_UPDATE_FIELDS)
    with pytest.raises(MassAssignmentError):
        apply_updates(obj, {"created_at": "2024-01-01"}, ZT_UPDATE_FIELDS)
    assert obj.tenant_id == "tenant-a"
    assert obj.id == "orig-id"


def test_apply_updates_allows_valid_fields():
    obj = FakeObj()
    apply_updates(obj, {"name": "new-name"}, ZT_UPDATE_FIELDS)
    assert obj.name == "new-name"


def test_filter_create_rejects_read_only_fields():
    with pytest.raises(MassAssignmentError):
        filter_create_data({"tenant_id": "t", "name": "n", "id": "x"}, {"tenant_id", "name"})
    with pytest.raises(MassAssignmentError):
        filter_create_data({"tenant_id": "t", "name": "n", "created_at": "x"}, {"tenant_id", "name"})


def test_zt_update_schema_rejects_tenant_and_id():
    with pytest.raises(ValidationError):
        ZeroTrustPolicyUpdate(tenant_id="other-tenant", name="x")
    with pytest.raises(ValidationError):
        ZeroTrustPolicyUpdate(id="00000000-0000-0000-0000-000000000001", name="x")


def test_ca_update_schema_rejects_tenant_and_id():
    with pytest.raises(ValidationError):
        ConditionalAccessUpdate(tenant_id="other-tenant")
    with pytest.raises(ValidationError):
        ConditionalAccessUpdate(created_at="2024-01-01")


def test_dlp_incident_create_rejects_id_and_status_override():
    with pytest.raises(ValidationError):
        DLPIncidentCreate(tenant_id="t", id="00000000-0000-0000-0000-000000000001")
    with pytest.raises(ValidationError):
        DLPIncidentCreate(tenant_id="t", tenant_id_override="x")


def test_session_recording_create_rejects_id():
    with pytest.raises(ValidationError):
        SessionRecordingCreate(tenant_id="t", user_id="u", id="x")


def test_ca_update_allowlists_exclude_protected_fields():
    assert "tenant_id" not in CA_UPDATE_FIELDS
    assert "id" not in CA_UPDATE_FIELDS
    assert "created_at" not in CA_UPDATE_FIELDS
    assert "name" in CA_UPDATE_FIELDS
