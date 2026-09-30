import logging
import re
import time

from prometheus_client import Counter, Histogram, Gauge, generate_latest, REGISTRY
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

logger = logging.getLogger(__name__)

PATH_PARAM_PATTERN = re.compile(r"/[0-9a-fA-F-]{36}|/\d+")


def _normalize_path(path: str) -> str:
    return PATH_PARAM_PATTERN.sub("/:param", path)


REQUEST_COUNT = Counter(
    "atlas_http_requests_total",
    "Total HTTP requests",
    labelnames=["method", "path", "status_code"],
)

REQUEST_DURATION = Histogram(
    "atlas_http_request_duration_seconds",
    "HTTP request duration in seconds",
    labelnames=["method", "path", "status_code"],
    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0),
)

REQUESTS_IN_PROGRESS = Gauge(
    "atlas_http_requests_in_progress",
    "Number of HTTP requests in progress",
    labelnames=["method", "path"],
)


class AtlasMetricsMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if request.url.path == "/metrics":
            return Response(content=generate_latest(REGISTRY), media_type="text/plain")

        path = _normalize_path(request.url.path)
        method = request.method
        REQUESTS_IN_PROGRESS.labels(method=method, path=path).inc()

        start = time.monotonic()
        try:
            response = await call_next(request)
        except Exception:
            duration = time.monotonic() - start
            REQUESTS_IN_PROGRESS.labels(method=method, path=path).dec()
            REQUEST_COUNT.labels(method=method, path=path, status_code=500).inc()
            REQUEST_DURATION.labels(method=method, path=path, status_code=500).observe(duration)
            logger.exception("metrics.request_failed", extra={"method": method, "path": path})
            raise

        duration = time.monotonic() - start
        status_code = response.status_code
        REQUESTS_IN_PROGRESS.labels(method=method, path=path).dec()
        REQUEST_COUNT.labels(method=method, path=path, status_code=status_code).inc()
        REQUEST_DURATION.labels(method=method, path=path, status_code=status_code).observe(duration)
        return response
