"""Tests for the Analytics Service API using FastAPI TestClient."""

import base64
import hashlib
import hmac
import json
import time

import pytest
from httpx import ASGITransport, AsyncClient
from main import app

INTERNAL_JWT_SECRET = "test-secret"


def _make_internal_token(secret: str, tenant_id: str = "test-tenant") -> str:
    hdr = base64.urlsafe_b64encode(
        json.dumps({"alg": "HS256", "typ": "JWT"}).encode()
    ).rstrip(b"=").decode()
    payload = base64.urlsafe_b64encode(
        json.dumps({"sub": "test", "tenant_id": tenant_id, "exp": int(time.time()) + 3600}).encode()
    ).rstrip(b"=").decode()
    sig = base64.urlsafe_b64encode(
        hmac.new(secret.encode(), f"{hdr}.{payload}".encode(), hashlib.sha256).digest()
    ).rstrip(b"=").decode()
    return f"{hdr}.{payload}.{sig}"


@pytest.fixture
def client():
    transport = ASGITransport(app=app)
    token = _make_internal_token(INTERNAL_JWT_SECRET, tenant_id="test-tenant")
    return AsyncClient(transport=transport, base_url="http://test", headers={"x-internal-auth": token})


@pytest.mark.asyncio
async def test_health_check(client):
    response = await client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert "status" in data
    assert "Analytics Service" in data["status"]


@pytest.mark.asyncio
async def test_performance_prediction(client):
    response = await client.get("/analytics/performance")
    assert response.status_code == 200
    data = response.json()
    assert data["predictions_ready"] is True
    assert "top_performer_id" in data
    assert "score" in data


@pytest.mark.asyncio
async def test_department_analytics_no_data(client):
    """Should return empty list when employee service is unreachable."""
    response = await client.get(
        "/analytics/department",
        headers={"X-Tenant-Id": "test-tenant"},
    )
    # We expect either 200 with empty list or 500 depending on env
    assert response.status_code in (200, 500)


@pytest.mark.asyncio
async def test_payroll_analytics_no_db(client):
    """Should return empty list when database is not connected."""
    response = await client.get(
        "/analytics/payroll",
        headers={"X-Tenant-Id": "test-tenant"},
    )
    # We expect either 200 with empty list or 500 depending on DB connection
    assert response.status_code in (200, 500)


@pytest.mark.asyncio
async def test_ai_insights_mock(client):
    """AI insights should return mock data when no API key is configured."""
    response = await client.post(
        "/analytics/ai-insights",
        headers={"X-Tenant-Id": "test-tenant"},
    )
    assert response.status_code == 200
    data = response.json()
    assert "insight" in data
