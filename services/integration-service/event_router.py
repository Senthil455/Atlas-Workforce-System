import json
import logging
import os
import random
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from sqlalchemy.orm import Session

from crud import (
    create_delivery_log,
    create_outbox_event,
    get_event_subscription,
    get_pending_outbox_events,
    get_pending_retries,
    list_event_subscriptions,
    list_webhooks,
    mark_outbox_published,
    mark_outbox_failed,
    update_delivery_log,
    update_webhook,
)
from models import Webhook, WebhookDeliveryLog
from webhook_engine import deliver_webhook, send_audit_event

logger = logging.getLogger("event-router")

RABBITMQ_URL = os.environ.get("RABBITMQ_URL", "amqp://atlas_rabbit:changeme_rabbit_pass@rabbitmq:5672/")
RABBITMQ_EXCHANGE = "notifications_exchange"

_rabbit_connection = None
_rabbit_channel = None
_db_session_factory = None


def set_db_session_factory(session_factory):
    global _db_session_factory
    _db_session_factory = session_factory


def get_db() -> Optional[Session]:
    if _db_session_factory:
        return _db_session_factory()
    return None


def start_rabbitmq_consumer():
    def _consume():
        try:
            import pika
            credentials = pika.PlainCredentials("guest", "guest")
            params = pika.ConnectionParameters(
                host=RABBITMQ_URL.split("@")[1].split(":")[0] if "@" in RABBITMQ_URL else "rabbitmq",
                port=5672,
                credentials=credentials,
                heartbeat=30,
            )
            connection = pika.BlockingConnection(params)
            channel = connection.channel()
            channel.exchange_declare(exchange=RABBITMQ_EXCHANGE, exchange_type="fanout", durable=True)
            result = channel.queue_declare(queue="", exclusive=True)
            queue_name = result.method.queue
            channel.queue_bind(exchange=RABBITMQ_EXCHANGE, queue=queue_name)
            channel.basic_consume(queue=queue_name, on_message_callback=_handle_rabbitmq_message, auto_ack=True)
            logger.info(f"RabbitMQ consumer started on exchange={RABBITMQ_EXCHANGE}")
            channel.start_consuming()
        except ImportError:
            logger.info("[MOCK] RabbitMQ consumer (pika not available)")
        except Exception as e:
            logger.error(f"RabbitMQ consumer error: {e}")
            time.sleep(10)

    thread = threading.Thread(target=_consume, daemon=True)
    thread.start()
    return thread


def _handle_rabbitmq_message(ch, method, properties, body):
    try:
        message = json.loads(body.decode("utf-8"))
        event_type = message.get("event_type", "notification")
        tenant_id = message.get("tenant_id", "default")
        logger.info(f"Received RabbitMQ event: {event_type} for tenant={tenant_id}")
        route_event(event_type, tenant_id, message)
    except Exception as e:
        logger.error(f"Error handling RabbitMQ message: {e}")


RETRY_BACKOFF_CAP_SEC = 30 * 60


def compute_backoff_delay(attempt: int, base_seconds: int, cap_seconds: int = RETRY_BACKOFF_CAP_SEC) -> float:
    # Exponential backoff (base * 2^(attempt-1)) with a small jitter and a cap,
    # so a permanently failing endpoint is not hit in a hot loop.
    base = max(int(base_seconds or 0), 1)
    delay = base * (2 ** max(int(attempt) - 1, 0))
    delay = min(delay, cap_seconds)
    return delay + random.uniform(0, base)


def build_retry_update(attempt: int, max_attempts: int, base_interval_sec: int, now=None) -> dict:
    now = now or datetime.now(timezone.utc)
    if attempt < max_attempts:
        return {
            "status": "PENDING",
            "attempts": attempt,
            "next_retry_at": now + timedelta(seconds=compute_backoff_delay(attempt, base_interval_sec)),
        }
    return {"status": "FAILED", "attempts": attempt, "next_retry_at": None}


def route_event(event_type: str, tenant_id: str, payload: dict, source_service: str = "rabbitmq"):
    db = get_db()
    if not db:
        logger.warning("No DB session available, skipping event routing")
        return

    try:
        webhooks = list_webhooks(db, tenant_id, enabled=True)
        for wh in webhooks.get("items", []):
            wh_event_types = wh.event_types or []
            if not wh_event_types or event_type in wh_event_types:
                log = create_delivery_log(db, tenant_id, wh.id, event_type, payload, wh.retry_count + 1)
                asyncio_thread = threading.Thread(
                    target=_deliver_sync,
                    args=(wh.url, payload, event_type, wh.id, log.id, wh.secret, wh.headers or {}, wh.timeout_sec, tenant_id),
                    daemon=True,
                )
                asyncio_thread.start()

        subs = list_event_subscriptions(db, tenant_id, enabled=True)
        for sub in subs.get("items", []):
            if sub.event_type == event_type or sub.event_type == "*":
                if sub.kafka_topic:
                    from kafka_handler import publish_to_kafka
                    transformed = _apply_transform(payload, sub.transform_template)
                    success = publish_to_kafka(sub.kafka_topic, key=tenant_id, value=transformed)
                    if success:
                        outbox_event = create_outbox_event(db, tenant_id, event_type, source_service, payload)
                        mark_outbox_published(db, outbox_event.id)

        send_audit_event("integration.event_routed", {
            "event_type": event_type,
            "tenant_id": tenant_id,
            "source_service": source_service,
        })
    finally:
        db.close()


def _deliver_sync(url, payload, event_type, webhook_id, log_id, secret, headers, timeout, tenant_id):
    import asyncio
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        status_code, response_body = loop.run_until_complete(
            deliver_webhook(url, payload, event_type, webhook_id, log_id, secret, headers, timeout)
        )
        db = get_db()
        if db:
            try:
                if 200 <= status_code < 300:
                    update_delivery_log(db, log_id, {
                        "status": "DELIVERED",
                        "status_code": status_code,
                        "response_body": response_body,
                        "delivered_at": datetime.now(timezone.utc),
                    })
                    update_webhook(db, webhook_id, tenant_id, {"last_triggered_at": datetime.now(timezone.utc)})
                else:
                    log_row = db.query(WebhookDeliveryLog).filter(WebhookDeliveryLog.id == log_id).first()
                    attempts = (log_row.attempts if log_row and log_row.attempts is not None else 0) + 1
                    max_attempts = log_row.max_attempts if log_row and log_row.max_attempts else 3
                    webhook_row = db.query(Webhook).filter(Webhook.id == webhook_id).first()
                    base_interval = webhook_row.retry_interval_sec if webhook_row and webhook_row.retry_interval_sec else 60
                    retry_data = build_retry_update(attempts, max_attempts, base_interval)
                    retry_data["status_code"] = status_code
                    retry_data["response_body"] = response_body
                    update_delivery_log(db, log_id, retry_data)
            finally:
                db.close()
    except Exception as e:
        logger.error(f"Delivery error: {e}")
    finally:
        loop.close()


def _apply_transform(payload: dict, template: Optional[dict]) -> dict:
    if not template:
        return payload
    transformed = {}
    for key, value in template.items():
        if isinstance(value, str) and value.startswith("$."):
            path = value[2:].split(".")
            current = payload
            for part in path:
                if isinstance(current, dict):
                    current = current.get(part, "")
                else:
                    current = ""
                    break
            transformed[key] = current
        elif isinstance(value, dict):
            transformed[key] = _apply_transform(payload, value)
        else:
            transformed[key] = value
    return transformed


def process_outbox():
    db = get_db()
    if not db:
        return
    try:
        events = get_pending_outbox_events(db)
        for event in events:
            subs = list_event_subscriptions(db, event.tenant_id, enabled=True)
            routed = False
            for sub in subs.get("items", []):
                if sub.event_type == event.event_type and sub.kafka_topic:
                    from kafka_handler import publish_to_kafka
                    success = publish_to_kafka(sub.kafka_topic, key=event.tenant_id, value=event.payload)
                    if success:
                        mark_outbox_published(db, event.id)
                        routed = True
                    else:
                        mark_outbox_failed(db, event.id, "Kafka publish failed")
            if not routed:
                mark_outbox_published(db, event.id)
    finally:
        db.close()


def retry_failed_deliveries():
    db = get_db()
    if not db:
        return
    try:
        logs = get_pending_retries(db)
        for log_entry in logs:
            from crud import get_webhook
            webhook = get_webhook(db, log_entry.webhook_id, log_entry.tenant_id)
            if not webhook or not webhook.enabled:
                update_delivery_log(db, log_entry.id, {"status": "FAILED"})
                continue
            asyncio_thread = threading.Thread(
                target=_deliver_sync,
                args=(
                    webhook.url, log_entry.payload, log_entry.event_type,
                    webhook.id, log_entry.id, webhook.secret,
                    webhook.headers or {}, webhook.timeout_sec, log_entry.tenant_id,
                ),
                daemon=True,
            )
            asyncio_thread.start()
    finally:
        db.close()
