import asyncio
import json
import logging
import os
import uuid
from collections import defaultdict
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Optional
import base64
import hashlib
import hmac
import time

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse
from atlas_observability import (
    AtlasLoggingMiddleware, AtlasMetricsMiddleware, CorrelationIdMiddleware,
    configure_logging, get_logger
)

load_dotenv()

CORS_ORIGINS = os.getenv("CORS_ORIGINS", "*")
RABBITMQ_URL = os.getenv("RABBITMQ_URL", "amqp://guest:guest@rabbitmq:5672/")
INTERNAL_JWT_SECRET = os.environ.get("INTERNAL_JWT_SECRET")

# ── Eviction Configuration ──────────────────────────────────────────────────

POLL_TTL_SECONDS = int(os.getenv("POLL_TTL_SECONDS", "86400"))
INCIDENT_TTL_SECONDS = int(os.getenv("INCIDENT_TTL_SECONDS", "604800"))
CHAT_ROOM_TTL_SECONDS = int(os.getenv("CHAT_ROOM_TTL_SECONDS", "86400"))
MAX_INCIDENTS_PER_ID = int(os.getenv("MAX_INCIDENTS_PER_ID", "100"))
PRESENCE_TTL_SECONDS = int(os.getenv("PRESENCE_TTL_SECONDS", "3600"))
EVICTION_INTERVAL_SECONDS = int(os.getenv("EVICTION_INTERVAL_SECONDS", "300"))

_INTERNAL_FIELDS = {"_created_at", "_last_seen"}

def _strip_internal(data: dict) -> dict:
    return {k: v for k, v in data.items() if k not in _INTERNAL_FIELDS}

def _strip_internal_from_list(items: list[dict]) -> list[dict]:
    return [_strip_internal(item) for item in items]

# ── In-Memory Channel State ─────────────────────────────────────────────────

class ChannelManager:
    def __init__(self):
        self.sse_clients: dict[str, set[asyncio.Queue]] = defaultdict(set)
        self.ws_clients: dict[str, set[WebSocket]] = defaultdict(set)
        self.channel_history: dict[str, list[dict]] = defaultdict(lambda: [])
        self.max_history = 200
        self.event_sequences: dict[str, int] = defaultdict(int)
        self.presence: dict[str, dict] = {}
        self.chat_rooms: dict[str, list[dict]] = defaultdict(lambda: [])
        self.polls: dict[str, dict] = {}
        self.poll_lock = asyncio.Lock()
        self.incidents: dict[str, list[dict]] = defaultdict(lambda: [])
        self.sla_status: dict[str, dict] = {}
        self.staffing: dict[str, dict] = {}

    def evict(self) -> dict[str, int]:
        now = datetime.now(timezone.utc).timestamp()
        removed = {"polls": 0, "chat_rooms": 0, "presence": 0, "incidents": 0}

        stale_polls = [
            pid for pid, poll in self.polls.items()
            if now - poll.get("_created_at", 0) > POLL_TTL_SECONDS
        ]
        for pid in stale_polls:
            del self.polls[pid]
            removed["polls"] += 1

        for room in list(self.chat_rooms.keys()):
            messages = self.chat_rooms[room]
            if not messages:
                del self.chat_rooms[room]
                removed["chat_rooms"] += 1
            else:
                last_ts = messages[-1].get("timestamp", "")
                if last_ts:
                    try:
                        last_time = datetime.fromisoformat(last_ts).timestamp()
                        if now - last_time > CHAT_ROOM_TTL_SECONDS:
                            del self.chat_rooms[room]
                            removed["chat_rooms"] += 1
                    except (ValueError, TypeError):
                        pass

        stale_presence = [
            uid for uid, p in self.presence.items()
            if now - p.get("_last_seen", 0) > PRESENCE_TTL_SECONDS
        ]
        for uid in stale_presence:
            del self.presence[uid]
            removed["presence"] += 1

        for inc_id in list(self.incidents.keys()):
            entries = self.incidents[inc_id]
            if len(entries) > MAX_INCIDENTS_PER_ID:
                self.incidents[inc_id] = entries[-MAX_INCIDENTS_PER_ID:]
                removed["incidents"] += len(entries) - MAX_INCIDENTS_PER_ID

        return removed

    async def _eviction_loop(self):
        while True:
            await asyncio.sleep(EVICTION_INTERVAL_SECONDS)
            removed = self.evict()
            total = sum(removed.values())
            if total:
                logger.info("eviction.cleanup", extra={"removed": removed, "total": total})

    async def broadcast_sse(self, channel: str, event: str, data: dict):
        self.event_sequences[channel] += 1
        message = {"channel": channel, "event": event, "data": data, "timestamp": datetime.now(timezone.utc).isoformat(), "event_id": self.event_sequences[channel]}
        self.channel_history[channel].append(message)
        if len(self.channel_history[channel]) > self.max_history:
            self.channel_history[channel] = self.channel_history[channel][-self.max_history:]
        dead = set()
        for queue in self.sse_clients.get(channel, set()):
            try:
                queue.put_nowait(message)
            except asyncio.QueueFull:
                dead.add(queue)
        for q in dead:
            self.sse_clients[channel].discard(q)

    async def broadcast_ws(self, channel: str, message: dict):
        dead = set()
        for ws in self.ws_clients.get(channel, set()):
            try:
                await ws.send_json(message)
            except Exception:
                dead.add(ws)
        for ws in dead:
            self.ws_clients[channel].discard(ws)

manager = ChannelManager()

# ── Message Schemas ─────────────────────────────────────────────────────────

class PresenceUpdate(BaseModel):
    user_id: str
    name: str
    status: str
    department: Optional[str] = None
    role: Optional[str] = None

class AttendanceEvent(BaseModel):
    employee_id: str
    employee_name: str
    event: str
    timestamp: str
    method: Optional[str] = None

class PayrollProgress(BaseModel):
    batch_id: str
    period: str
    status: str
    progress: int
    total: int
    processed: int

class LeaveApproval(BaseModel):
    request_id: str
    employee_name: str
    type: str
    status: str
    start_date: str
    end_date: str
    approved_by: Optional[str] = None

class KPIUpdate(BaseModel):
    metric_id: str
    name: str
    value: float
    target: float
    unit: str
    department: Optional[str] = None

class ActivityEvent(BaseModel):
    actor: str
    action: str
    resource: str
    details: Optional[str] = None
    department: Optional[str] = None

class Alert(BaseModel):
    title: str
    message: str
    severity: str
    category: str
    source: Optional[str] = None

class Announcement(BaseModel):
    title: str
    message: str
    author: str
    priority: str

class WorkforceHeatmap(BaseModel):
    department: str
    metric: str
    value: float
    change: float

class TaskAssignment(BaseModel):
    task_id: str
    title: str
    assigned_to: str
    assigned_by: str
    priority: str
    due_date: Optional[str] = None

class Escalation(BaseModel):
    escalation_id: str
    incident: str
    severity: str
    escalated_by: str
    assigned_to: Optional[str] = None

class ComplianceViolation(BaseModel):
    violation_id: str
    policy: str
    severity: str
    description: str
    affected_entity: str

class OnboardingProgress(BaseModel):
    employee_id: str
    employee_name: str
    stage: str
    progress: int
    status: str

class RecruitmentUpdate(BaseModel):
    candidate_name: str
    position: str
    stage: str
    status: str

class ForecastUpdate(BaseModel):
    department: str
    metric: str
    current_value: float
    forecast_value: float
    confidence: float

class SLAUpdate(BaseModel):
    service: str
    status: str
    response_time_ms: int
    threshold_ms: int

class StaffingUpdate(BaseModel):
    employee_name: str
    department: str
    change_type: str
    previous_role: Optional[str] = None
    new_role: Optional[str] = None

class ChatMessage(BaseModel):
    room: str
    sender: str
    message: str
    message_type: str = "text"

class Poll(BaseModel):
    poll_id: str
    question: str
    options: list[str]
    votes: Optional[dict[str, int]] = None
    created_by: str

class PollVote(BaseModel):
    poll_id: str
    option: str
    voter: str

class EmergencyBroadcast(BaseModel):
    title: str
    message: str
    severity: str
    author: str
    targets: Optional[list[str]] = None

class IncidentManagement(BaseModel):
    incident_id: str
    title: str
    severity: str
    status: str
    reported_by: str
    description: Optional[str] = None

class ExecutiveUpdate(BaseModel):
    metric: str
    value: float
    change: float
    trend: str
    category: str

# ── Internal Auth ────────────────────────────────────────────────────────────

def validate_internal_jwt(auth_header: str) -> dict:
    if not INTERNAL_JWT_SECRET:
        raise HTTPException(status_code=500, detail="Service not configured")

    try:
        parts = auth_header.split(".")
        if len(parts) != 3:
            raise HTTPException(status_code=401, detail="Invalid token format")

        _header_b64, payload_b64, signature = parts

        expected = hmac.new(
            INTERNAL_JWT_SECRET.encode(),
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


@app.middleware("http")
async def internal_auth_middleware(request: Request, call_next):
    if request.url.path in ("/health", "/metrics"):
        return await call_next(request)

    auth_header = request.headers.get("x-internal-auth")
    if not auth_header:
        return JSONResponse(status_code=401, content={"error": "Missing internal authentication"})

    try:
        claims = validate_internal_jwt(auth_header)
        request.state.user_id = claims.get("user_id", "")
        request.state.user_role = claims.get("user_role", "employee")
        request.state.tenant_id = claims.get("tenant_id", "default")
    except HTTPException as e:
        return JSONResponse(status_code=e.status_code, content={"error": e.detail})
    except Exception:
        return JSONResponse(status_code=401, content={"error": "Invalid internal authentication"})

    return await call_next(request)


# ── FastAPI App ─────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    asyncio.create_task(rabbitmq_consumer())
    asyncio.create_task(notifications_consumer())
    asyncio.create_task(manager._eviction_loop())
    yield

app = FastAPI(title="Atlas Live Service", description="Real-time SSE + WebSocket engine for 25 live channels", version="1.0.0", lifespan=lifespan)

configure_logging("live-service", level=logging.INFO)
logger = get_logger("live-service")

app.add_middleware(CORSMiddleware, allow_origins=CORS_ORIGINS.split(",") if CORS_ORIGINS != "*" else ["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

app.add_middleware(CorrelationIdMiddleware)
app.add_middleware(AtlasLoggingMiddleware)
app.add_middleware(AtlasMetricsMiddleware)

# ── RabbitMQ Consumer ──────────────────────────────────────────────────────

async def rabbitmq_consumer():
    while True:
        try:
            import aio_pika
            connection = await aio_pika.connect_robust(RABBITMQ_URL)
            async with connection:
                channel = await connection.channel()
                exchange = await channel.declare_exchange("live_exchange", aio_pika.ExchangeType.TOPIC, durable=True)
                queue = await channel.declare_queue("live_service_queue", durable=True)
                routing_keys = [
                    "presence.*", "attendance.*", "payroll.*", "leave.*", "kpi.*",
                    "activity.*", "alert.*", "announcement.*", "heatmap.*", "task.*",
                    "escalation.*", "compliance.*", "onboarding.*", "recruitment.*",
                    "forecast.*", "sla.*", "staffing.*", "chat.*", "poll.*", "emergency.*",
                    "incident.*", "executive.*",
                ]
                for rk in routing_keys:
                    await queue.bind(exchange, routing_key=rk)
                async with queue.iterator() as queue_iter:
                    async for message in queue_iter:
                        async with message.process():
                            try:
                                payload = json.loads(message.body.decode())
                                channel_name = message.routing_key.split(".")[0]
                                await manager.broadcast_sse(channel_name, message.routing_key, payload)
                                await manager.broadcast_ws(channel_name, payload)
                            except Exception:
                                pass
        except Exception as e:
            print(f"RabbitMQ connection error: {e}, retrying in 5s...")
            await asyncio.sleep(5)


async def notifications_consumer():
    while True:
        try:
            import aio_pika
            connection = await aio_pika.connect_robust(RABBITMQ_URL)
            async with connection:
                channel = await connection.channel()
                exchange = await channel.declare_exchange("notifications_exchange", aio_pika.ExchangeType.FANOUT, durable=True)
                queue = await channel.declare_queue("", exclusive=True)
                await queue.bind(exchange, routing_key="")
                logger.info("Notifications consumer started for employee.deleted events")
                async with queue.iterator() as queue_iter:
                    async for message in queue_iter:
                        async with message.process():
                            try:
                                payload = json.loads(message.body.decode())
                                if payload.get("event") == "employee.deleted":
                                    email = payload.get("email", "")
                                    tenant_id = payload.get("tenant_id", "")
                                    logger.info("employee.deleted.presence_cleanup",
                                        extra={"email": email, "tenant_id": tenant_id})
                                    manager.presence.pop(email, None)
                                    manager.presence.pop(tenant_id + ":" + email, None)
                            except Exception:
                                pass
        except Exception as e:
            print(f"Notifications consumer connection error: {e}, retrying in 5s...")
            await asyncio.sleep(5)


# ── SSE Endpoints ───────────────────────────────────────────────────────────

async def sse_generator(queue: asyncio.Queue, channel: str):
    try:
        while True:
            msg = await queue.get()
            yield {"id": str(msg.get("event_id", "")), "event": msg["event"], "data": json.dumps(msg)}
    except asyncio.CancelledError:
        pass
    finally:
        manager.sse_clients[channel].discard(queue)

@app.get("/api/v1/live/sse/{channel}")
async def sse_channel(channel: str, request: Request):
    queue: asyncio.Queue = asyncio.Queue(maxsize=100)
    manager.sse_clients[channel].add(queue)
    last_event_id = request.headers.get("last-event-id")
    history = manager.channel_history.get(channel, [])
    if last_event_id:
        try:
            last_id = int(last_event_id)
            history = [msg for msg in history if msg.get("event_id", 0) > last_id]
        except (ValueError, TypeError):
            history = history[-20:]
    else:
        history = history[-20:]
    for msg in history:
        await queue.put(msg)
    return EventSourceResponse(sse_generator(queue, channel))

@app.get("/api/v1/live/sse/presence")
async def sse_presence(request: Request): return await sse_channel("presence", request)
@app.get("/api/v1/live/sse/attendance")
async def sse_attendance(request: Request): return await sse_channel("attendance", request)
@app.get("/api/v1/live/sse/payroll")
async def sse_payroll(request: Request): return await sse_channel("payroll", request)
@app.get("/api/v1/live/sse/leave")
async def sse_leave(request: Request): return await sse_channel("leave", request)
@app.get("/api/v1/live/sse/kpi")
async def sse_kpi(request: Request): return await sse_channel("kpi", request)
@app.get("/api/v1/live/sse/activity")
async def sse_activity(request: Request): return await sse_channel("activity", request)
@app.get("/api/v1/live/sse/alert")
async def sse_alert(request: Request): return await sse_channel("alert", request)
@app.get("/api/v1/live/sse/announcement")
async def sse_announcement(request: Request): return await sse_channel("announcement", request)
@app.get("/api/v1/live/sse/heatmap")
async def sse_heatmap(request: Request): return await sse_channel("heatmap", request)
@app.get("/api/v1/live/sse/task")
async def sse_task(request: Request): return await sse_channel("task", request)
@app.get("/api/v1/live/sse/escalation")
async def sse_escalation(request: Request): return await sse_channel("escalation", request)
@app.get("/api/v1/live/sse/compliance")
async def sse_compliance(request: Request): return await sse_channel("compliance", request)
@app.get("/api/v1/live/sse/onboarding")
async def sse_onboarding(request: Request): return await sse_channel("onboarding", request)
@app.get("/api/v1/live/sse/recruitment")
async def sse_recruitment(request: Request): return await sse_channel("recruitment", request)
@app.get("/api/v1/live/sse/forecast")
async def sse_forecast(request: Request): return await sse_channel("forecast", request)
@app.get("/api/v1/live/sse/sla")
async def sse_sla(request: Request): return await sse_channel("sla", request)
@app.get("/api/v1/live/sse/staffing")
async def sse_staffing(request: Request): return await sse_channel("staffing", request)
@app.get("/api/v1/live/sse/executive")
async def sse_executive(request: Request): return await sse_channel("executive", request)

# ── WebSocket Auth ────────────────────────────────────────────────────────────

async def verify_ws_token(websocket: WebSocket, token: Optional[str] = None) -> bool:
    auth_header = websocket.headers.get("x-internal-auth")
    token_str = token or auth_header
    if not token_str:
        await websocket.close(code=4001, reason="Missing authentication token")
        return False

    try:
        parts = token_str.split(".")
        if len(parts) != 3:
            await websocket.close(code=4001, reason="Invalid token format")
            return False

        _header_b64, payload_b64, signature = parts
        expected = hmac.new(
            INTERNAL_JWT_SECRET.encode(),
            f"{_header_b64}.{payload_b64}".encode(),
            hashlib.sha256,
        )
        expected_sig = base64.urlsafe_b64encode(expected.digest()).rstrip(b"=").decode()

        if not hmac.compare_digest(expected_sig, signature):
            await websocket.close(code=4001, reason="Invalid token signature")
            return False

        padded = payload_b64 + "=" * (4 - len(payload_b64) % 4)
        decoded = base64.urlsafe_b64decode(padded)
        claims = json.loads(decoded)

        exp = claims.get("exp", 0)
        if exp and time.time() > exp:
            await websocket.close(code=4001, reason="Token expired")
            return False

        websocket.state.user_id = claims.get("user_id", "")
        websocket.state.user_role = claims.get("user_role", "employee")
        websocket.state.tenant_id = claims.get("tenant_id", "default")
        return True
    except Exception:
        await websocket.close(code=4001, reason="Invalid authentication")
        return False


# ── WebSocket Endpoints ─────────────────────────────────────────────────────

@app.websocket("/api/v1/live/ws/{channel}")
async def websocket_channel(websocket: WebSocket, channel: str, token: Optional[str] = Query(None)):
    if not await verify_ws_token(websocket, token):
        return
    await websocket.accept()
    manager.ws_clients[channel].add(websocket)
    try:
        history = manager.channel_history.get(channel, [])
        for msg in history[-50:]:
            await websocket.send_json(msg)
        while True:
            data = await websocket.receive_json()
            handler = ws_handlers.get(channel)
            if handler:
                await handler(websocket, data)
    except WebSocketDisconnect:
        pass
    finally:
        manager.ws_clients[channel].discard(websocket)

ws_handlers: dict[str, callable] = {}

@app.websocket("/api/v1/live/ws/chat")
async def websocket_chat(websocket: WebSocket, token: Optional[str] = Query(None)):
    if not await verify_ws_token(websocket, token):
        return
    await websocket.accept()
    manager.ws_clients["chat"].add(websocket)
    try:
        while True:
            data = await websocket.receive_json()
            msg = ChatMessage(**data)
            entry = {"id": str(uuid.uuid4()), "sender": msg.sender, "message": msg.message, "message_type": msg.message_type, "room": msg.room, "timestamp": datetime.now(timezone.utc).isoformat()}
            manager.chat_rooms[msg.room].append(entry)
            if len(manager.chat_rooms[msg.room]) > 200:
                manager.chat_rooms[msg.room] = manager.chat_rooms[msg.room][-200:]
            await manager.broadcast_ws(f"chat:{msg.room}", {"event": "chat.message", "data": entry})
    except WebSocketDisconnect:
        pass
    finally:
        manager.ws_clients["chat"].discard(websocket)

@app.websocket("/api/v1/live/ws/presence")
async def websocket_presence(websocket: WebSocket, token: Optional[str] = Query(None)):
    if not await verify_ws_token(websocket, token):
        return
    await websocket.accept()
    manager.ws_clients["presence"].add(websocket)
    try:
        while True:
            data = await websocket.receive_json()
            update = PresenceUpdate(**data)
            entry = update.model_dump()
            entry["_last_seen"] = datetime.now(timezone.utc).timestamp()
            manager.presence[update.user_id] = entry
            public = _strip_internal(entry)
            await manager.broadcast_ws("presence", {"event": "presence.update", "data": public})
            await manager.broadcast_sse("presence", "presence.update", public)
    except WebSocketDisconnect:
        pass
    finally:
        manager.ws_clients["presence"].discard(websocket)

# ── REST Endpoints ──────────────────────────────────────────────────────────

@app.post("/api/v1/live/publish/{channel}")
async def publish_event(channel: str, request: Request, event: str = Query(...)):
    body = await request.json()
    await manager.broadcast_sse(channel, event, body)
    await manager.broadcast_ws(channel, {"event": event, "data": body})
    return {"status": "published", "channel": channel, "event": event}

@app.post("/api/v1/live/presence")
async def update_presence(update: PresenceUpdate):
    entry = update.model_dump()
    entry["_last_seen"] = datetime.now(timezone.utc).timestamp()
    manager.presence[update.user_id] = entry
    public = _strip_internal(entry)
    await manager.broadcast_sse("presence", "presence.update", public)
    await manager.broadcast_ws("presence", {"event": "presence.update", "data": public})
    return {"status": "ok"}

@app.get("/api/v1/live/presence")
async def get_presence():
    return {"users": _strip_internal_from_list(manager.presence.values())}

@app.post("/api/v1/live/attendance")
async def publish_attendance(event: AttendanceEvent):
    await manager.broadcast_sse("attendance", "attendance.event", event.model_dump())
    return {"status": "ok"}

@app.post("/api/v1/live/payroll")
async def publish_payroll(progress: PayrollProgress):
    await manager.broadcast_sse("payroll", "payroll.progress", progress.model_dump())
    return {"status": "ok"}

@app.post("/api/v1/live/leave")
async def publish_leave(approval: LeaveApproval):
    await manager.broadcast_sse("leave", "leave.approval", approval.model_dump())
    return {"status": "ok"}

@app.post("/api/v1/live/kpi")
async def publish_kpi(kpi: KPIUpdate):
    await manager.broadcast_sse("kpi", "kpi.update", kpi.model_dump())
    return {"status": "ok"}

@app.post("/api/v1/live/activity")
async def publish_activity(event: ActivityEvent):
    await manager.broadcast_sse("activity", "activity.event", event.model_dump())
    return {"status": "ok"}

@app.post("/api/v1/live/alert")
async def publish_alert(alert: Alert):
    await manager.broadcast_sse("alert", "alert.new", alert.model_dump())
    return {"status": "ok"}

@app.post("/api/v1/live/announcement")
async def publish_announcement(ann: Announcement):
    await manager.broadcast_sse("announcement", "announcement.new", ann.model_dump())
    return {"status": "ok"}

@app.post("/api/v1/live/heatmap")
async def publish_heatmap(data: WorkforceHeatmap):
    await manager.broadcast_sse("heatmap", "heatmap.update", data.model_dump())
    return {"status": "ok"}

@app.post("/api/v1/live/task")
async def publish_task(task: TaskAssignment):
    await manager.broadcast_sse("task", "task.assign", task.model_dump())
    return {"status": "ok"}

@app.post("/api/v1/live/escalation")
async def publish_escalation(esc: Escalation):
    await manager.broadcast_sse("escalation", "escalation.new", esc.model_dump())
    return {"status": "ok"}

@app.post("/api/v1/live/compliance")
async def publish_compliance(violation: ComplianceViolation):
    await manager.broadcast_sse("compliance", "compliance.violation", violation.model_dump())
    return {"status": "ok"}

@app.post("/api/v1/live/onboarding")
async def publish_onboarding(progress: OnboardingProgress):
    await manager.broadcast_sse("onboarding", "onboarding.progress", progress.model_dump())
    return {"status": "ok"}

@app.post("/api/v1/live/recruitment")
async def publish_recruitment(update: RecruitmentUpdate):
    await manager.broadcast_sse("recruitment", "recruitment.update", update.model_dump())
    return {"status": "ok"}

@app.post("/api/v1/live/forecast")
async def publish_forecast(update: ForecastUpdate):
    await manager.broadcast_sse("forecast", "forecast.update", update.model_dump())
    return {"status": "ok"}

@app.post("/api/v1/live/sla")
async def publish_sla(update: SLAUpdate):
    manager.sla_status[update.service] = update.model_dump()
    await manager.broadcast_sse("sla", "sla.update", update.model_dump())
    return {"status": "ok"}

@app.get("/api/v1/live/sla")
async def get_sla():
    return {"services": list(manager.sla_status.values())}

@app.post("/api/v1/live/staffing")
async def publish_staffing(update: StaffingUpdate):
    await manager.broadcast_sse("staffing", "staffing.update", update.model_dump())
    return {"status": "ok"}

@app.post("/api/v1/live/poll/create")
async def create_poll(poll: Poll):
    if not poll.poll_id:
        poll.poll_id = str(uuid.uuid4())
    if not poll.votes:
        poll.votes = {opt: 0 for opt in poll.options}
    entry = poll.model_dump()
    entry["_created_at"] = datetime.now(timezone.utc).timestamp()
    manager.polls[poll.poll_id] = entry
    public = _strip_internal(entry)
    await manager.broadcast_ws("poll", {"event": "poll.created", "data": public})
    return public

@app.post("/api/v1/live/poll/vote")
async def vote_poll(vote: PollVote):
    async with manager.poll_lock:
        poll = manager.polls.get(vote.poll_id)
        if not poll:
            raise HTTPException(status_code=404, detail="Poll not found")
        if vote.option not in poll["options"]:
            raise HTTPException(status_code=400, detail="Invalid option")
        poll["votes"][vote.option] = poll["votes"].get(vote.option, 0) + 1
        votes_snapshot = dict(poll["votes"])
    await manager.broadcast_ws("poll", {"event": "poll.vote", "data": {"poll_id": vote.poll_id, "votes": votes_snapshot}})
    return _strip_internal(poll)

@app.get("/api/v1/live/polls")
async def get_polls():
    return {"polls": _strip_internal_from_list(manager.polls.values())}

@app.post("/api/v1/live/emergency")
async def broadcast_emergency(emergency: EmergencyBroadcast):
    for ch in ["emergency", "alert", "incident"]:
        await manager.broadcast_sse(ch, "emergency.broadcast", emergency.model_dump())
        await manager.broadcast_ws(ch, {"event": "emergency.broadcast", "data": emergency.model_dump()})
    return {"status": "broadcasted"}

@app.post("/api/v1/live/incident")
async def report_incident(incident: IncidentManagement):
    if not incident.incident_id:
        incident.incident_id = str(uuid.uuid4())
    entry = incident.model_dump()
    entry["_created_at"] = datetime.now(timezone.utc).timestamp()
    inc_id = incident.incident_id
    manager.incidents[inc_id].append(entry)
    if len(manager.incidents[inc_id]) > MAX_INCIDENTS_PER_ID:
        manager.incidents[inc_id] = manager.incidents[inc_id][-MAX_INCIDENTS_PER_ID:]
    public = _strip_internal(entry)
    await manager.broadcast_sse("incident", "incident.new", public)
    await manager.broadcast_ws("incident", {"event": "incident.new", "data": public})
    return public

@app.get("/api/v1/live/incidents")
async def get_incidents(status: Optional[str] = None):
    all_inc = []
    for inc_list in manager.incidents.values():
        for inc in inc_list:
            if not status or inc.get("status") == status:
                all_inc.append(inc)
    sorted_inc = sorted(all_inc, key=lambda x: x.get("_created_at", 0), reverse=True)
    return {"incidents": _strip_internal_from_list(sorted_inc)}

@app.get("/api/v1/live/history/{channel}")
async def get_channel_history(channel: str):
    return {"channel": channel, "messages": manager.channel_history.get(channel, [])}

@app.get("/api/v1/live/chat/{room}")
async def get_chat_history(room: str):
    return {"room": room, "messages": manager.chat_rooms.get(room, [])}

@app.get("/api/v1/live/stats")
async def get_stats():
    return {
        "channels": len(manager.channel_history),
        "chat_rooms": len(manager.chat_rooms),
        "polls": len(manager.polls),
        "presence_users": len(manager.presence),
        "incident_groups": len(manager.incidents),
        "sla_services": len(manager.sla_status),
    }

@app.get("/health")
async def health():
    return {"status": "healthy", "service": "live-service", "version": "1.0.0"}
