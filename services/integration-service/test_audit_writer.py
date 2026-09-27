import base64
import hashlib
import hmac
import json
import os
from pathlib import Path

os.environ.setdefault("INTERNAL_JWT_SECRET", "test-jwt-secret")

import webhook_engine


def _decode_payload(token: str) -> dict:
    _, payload_b64, _ = token.split(".")
    padded = payload_b64 + "=" * (4 - len(payload_b64) % 4)
    return json.loads(base64.urlsafe_b64decode(padded))


def test_writer_token_carries_audience():
    os.environ["INTERNAL_JWT_SECRET"] = "test-jwt-secret"
    import importlib

    importlib.reload(webhook_engine)
    token = webhook_engine.mint_audit_writer_token()
    payload = _decode_payload(token)
    assert payload["aud"] == "audit-writer"
    assert payload["service"] == "integration-service"


def test_writer_token_signature_verifies():
    secret = "test-jwt-secret"
    os.environ["INTERNAL_JWT_SECRET"] = secret
    import importlib

    importlib.reload(webhook_engine)
    token = webhook_engine.mint_audit_writer_token()
    header_b64, payload_b64, signature = token.split(".")
    expected = base64.urlsafe_b64encode(
        hmac.new(secret.encode(), f"{header_b64}.{payload_b64}".encode(), hashlib.sha256).digest()
    ).rstrip(b"=").decode()
    assert hmac.compare_digest(expected, signature)


def test_no_shared_key_path_in_writer():
    source = Path(__file__).with_name("webhook_engine.py").read_text()
    assert "X-Internal-Key" not in source
    assert "svc-integration-key-change-in-production" not in source
    assert "x-internal-auth" in source


def test_shared_mint_helper_matches_verifier():
    import sys

    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "atlas_observability"))
    from atlas_observability.shared import mint_internal_auth, verify_internal_auth

    token = mint_internal_auth("test-jwt-secret", "integration-service")

    class _Req:
        headers = {"x-internal-auth": token}

    claims = verify_internal_auth(_Req(), "test-jwt-secret")
    assert claims["aud"] == "audit-writer"
