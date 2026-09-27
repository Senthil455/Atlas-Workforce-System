import asyncio
import hmac
import hashlib
import json
import logging
import os
import time
from datetime import datetime, timezone
from typing import Optional
from uuid import UUID

import httpx

from ssrf_guard import MAX_RESPONSE_BODY_CHARS, SSRFBlockedError, validate_webhook_headers, validate_webhook_url

logger = logging.getLogger("webhook-engine")

INTERNAL_API_KEY = os.environ.get("INTERNAL_API_KEY", "svc-integration-key-change-in-production")
AUDIT_SERVICE_URL = os.environ.get("AUDIT_SERVICE_URL", "http://audit-compliance-service:8011")

_http_client: Optional[httpx.AsyncClient] = None


def get_client() -> httpx.AsyncClient:
    global _http_client
    if _http_client is None:
        _http_client = httpx.AsyncClient(timeout=30.0, limits=httpx.Limits(max_keepalive_connections=50, max_connections=100))
    return _http_client


def compute_signature(payload: bytes, secret: str) -> str:
    return hmac.new(secret.encode("utf-8"), payload, hashlib.sha256).hexdigest()


async def deliver_webhook(
    url: str,
    payload: dict,
    event_type: str,
    webhook_id: UUID,
    delivery_log_id: UUID,
    secret: Optional[str] = None,
    custom_headers: Optional[dict[str, str]] = None,
    timeout_sec: int = 30,
) -> tuple[int, Optional[str]]:
    try:
        validate_webhook_url(url)
    except SSRFBlockedError as e:
        logger.warning(f"Blocked webhook delivery to disallowed destination: {e}")
        return 0, f"Blocked destination: {e}"

    try:
        safe_headers = validate_webhook_headers(custom_headers)
    except SSRFBlockedError as e:
        logger.warning(f"Blocked webhook delivery with disallowed headers: {e}")
        return 0, f"Blocked headers: {e}"

    client = get_client()
    body = json.dumps(payload, default=str).encode("utf-8")

    headers = {
        "Content-Type": "application/json",
        "X-Webhook-Event": event_type,
        "X-Webhook-ID": str(webhook_id),
        "X-Delivery-ID": str(delivery_log_id),
    }
    if secret:
        headers["X-Webhook-Signature"] = compute_signature(body, secret)
    if safe_headers:
        headers.update(safe_headers)

    try:
        response = await client.post(url, content=body, headers=headers, timeout=timeout_sec, follow_redirects=False)
        if response.status_code in (301, 302, 303, 307, 308):
            return response.status_code, "Redirects are not followed for webhook deliveries"
        return response.status_code, response.text[:MAX_RESPONSE_BODY_CHARS]
    except httpx.TimeoutException:
        return 408, "Request timed out"
    except httpx.RequestError as e:
        return 0, str(e)


async def send_audit_event(event_type: str, details: dict):
    try:
        client = get_client()
        await client.post(
            f"{AUDIT_SERVICE_URL}/api/v1/audit/log",
            json={
                "event_type": event_type,
                "user_id": "system",
                "email": "system@integration-service",
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "details": details,
                "service": "integration-service",
            },
            headers={"X-Internal-Key": INTERNAL_API_KEY},
            timeout=3.0,
        )
    except Exception as e:
        logger.warning(f"Failed to send audit event: {e}")


async def close_client():
    global _http_client
    if _http_client:
        await _http_client.aclose()
        _http_client = None
