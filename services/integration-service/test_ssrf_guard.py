import os

import pytest
from pydantic import ValidationError

import ssrf_guard
from ssrf_guard import (
    SSRFBlockedError,
    validate_webhook_headers,
    validate_webhook_url,
)


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for var in ("WEBHOOK_ALLOW_HTTP", "WEBHOOK_ALLOW_PRIVATE_IPS", "WEBHOOK_ALLOWED_HOSTS", "WEBHOOK_BLOCKED_HOSTS"):
        monkeypatch.delenv(var, raising=False)


def test_metadata_url_rejected():
    with pytest.raises(SSRFBlockedError):
        validate_webhook_url("http://169.254.169.254/", resolve_dns=False)
    with pytest.raises(SSRFBlockedError):
        validate_webhook_url("http://169.254.169.254/latest/meta-data/iam/security-credentials/", resolve_dns=False)


def test_internal_service_url_rejected():
    with pytest.raises(SSRFBlockedError):
        validate_webhook_url("http://postgres:5432", resolve_dns=False)
    with pytest.raises(SSRFBlockedError):
        validate_webhook_url("http://audit-compliance-service:8011/api/v1/audit/logs?page=1", resolve_dns=False)
    with pytest.raises(SSRFBlockedError):
        validate_webhook_url("http://redis:6379", resolve_dns=False)


def test_loopback_and_private_rejected():
    for url in (
        "https://127.0.0.1/hook",
        "https://10.0.0.1/hook",
        "https://172.16.0.5/hook",
        "https://192.168.1.1/hook",
        "https://[::1]/hook",
        "https://localhost:3000/hook",
    ):
        with pytest.raises(SSRFBlockedError):
            validate_webhook_url(url, resolve_dns=False)


def test_non_https_rejected_by_default():
    with pytest.raises(SSRFBlockedError):
        validate_webhook_url("http://example.com/hook", resolve_dns=False)


def test_http_allowed_with_opt_in(monkeypatch):
    monkeypatch.setenv("WEBHOOK_ALLOW_HTTP", "true")
    monkeypatch.setenv("WEBHOOK_ALLOW_PRIVATE_IPS", "true")
    assert validate_webhook_url("http://localhost:3000/hook", resolve_dns=False)


def test_public_https_allowed_without_dns():
    assert validate_webhook_url("https://example.com/webhook", resolve_dns=False)


def test_url_with_credentials_rejected():
    with pytest.raises(SSRFBlockedError):
        validate_webhook_url("https://user:pass@example.com/hook", resolve_dns=False)


def test_dns_rebinding_rejected(monkeypatch):
    import socket

    def fake_getaddrinfo(host, port, *args, **kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 0))]

    monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)
    with pytest.raises(SSRFBlockedError):
        validate_webhook_url("https://example.com/webhook", resolve_dns=True)


def test_blocked_headers_rejected():
    for header in ("Host", "Content-Length", "Transfer-Encoding", "Authorization", "X-Internal-Key", "X-Tenant-Id", "Content-Type", "X-Webhook-Event"):
        with pytest.raises(SSRFBlockedError):
            validate_webhook_headers({header: "evil"})


def test_custom_header_allowed():
    assert validate_webhook_headers({"X-Custom-Header": "ok"}) == {"X-Custom-Header": "ok"}


def test_schema_rejects_metadata_url():
    from schemas import WebhookCreate

    with pytest.raises(ValidationError):
        WebhookCreate(name="x", url="http://169.254.169.254/", event_types=[])


def test_schema_rejects_internal_url():
    from schemas import WebhookCreate

    with pytest.raises(ValidationError):
        WebhookCreate(name="x", url="http://postgres:5432", event_types=[])


def test_schema_rejects_blocked_header():
    from schemas import WebhookCreate

    with pytest.raises(ValidationError):
        WebhookCreate(name="x", url="https://example.com/hook", headers={"X-Internal-Key": "evil"})


@pytest.mark.asyncio
async def test_delivery_never_posts_to_blocked_destination(monkeypatch):
    import webhook_engine

    called = []

    class FakeResponse:
        status_code = 200
        text = "should-not-happen"

    async def fake_post(*args, **kwargs):
        called.append((args, kwargs))
        return FakeResponse()

    monkeypatch.setattr(webhook_engine, "get_client", lambda: type("C", (), {"post": staticmethod(fake_post)})())
    status, body = await webhook_engine.deliver_webhook(
        "http://169.254.169.254/latest/meta-data/",
        {"event": "test"},
        "test.event",
        "00000000-0000-0000-0000-000000000001",
        "00000000-0000-0000-0000-000000000002",
    )
    assert status == 0
    assert body.startswith("Blocked destination:")
    assert called == []
