"""Empty-body validation tests for issue #180.

Empty JSON bodies must return 4xx (422 from Pydantic or 400 from crud
validation), never 500 from a raw-dict KeyError.
"""
import base64
import hashlib
import hmac
import json
import os
import time

os.environ.setdefault("DATABASE_URL", "sqlite:///test.db")
os.environ.setdefault("INTERNAL_API_KEY", "test-key")
os.environ.setdefault("INTERNAL_JWT_SECRET", "test-jwt-secret")

import pytest  # noqa: E402
from pydantic import ValidationError  # noqa: E402

from crud import (  # noqa: E402
    assess_risk,
    report_dlp_incident,
    request_privileged_access,
    require_fields,
    resolve_tenant,
    start_session_recording,
)
from schemas import (  # noqa: E402
    DLPIncidentCreate,
    PrivilegedAccessRequest,
    RiskAssessmentRequest,
    SessionRecordingCreate,
)


def test_require_fields_rejects_empty():
    with pytest.raises(ValueError, match="Missing required fields"):
        require_fields({}, ["tenant_id", "user_id"])
    with pytest.raises(ValueError, match="Request body must be a JSON object"):
        require_fields("nope", ["tenant_id"])
    require_fields({"tenant_id": "t", "user_id": "u"}, ["tenant_id", "user_id"])


def test_resolve_tenant_prefers_context():
    assert resolve_tenant({"tenant_id": "t1"}) == "t1"
    assert resolve_tenant({}, context_tenant="ctx") == "ctx"
    with pytest.raises(ValueError, match="Tenant mismatch"):
        resolve_tenant({"tenant_id": "other"}, context_tenant="ctx")
    with pytest.raises(ValueError, match="tenant_id"):
        resolve_tenant({})


def test_crud_empty_body_raises_value_error():
    for fn in (
        assess_risk,
        request_privileged_access,
        start_session_recording,
        report_dlp_incident,
    ):
        try:
            fn(None, {})
            raise AssertionError(f"{fn.__name__} should have raised")
        except ValueError:
            pass
        except KeyError:
            raise AssertionError(f"{fn.__name__} raised KeyError instead of ValueError")


def test_schemas_reject_empty_body():
    for model in (
        RiskAssessmentRequest,
        PrivilegedAccessRequest,
        DLPIncidentCreate,
        SessionRecordingCreate,
    ):
        with pytest.raises(ValidationError):
            model.model_validate({})


def _make_internal_token(secret, tenant_id="test-tenant"):
    def b64(obj):
        return base64.urlsafe_b64encode(json.dumps(obj).encode()).rstrip(b"=").decode()

    header = b64({"alg": "HS256", "typ": "JWT"})
    payload = b64(
        {
            "tenant_id": tenant_id,
            "user_id": "tester",
            "user_role": "admin",
            "exp": int(time.time()) + 600,
        }
    )
    sig = (
        base64.urlsafe_b64encode(
            hmac.new(secret.encode(), f"{header}.{payload}".encode(), hashlib.sha256).digest()
        )
        .rstrip(b"=")
        .decode()
    )
    return f"{header}.{payload}.{sig}"


@pytest.mark.asyncio
async def test_empty_body_endpoints_return_4xx_not_500():
    from httpx import ASGITransport, AsyncClient

    from main import app

    token = _make_internal_token(os.environ["INTERNAL_JWT_SECRET"])
    headers = {"x-internal-auth": token, "Content-Type": "application/json"}
    transport = ASGITransport(app=app)
    paths = [
        "/api/v1/security/risk/assess",
        "/api/v1/security/pam/requests",
        "/api/v1/security/dlp/incidents",
        "/api/v1/security/session-recordings/start",
    ]
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        for path in paths:
            resp = await client.post(path, headers=headers, json={})
            assert resp.status_code != 500, f"{path} returned 500"
            assert resp.status_code in (400, 401, 403, 404, 422), (
                f"{path} returned unexpected {resp.status_code}: {resp.text[:200]}"
            )
