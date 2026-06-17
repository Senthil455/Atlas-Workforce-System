import os
import pytest
from httpx import AsyncClient, ASGITransport

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from main import app  # noqa: E402


@pytest.mark.asyncio
async def test_health_check():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "healthy"
        assert data["service"] == "ai-service"
