import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone
from uuid import uuid4

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

os.environ.setdefault("DATABASE_URL", "sqlite:///test.db")
os.environ.setdefault("INTERNAL_JWT_SECRET", "test-jwt-secret")

import event_router
from event_router import (
    RETRY_BACKOFF_CAP_SEC,
    build_retry_update,
    compute_backoff_delay,
)


class FakeRow:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


class FakeQuery:
    def __init__(self, store, model):
        self._store = store
        self._model = model

    def filter(self, *args, **kwargs):
        return self

    def first(self):
        return self._store.get(self._model.__name__)


class FakeSession:
    def __init__(self, store):
        self._store = store
        self.closed = False

    def query(self, model):
        return FakeQuery(self._store, model)

    def close(self):
        self.closed = True


def _run_failures(base_interval=60, max_attempts=3, failures=3):
    log_id = uuid4()
    webhook_id = uuid4()
    store = {
        "WebhookDeliveryLog": FakeRow(id=log_id, attempts=0, max_attempts=max_attempts),
        "Webhook": FakeRow(id=webhook_id, retry_interval_sec=base_interval),
    }
    written = []

    async def failing_deliver(*args, **kwargs):
        return 500, "boom"

    def fake_update(db, lid, data):
        row = store["WebhookDeliveryLog"]
        for key, value in data.items():
            setattr(row, key, value)
        written.append(dict(data))
        return row

    old_deliver = event_router.deliver_webhook
    old_update = event_router.update_delivery_log
    old_webhook_update = event_router.update_webhook
    old_factory = event_router._db_session_factory
    event_router.deliver_webhook = failing_deliver
    event_router.update_delivery_log = fake_update
    event_router.update_webhook = lambda *a, **k: None
    event_router.set_db_session_factory(lambda: FakeSession(store))
    try:
        for _ in range(failures):
            event_router._deliver_sync(
                "http://example.com/hook", {"a": 1}, "test.event",
                webhook_id, log_id, None, {}, 30, "tenant-a",
            )
    finally:
        event_router.deliver_webhook = old_deliver
        event_router.update_delivery_log = old_update
        event_router.update_webhook = old_webhook_update
        event_router._db_session_factory = old_factory
    return store["WebhookDeliveryLog"], written


def test_backoff_grows_exponentially():
    random_free = [compute_backoff_delay(n, 60, cap_seconds=10**9) for n in (1, 2, 3)]
    # strip jitter by comparing lower bounds: delay >= base * 2^(n-1)
    assert random_free[0] >= 60
    assert random_free[1] >= 120
    assert random_free[2] >= 240


def test_backoff_respects_cap():
    for _ in range(20):
        assert compute_backoff_delay(100, 60) <= RETRY_BACKOFF_CAP_SEC + 60


def test_backoff_positive_with_zero_base():
    assert compute_backoff_delay(1, 0) >= 1


def test_retry_update_sets_future_datetime():
    before = datetime.now(timezone.utc)
    update = build_retry_update(1, 3, 60)
    assert update["status"] == "PENDING"
    assert isinstance(update["next_retry_at"], datetime)
    assert update["next_retry_at"] > before


def test_retry_update_exhaustion_clears_next_retry():
    update = build_retry_update(3, 3, 60)
    assert update["status"] == "FAILED"
    assert update["attempts"] == 3
    assert update["next_retry_at"] is None


def test_three_failures_advance_attempts_and_backoff():
    row, written = _run_failures(base_interval=60, max_attempts=3, failures=3)
    assert [w["attempts"] for w in written] == [1, 2, 3]
    assert [w["status"] for w in written] == ["PENDING", "PENDING", "FAILED"]
    assert [w["status_code"] for w in written] == [500, 500, 500]
    assert all(w["response_body"] == "boom" for w in written)
    first, second = written[0]["next_retry_at"], written[1]["next_retry_at"]
    assert isinstance(first, datetime)
    assert isinstance(second, datetime)
    assert second > first
    assert written[2]["next_retry_at"] is None
    assert row.attempts == 3
    assert row.status == "FAILED"


def test_success_marks_delivered_with_datetime():
    log_id = uuid4()
    webhook_id = uuid4()
    store = {
        "WebhookDeliveryLog": FakeRow(id=log_id, attempts=1, max_attempts=3),
        "Webhook": FakeRow(id=webhook_id, retry_interval_sec=60),
    }
    written = []

    async def ok_deliver(*args, **kwargs):
        return 200, "ok"

    old_deliver = event_router.deliver_webhook
    old_update = event_router.update_delivery_log
    old_webhook_update = event_router.update_webhook
    old_factory = event_router._db_session_factory
    event_router.deliver_webhook = ok_deliver
    event_router.update_delivery_log = lambda db, lid, data: written.append(data)
    event_router.update_webhook = lambda *a, **k: None
    event_router.set_db_session_factory(lambda: FakeSession(store))
    try:
        event_router._deliver_sync(
            "http://example.com/hook", {"a": 1}, "test.event",
            webhook_id, log_id, None, {}, 30, "tenant-a",
        )
    finally:
        event_router.deliver_webhook = old_deliver
        event_router.update_delivery_log = old_update
        event_router.update_webhook = old_webhook_update
        event_router._db_session_factory = old_factory
    assert written[0]["status"] == "DELIVERED"
    assert isinstance(written[0]["delivered_at"], datetime)


def test_retry_honors_webhook_interval_policy():
    row_fast, written_fast = _run_failures(base_interval=10, max_attempts=2, failures=1)
    row_slow, written_slow = _run_failures(base_interval=300, max_attempts=2, failures=1)
    assert written_fast[0]["next_retry_at"] < written_slow[0]["next_retry_at"]
