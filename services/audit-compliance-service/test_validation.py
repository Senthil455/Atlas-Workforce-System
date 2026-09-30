"""Empty-body validation tests for issue #180 (audit-compliance-service).

Crud helpers must raise ValueError (mapped to 400) instead of KeyError
(mapped to 500), and the Pydantic request models must reject {} so the
endpoints return 422.
"""
import pytest
from pydantic import ValidationError

from crud import (
    create_audit_log,
    create_policy,
    create_retention_policy,
    create_violation,
    record_consent,
    require_fields,
    resolve_tenant,
)
from schemas import (
    AuditLogCreate,
    CompliancePolicyCreate,
    ComplianceViolationCreate,
    DataRetentionPolicyCreate,
    GDPRConsentCreate,
)


def test_require_fields_rejects_empty():
    with pytest.raises(ValueError, match="Missing required fields"):
        require_fields({}, ["tenant_id"])
    with pytest.raises(ValueError, match="Request body must be a JSON object"):
        require_fields(None, ["tenant_id"])
    require_fields({"tenant_id": "t"}, ["tenant_id"])


def test_resolve_tenant_prefers_context():
    assert resolve_tenant({"tenant_id": "t1"}) == "t1"
    assert resolve_tenant({}, context_tenant="ctx") == "ctx"
    with pytest.raises(ValueError, match="Tenant mismatch"):
        resolve_tenant({"tenant_id": "other"}, context_tenant="ctx")
    with pytest.raises(ValueError, match="tenant_id"):
        resolve_tenant({})


def test_crud_empty_body_raises_value_error():
    with pytest.raises(ValueError, match="Missing required fields"):
        create_audit_log(None, {}, "salt")
    with pytest.raises(ValueError, match="Missing required fields"):
        create_policy(None, {})
    with pytest.raises(ValueError, match="Missing required fields"):
        create_violation(None, {})
    with pytest.raises(ValueError, match="Missing required fields"):
        create_retention_policy(None, {})
    with pytest.raises(ValueError, match="Missing required fields"):
        record_consent(None, {})


def test_crud_never_raises_key_error_on_empty():
    for fn, args in (
        (create_audit_log, ({}, "salt")),
        (create_policy, ({},)),
        (create_violation, ({},)),
        (create_retention_policy, ({},)),
        (record_consent, ({},)),
    ):
        try:
            fn(None, *args)
        except ValueError:
            pass
        except KeyError:
            raise AssertionError(f"{fn.__name__} raised KeyError instead of ValueError")


def test_schemas_reject_empty_body():
    for model in (
        AuditLogCreate,
        CompliancePolicyCreate,
        ComplianceViolationCreate,
    ):
        with pytest.raises(ValidationError):
            model.model_validate({})
    # Retention and consent allow server defaults for some fields, but an
    # empty body must still fail on their required fields.
    with pytest.raises(ValidationError):
        DataRetentionPolicyCreate.model_validate({})
    with pytest.raises(ValidationError):
        GDPRConsentCreate.model_validate({})
