import pytest
from pydantic import ValidationError

from crud import (
    MassAssignmentError,
    apply_updates,
    COMPLIANCE_POLICY_UPDATE_FIELDS,
)
from schemas import CompliancePolicyUpdate


class FakePolicy:
    def __init__(self):
        self.name = "old"
        self.tenant_id = "tenant-a"
        self.id = "orig-id"
        self.enabled = True


def test_update_rejects_tenant_id_and_id():
    policy = FakePolicy()
    with pytest.raises(MassAssignmentError):
        apply_updates(policy, {"tenant_id": "other-tenant"}, COMPLIANCE_POLICY_UPDATE_FIELDS)
    with pytest.raises(MassAssignmentError):
        apply_updates(policy, {"id": "00000000-0000-0000-0000-000000000001"}, COMPLIANCE_POLICY_UPDATE_FIELDS)
    with pytest.raises(MassAssignmentError):
        apply_updates(policy, {"created_at": "2024-01-01"}, COMPLIANCE_POLICY_UPDATE_FIELDS)
    assert policy.tenant_id == "tenant-a"
    assert policy.id == "orig-id"


def test_update_allows_valid_fields():
    policy = FakePolicy()
    apply_updates(policy, {"name": "new-name", "enabled": False}, COMPLIANCE_POLICY_UPDATE_FIELDS)
    assert policy.name == "new-name"
    assert policy.enabled is False


def test_schema_rejects_extra_fields():
    with pytest.raises(ValidationError):
        CompliancePolicyUpdate(name="x", tenant_id="other-tenant")
    with pytest.raises(ValidationError):
        CompliancePolicyUpdate(name="x", id="00000000-0000-0000-0000-000000000001")


def test_allowlist_excludes_protected_fields():
    assert "tenant_id" not in COMPLIANCE_POLICY_UPDATE_FIELDS
    assert "id" not in COMPLIANCE_POLICY_UPDATE_FIELDS
    assert "created_at" not in COMPLIANCE_POLICY_UPDATE_FIELDS
    assert "name" in COMPLIANCE_POLICY_UPDATE_FIELDS
