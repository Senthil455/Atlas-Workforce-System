import base64
import hashlib
import hmac
import json
import os
import time

import pytest
from httpx import AsyncClient, ASGITransport

os.environ.setdefault("DATABASE_URL", "sqlite:///test.db")
os.environ.setdefault("INTERNAL_API_KEY", "test-key")
os.environ.setdefault("INTERNAL_JWT_SECRET", "test-jwt-secret")

from main import app  # noqa: E402


def _mint_internal_token(secret: str = "test-jwt-secret", exp_offset: int = 3600) -> str:
    """Mint an internal auth JWT matching atlas_observability.verify_internal_auth format."""
    header = base64.urlsafe_b64encode(json.dumps({"alg": "HS256"}).encode()).rstrip(b"=").decode()
    payload_b64 = base64.urlsafe_b64encode(
        json.dumps({"sub": "integration-service", "exp": int(time.time()) + exp_offset}).encode()
    ).rstrip(b"=").decode()
    signing_input = f"{header}.{payload_b64}"
    signature = base64.urlsafe_b64encode(
        hmac.new(secret.encode(), signing_input.encode(), hashlib.sha256).digest()
    ).rstrip(b"=").decode()
    return f"{signing_input}.{signature}"


def _mock_dashboard_stats():
    return {
        "total_webhooks": 0,
        "active_webhooks": 0,
        "total_subscriptions": 0,
        "total_deliveries": 0,
        "successful_deliveries": 0,
        "failed_deliveries": 0,
        "pending_deliveries": 0,
        "outbox_pending": 0,
        "outbox_failed": 0,
    }


@pytest.mark.asyncio
async def test_health_check():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "healthy"
        assert data["service"] == "integration-service"


@pytest.mark.asyncio
async def test_missing_internal_auth_returns_401(monkeypatch):
    monkeypatch.setattr("main.get_dashboard_stats", lambda db, tenant_id: _mock_dashboard_stats())
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/api/v1/integration/dashboard")
        assert resp.status_code == 401
        assert resp.json()["error"] == "Missing internal authentication"


@pytest.mark.asyncio
async def test_invalid_signature_returns_401(monkeypatch):
    monkeypatch.setattr("main.get_dashboard_stats", lambda db, tenant_id: _mock_dashboard_stats())
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get(
            "/api/v1/integration/dashboard",
            headers={"x-internal-auth": f"{_mint_internal_token()[:-10]}AAAAAAAAAA"},
        )
        assert resp.status_code == 401
        assert "Invalid" in resp.json()["error"]


@pytest.mark.asyncio
async def test_valid_internal_token_passes_middleware(monkeypatch):
    monkeypatch.setattr("main.get_dashboard_stats", lambda db, tenant_id: _mock_dashboard_stats())
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get(
            "/api/v1/integration/dashboard",
            headers={"x-internal-auth": _mint_internal_token()},
        )
        assert resp.status_code == 200
        assert resp.json() == _mock_dashboard_stats()


@pytest.mark.asyncio
async def test_wrong_secret_returns_401(monkeypatch):
    monkeypatch.setattr("main.get_dashboard_stats", lambda db, tenant_id: _mock_dashboard_stats())
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get(
            "/api/v1/integration/dashboard",
            headers={"x-internal-auth": _mint_internal_token(secret="wrong-secret")},
        )
        assert resp.status_code == 401
        assert "Invalid" in resp.json()["error"]
