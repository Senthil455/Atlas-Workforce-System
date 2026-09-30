import asyncio
import hmac
import hashlib
import json
import logging
import os
import threading
import time
from datetime import datetime, timezone
from typing import Dict, Optional
from uuid import UUID

import httpx

try:
    from prometheus_client import Counter as _PromCounter
except Exception:
    _PromCounter = None
from ssrf_guard import MAX_RESPONSE_BODY_CHARS, SSRFBlockedError, validate_webhook_headers, validate_webhook_url

logger = logging.getLogger("webhook-engine")

INTERNAL_JWT_SECRET = os.environ.get("INTERNAL_JWT_SECRET", "")
AUDIT_SERVICE_URL = os.environ.get("AUDIT_SERVICE_URL", "http://audit-compliance-service:8011")
AUDIT_WRITER_AUDIENCE = "audit-writer"

if _PromCounter is not None:
    try:
        AUDIT_DELIVERY_FAILURES = _PromCounter(
            "atlas_audit_delivery_failures_total",
            "Total audit log delivery failures from integration-service",
            ["event_type"],
        )
    except Exception:
        AUDIT_DELIVERY_FAILURES = None
else:
    AUDIT_DELIVERY_FAILURES = None

# httpx.AsyncClient pools hold primitives bound to the loop that first used
# them, so one global client cannot be shared across the per-delivery loops
# created in event_router. Keep one client per running loop instead.
_clients: Dict[int, httpx.AsyncClient] = {}
_clients_lock = threading.Lock()


def _loop_key() -> Optional[int]:
    try:
        return id(asyncio.get_running_loop())
    except RuntimeError:
        return None


def get_client() -> httpx.AsyncClient:
    key = _loop_key()
    with _clients_lock:
        client = _clients.get(key)
        if client is None or client.is_closed:
            client = httpx.AsyncClient(timeout=30.0, limits=httpx.Limits(max_keepalive_connections=50, max_connections=100))
            _clients[key] = client
        return client


def compute_signature(payload: bytes, secret: str) -> str:
    return hmac.new(secret.encode("utf-8"), payload, hashlib.sha256).hexdigest()


def _base64url_no_pad(raw: bytes) -> str:
    import base64

    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def mint_audit_writer_token() -> str:
    if not INTERNAL_JWT_SECRET:
        raise RuntimeError("INTERNAL_JWT_SECRET is required to send audit events")
    header_b64 = _base64url_no_pad(json.dumps({"alg": "HS256"}).encode())
    payload_b64 = _base64url_no_pad(
        json.dumps(
            {
                "sub": "integration-service",
                "service": "integration-service",
                "tenant_id": "default",
                "aud": AUDIT_WRITER_AUDIENCE,
                "exp": int(time.time()) + 60,
            }
        ).encode()
    )
    signing_input = f"{header_b64}.{payload_b64}"
    signature = _base64url_no_pad(
        hmac.new(INTERNAL_JWT_SECRET.encode(), signing_input.encode(), hashlib.sha256).digest()
    )
    return f"{signing_input}.{signature}"


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
        token = mint_audit_writer_token()
    except RuntimeError as e:
        logger.warning(f"Skipping audit event, service not configured: {e}")
        return
    delays = [0, 0.3]
    for attempt, delay in enumerate(delays):
        if delay:
            await asyncio.sleep(delay)
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
                headers={"x-internal-auth": token},
                timeout=3.0,
            )
            return
        except Exception as e:
            if attempt == len(delays) - 1:
                if AUDIT_DELIVERY_FAILURES is not None:
                    try:
                        AUDIT_DELIVERY_FAILURES.labels(event_type=event_type).inc()
                    except Exception:
                        pass
                logger.warning(f"Failed to send audit event: {e}")


async def close_client():
    key = _loop_key()
    with _clients_lock:
        client = _clients.pop(key, None)
    if client is not None and not client.is_closed:
        await client.aclose()


async def close_all_clients():
    with _clients_lock:
        clients = list(_clients.values())
        _clients.clear()
    for client in clients:
        if not client.is_closed:
            try:
                await client.aclose()
            except Exception as e:
                logger.warning(f"Failed to close webhook client: {e}")
