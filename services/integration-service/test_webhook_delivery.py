"""Webhook delivery loop tests for issue #184.

Each delivery runs on its own event loop, so the httpx client must not be
a global bound to the first loop. Three sequential deliveries must all be
recorded, and an unexpected error must mark the log FAILED (never stuck
PENDING) with the exception type visible.
"""
import asyncio
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from uuid import uuid4

import event_router
import webhook_engine


class _QuietHandler(BaseHTTPRequestHandler):
    hits = 0

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        self.rfile.read(length)
        type(self).hits += 1
        body = b"ok"
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def _start_local_server():
    server = HTTPServer(("127.0.0.1", 0), _QuietHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


class _DummyDb:
    def close(self):
        pass

    def execute(self, *args, **kwargs):
        class _Row:
            def fetchone(self):
                return (0, 3)

        return _Row()


def _patch_db(monkeypatch, deliveries, webhooks):
    monkeypatch.setattr(event_router, "get_db", lambda: _DummyDb())
    monkeypatch.setattr(
        event_router, "update_delivery_log", lambda db, log_id, data: deliveries.append(data)
    )
    monkeypatch.setattr(
        event_router, "update_webhook", lambda *args, **kwargs: webhooks.append(args)
    )


def test_clients_are_isolated_per_loop():
    async def _grab():
        return webhook_engine.get_client()

    async def _close():
        await webhook_engine.close_client()

    loop1 = asyncio.new_event_loop()
    loop2 = asyncio.new_event_loop()
    try:
        c1 = loop1.run_until_complete(_grab())
        c2 = loop2.run_until_complete(_grab())
        assert c1 is not c2
        loop1.run_until_complete(_close())
        loop2.run_until_complete(_close())
    finally:
        loop1.close()
        loop2.close()


def test_three_sequential_deliveries_all_recorded(monkeypatch):
    server = _start_local_server()
    try:
        _QuietHandler.hits = 0
        deliveries = []
        webhooks = []
        _patch_db(monkeypatch, deliveries, webhooks)
        url = f"http://127.0.0.1:{server.server_port}/hook"
        for _ in range(3):
            event_router._deliver_sync(
                url, {"n": 1}, "test.event", uuid4(), uuid4(), None, {}, 10, "t1"
            )
        assert _QuietHandler.hits == 3
        assert len(deliveries) == 3
        for d in deliveries:
            assert d["status"] == "DELIVERED"
            assert d["status_code"] == 200
    finally:
        server.shutdown()


def test_unexpected_error_marks_failed(monkeypatch):
    async def _boom(*args, **kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(event_router, "deliver_webhook", _boom)
    deliveries = []
    webhooks = []
    _patch_db(monkeypatch, deliveries, webhooks)
    event_router._deliver_sync(
        "http://127.0.0.1:9/hook", {}, "test.event", uuid4(), uuid4(), None, {}, 10, "t1"
    )
    assert len(deliveries) == 1
    assert deliveries[0]["status"] == "FAILED"
    assert deliveries[0]["status_code"] == 0
    assert "RuntimeError" in deliveries[0]["response_body"]
