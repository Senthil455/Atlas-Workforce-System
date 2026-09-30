import ipaddress
import os
import re
import socket
from urllib.parse import urlparse

MAX_RESPONSE_BODY_CHARS = 1000
MAX_HEADERS = 20
MAX_HEADER_NAME_LEN = 100
MAX_HEADER_VALUE_LEN = 2000

BLOCKED_HEADER_NAMES = frozenset({
    "host",
    "content-length",
    "content-type",
    "transfer-encoding",
    "te",
    "trailer",
    "upgrade",
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "authorization",
    "cookie",
    "set-cookie",
})

BLOCKED_HEADER_PREFIXES = (
    "x-internal-",
    "x-tenant-id",
    "x-webhook-",
    "proxy-",
)

INTERNAL_SERVICE_NAMES = frozenset({
    "localhost",
    "postgres",
    "redis",
    "rabbitmq",
    "mongodb",
    "mongo",
    "kafka",
    "zookeeper",
    "api-gateway",
    "auth-service",
    "employee-service",
    "payroll-service",
    "analytics-service",
    "notification-service",
    "attendance-service",
    "leave-service",
    "audit-service",
    "audit-compliance-service",
    "integration-service",
    "security-service",
    "lms-service",
    "ats-service",
    "ai-service",
    "ai-copilot-service",
    "live-service",
    "lifecycle-service",
    "workforce-service",
    "workforce-planning-service",
    "performance-service",
})

INTERNAL_SUFFIXES = (".localhost", ".local", ".internal", ".svc", ".cluster.local")

HEADER_NAME_RE = re.compile(r"^[A-Za-z0-9-]+$")


class SSRFBlockedError(ValueError):
    pass


def _env_flag(name: str, default: bool = False) -> bool:
    return os.getenv(name, str(default)).strip().lower() in ("1", "true", "yes", "on")


def _csv_env(name: str) -> set:
    raw = os.getenv(name, "")
    return {part.strip().lower() for part in raw.split(",") if part.strip()}


def is_ip_blocked(ip: ipaddress._BaseAddress) -> bool:
    return (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    )


def validate_webhook_headers(headers: dict | None) -> dict:
    if not headers:
        return {}
    if len(headers) > MAX_HEADERS:
        raise SSRFBlockedError(f"Too many headers (max {MAX_HEADERS})")
    cleaned: dict = {}
    for raw_key, raw_value in headers.items():
        key = str(raw_key).strip()
        value = str(raw_value) if raw_value is not None else ""
        if not key or not HEADER_NAME_RE.match(key):
            raise SSRFBlockedError(f"Invalid header name: {raw_key!r}")
        if len(key) > MAX_HEADER_NAME_LEN:
            raise SSRFBlockedError(f"Header name too long: {key}")
        if len(value) > MAX_HEADER_VALUE_LEN:
            raise SSRFBlockedError(f"Header value too long for: {key}")
        lowered = key.lower()
        if lowered in BLOCKED_HEADER_NAMES:
            raise SSRFBlockedError(f"Header not allowed: {key}")
        if any(lowered == p or lowered.startswith(p) for p in BLOCKED_HEADER_PREFIXES):
            raise SSRFBlockedError(f"Header not allowed: {key}")
        cleaned[key] = value
    return cleaned


def _check_resolved_ips(hostname: str) -> None:
    try:
        infos = socket.getaddrinfo(hostname, None)
    except socket.gaierror:
        raise SSRFBlockedError(f"Hostname does not resolve: {hostname}")
    for info in infos:
        ip_str = info[4][0]
        try:
            ip = ipaddress.ip_address(ip_str)
        except ValueError:
            continue
        if is_ip_blocked(ip):
            raise SSRFBlockedError(f"Hostname resolves to a blocked address: {hostname}")


def validate_webhook_url(url: str, resolve_dns: bool = True) -> str:
    if not url or not isinstance(url, str):
        raise SSRFBlockedError("URL is required")
    url = url.strip()
    if len(url) > 2000:
        raise SSRFBlockedError("URL too long")
    try:
        parsed = urlparse(url)
    except Exception:
        raise SSRFBlockedError("Malformed URL")

    allow_http = _env_flag("WEBHOOK_ALLOW_HTTP", False)
    allowed_schemes = {"https", "http"} if allow_http else {"https"}
    if parsed.scheme.lower() not in allowed_schemes:
        if parsed.scheme.lower() == "http":
            raise SSRFBlockedError("Plain http webhooks are disabled; use https or set WEBHOOK_ALLOW_HTTP=true for local development")
        raise SSRFBlockedError("URL must use https")

    if parsed.username or parsed.password:
        raise SSRFBlockedError("URL must not contain credentials")

    host = (parsed.hostname or "").strip().lower()
    if not host:
        raise SSRFBlockedError("URL must include a hostname")

    allow_private = _env_flag("WEBHOOK_ALLOW_PRIVATE_IPS", False)

    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        ip = None
    if ip is not None:
        if is_ip_blocked(ip) and not allow_private:
            raise SSRFBlockedError(f"Destination IP is blocked: {host}")
        return url

    if host in INTERNAL_SERVICE_NAMES and not allow_private:
        raise SSRFBlockedError(f"Internal hostname is blocked: {host}")
    if host == "localhost" and not allow_private:
        raise SSRFBlockedError(f"Internal hostname is blocked: {host}")
    if any(host.endswith(suffix) for suffix in INTERNAL_SUFFIXES) and not allow_private:
        raise SSRFBlockedError(f"Internal hostname is blocked: {host}")
    if "." not in host and not allow_private:
        raise SSRFBlockedError(f"Single-label hostname is blocked: {host}")

    blocked_hosts = _csv_env("WEBHOOK_BLOCKED_HOSTS")
    if host in blocked_hosts:
        raise SSRFBlockedError(f"Hostname is blocked by policy: {host}")

    allowed_hosts = _csv_env("WEBHOOK_ALLOWED_HOSTS")
    if allowed_hosts and host not in allowed_hosts:
        raise SSRFBlockedError(f"Hostname is not in the egress allowlist: {host}")

    if resolve_dns and not allow_private:
        _check_resolved_ips(host)

    return url
