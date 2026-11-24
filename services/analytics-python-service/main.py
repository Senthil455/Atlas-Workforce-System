import logging
import hashlib
import re
import contextlib
import functools
from datetime import datetime, timezone
from fastapi import FastAPI, HTTPException, Header, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.openapi.utils import get_openapi
from fastapi.responses import JSONResponse
import pandas as pd
import os
import uvicorn
from sqlalchemy import create_engine, text
from openai import OpenAI
import json
import time
import threading
import pika
import requests
from prometheus_client import Counter, Gauge, Histogram
from urllib.parse import urljoin
from atlas_observability import (
    AtlasLoggingMiddleware, AtlasMetricsMiddleware, CorrelationIdMiddleware,
    SecurityHeadersMiddleware,
    configure_logging, get_logger, mint_internal_auth, verify_internal_auth
)

INTERNAL_JWT_SECRET = os.environ.get("INTERNAL_JWT_SECRET", "")

app = FastAPI(title="Analytics Service API", version="2.0.0")

configure_logging("analytics-service", level=logging.INFO)
logger = get_logger("analytics-service")

payroll_cache = {}
payroll_cache_timestamp = {}
PAYROLL_CACHE_TTL = 300
payroll_cache_lock = threading.Lock()

department_cache = {}
department_cache_timestamp = {}
DEPARTMENT_CACHE_TTL = 300
department_cache_lock = threading.Lock()


def invalidate_department_cache(tenant_id=None):
    with department_cache_lock:
        if tenant_id:
            department_cache.pop(tenant_id, None)
            department_cache_timestamp.pop(tenant_id, None)
        else:
            department_cache.clear()
            department_cache_timestamp.clear()


def invalidate_payroll_cache(tenant_id=None):
    with payroll_cache_lock:
        if tenant_id:
            payroll_cache.pop(f"payroll_{tenant_id}", None)
            payroll_cache_timestamp.pop(f"payroll_{tenant_id}", None)
        else:
            payroll_cache.clear()
            payroll_cache_timestamp.clear()


def record_payroll_write(tenant_id=None):
    invalidate_payroll_cache(tenant_id)


def safe_divide(numerator, denominator, default=0):
    try:
        if denominator == 0 or denominator is None:
            return default
        return numerator / denominator
    except (ZeroDivisionError, TypeError, ValueError):
        return default


def _env_int(name, default, minimum=1):
    try:
        value = int(os.environ.get(name, str(default)))
        if value < minimum:
            raise ValueError(f"must be >= {minimum}")
        return value
    except ValueError as e:
        logger.warning("config.invalid_env_value", extra={"name": name, "error": str(e), "fallback": default})
        return default


def _env_float(name, default, minimum=0.0):
    try:
        value = float(os.environ.get(name, str(default)))
        if value < minimum:
            raise ValueError(f"must be >= {minimum}")
        return value
    except ValueError as e:
        logger.warning("config.invalid_env_value", extra={"name": name, "error": str(e), "fallback": default})
        return default


class OverloadedError(Exception):
    """Raised when a heavy endpoint is at capacity and the queue cannot absorb it."""

    def __init__(self, retry_after):
        super().__init__("heavy endpoint at capacity")
        self.retry_after = retry_after


class HeavyEndpointGate:
    """Bounded concurrency gate for expensive analytics computations.

    A request admits immediately while the endpoint is under both the global
    cost budget and the per-tenant request cap. Once the budget is exhausted
    the request waits in a bounded queue for wait_seconds; when the queue is
    full or the wait elapses it is rejected with a retry hint, because fast
    rejection beats slow degradation from one tenant stacking full sweeps.

    Each endpoint declares a cost (a payroll table scan costs more than one
    upstream fetch), and admission is budget-weighted so heavy computations
    consume proportionally more of the capacity.
    """

    def __init__(self, name, budget, cost=1, per_tenant_limit=2, queue_limit=32,
                 wait_seconds=5.0, retry_after=2):
        self.name = name
        self.budget = max(1, int(budget))
        self.cost = max(1, min(int(cost), self.budget))
        self.per_tenant_limit = max(1, int(per_tenant_limit))
        self.queue_limit = max(0, int(queue_limit))
        self.wait_seconds = max(0.0, float(wait_seconds))
        self.retry_after = max(1, int(retry_after))
        self._condition = threading.Condition()
        self._active_cost = 0
        self._queued = 0
        self._active_by_tenant = {}
        self._metrics_lock = threading.Lock()
        self._metrics = {
            "admitted": 0,
            "rejected": 0,
            "timed_out": 0,
            "queued_waits": 0,
            "queued_wait_seconds": 0.0,
        }

    def _record(self, **deltas):
        with self._metrics_lock:
            for key, value in deltas.items():
                self._metrics[key] = self._metrics.get(key, 0) + value

    def metrics(self):
        with self._condition:
            with self._metrics_lock:
                snapshot = dict(self._metrics)
                snapshot["active_cost"] = self._active_cost
                snapshot["queued"] = self._queued
                snapshot["active_tenants"] = len(self._active_by_tenant)
        snapshot["budget"] = self.budget
        snapshot["cost"] = self.cost
        snapshot["perTenantLimit"] = self.per_tenant_limit
        snapshot["queueLimit"] = self.queue_limit
        snapshot["waitSeconds"] = self.wait_seconds
        return snapshot

    def _record_rejection(self, outcome):
        self._record(rejected=1)
        HEAVY_REQUESTS_TOTAL.labels(endpoint=self.name, outcome=outcome).inc()
        HEAVY_QUEUE_DEPTH.labels(endpoint=self.name).set(self._queued)

    @contextlib.contextmanager
    def slot(self, tenant_id):
        start = time.monotonic()
        with self._condition:
            tenant_active = self._active_by_tenant.get(tenant_id, 0)
            if tenant_active >= self.per_tenant_limit:
                self._record_rejection("rejected_tenant_cap")
                raise OverloadedError(self.retry_after)
            if self._active_cost + self.cost > self.budget or self._queued > 0:
                if self._queued >= self.queue_limit:
                    self._record_rejection("rejected_queue_full")
                    raise OverloadedError(self.retry_after)
                self._queued += 1
                HEAVY_QUEUE_DEPTH.labels(endpoint=self.name).set(self._queued)
                try:
                    deadline = start + self.wait_seconds
                    while self._active_cost + self.cost > self.budget:
                        remaining = deadline - time.monotonic()
                        if remaining <= 0:
                            self._record(timed_out=1)
                            raise OverloadedError(self.retry_after)
                        self._condition.wait(remaining)
                finally:
                    self._queued -= 1
                    HEAVY_QUEUE_DEPTH.labels(endpoint=self.name).set(self._queued)
                wait_seconds = time.monotonic() - start
                self._record(queued_waits=1, queued_wait_seconds=wait_seconds)
                HEAVY_QUEUE_WAIT_SECONDS.labels(endpoint=self.name).observe(wait_seconds)
            self._active_cost += self.cost
            self._active_by_tenant[tenant_id] = tenant_active + 1
            self._record(admitted=1)
            HEAVY_REQUESTS_TOTAL.labels(endpoint=self.name, outcome="admitted").inc()
            HEAVY_IN_FLIGHT.labels(endpoint=self.name).inc()
        try:
            yield
        finally:
            with self._condition:
                self._active_cost = max(0, self._active_cost - self.cost)
                tenant_remaining = self._active_by_tenant.get(tenant_id, 1) - 1
                if tenant_remaining > 0:
                    self._active_by_tenant[tenant_id] = tenant_remaining
                else:
                    self._active_by_tenant.pop(tenant_id, None)
                self._condition.notify()
            HEAVY_IN_FLIGHT.labels(endpoint=self.name).dec()


# Concurrency configuration. Defaults are sized for a single worker process
# (uvicorn's threadpool), documented in .env.example and overridable per
# deployment: ANALYTICS_HEAVY_MAX_CONCURRENCY is a global cost budget shared
# by the heavy endpoints, ANALYTICS_HEAVY_MAX_PER_TENANT caps one tenant's
# concurrent heavy requests, and over-limit requests wait in a queue of
# ANALYTICS_HEAVY_QUEUE_LIMIT for at most ANALYTICS_HEAVY_QUEUE_WAIT_SECONDS
# before a 503 with Retry-After (ANALYTICS_HEAVY_RETRY_AFTER_SECONDS).
HEAVY_ENDPOINT_GLOBAL_BUDGET = _env_int("ANALYTICS_HEAVY_MAX_CONCURRENCY", 8)
HEAVY_ENDPOINT_PER_TENANT_LIMIT = _env_int("ANALYTICS_HEAVY_MAX_PER_TENANT", 2)
HEAVY_ENDPOINT_QUEUE_LIMIT = _env_int("ANALYTICS_HEAVY_QUEUE_LIMIT", 32, minimum=0)
HEAVY_ENDPOINT_QUEUE_WAIT_SECONDS = _env_float("ANALYTICS_HEAVY_QUEUE_WAIT_SECONDS", 5.0)
HEAVY_ENDPOINT_RETRY_AFTER_SECONDS = _env_int("ANALYTICS_HEAVY_RETRY_AFTER_SECONDS", 2)

# Relative cost of each heavy computation within the global budget.
HEAVY_ENDPOINT_COSTS = {
    "analytics.department": 1,
    "analytics.payroll": 2,
    "analytics.payroll-verify": 2,
    "analytics.ai-insights": 3,
}

HEAVY_REQUESTS_TOTAL = Counter(
    "atlas_analytics_heavy_requests_total",
    "Heavy analytics endpoint admissions and rejections",
    labelnames=["endpoint", "outcome"],
)
HEAVY_IN_FLIGHT = Gauge(
    "atlas_analytics_heavy_requests_in_flight",
    "Heavy analytics computations currently running",
    labelnames=["endpoint"],
)
HEAVY_QUEUE_DEPTH = Gauge(
    "atlas_analytics_heavy_queue_depth",
    "Heavy analytics requests waiting for capacity",
    labelnames=["endpoint"],
)
HEAVY_QUEUE_WAIT_SECONDS = Histogram(
    "atlas_analytics_heavy_queue_wait_seconds",
    "Time heavy analytics requests spent waiting for capacity",
    labelnames=["endpoint"],
    buckets=(0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0),
)

HEAVY_ENDPOINT_GATES = {
    name: HeavyEndpointGate(
        name,
        budget=HEAVY_ENDPOINT_GLOBAL_BUDGET,
        cost=cost,
        per_tenant_limit=HEAVY_ENDPOINT_PER_TENANT_LIMIT,
        queue_limit=HEAVY_ENDPOINT_QUEUE_LIMIT,
        wait_seconds=HEAVY_ENDPOINT_QUEUE_WAIT_SECONDS,
        retry_after=HEAVY_ENDPOINT_RETRY_AFTER_SECONDS,
    )
    for name, cost in HEAVY_ENDPOINT_COSTS.items()
}


def heavy_endpoint(name):
    """Wrap a heavy endpoint with its concurrency gate.

    Over-capacity requests get a 503 plus Retry-After instead of queueing
    without bound. Interactive endpoints (health, single-row lookups, the
    cheap command-center reads) stay unthrottled by design; the caps target
    the full-sweep computations and external calls that share the worker.
    """

    def decorator(func):
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            gate = HEAVY_ENDPOINT_GATES[name]
            tenant_id = kwargs.get("x_tenant_id") or "default"
            try:
                with gate.slot(tenant_id):
                    return func(*args, **kwargs)
            except OverloadedError as e:
                logger.warning(
                    "analytics.heavy_endpoint_overloaded",
                    extra={"endpoint": name, "tenant_id": tenant_id},
                )
                raise HTTPException(
                    status_code=503,
                    detail=f"Service busy: {name} at capacity, retry shortly",
                    headers={"Retry-After": str(e.retry_after)},
                )

        return wrapper

    return decorator


def custom_openapi():
    if app.openapi_schema:
        return app.openapi_schema
    openapi_schema = get_openapi(
        title="Atlas Analytics Service",
        version="2.0.0",
        description="Workforce analytics, reporting, and AI-powered insights. Part of the Atlas Workforce System.",
        routes=app.routes,
    )
    openapi_schema["servers"] = [{"url": "http://localhost:8003", "description": "Local development"}]
    openapi_schema["tags"] = [
        {"name": "analytics", "description": "Analytics and reporting endpoints"},
        {"name": "ai", "description": "AI-powered insights"},
        {"name": "health", "description": "Service health check"},
        {"name": "command-center", "description": "Command Center dashboard endpoints"},
    ]
    app.openapi_schema = openapi_schema
    return app.openapi_schema


app.openapi = custom_openapi

ALLOWED_ORIGINS = os.environ.get("ALLOWED_ORIGINS", "http://localhost:3000").split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.add_middleware(CorrelationIdMiddleware)
app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(AtlasLoggingMiddleware)
app.add_middleware(AtlasMetricsMiddleware)


@app.middleware("http")
async def internal_auth_middleware(request: Request, call_next):
    if request.url.path in ("/health", "/metrics"):
        return await call_next(request)

    auth_header = request.headers.get("x-internal-auth")
    if not auth_header:
        return JSONResponse(status_code=401, content={"error": "Missing internal authentication"})

    try:
        claims = verify_internal_auth(request, INTERNAL_JWT_SECRET)
        request.state.tenant_id = claims.get("tenant_id", "default")
        request.state.user_id = claims.get("user_id", "")
        request.state.user_role = claims.get("user_role", "employee")
        # Enforce tenant isolation - reject if header/query tenant differs from claim
        header_tenant = request.headers.get("x-tenant-id") or request.headers.get("X-Tenant-Id")
        if header_tenant and header_tenant != request.state.tenant_id:
            return JSONResponse(status_code=403, content={"error": "Tenant mismatch"})
        query_tenant = request.query_params.get("tenant_id")
        if query_tenant and query_tenant != request.state.tenant_id:
            return JSONResponse(status_code=403, content={"error": "Tenant mismatch"})
        # Overwrite tenant header/query with verified claim so downstream code cannot use spoofed value
        try:
            headers = list(request.scope.get("headers", []))
            found = False
            for idx, (k, v) in enumerate(headers):
                if k.lower() == b"x-tenant-id":
                    headers[idx] = (k, request.state.tenant_id.encode())
                    found = True
            if not found:
                headers.append((b"x-tenant-id", request.state.tenant_id.encode()))
            request.scope["headers"] = headers
            # For query-based services, ensure tenant_id query param matches claim
            from urllib.parse import parse_qs, urlencode
            qs = request.scope.get("query_string", b"").decode()
            if qs:
                params = parse_qs(qs)
                if "tenant_id" in params:
                    params["tenant_id"] = [request.state.tenant_id]
                    request.scope["query_string"] = urlencode(params, doseq=True).encode()
        except (AttributeError, TypeError, ValueError, UnicodeError) as e:
            logger.warning("auth.tenant_scope_rewrite_failed", extra={"error": str(e)})
    except HTTPException as e:
        return JSONResponse(status_code=e.status_code, content={"error": e.detail})
    except (ValueError, KeyError, AttributeError, TypeError, UnicodeError) as e:
        logger.warning("auth.unexpected_claims_shape", extra={"error": str(e), "error_type": type(e).__name__})
        return JSONResponse(status_code=401, content={"error": "Invalid internal authentication"})
    except Exception:
        logger.exception("auth.middleware_unexpected_error")
        return JSONResponse(status_code=401, content={"error": "Invalid internal authentication"})

    return await call_next(request)


POSTGRES_USER = os.environ.get("POSTGRES_USER", "atlas_user")
POSTGRES_PASSWORD = os.environ.get("POSTGRES_PASSWORD", "atlas_password")
POSTGRES_HOST = os.environ.get("POSTGRES_HOST", "postgres")
POSTGRES_DB = os.environ.get("POSTGRES_DB", "atlas_db")
DATABASE_URL = os.environ.get(
    "POSTGRES_URL",
    f"postgresql://{POSTGRES_USER}:{POSTGRES_PASSWORD}@{POSTGRES_HOST}:5432/{POSTGRES_DB}",
)

try:
    engine = create_engine(DATABASE_URL)
except Exception:
    logger.exception("analytics.engine_creation_failed")
    engine = None

api_key = os.environ.get("OPENAI_API_KEY")
client = OpenAI(api_key=api_key) if api_key and api_key != "dummy_key_for_now" else None


@app.get("/health", tags=["health"])
def health_check():
    """Check if the analytics service is healthy."""
    return {"status": "Analytics Service is running"}


RABBITMQ_URL = os.environ.get("RABBITMQ_URL", "")
RABBITMQ_HOST = os.environ.get("RABBITMQ_HOST", "rabbitmq")


def _get_rabbitmq_port():
    try:
        return int(os.environ.get("RABBITMQ_PORT", "5672"))
    except ValueError as e:
        logger.warning("config.invalid_RABBITMQ_PORT", extra={"error": str(e), "fallback": 5672})
        return 5672


RABBITMQ_PORT = _get_rabbitmq_port()
RABBITMQ_USER = os.environ.get("RABBITMQ_USER", "guest")
RABBITMQ_PASSWORD = os.environ.get("RABBITMQ_PASSWORD", "guest")


def _rabbitmq_params():
    if RABBITMQ_URL:
        return pika.URLParameters(RABBITMQ_URL)
    return pika.ConnectionParameters(
        host=RABBITMQ_HOST,
        port=RABBITMQ_PORT,
        credentials=pika.PlainCredentials(RABBITMQ_USER, RABBITMQ_PASSWORD),
    )

EMPLOYEE_SERVICE_URL = os.environ.get("EMPLOYEE_SERVICE_URL", "http://employee-service:8001")
ATS_SERVICE_URL = os.environ.get("ATS_SERVICE_URL", "http://ats-service:8012")
# The employee service caps page_size at 100 (employee-python-service/main.py:313)
# and reports a `total` plus `total_pages`; walk pages until the reported total.
EMPLOYEE_PAGE_SIZE = 100
EMPLOYEE_MAX_PAGES = 500
EMPLOYEE_SERVICE_AUDIENCE = "employee-service"
ATS_PAGE_SIZE = 100
ATS_MAX_PAGES = 200

# Canned command-center fixtures were authored against this date. They are
# surfaced with dataSource.kind = "not-live" until each view gets a real
# source, so nothing on the dashboard pretends to be measured tenant data.
CANNED_FIXTURE_AS_OF = "2026-05-25T00:00:00Z"


def _iso_now():
    return datetime.now(timezone.utc).isoformat()


def fixture_data_source(basis="Canned fixture data for UI development; not tenant data"):
    """Explicit provenance marker for endpoints that are not live yet."""
    return {
        "kind": "not-live",
        "services": [],
        "basis": basis,
        "liveFields": [],
        "notLiveFields": [],
        "unavailableFields": [],
        "asOf": CANNED_FIXTURE_AS_OF,
    }


def build_data_source(kind, services, basis, live_fields=None,
                      not_live_fields=None, unavailable_fields=None):
    return {
        "kind": kind,
        "services": services,
        "basis": basis,
        "liveFields": sorted(live_fields or []),
        "notLiveFields": sorted(not_live_fields or []),
        "unavailableFields": sorted(unavailable_fields or []),
        "asOf": _iso_now(),
    }


def build_internal_service_headers(tenant_id, audience):
    """Headers for an internal service-to-service call.

    The token is minted with the shared credential helper so its signature
    cannot drift from verify_internal_auth; downstream services bind the
    tenant from the claim instead of trusting the header value.
    """
    try:
        token = mint_internal_auth(
            INTERNAL_JWT_SECRET, "analytics-service",
            tenant_id=tenant_id, audience=audience, ttl_seconds=60,
        )
    except ValueError:
        logger.error("analytics.internal_service_auth_not_configured")
        raise HTTPException(
            status_code=502,
            detail="Internal service unavailable (internal auth not configured)",
        )
    return {"X-Tenant-Id": tenant_id, "x-internal-auth": token}


def build_employee_service_headers(tenant_id):
    """Headers for an internal call to the employee service.

    The internal JWT is minted with the shared credential helper so the
    signature format cannot drift from verify_internal_auth; the employee
    service binds the tenant from these claims, not from the header value.
    """
    return build_internal_service_headers(tenant_id, EMPLOYEE_SERVICE_AUDIENCE)


def fetch_tenant_employees(tenant_id):
    """Fetch every employee for a tenant across all upstream pages.

    Follows the employee service contract: page (1-based), page_size (max
    100), `total` and `total_pages` in the response. A non-200 upstream is an
    error (502 naming the dependency), never an empty result.
    """
    items = []
    page = 1
    while page <= EMPLOYEE_MAX_PAGES:
        resp = requests.get(
            urljoin(EMPLOYEE_SERVICE_URL, "/employees"),
            params={"page": page, "page_size": EMPLOYEE_PAGE_SIZE},
            headers=build_employee_service_headers(tenant_id),
            timeout=10,
        )
        if resp.status_code != 200:
            raise HTTPException(
                status_code=502,
                detail=f"Employee service unavailable (upstream status {resp.status_code})",
            )
        try:
            payload = resp.json()
        except ValueError:
            raise HTTPException(status_code=502, detail="Employee service returned an invalid payload")

        if isinstance(payload, list):
            # Legacy response shape without pagination metadata.
            items.extend(payload)
            return items

        batch = payload.get("items", [])
        items.extend(batch)
        if not batch:
            break
        total = payload.get("total")
        if isinstance(total, int) and len(items) >= total:
            break
        total_pages = payload.get("total_pages")
        if isinstance(total_pages, int) and page >= total_pages:
            break
        page += 1
    else:
        logger.warning("analytics.department_pagination_cap_reached",
                       extra={"tenant_fp": hashlib.sha256(str(tenant_id).encode()).hexdigest()[:16],
                              "max_pages": EMPLOYEE_MAX_PAGES})
    return items


def fetch_ats_json(path, tenant_id, params=None):
    resp = requests.get(
        urljoin(ATS_SERVICE_URL, path),
        params=params,
        headers=build_internal_service_headers(tenant_id, "ats-service"),
        timeout=10,
    )
    if resp.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail=f"ATS service unavailable (upstream status {resp.status_code})",
        )
    try:
        return resp.json()
    except ValueError:
        raise HTTPException(status_code=502, detail="ATS service returned an invalid payload")


def fetch_ats_open_positions(tenant_id):
    payload = fetch_ats_json("/api/v1/jobs", tenant_id,
                             params={"status": "PUBLISHED", "page": 1, "page_size": 1})
    total = payload.get("total")
    return int(total) if isinstance(total, int) else 0


def fetch_ats_time_to_hire_days(tenant_id):
    payload = fetch_ats_json("/api/v1/analytics/time-to-hire", tenant_id)
    days = payload.get("average_days")
    return round(float(days), 1) if isinstance(days, (int, float)) else None


def fetch_ats_pipeline_snapshot(tenant_id):
    """Return the ATS candidate overview plus every published job."""
    overview = fetch_ats_json("/api/v1/analytics/overview", tenant_id)
    jobs = []
    page = 1
    while page <= ATS_MAX_PAGES:
        payload = fetch_ats_json("/api/v1/jobs", tenant_id, params={
            "status": "PUBLISHED", "page": page, "page_size": ATS_PAGE_SIZE,
        })
        batch = payload.get("items", [])
        jobs.extend(batch)
        if not batch:
            break
        total_pages = payload.get("total_pages")
        if isinstance(total_pages, int) and page >= total_pages:
            break
        page += 1
    return overview, jobs


def fetch_payroll_mtd(tenant_id):
    """Gross payroll (base + allowances) booked in the current month."""
    if not engine:
        raise RuntimeError("database engine unavailable")
    period = datetime.now(timezone.utc).strftime("%Y-%m")
    query = text("""
        SELECT COALESCE(sum(base_salary + allowances), 0) AS total
        FROM payroll_records
        WHERE tenant_id = :tenant_id AND period = :period
    """)
    df = pd.read_sql_query(query.bindparams(tenant_id=tenant_id, period=period), engine)
    if df.empty:
        return 0.0
    return float(df.iloc[0]["total"])


def fetch_payroll_by_employee(tenant_id):
    """Per-employee payroll aggregates for the cost view."""
    if not engine:
        raise RuntimeError("database engine unavailable")
    query = text("""
        SELECT employee_id,
               sum(base_salary) AS base_salary,
               sum(allowances) AS allowances,
               sum(tax) AS tax
        FROM payroll_records
        WHERE tenant_id = :tenant_id
        GROUP BY employee_id
    """)
    df = pd.read_sql_query(query.bindparams(tenant_id=tenant_id), engine)
    return df.to_dict(orient="records")


def fetch_payroll_by_period(tenant_id, limit=6):
    """Cost per payroll period, oldest first, capped to the recent window."""
    if not engine:
        raise RuntimeError("database engine unavailable")
    query = text("""
        SELECT period, sum(base_salary + allowances) AS cost
        FROM payroll_records
        WHERE tenant_id = :tenant_id
        GROUP BY period
        ORDER BY period DESC
        LIMIT :limit
    """)
    df = pd.read_sql_query(query.bindparams(tenant_id=tenant_id, limit=limit), engine)
    return list(reversed(df.to_dict(orient="records")))


@app.get("/analytics/department", tags=["analytics"], summary="Department headcount breakdown")
@heavy_endpoint("analytics.department")
def get_department_analytics(x_tenant_id: str = Header("default", alias="X-Tenant-Id")):
    """Returns headcount grouped by department for the given tenant."""
    now = time.time()
    with department_cache_lock:
        cached = department_cache.get(x_tenant_id)
        if cached is not None and (now - department_cache_timestamp.get(x_tenant_id, 0)) < DEPARTMENT_CACHE_TTL:
            return cached
    try:
        items = fetch_tenant_employees(x_tenant_id)
        if not items:
            result = []
        else:
            dept_counts = {}
            for emp in items:
                dept = emp.get("department", "Unknown")
                dept_counts[dept] = dept_counts.get(dept, 0) + 1
            result = [
                {"department": dept, "headcount": count}
                for dept, count in sorted(dept_counts.items(), key=lambda x: -x[1])
            ]
        with department_cache_lock:
            department_cache[x_tenant_id] = result
            department_cache_timestamp[x_tenant_id] = time.time()
        return result
    except HTTPException:
        raise
    except requests.Timeout as e:
        logger.warning("analytics.department_analytics_timeout", extra={"error": str(e), "tenant_id": x_tenant_id})
        raise HTTPException(status_code=504, detail="Employee service timed out")
    except requests.RequestException as e:
        logger.warning("analytics.department_analytics_unavailable", extra={"error": str(e), "tenant_id": x_tenant_id})
        raise HTTPException(status_code=502, detail="Employee service unavailable")
    except (ValueError, KeyError, AttributeError, TypeError) as e:
        logger.warning("analytics.department_analytics_bad_payload", extra={"error": str(e), "tenant_id": x_tenant_id})
        raise HTTPException(status_code=502, detail="Employee service returned an invalid payload")
    except Exception:
        logger.exception("analytics.department_analytics_failed", extra={"tenant_id": x_tenant_id})
        raise HTTPException(status_code=500, detail="Failed to retrieve department analytics")


@app.get("/analytics/payroll", tags=["analytics"], summary="Payroll trends")
@heavy_endpoint("analytics.payroll")
def get_payroll_analytics(x_tenant_id: str = Header("default", alias="X-Tenant-Id")):
    """Returns aggregated payroll data grouped by period."""
    if not engine:
        raise HTTPException(status_code=500, detail="Database connection failed")

    cache_key = f"payroll_{x_tenant_id}"
    now = time.time()
    with payroll_cache_lock:
        if cache_key in payroll_cache and (now - payroll_cache_timestamp.get(cache_key, 0)) < PAYROLL_CACHE_TTL:
            return payroll_cache[cache_key]

    try:
        query = """
        SELECT period, sum(base_salary) as total_base, sum(tax) as total_tax, sum(net_salary) as total_net
        FROM payroll_records
        WHERE tenant_id = :tenant_id
        GROUP BY period
        ORDER BY period ASC
        """
        df = pd.read_sql_query(text(query).bindparams(tenant_id=x_tenant_id), engine)
        result = df.to_dict(orient="records")
        with payroll_cache_lock:
            payroll_cache[cache_key] = result
            payroll_cache_timestamp[cache_key] = now
        return result
    except Exception:
        logger.exception("analytics.payroll_failed", extra={"tenant_id": x_tenant_id})
        return []


@app.get("/analytics/performance", tags=["analytics"], summary="Performance prediction")
def get_performance_prediction():
    """Returns mock performance prediction data based on experience and project completion."""
    data = {
        "employee_id": [1, 2, 3],
        "years_experience": [2, 5, 10],
        "projects_completed": [5, 12, 25],
    }
    df = pd.DataFrame(data)

    df["performance_score"] = (df["years_experience"] * 0.4) + (
        df["projects_completed"] * 0.6
    )
    top_performer = df.loc[df["performance_score"].idxmax()]

    return {
        "predictions_ready": True,
        "top_performer_id": int(top_performer["employee_id"]),
        "score": float(top_performer["performance_score"]),
        "provisional": True,
        "source": "mock-heuristic",
        "disclaimer": "Provisional mock output for UI development; not a production prediction.",
    }


@app.post("/analytics/ai-insights", tags=["ai"], summary="AI-powered workforce insights")
@heavy_endpoint("analytics.ai-insights")
def get_ai_insights(x_tenant_id: str = Header("default", alias="X-Tenant-Id")):
    """Generates strategic HR insights using AI based on current workforce data."""
    try:
        if not client:
            return {
                "insight": (
                    "AI Insights (Mock): Your engineering department is growing rapidly, "
                    "which correlates with the 15% increase in total net payroll observed this period. "
                    "Consider optimizing cloud costs to offset the growing personnel expenditure."
                )
            }

        dept_data = get_department_analytics(x_tenant_id=x_tenant_id)
        payroll_data = get_payroll_analytics(x_tenant_id=x_tenant_id)

        context = f"Department Headcounts: {json.dumps(dept_data)}. Payroll Trends: {json.dumps(payroll_data)}."

        response = client.chat.completions.create(
            model="gpt-4",
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are an expert HR and financial analyst AI. Provide a "
                        "2-sentence strategic insight based on the provided workforce data."
                    ),
                },
                {"role": "user", "content": context},
            ],
        )
        return {"insight": response.choices[0].message.content}
    except HTTPException:
        raise
    except (TimeoutError, ConnectionError) as e:
        logger.warning("analytics.ai_insights_unavailable", extra={"error": str(e), "tenant_id": x_tenant_id})
        raise HTTPException(status_code=502, detail="AI provider unavailable")
    except Exception:
        logger.exception("analytics.ai_insights_failed", extra={"tenant_id": x_tenant_id})
        raise HTTPException(status_code=500, detail="Failed to generate AI insights")


@app.get("/analytics/concurrency/status", tags=["analytics"],
         summary="Heavy endpoint concurrency status")
def get_concurrency_status(x_tenant_id: str = Header("default", alias="X-Tenant-Id")):
    """Current in-flight cost, queue depth and admission counters per heavy endpoint.

    The same numbers are exported to Prometheus on /metrics as
    atlas_analytics_heavy_requests_total, atlas_analytics_heavy_requests_in_flight,
    atlas_analytics_heavy_queue_depth and atlas_analytics_heavy_queue_wait_seconds.
    """
    return {
        "endpoints": {name: gate.metrics() for name, gate in HEAVY_ENDPOINT_GATES.items()},
        "thresholds": {
            "maxConcurrency": HEAVY_ENDPOINT_GLOBAL_BUDGET,
            "maxPerTenant": HEAVY_ENDPOINT_PER_TENANT_LIMIT,
            "queueLimit": HEAVY_ENDPOINT_QUEUE_LIMIT,
            "queueWaitSeconds": HEAVY_ENDPOINT_QUEUE_WAIT_SECONDS,
            "retryAfterSeconds": HEAVY_ENDPOINT_RETRY_AFTER_SECONDS,
        },
        "unthrottled_note": (
            "Interactive endpoints (health, performance, command-center reads) are "
            "intentionally unthrottled; only full-sweep computations and external "
            "calls carry a concurrency gate."
        ),
    }


@app.get("/api/v1/command-center/overview", tags=["command-center"], summary="Command Center overview")
def get_overview(x_tenant_id: str = Header("default", alias="X-Tenant-Id")):
    """Organization overview. Live fields are computed per request; fields
    without a live source are null and named in dataSource."""
    unavailable = []
    total_headcount = None
    try:
        total_headcount = len(fetch_tenant_employees(x_tenant_id))
    except HTTPException as e:
        logger.warning("analytics.overview_headcount_unavailable",
                       extra={"tenant_id": x_tenant_id, "status_code": e.status_code})
        unavailable.append("totalHeadcount")

    payroll_mtd = None
    try:
        payroll_mtd = fetch_payroll_mtd(x_tenant_id)
    except Exception as e:
        logger.warning("analytics.overview_payroll_unavailable",
                       extra={"tenant_id": x_tenant_id, "error": str(e), "error_type": type(e).__name__})
        unavailable.append("payrollMtd")

    open_positions = None
    try:
        open_positions = fetch_ats_open_positions(x_tenant_id)
    except HTTPException as e:
        logger.warning("analytics.overview_open_positions_unavailable",
                       extra={"tenant_id": x_tenant_id, "status_code": e.status_code})
        unavailable.append("openPositions")

    avg_time_to_hire = None
    try:
        avg_time_to_hire = fetch_ats_time_to_hire_days(x_tenant_id)
    except HTTPException as e:
        logger.warning("analytics.overview_time_to_hire_unavailable",
                       extra={"tenant_id": x_tenant_id, "status_code": e.status_code})
        unavailable.append("avgTimeToHire")

    return {
        "totalHeadcount": total_headcount,
        "headcountChange": None,
        "payrollMtd": payroll_mtd,
        "payrollChange": None,
        "openPositions": open_positions,
        "positionsChange": None,
        "trainingCompletion": None,
        "trainingChange": None,
        "satisfactionScore": None,
        "satisfactionChange": None,
        "orgHealthScore": None,
        "productivityScore": None,
        "riskScore": None,
        "newHiresThisMonth": None,
        "departuresThisMonth": None,
        "avgTenure": None,
        "avgTimeToHire": avg_time_to_hire,
        "dataSource": build_data_source(
            "mixed",
            ["employee-python-service", "ats-service", "payroll_records (primary database)"],
            "totalHeadcount is the employee service total, payrollMtd is gross payroll "
            "(base + allowances) booked this month, and openPositions/avgTimeToHire come "
            "from the ATS service. Every other field has no live source yet and is null.",
            live_fields=["totalHeadcount", "payrollMtd", "openPositions", "avgTimeToHire"],
            not_live_fields=[
                "headcountChange", "payrollChange", "positionsChange",
                "trainingCompletion", "trainingChange", "satisfactionScore",
                "satisfactionChange", "orgHealthScore", "productivityScore",
                "riskScore", "newHiresThisMonth", "departuresThisMonth", "avgTenure",
            ],
            unavailable_fields=unavailable,
        ),
        "asOf": _iso_now(),
    }


@app.get("/api/v1/command-center/org-health", tags=["command-center"], summary="Organizational health dashboard")
def get_org_health(x_tenant_id: str = Header("default", alias="X-Tenant-Id")):
    """Returns organizational health breakdown by dimension with trend data."""
    return {
        "dataSource": fixture_data_source("Static health-dimension fixture; not tenant data"),
        "asOf": CANNED_FIXTURE_AS_OF,
        "overall": 78,
        "dimensions": [
            {"name": "Engagement", "score": 82, "change": 3, "status": "healthy"},
            {"name": "Productivity", "score": 78, "change": -2, "status": "healthy"},
            {"name": "Retention", "score": 74, "change": 5, "status": "moderate"},
            {"name": "Culture", "score": 71, "change": 1, "status": "moderate"},
            {"name": "Innovation", "score": 68, "change": -4, "status": "needs-attention"},
            {"name": "Diversity", "score": 76, "change": 8, "status": "healthy"},
            {"name": "Wellness", "score": 80, "change": 2, "status": "healthy"},
        ],
        "trend": [
            {"month": "2026-01", "score": 72},
            {"month": "2026-02", "score": 74},
            {"month": "2026-03", "score": 75},
            {"month": "2026-04", "score": 77},
            {"month": "2026-05", "score": 78},
        ],
    }


@app.get("/api/v1/command-center/department-heatmap", tags=["command-center"], summary="Department heatmap")
def get_department_heatmap(x_tenant_id: str = Header("default", alias="X-Tenant-Id")):
    """Returns organization heatmap with department-level metrics and health scores."""
    return {
        "dataSource": fixture_data_source("Static department heatmap fixture; not tenant data"),
        "asOf": CANNED_FIXTURE_AS_OF,
        "departments": [
            {"name": "Engineering",
             "metrics": {"productivity": 92, "engagement": 85, "retention": 88,
                         "innovation": 90, "wellness": 78},
             "headcount": 420, "attrition": 8, "budgetUtilization": 88,
             "health": "excellent"},
            {"name": "Sales",
             "metrics": {"productivity": 88, "engagement": 72, "retention": 70,
                         "innovation": 65, "wellness": 75},
             "headcount": 280, "attrition": 15, "budgetUtilization": 92,
             "health": "good"},
            {"name": "Operations",
             "metrics": {"productivity": 85, "engagement": 78, "retention": 82,
                         "innovation": 60, "wellness": 80},
             "headcount": 210, "attrition": 10, "budgetUtilization": 76,
             "health": "good"},
            {"name": "HR",
             "metrics": {"productivity": 90, "engagement": 82, "retention": 92,
                         "innovation": 70, "wellness": 85},
             "headcount": 95, "attrition": 5, "budgetUtilization": 70,
             "health": "excellent"},
            {"name": "Finance",
             "metrics": {"productivity": 87, "engagement": 80, "retention": 90,
                         "innovation": 55, "wellness": 82},
             "headcount": 143, "attrition": 6, "budgetUtilization": 85,
             "health": "excellent"},
            {"name": "Marketing",
             "metrics": {"productivity": 83, "engagement": 76, "retention": 74,
                         "innovation": 85, "wellness": 72},
             "headcount": 100, "attrition": 12, "budgetUtilization": 80,
             "health": "good"},
        ],
        "avgProductivity": 87.5,
        "avgEngagement": 78.8,
        "overallHealth": "good",
    }


@app.get("/api/v1/command-center/workforce-cost", tags=["command-center"], summary="Workforce cost visualization")
def get_workforce_cost(x_tenant_id: str = Header("default", alias="X-Tenant-Id")):
    """Cost visualization computed from payroll_records and employee data."""
    unavailable = []
    try:
        payroll_rows = fetch_payroll_by_employee(x_tenant_id)
    except Exception as e:
        logger.warning("analytics.workforce_cost_payroll_unavailable",
                       extra={"tenant_id": x_tenant_id, "error": str(e), "error_type": type(e).__name__})
        raise HTTPException(status_code=502, detail="Payroll data unavailable")

    employees = None
    try:
        employees = fetch_tenant_employees(x_tenant_id)
    except HTTPException as e:
        logger.warning("analytics.workforce_cost_headcount_unavailable",
                       extra={"tenant_id": x_tenant_id, "status_code": e.status_code})
        unavailable.append("byDepartment.headcount")

    department_by_employee = {}
    if employees is not None:
        for emp in employees:
            emp_id = emp.get("_id") or emp.get("id")
            if emp_id:
                department_by_employee[str(emp_id)] = emp.get("department", "Unknown")

    totals_by_department = {}
    for row in payroll_rows:
        department = department_by_employee.get(str(row.get("employee_id")), "Unmapped")
        entry = totals_by_department.setdefault(department, {"payroll": 0.0, "taxes": 0.0, "headcount": 0})
        entry["payroll"] += float(row.get("base_salary") or 0) + float(row.get("allowances") or 0)
        entry["taxes"] += float(row.get("tax") or 0)
        entry["headcount"] += 1

    total_payroll = round(sum(e["payroll"] for e in totals_by_department.values()), 2)
    total_taxes = round(sum(e["taxes"] for e in totals_by_department.values()), 2)
    by_department = [
        {
            "department": dept,
            "headcount": entry["headcount"],
            "payroll": round(entry["payroll"], 2),
            "benefits": None,
            "total": round(entry["payroll"], 2),
            "percentOfTotal": round((entry["payroll"] / total_payroll) * 100, 1) if total_payroll else 0.0,
        }
        for dept, entry in sorted(totals_by_department.items(), key=lambda x: -x[1]["payroll"])
    ]

    cost_trend = None
    try:
        cost_trend = fetch_payroll_by_period(x_tenant_id)
    except Exception as e:
        logger.warning("analytics.workforce_cost_trend_unavailable",
                       extra={"tenant_id": x_tenant_id, "error": str(e), "error_type": type(e).__name__})
        unavailable.append("costTrend")

    headcount = len(employees) if employees is not None else None
    return {
        "totalPayroll": total_payroll,
        "totalBenefits": None,
        "totalTaxes": total_taxes,
        "totalCost": total_payroll,
        "byDepartment": by_department,
        "costPerEmployee": round(total_payroll / headcount, 2) if headcount else None,
        "costTrend": cost_trend,
        "dataSource": build_data_source(
            "mixed",
            ["payroll_records (primary database)", "employee-python-service"],
            "Cost is gross payroll (base + allowances) from payroll_records; departments "
            "come from the employee service via employee_id. Benefits have no live source "
            "and are null, and unmatched payroll rows are grouped as Unmapped.",
            live_fields=["totalPayroll", "totalTaxes", "totalCost", "byDepartment", "costTrend", "costPerEmployee"],
            not_live_fields=["totalBenefits", "byDepartment.benefits"],
            unavailable_fields=unavailable,
        ),
        "asOf": _iso_now(),
    }


@app.get("/api/v1/command-center/attrition-risk-map", tags=["command-center"], summary="Attrition risk map")
def get_attrition_risk_map(x_tenant_id: str = Header("default", alias="X-Tenant-Id")):
    """Returns attrition risk analysis with department breakdown, high-risk employees, and trend."""
    return {
        "dataSource": fixture_data_source("Static attrition fixture; not tenant data"),
        "asOf": CANNED_FIXTURE_AS_OF,
        "overallRiskScore": 22,
        "atRiskCount": 28,
        "highRiskCount": 8,
        "byDepartment": [
            {"department": "Engineering", "riskScore": 32, "atRisk": 12,
                "highRisk": 4, "avgTenure": 2.8, "avgSatisfaction": 68},
            {"department": "Sales", "riskScore": 28, "atRisk": 8,
             "highRisk": 2, "avgTenure": 3.1, "avgSatisfaction": 72},
            {"department": "Operations", "riskScore": 18, "atRisk": 4,
             "highRisk": 1, "avgTenure": 4.2, "avgSatisfaction": 78},
            {"department": "Marketing", "riskScore": 24, "atRisk": 3,
             "highRisk": 1, "avgTenure": 2.5, "avgSatisfaction": 70},
            {"department": "HR", "riskScore": 12, "atRisk": 1,
             "highRisk": 0, "avgTenure": 5.1, "avgSatisfaction": 85},
            {"department": "Finance", "riskScore": 14, "atRisk": 0,
             "highRisk": 0, "avgTenure": 4.8, "avgSatisfaction": 82},
        ],
        "highRiskEmployees": [
            {"name": "Alex Rivera", "department": "Engineering", "risk": 87,
                "role": "Senior Developer", "reason": "Passive job seeker"},
            {"name": "Emily Watson", "department": "Sales", "risk": 76,
                "role": "Account Executive", "reason": "No promotion in 3 years"},
            {"name": "Mike Johnson", "department": "Operations", "risk": 65,
                "role": "Operations Manager", "reason": "Work-life balance concerns"},
            {"name": "Priya Sharma", "department": "Engineering", "risk": 62,
                "role": "ML Engineer", "reason": "Below market compensation"},
        ],
        "trend": [
            {"month": "2026-01", "rate": 14},
            {"month": "2026-02", "rate": 13},
            {"month": "2026-03", "rate": 12},
            {"month": "2026-04", "rate": 11},
            {"month": "2026-05", "rate": 10},
        ],
    }


@app.get("/api/v1/command-center/hiring-pipeline", tags=["command-center"], summary="Hiring pipeline dashboard")
def get_hiring_pipeline(x_tenant_id: str = Header("default", alias="X-Tenant-Id")):
    """Hiring pipeline computed from ATS jobs and candidate records."""
    overview, jobs = fetch_ats_pipeline_snapshot(x_tenant_id)

    by_stage_raw = overview.get("by_stage", {}) if isinstance(overview, dict) else {}
    total_candidates = overview.get("total_candidates") if isinstance(overview, dict) else None
    if not isinstance(total_candidates, int):
        total_candidates = sum(int(v) for v in by_stage_raw.values() if isinstance(v, int))
    pipeline_stages = sorted(
        ({"stage": str(stage), "count": int(count)}
         for stage, count in by_stage_raw.items() if isinstance(count, int)),
        key=lambda s: -s["count"],
    )

    by_job = overview.get("by_job", []) if isinstance(overview, dict) else []
    applications_by_job = {
        str(job.get("job_id")): int(job.get("applications") or 0)
        for job in by_job if isinstance(job, dict)
    }
    departments = {}
    for job in jobs:
        dept = job.get("department") or "Unmapped"
        entry = departments.setdefault(dept, {"openings": 0, "candidates": 0})
        entry["openings"] += 1
        entry["candidates"] += applications_by_job.get(str(job.get("id")), 0)
    by_department = [
        {
            "department": dept,
            "openings": entry["openings"],
            "candidates": entry["candidates"],
            "interviews": None,
            "offers": None,
        }
        for dept, entry in sorted(departments.items(), key=lambda x: -x[1]["openings"])
    ]

    time_to_hire = fetch_ats_time_to_hire_days(x_tenant_id)
    return {
        "openPositions": len(jobs),
        "activeCandidates": total_candidates,
        "interviewsThisWeek": None,
        "offersOutstanding": None,
        "timeToHireAvg": time_to_hire,
        "acceptanceRate": None,
        "pipelineStages": pipeline_stages,
        "byDepartment": by_department,
        "upcomingInterviews": None,
        "dataSource": build_data_source(
            "mixed",
            ["ats-service"],
            "Open positions, candidate stage counts, per-department openings/candidates "
            "and average time to hire come from the ATS service (published jobs and "
            "candidate/application records; activeCandidates is the ATS candidate total "
            "across all statuses). Interview and offer fields have no live "
            "source in this view yet and are null.",
            live_fields=["openPositions", "activeCandidates", "pipelineStages",
                         "byDepartment.openings", "byDepartment.candidates", "timeToHireAvg"],
            not_live_fields=["interviewsThisWeek", "offersOutstanding", "acceptanceRate",
                             "byDepartment.interviews", "byDepartment.offers", "upcomingInterviews"],
        ),
        "asOf": _iso_now(),
    }


@app.get("/api/v1/command-center/budget-forecast", tags=["command-center"], summary="Budget forecast dashboard")
def get_budget_forecast(x_tenant_id: str = Header("default", alias="X-Tenant-Id")):
    """Returns budget dashboard with departmental spending, burn rate, and monthly burn trends."""
    return {
        "dataSource": fixture_data_source("Static budget fixture; not tenant data"),
        "asOf": CANNED_FIXTURE_AS_OF,
        "totalBudget": 4500000,
        "totalSpent": 3820000,
        "remainingBudget": 680000,
        "burnRate": 764000,
        "projectedOverspend": False,
        "byDepartment": [
            {"department": "Engineering",
             "budget": 1400000,
             "spent": 1268000,
             "remaining": 132000,
             "utilization": 90.6,
             "forecast": 1350000,
             "onTrack": True},
            {"department": "Sales",
             "budget": 950000,
             "spent": 812000,
             "remaining": 138000,
             "utilization": 85.5,
             "forecast": 870000,
             "onTrack": True},
            {"department": "Operations",
             "budget": 650000,
             "spent": 564000,
             "remaining": 86000,
             "utilization": 86.8,
             "forecast": 610000,
             "onTrack": True},
            {"department": "HR",
             "budget": 300000,
             "spent": 218000,
             "remaining": 82000,
             "utilization": 72.7,
             "forecast": 260000,
             "onTrack": True},
            {"department": "Finance",
             "budget": 450000,
             "spent": 337200,
             "remaining": 112800,
             "utilization": 74.9,
             "forecast": 380000,
             "onTrack": True},
            {"department": "Marketing",
             "budget": 750000,
             "spent": 620000,
             "remaining": 130000,
             "utilization": 82.7,
             "forecast": 690000,
             "onTrack": True},
        ],
        "monthlyBurn": [
            {"month": "2026-01", "budget": 380000, "actual": 350000},
            {"month": "2026-02", "budget": 380000, "actual": 358000},
            {"month": "2026-03", "budget": 380000, "actual": 365000},
            {"month": "2026-04", "budget": 380000, "actual": 374000},
            {"month": "2026-05", "budget": 380000, "actual": 382000},
        ],
    }


@app.get("/api/v1/command-center/utilization", tags=["command-center"], summary="Workforce utilization")
def get_utilization(x_tenant_id: str = Header("default", alias="X-Tenant-Id")):
    """Returns workforce utilization metrics including billable utilization, capacity, and trend."""
    return {
        "dataSource": fixture_data_source("Static utilization fixture; not tenant data"),
        "asOf": CANNED_FIXTURE_AS_OF,
        "overallUtilization": 83,
        "billableUtilization": 76,
        "byDepartment": [
            {"department": "Engineering", "utilization": 88, "billable": 82,
             "capacity": 420, "active": 385, "idle": 35},
            {"department": "Sales", "utilization": 92, "billable": 88,
             "capacity": 280, "active": 265, "idle": 15},
            {"department": "Operations", "utilization": 78, "billable": 70,
             "capacity": 210, "active": 175, "idle": 35},
            {"department": "HR", "utilization": 75, "billable": 60,
             "capacity": 95, "active": 78, "idle": 17},
            {"department": "Finance", "utilization": 80, "billable": 75,
             "capacity": 143, "active": 122, "idle": 21},
            {"department": "Marketing", "utilization": 82, "billable": 72,
             "capacity": 100, "active": 86, "idle": 14},
        ],
        "trend": [
            {"month": "2026-01", "utilization": 80},
            {"month": "2026-02", "utilization": 81},
            {"month": "2026-03", "utilization": 82},
            {"month": "2026-04", "utilization": 82},
            {"month": "2026-05", "utilization": 83},
        ],
    }


@app.get("/api/v1/command-center/benchmarking", tags=["command-center"], summary="Department benchmarking")
def get_benchmarking(x_tenant_id: str = Header("default", alias="X-Tenant-Id")):
    """Returns department benchmarking against company and industry averages."""
    return {
        "dataSource": fixture_data_source("Static benchmarking fixture; not tenant data"),
        "asOf": CANNED_FIXTURE_AS_OF,
        "companyAvg": {"productivity": 87.5, "engagement": 78.8,
                       "retention": 82.7, "attrition": 9.3,
                       "costPerEmployee": 3061},
        "industryAvg": {"productivity": 82, "engagement": 74,
                        "retention": 78, "attrition": 12,
                        "costPerEmployee": 3200},
        "departments": [
            {"name": "Engineering", "productivity": 92, "engagement": 85, "retention": 88,
                "attrition": 8, "costPerHead": 3020, "benchmark": "above"},
            {"name": "Sales", "productivity": 88, "engagement": 72, "retention": 70,
                "attrition": 15, "costPerHead": 2900, "benchmark": "below"},
            {"name": "Operations", "productivity": 85, "engagement": 78, "retention": 82,
                "attrition": 10, "costPerHead": 2690, "benchmark": "match"},
            {"name": "HR", "productivity": 90, "engagement": 82, "retention": 92,
                "attrition": 5, "costPerHead": 2290, "benchmark": "above"},
            {"name": "Finance", "productivity": 87, "engagement": 80, "retention": 90,
                "attrition": 6, "costPerHead": 2360, "benchmark": "above"},
            {"name": "Marketing", "productivity": 83, "engagement": 76, "retention": 74,
                "attrition": 12, "costPerHead": 2400, "benchmark": "match"},
        ],
    }


@app.get("/api/v1/command-center/ai-briefing", tags=["command-center"], summary="Executive AI briefing")
def get_ai_briefing(x_tenant_id: str = Header("default", alias="X-Tenant-Id")):
    """Returns executive AI briefing with key findings, recommendations, and risk flags."""
    return {
        "dataSource": fixture_data_source("Static briefing fixture; not tenant data"),
        "asOf": CANNED_FIXTURE_AS_OF,
        "generatedAt": "2026-05-25T10:30:00Z",
        "executiveSummary": (
            "The organization is in strong health overall with an 78/100 health score. "
            "Engineering leads in productivity at 92% while Sales shows strong revenue "
            "generation but needs engagement improvements. Attrition is trending down "
            "but Engineering requires attention with 32% risk score. The hiring pipeline "
            "is robust with 156 active candidates for 23 positions."
        ),
        "keyFindings": [
            {"severity": "positive", "area": "Productivity",
             "message": "Overall productivity at 87.5% — 5.5% above industry average",
             "metric": "+5.5%"},
            {"severity": "warning", "area": "Retention",
             "message": "Sales department attrition at 15% — 3x the company target of 5%",
             "metric": "15%"},
            {"severity": "critical", "area": "Pipeline",
             "message": "Engineering has 10 critical roles unfilled with 45-day avg time to hire",
             "metric": "45 days"},
            {"severity": "positive", "area": "Cost",
             "message": "Cost per employee at $3,061 is 4.3% below industry average",
             "metric": "-4.3%"},
        ],
        "recommendations": [
            {"priority": "high", "action": "Launch Engineering retention program with comp review",
             "impact": "Could save 4-6 senior engineers annually", "timeline": "Q3 2026"},
            {"priority": "high", "action": "Accelerate Sales hiring by 2 weeks to meet Q3 targets",
             "impact": "Unlock $2.8M in additional pipeline", "timeline": "Next 30 days"},
            {"priority": "medium", "action": "Implement hybrid work policy to improve engagement",
             "impact": "Expected 8-12% engagement improvement", "timeline": "Q3 2026"},
            {"priority": "low", "action": "Launch diversity recruiting initiative",
             "impact": "Long-term culture and innovation benefits", "timeline": "H2 2026"},
        ],
        "riskFlags": [
            {"type": "attrition", "severity": "high",
             "message": "8 employees at critical risk of departure",
             "affectedDept": "Engineering, Sales"},
            {"type": "skill_gap", "severity": "medium",
             "message": "42% of AI/ML positions unfilled",
             "affectedDept": "Engineering"},
            {"type": "budget", "severity": "low",
             "message": "Marketing budget burn rate exceeding plan by 2%",
             "affectedDept": "Marketing"},
        ],
    }


@app.get("/api/v1/command-center/risk-dashboard", tags=["command-center"], summary="Composite risk assessment")
def get_risk_dashboard(x_tenant_id: str = Header("default", alias="X-Tenant-Id")):
    """Returns composite risk assessment with category breakdown, risk levels, and trend."""
    return {
        "dataSource": fixture_data_source("Static risk fixture; not tenant data"),
        "asOf": CANNED_FIXTURE_AS_OF,
        "overallRiskScore": 22,
        "riskLevel": "low",
        "categories": [
            {"name": "Attrition Risk", "score": 28, "level": "medium", "trend": "improving"},
            {"name": "Talent Gap Risk", "score": 35, "level": "medium", "trend": "stable"},
            {"name": "Budget Risk", "score": 15, "level": "low", "trend": "worsening"},
            {"name": "Compliance Risk", "score": 8, "level": "low", "trend": "stable"},
            {"name": "Operational Risk", "score": 20, "level": "low", "trend": "improving"},
            {"name": "Market Risk", "score": 25, "level": "low", "trend": "stable"},
        ],
        "trend": [
            {"month": "2026-01", "score": 30},
            {"month": "2026-02", "score": 28},
            {"month": "2026-03", "score": 25},
            {"month": "2026-04", "score": 23},
            {"month": "2026-05", "score": 22},
        ],
    }


@app.get("/api/v1/payroll/verify/{period}", tags=["analytics"],
         summary="Verify payroll amounts against attendance records")
@heavy_endpoint("analytics.payroll-verify")
def verify_payroll_consistency(
    period: str,
    x_tenant_id: str = Header("default", alias="X-Tenant-Id")
):
    if not re.match(r"^\d{4}-(0[1-9]|1[0-2])$", period or ""):
        raise HTTPException(status_code=400, detail="Invalid period format, expected YYYY-MM")
    if not engine:
        raise HTTPException(status_code=500, detail="Database connection failed")
    MAX_VERIFY_ROWS = 5000
    try:
        payroll_query = text("""
            SELECT employee_id, period, base_salary, allowances, deductions,
                   gross_salary, net_salary, tax
            FROM payroll_records
            WHERE tenant_id = :tenant_id AND period = :period
            LIMIT 5000
        """)
        payroll_df = pd.read_sql_query(
            payroll_query.bindparams(tenant_id=x_tenant_id, period=period), engine
        )
        if len(payroll_df) > MAX_VERIFY_ROWS:
            payroll_df = payroll_df.head(MAX_VERIFY_ROWS)

        attendance_query = text("""
            SELECT employee_id, date, status, clock_in, clock_out
            FROM attendance_records
            WHERE tenant_id = :tenant_id
              AND date >= (:period || '-01')::date
              AND date < ((:period || '-01')::date + INTERVAL '1 month')
            LIMIT 5000
        """)
        attendance_df = pd.read_sql_query(
            attendance_query.bindparams(tenant_id=x_tenant_id, period=period), engine
        )
        if len(attendance_df) > MAX_VERIFY_ROWS:
            attendance_df = attendance_df.head(MAX_VERIFY_ROWS)

        attendance_by_employee = dict(tuple(attendance_df.groupby("employee_id"))) if not attendance_df.empty else {}
        discrepancies = []
        for _, row in payroll_df.iterrows():
            emp_id = row["employee_id"]
            # Log only a non-reversible fingerprint, never the raw employee ID.
            emp_fp = hashlib.sha256(f"{x_tenant_id}:{emp_id}".encode()).hexdigest()[:16]
            emp_attendance = attendance_by_employee.get(emp_id)
            if emp_attendance is None:
                total_days = 0
                total_hours = 0
            else:
                total_days = len(emp_attendance)
                total_hours = 0
                for _, a in emp_attendance.iterrows():
                    if a["clock_in"] and a["clock_out"]:
                        try:
                            cin = pd.to_datetime(a["clock_in"])
                            cout = pd.to_datetime(a["clock_out"])
                            total_hours += (cout - cin).total_seconds() / 3600
                        except (ValueError, TypeError) as e:
                            logger.warning("payroll.verify_row_skipped",
                                extra={"error": str(e), "employee_fp": emp_fp, "period": period})
            discrepancies.append({
                "employee_id": emp_id,
                "period": period,
                "gross_salary": float(row["gross_salary"]),
                "attendance_days": total_days,
                "attendance_hours": round(total_hours, 2),
                "base_salary": float(row["base_salary"]),
            })
            if len(discrepancies) >= MAX_VERIFY_ROWS:
                break

        return {
            "period": period,
            "tenant_id": x_tenant_id,
            "total_payroll_records": len(payroll_df),
            "total_attendance_records": len(attendance_df),
            "discrepancies": discrepancies,
            "verified_at": datetime.now(timezone.utc).isoformat(),
        }
    except HTTPException:
        raise
    except Exception:
        logger.exception("payroll.verify_failed", extra={"period": period, "tenant_id": x_tenant_id})
        raise HTTPException(status_code=500, detail="Failed to verify payroll consistency")


@app.get("/api/v1/command-center/activity-feed", tags=["command-center"], summary="Real-time activity feed")
def get_activity_feed(x_tenant_id: str = Header("default", alias="X-Tenant-Id")):
    """Returns real-time activity feed with varied event types."""
    return {
        "dataSource": fixture_data_source("Static activity feed fixture; not tenant data"),
        "asOf": CANNED_FIXTURE_AS_OF,
        "activities": [
            {"id": 1, "type": "hire", "department": "Engineering", "severity": "info",
             "message": "Sarah Chen accepted Senior Developer offer",
             "timestamp": "2026-05-25T09:15:00Z"},
            {"id": 2, "type": "departure", "department": "Finance", "severity": "warning",
             "message": "John Smith (Finance) submitted resignation",
             "timestamp": "2026-05-25T08:45:00Z"},
            {"id": 3, "type": "promotion", "department": "Operations", "severity": "positive",
             "message": "Emily Davis promoted to Team Lead in Operations",
             "timestamp": "2026-05-25T08:00:00Z"},
            {"id": 4, "type": "risk", "department": "Engineering", "severity": "critical",
             "message": "Alex Rivera (Engineering) flagged as high attrition risk",
             "timestamp": "2026-05-25T07:30:00Z"},
            {"id": 5, "type": "onboarding", "department": "HR", "severity": "info",
             "message": "New hire cohort of 5 starts onboarding next week",
             "timestamp": "2026-05-24T16:00:00Z"},
            {"id": 6, "type": "milestone", "department": "Engineering", "severity": "positive",
             "message": "Engineering team hits 95% sprint completion rate",
             "timestamp": "2026-05-24T14:30:00Z"},
            {"id": 7, "type": "budget", "department": "Marketing", "severity": "warning",
             "message": "Marketing exceeds Q2 budget by 2.1%",
             "timestamp": "2026-05-24T11:00:00Z"},
            {"id": 8, "type": "training", "department": "HR", "severity": "positive",
             "message": "Leadership training program completed by 24 managers",
             "timestamp": "2026-05-24T09:00:00Z"},
            {"id": 9, "type": "compliance", "department": "Legal", "severity": "positive",
             "message": "Q2 compliance audit passed with 98% score",
             "timestamp": "2026-05-23T15:00:00Z"},
            {"id": 10, "type": "engagement", "department": "Sales", "severity": "warning",
             "message": "Sales team engagement survey drops 5 points",
             "timestamp": "2026-05-23T13:00:00Z"},
            {"id": 11, "type": "interview", "department": "Sales", "severity": "info",
             "message": "James Wilson interviewing for Sales Manager role",
             "timestamp": "2026-05-23T10:00:00Z"},
            {"id": 12, "type": "hire", "department": "Marketing", "severity": "info",
             "message": "Maria Garcia accepts Marketing Director position",
             "timestamp": "2026-05-22T16:30:00Z"},
            {"id": 13, "type": "departure", "department": "Engineering", "severity": "warning",
             "message": "Tom Nguyen (Engineering) moving to competitor",
             "timestamp": "2026-05-22T14:00:00Z"},
            {"id": 14, "type": "award", "department": "Finance", "severity": "positive",
             "message": "Finance team wins 'Most Improved Department' award",
             "timestamp": "2026-05-22T11:00:00Z"},
            {"id": 15, "type": "initiative", "department": "HR", "severity": "positive",
             "message": "Wellness program enrollment reaches 340 participants",
             "timestamp": "2026-05-21T09:00:00Z"},
        ],
    }


@app.post("/analytics/payroll/invalidate", tags=["analytics"], summary="Invalidate payroll cache")
def invalidate_payroll_cache_endpoint(x_tenant_id: str = Header("default", alias="X-Tenant-Id")):
    record_payroll_write(x_tenant_id)
    return {"status": "invalidated", "tenant_id": x_tenant_id}


def payroll_processed_consumer():
    def callback(ch, method, properties, body):
        try:
            event = json.loads(body)
            tenant_id = event.get("tenant_id", event.get("x-tenant-id", ""))
            routing_key = method.routing_key
            invalidate_payroll_cache(tenant_id)
            logger.info(
                "payroll.processed.cache_invalidated",
                extra={"tenant_id": tenant_id, "routing_key": routing_key})
        except (json.JSONDecodeError, UnicodeDecodeError, AttributeError) as e:
            logger.warning("payroll.processed.bad_message", extra={"error": str(e), "error_type": type(e).__name__})
        except Exception:
            logger.exception("payroll.processed.error")
        finally:
            ch.basic_ack(delivery_tag=method.delivery_tag)

    while True:
        try:
            params = _rabbitmq_params()
            connection = pika.BlockingConnection(params)
            channel = connection.channel()
            channel.exchange_declare(exchange="live_exchange", exchange_type="topic", durable=True)
            result = channel.queue_declare(queue="", exclusive=True)
            queue_name = result.method.queue
            channel.queue_bind(exchange="live_exchange", queue=queue_name, routing_key="payroll.processed")
            channel.basic_consume(queue=queue_name, on_message_callback=callback, auto_ack=False)
            logger.info("Started listening for payroll.processed events on live_exchange")
            channel.start_consuming()
        except Exception:
            logger.exception("RabbitMQ connection error in payroll consumer")
            time.sleep(5)


def employee_deletion_consumer():
    def callback(ch, method, properties, body):
        try:
            event = json.loads(body)
            if event.get("event") == "employee.deleted":
                email = event.get("email", "")
                tenant_id = event.get("tenant_id", "")
                if tenant_id:
                    invalidate_department_cache(tenant_id)
                logger.info(
                    "employee.deleted.cascade",
                    extra={"email": email, "tenant_id": tenant_id,
                           "action": "cleanup_derived_data"})
        except (json.JSONDecodeError, UnicodeDecodeError, AttributeError) as e:
            logger.warning("employee.deleted.bad_message", extra={"error": str(e), "error_type": type(e).__name__})
        except Exception:
            logger.exception("employee.deleted.error")
        finally:
            ch.basic_ack(delivery_tag=method.delivery_tag)

    while True:
        try:
            params = _rabbitmq_params()
            connection = pika.BlockingConnection(params)
            channel = connection.channel()
            channel.exchange_declare(exchange="notifications_exchange", exchange_type="fanout", durable=True)
            result = channel.queue_declare(queue="", exclusive=True)
            queue_name = result.method.queue
            channel.queue_bind(exchange="notifications_exchange", queue=queue_name)
            channel.basic_consume(queue=queue_name, on_message_callback=callback, auto_ack=False)
            logger.info("Started listening for employee.deleted events")
            channel.start_consuming()
        except Exception:
            logger.exception("RabbitMQ connection error in analytics consumer")
            time.sleep(5)


@app.on_event("startup")
def start_consumers():
    thread = threading.Thread(target=employee_deletion_consumer, daemon=True)
    thread.start()
    thread2 = threading.Thread(target=payroll_processed_consumer, daemon=True)
    thread2.start()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8003))
    uvicorn.run(app, host="0.0.0.0", port=port)
