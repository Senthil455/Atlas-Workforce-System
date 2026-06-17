"""Tests for the ATS Service API using FastAPI TestClient."""

import base64
import hashlib
import hmac
import json
import os
import time

import pytest
from fastapi.testclient import TestClient
from main import app

os.environ.setdefault("INTERNAL_JWT_SECRET", "test-secret")
INTERNAL_JWT_SECRET = "test-secret"


def _make_internal_token(secret: str) -> str:
    hdr = base64.urlsafe_b64encode(
        json.dumps({"alg": "HS256", "typ": "JWT"}).encode()
    ).rstrip(b"=").decode()
    payload = base64.urlsafe_b64encode(
        json.dumps({"sub": "test", "exp": int(time.time()) + 3600}).encode()
    ).rstrip(b"=").decode()
    sig = base64.urlsafe_b64encode(
        hmac.new(secret.encode(), f"{hdr}.{payload}".encode(), hashlib.sha256).digest()
    ).rstrip(b"=").decode()
    return f"{hdr}.{payload}.{sig}"


@pytest.fixture
def client():
    token = _make_internal_token(INTERNAL_JWT_SECRET)
    return TestClient(app, headers={"x-internal-auth": token})


def test_health_check(client):
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert "status" in data
    assert "ATS Service" in data["status"]


def test_list_jobs_empty(client):
    response = client.get("/api/v1/jobs", headers={"X-Tenant-Id": "test-tenant"})
    assert response.status_code == 200
    data = response.json()
    assert "items" in data
    assert "total" in data
    assert "page" in data
    assert "page_size" in data


def test_list_jobs_pagination(client):
    response = client.get(
        "/api/v1/jobs?page=1&page_size=5",
        headers={"X-Tenant-Id": "test-tenant"},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["page"] == 1
    assert data["page_size"] == 5


def test_get_nonexistent_job(client):
    response = client.get(
        "/api/v1/jobs/00000000-0000-0000-0000-000000000000",
        headers={"X-Tenant-Id": "test-tenant"},
    )
    assert response.status_code == 404
    assert response.json()["detail"] == "Job not found"


def test_invalid_page_param(client):
    response = client.get(
        "/api/v1/jobs?page=0",
        headers={"X-Tenant-Id": "test-tenant"},
    )
    assert response.status_code == 422


def test_list_candidates_empty(client):
    response = client.get("/api/v1/candidates", headers={"X-Tenant-Id": "test-tenant"})
    assert response.status_code == 200
    data = response.json()
    assert "items" in data


def test_list_applications_empty(client):
    response = client.get("/api/v1/applications", headers={"X-Tenant-Id": "test-tenant"})
    assert response.status_code == 200
    data = response.json()
    assert "items" in data


def test_list_interviews_empty(client):
    response = client.get("/api/v1/interviews", headers={"X-Tenant-Id": "test-tenant"})
    assert response.status_code == 200
    data = response.json()
    assert "items" in data


def test_list_offers_empty(client):
    response = client.get("/api/v1/offers", headers={"X-Tenant-Id": "test-tenant"})
    assert response.status_code == 200
    data = response.json()
    assert "items" in data


def test_analytics_overview(client):
    response = client.get("/api/v1/analytics/overview", headers={"X-Tenant-Id": "test-tenant"})
    assert response.status_code == 200


def test_analytics_time_to_hire(client):
    response = client.get("/api/v1/analytics/time-to-hire", headers={"X-Tenant-Id": "test-tenant"})
    assert response.status_code == 200


def test_analytics_source_effectiveness(client):
    response = client.get("/api/v1/analytics/source-effectiveness", headers={"X-Tenant-Id": "test-tenant"})
    assert response.status_code == 200


def test_analytics_conversion_funnel(client):
    response = client.get("/api/v1/analytics/conversion-funnel", headers={"X-Tenant-Id": "test-tenant"})
    assert response.status_code == 200
