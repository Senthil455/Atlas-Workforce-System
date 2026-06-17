import base64
import hashlib
import hmac
import json
import re
import time
import uuid
from contextvars import ContextVar
from dataclasses import dataclass, field
from urllib.parse import urlparse, urlunparse

from fastapi import HTTPException
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

correlation_id_ctx: ContextVar[str] = ContextVar("correlation_id", default="")


@dataclass
class ObservabilityConfig:
    service_name: str = ""
    service_version: str = ""
    environment: str = "development"


def get_correlation_id() -> str:
    return correlation_id_ctx.get()


_URL_CREDENTIALS_RE = re.compile(r"://([^:]+):([^@]+)@")


def sanitize_url(url: str) -> str:
    if not url:
        return url
    try:
        parsed = urlparse(url)
        if parsed.password:
            netloc = parsed.hostname or ""
            if parsed.port:
                netloc = f"{netloc}:{parsed.port}"
            if parsed.username:
                netloc = f"{parsed.username}:****@{netloc}"
            return urlunparse(parsed._replace(netloc=netloc))
        return url
    except Exception:
        return _URL_CREDENTIALS_RE.sub(r"://\1:****@", url)


class CorrelationIdMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        correlation_id = request.headers.get("X-Correlation-Id", str(uuid.uuid4()))
        correlation_id_ctx.set(correlation_id)
        response = await call_next(request)
        response.headers["X-Correlation-Id"] = correlation_id
        return response


def verify_internal_auth(request: Request, jwt_secret: str) -> dict:
    if not jwt_secret:
        raise HTTPException(status_code=500, detail="Service not configured")

    auth_header = request.headers.get("x-internal-auth")
    if not auth_header:
        raise HTTPException(status_code=401, detail="Missing internal authentication")

    try:
        parts = auth_header.split(".")
        if len(parts) != 3:
            raise HTTPException(status_code=401, detail="Invalid token format")

        _header_b64, payload_b64, signature = parts

        expected = hmac.new(
            jwt_secret.encode(),
            f"{_header_b64}.{payload_b64}".encode(),
            hashlib.sha256,
        )
        expected_sig = base64.urlsafe_b64encode(expected.digest()).rstrip(b"=").decode()

        if not hmac.compare_digest(expected_sig, signature):
            raise HTTPException(status_code=401, detail="Invalid token signature")

        padded = payload_b64 + "=" * (4 - len(payload_b64) % 4)
        decoded = base64.urlsafe_b64decode(padded)
        claims = json.loads(decoded)

        exp = claims.get("exp", 0)
        if exp and time.time() > exp:
            raise HTTPException(status_code=401, detail="Token expired")

        return claims
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid internal authentication")
