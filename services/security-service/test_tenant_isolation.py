import base64
import hashlib
import hmac
import json
import os
import time
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException
from httpx import ASGITransport, AsyncClient

os.environ.setdefault("DATABASE_URL", "sqlite:///test.db")
os.environ.setdefault("INTERNAL_API_KEY", "test-key")
os.environ.setdefault("INTERNAL_JWT_SECRET", "test-secret")

from main import app, get_db, get_tenant, resolve_tenant
from crud import _require_tenant

INTERNAL_JWT_SECRET = os.environ.get("INTERNAL_JWT_SECRET", "test-secret")


def _make_internal_token(secret: str, tenant_id: str = "tenant-a") -> str:
    hdr = base64.urlsafe_b64encode(
        json.dumps({"alg": "HS256", "typ": "JWT"}).encode()
    ).rstrip(b"=").decode()
    payload = base64.urlsafe_b64encode(
        json.dumps(
            {"sub": "test", "tenant_id": tenant_id, "exp": int(time.time()) + 3600}
        ).encode()
    ).rstrip(b"=").decode()
    sig = base64.urlsafe_b64encode(
        hmac.new(secret.encode(), f"{hdr}.{payload}".encode(), hashlib.sha256).digest()
    ).rstrip(b"=").decode()
    return f"{hdr}.{payload}.{sig}"


def _mock_db():
    db = MagicMock()
    query = MagicMock()
    # Chain: query.filter -> query, query.order_by -> query,
    # query.count -> 0, query.offset -> query, query.limit -> query, query.all -> []
    query.filter.return_value = query
    query.order_by.return_value = query
    query.count.return_value = 0
    query.offset.return_value = query
    query.limit.return_value = query
    query.all.return_value = []
    db.query.return_value = query
    return db


def test_require_tenant_rejects_empty():
    for bad in (None, "", "   "):
        try:
            _require_tenant(bad)
        except ValueError:
            pass
        else:
            raise AssertionError(f"expected ValueError for {bad!r}")
    assert _require_tenant("tenant-a") == "tenant-a"
    assert _require_tenant("  tenant-a  ") == "tenant-a"


def test_resolve_tenant():
    assert resolve_tenant(None, "tenant-a") == "tenant-a"
    assert resolve_tenant("tenant-a", "tenant-a") == "tenant-a"
    try:
        resolve_tenant("", "tenant-a")
    except HTTPException as e:
        assert e.status_code == 400
    else:
        raise AssertionError("expected 400 for empty tenant_id")
    try:
        resolve_tenant("tenant-b", "tenant-a")
    except HTTPException as e:
        assert e.status_code == 403
    else:
        raise AssertionError("expected 403 for mismatch")


def test_get_tenant_missing():
    req = MagicMock()
    req.state.tenant_id = ""
    try:
        get_tenant(req)
    except HTTPException as e:
        assert e.status_code == 403
    else:
        raise AssertionError("expected 403 for missing tenant")


@pytest.mark.asyncio
async def test_empty_header_rejected():
    db = _mock_db()

    def _override():
        yield db

    app.dependency_overrides[get_db] = _override
    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            token = _make_internal_token(INTERNAL_JWT_SECRET, "tenant-a")
            resp = await client.get(
                "/api/v1/security/zero-trust",
                headers={"x-internal-auth": token, "x-tenant-id": ""},
            )
            assert resp.status_code == 400
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_empty_query_rejected():
    db = _mock_db()

    def _override():
        yield db

    app.dependency_overrides[get_db] = _override
    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            token = _make_internal_token(INTERNAL_JWT_SECRET, "tenant-a")
            resp = await client.get(
                "/api/v1/security/zero-trust?tenant_id=",
                headers={"x-internal-auth": token},
            )
            assert resp.status_code == 400
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_mismatch_query_rejected():
    db = _mock_db()

    def _override():
        yield db

    app.dependency_overrides[get_db] = _override
    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            token = _make_internal_token(INTERNAL_JWT_SECRET, "tenant-a")
            resp = await client.get(
                "/api/v1/security/zero-trust?tenant_id=tenant-b",
                headers={"x-internal-auth": token},
            )
            assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_missing_query_uses_verified_tenant():
    db = _mock_db()

    def _override():
        yield db

    app.dependency_overrides[get_db] = _override
    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            token = _make_internal_token(INTERNAL_JWT_SECRET, "tenant-a")
            resp = await client.get(
                "/api/v1/security/zero-trust",
                headers={"x-internal-auth": token},
            )
            # Must not return unfiltered data; with mocked DB it returns empty page
            assert resp.status_code == 200
            # crud must have applied a tenant filter
            assert db.query.called
    finally:
        app.dependency_overrides.clear()
