import json
import logging
import uuid
import random
import hmac
from contextvars import ContextVar
from fastapi import FastAPI, HTTPException, Body, Query, Header, Depends, Request
from pydantic import BaseModel, Field
from typing import List, Optional
import os
import math
import re
import asyncio
import uvicorn
# pyrefly: ignore [missing-import]
from motor.motor_asyncio import AsyncIOMotorClient
import pymongo.errors
from contextlib import asynccontextmanager
import pika
from atlas_observability import AtlasMetricsMiddleware, SecurityHeadersMiddleware, sanitize_url

# ------------------------------------------------
# Structured Logger
# ------------------------------------------------
SERVICE_NAME = "employee-service"
SERVICE_VERSION = "2.0.0"

logger = logging.getLogger(SERVICE_NAME)
logger.setLevel(logging.INFO)
handler = logging.StreamHandler()
handler.setFormatter(logging.Formatter("%(message)s"))
logger.handlers.clear()
logger.addHandler(handler)

correlation_id_ctx: ContextVar[str] = ContextVar("correlation_id", default="")


def log_event(level: str, event: str, **kwargs):
    record = {
        "service": SERVICE_NAME,
        "version": SERVICE_VERSION,
        "level": level,
        "event": event,
    }
    cid = correlation_id_ctx.get()
    if cid:
        record["correlation_id"] = cid
    record.update(kwargs)
    logger.log(getattr(logging, level.upper(), logging.INFO), json.dumps(record))


# ------------------------------------------------
# Configuration
# ------------------------------------------------
MONGO_USER = os.environ.get("MONGO_USER", "")
MONGO_PASSWORD = os.environ.get("MONGO_PASSWORD", "")
MONGO_HOST = os.environ.get("MONGO_HOST", "localhost")
MONGO_DB = os.environ.get("MONGO_DB", "atlas_db")
MONGO_URL = os.environ.get(
    "MONGO_URL",
    f"mongodb://{MONGO_USER}:{MONGO_PASSWORD}@{MONGO_HOST}:27017/{MONGO_DB}?authSource=admin",
)
DB_NAME = "atlas_db"

INTERNAL_KEY = os.environ.get("INTERNAL_KEY", "")

RABBITMQ_HOST = os.environ.get("RABBITMQ_HOST", "localhost")
RABBITMQ_PORT = int(os.environ.get("RABBITMQ_PORT", "5672"))
RABBITMQ_USER = os.environ.get("RABBITMQ_USER", "guest")
RABBITMQ_PASSWORD = os.environ["RABBITMQ_PASSWORD"]

client = AsyncIOMotorClient(MONGO_URL)
db = client[DB_NAME]
employees_collection = db["employees"]

# ------------------------------------------------
# Security Constants
# ------------------------------------------------
ALLOWED_SEARCH_FIELDS = {"name", "email", "department", "position"}
SEARCH_MAX_LENGTH = 200
SEARCH_ALLOWED_CHARS = re.compile(r"^[a-zA-Z0-9 @._\-]+$")


@asynccontextmanager
async def lifespan(app: FastAPI):
    log_event("info", "service.starting", mongo_url=sanitize_url(MONGO_URL))
    try:
        await employees_collection.create_index("email", unique=True)
        await employees_collection.create_index("name")
        await employees_collection.create_index("department")
        await employees_collection.create_index([("tenant_id", 1), ("email", 1)])
        await employees_collection.create_index([("tenant_id", 1), ("name", 1)])
        await employees_collection.create_index([("tenant_id", 1), ("department", 1), ("position", 1)])
        log_event("info", "indexes.created")
    except Exception as e:
        log_event("warning", "indexes.failed", error=str(e))
    yield
    client.close()
    log_event("info", "service.stopped")


app = FastAPI(title="Employee Service API", version=SERVICE_VERSION, lifespan=lifespan)


@app.middleware("http")
async def add_correlation_id(request: Request, call_next):
    correlation_id = request.headers.get("X-Correlation-Id", str(uuid.uuid4()))
    correlation_id_ctx.set(correlation_id)
    response = await call_next(request)
    response.headers["X-Correlation-Id"] = correlation_id
    return response


app.add_middleware(AtlasMetricsMiddleware)
app.add_middleware(SecurityHeadersMiddleware)


# ------------------------------------------------
# Input Validation
# ------------------------------------------------
def validate_search_param(search: Optional[str]) -> Optional[str]:
    if not search:
        return search
    if len(search) > SEARCH_MAX_LENGTH:
        log_event("warning", "search.too_long", length=len(search))
        raise HTTPException(status_code=400, detail="Search query too long")
    if not SEARCH_ALLOWED_CHARS.match(search):
        log_event("warning", "search.invalid_chars", search=search)
        raise HTTPException(status_code=400, detail="Search contains invalid characters")
    return search


# ------------------------------------------------
# Auth Helpers
# ------------------------------------------------
async def verify_internal_key(request: Request):
    x_internal_key = request.headers.get("X-Internal-Key")
    if not x_internal_key or not hmac.compare_digest(x_internal_key, INTERNAL_KEY):
        log_event("warning", "auth.invalid_internal_key")
        raise HTTPException(status_code=403, detail="Invalid or missing internal key")
    return x_internal_key


# ------------------------------------------------
# RabbitMQ Helpers
# ------------------------------------------------
async def publish_delete_event(email: str, tenant_id: str):
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, _publish_delete_event_sync, email, tenant_id)


def _publish_delete_event_sync(email: str, tenant_id: str):
    try:
        credentials = pika.PlainCredentials(RABBITMQ_USER, RABBITMQ_PASSWORD)
        params = pika.ConnectionParameters(
            host=RABBITMQ_HOST,
            port=RABBITMQ_PORT,
            credentials=credentials,
        )
        connection = pika.BlockingConnection(params)
        channel = connection.channel()
        channel.exchange_declare(exchange="notifications_exchange", exchange_type="fanout", durable=True)
        message = json.dumps({
            "event": "employee.deleted",
            "email": email,
            "tenant_id": tenant_id,
            "service": SERVICE_NAME,
        })
        channel.basic_publish(
            exchange="notifications_exchange",
            routing_key="",
            body=message,
            properties=pika.BasicProperties(delivery_mode=2),
        )
        connection.close()
        log_event("info", "employee.delete.published", email=email, tenant_id=tenant_id)
    except Exception as e:
        log_event("error", "employee.delete.publish.failed", email=email, tenant_id=tenant_id, error=str(e))


# ------------------------------------------------
# Pydantic Schemas
# ------------------------------------------------
class EmployeeSchema(BaseModel):
    id: Optional[str] = Field(None, alias="_id")
    name: str = Field(..., min_length=1, max_length=200, description="Full name of the employee")
    department: str = Field(..., min_length=1, max_length=200, description="Department name")
    position: str = Field(..., min_length=1, max_length=200, description="Job position/title")
    email: str = Field(
        ...,
        min_length=5,
        max_length=254,
        pattern=r"^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$",
        description="Employee email address (unique per tenant)",
    )
    tenant_id: Optional[str] = Field(None, description="Multi-tenant identifier")

    class Config:
        populate_by_name = True
        json_schema_extra = {
            "example": {
                "name": "John Doe",
                "department": "Engineering",
                "position": "Software Engineer",
                "email": "john.doe@atlas.io",
            }
        }


class PaginatedEmployees(BaseModel):
    items: List[EmployeeSchema]
    total: int
    page: int
    page_size: int
    total_pages: int


def serialize_employee(employee: dict) -> dict:
    employee["_id"] = str(employee["_id"])
    return employee


class EmployeeUpdateSchema(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=200, description="Updated full name")
    department: Optional[str] = Field(None, min_length=1, max_length=200, description="Updated department")
    position: Optional[str] = Field(None, min_length=1, max_length=200, description="Updated position")
    email: Optional[str] = Field(
        None,
        min_length=5,
        max_length=254,
        pattern=r"^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$",
        description="Updated email",
    )


# ------------------------------------------------
# Endpoints
# ------------------------------------------------
@app.get("/health", tags=["health"])
async def health_check():
    """Check if the service and database are healthy."""
    try:
        await client.admin.command("ping")
        return {"status": "Employee Service is running", "database": "connected"}
    except Exception:
        return {
            "status": "Employee Service is running",
            "database": "disconnected",
        }


@app.get("/employees", response_model=PaginatedEmployees, tags=["employees"], summary="List all employees")
async def get_employees(
    page: int = Query(1, ge=1, description="Page number"),
    page_size: int = Query(10, ge=1, le=100, description="Items per page"),
    search: Optional[str] = Query(None, description="Search by name, email, department, or position"),
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
):
    """Retrieve a paginated, searchable list of employees scoped to a tenant."""
    search = validate_search_param(search)
    query = {"tenant_id": x_tenant_id}
    if search:
        pattern = re.compile(re.escape(search), re.IGNORECASE)
        query["$or"] = [{field: pattern} for field in ALLOWED_SEARCH_FIELDS]

    total = await employees_collection.count_documents(query)

    skip = (page - 1) * page_size
    total_pages = max(1, math.ceil(total / page_size)) if total else 1

    cursor = employees_collection.find(query).skip(skip).limit(page_size)
    items = []
    async for employee in cursor:
        items.append(serialize_employee(employee))

    return {
        "items": items,
        "total": total,
        "page": page,
        "page_size": page_size,
        "total_pages": total_pages,
    }


@app.get("/employees/{email}", response_model=EmployeeSchema, tags=["employees"], summary="Get employee by email")
async def get_employee(email: str, x_tenant_id: str = Header("default", alias="X-Tenant-Id")):
    """Fetch a single employee by their email address within a tenant scope."""
    employee = await employees_collection.find_one({"email": email, "tenant_id": x_tenant_id})
    if employee:
        return serialize_employee(employee)
    await asyncio.sleep(random.uniform(0, 0.05))
    raise HTTPException(status_code=404, detail="Employee not found")


@app.post("/employees", response_model=EmployeeSchema, tags=["employees"], summary="Create employee")
async def create_employee(
    employee: EmployeeSchema = Body(...),
    x_tenant_id: str = Header("default", alias="X-Tenant-Id")
):
    """Create a new employee record. Email must be unique per tenant."""
    employee_dict = employee.model_dump(by_alias=True, exclude_none=True)
    employee_dict["tenant_id"] = x_tenant_id

    try:
        result = await employees_collection.insert_one(employee_dict)
        employee_dict["_id"] = str(result.inserted_id)
        return employee_dict
    except pymongo.errors.DuplicateKeyError:
        log_event("warning", "employee.duplicate_email", email=employee.email, tenant_id=x_tenant_id)
        raise HTTPException(
            status_code=400, detail="Employee with this email already exists"
        )


@app.put("/employees/{email}", response_model=EmployeeSchema, tags=["employees"], summary="Update employee")
async def update_employee(
    email: str,
    employee: EmployeeUpdateSchema = Body(...),
    x_tenant_id: str = Header("default", alias="X-Tenant-Id")
):
    """Update an existing employee's details. Email change is validated for uniqueness."""
    existing = await employees_collection.find_one({"email": email, "tenant_id": x_tenant_id})
    if not existing:
        raise HTTPException(status_code=404, detail="Employee not found")

    update_data = employee.model_dump(exclude_none=True)
    if not update_data:
        raise HTTPException(status_code=400, detail="No fields to update")

    if "email" in update_data and update_data["email"] != email:
        duplicate = await employees_collection.find_one(
            {"email": update_data["email"], "tenant_id": x_tenant_id}
        )
        if duplicate:
            raise HTTPException(status_code=400, detail="Email already in use")

    await employees_collection.update_one(
        {"email": email, "tenant_id": x_tenant_id},
        {"$set": update_data}
    )

    updated = await employees_collection.find_one({"email": update_data.get("email", email), "tenant_id": x_tenant_id})
    return serialize_employee(updated)


@app.delete("/employees/{email}", tags=["employees"], summary="Delete employee")
async def delete_employee(
    email: str,
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    _: Optional[str] = Depends(verify_internal_key),
):
    """Permanently delete an employee record."""
    result = await employees_collection.delete_one({"email": email, "tenant_id": x_tenant_id})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Employee not found")
    await publish_delete_event(email, x_tenant_id)
    return {"message": "Employee deleted successfully"}


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8001))
    uvicorn.run(app, host="0.0.0.0", port=port)
