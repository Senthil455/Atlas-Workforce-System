import base64
import hashlib
import hmac
import json
import time

import pytest
from httpx import AsyncClient, ASGITransport
from main import app

INTERNAL_JWT_SECRET = "test-secret"


def _make_internal_token(secret: str) -> str:
    hdr = base64.urlsafe_b64encode(
        json.dumps({"alg": "HS256", "typ": "JWT"}).encode()
    ).rstrip(b"=").decode()
    payload = base64.urlsafe_b64encode(
        json.dumps({"sub": "test", "exp": int(time.time()) + 3600}).encode()
    ).rstrip(b"=").decode()
    sig = base64.urlsafe_b64encode(
        hmac.new(secret.encode(), f"{hdr}.{payload}".encode(), hashlib.sha256).digest()
    ).rstrip(b"=").decode()
    return f"{hdr}.{payload}.{sig}"


@pytest.fixture
def client():
    transport = ASGITransport(app=app)
    token = _make_internal_token(INTERNAL_JWT_SECRET)
    return AsyncClient(transport=transport, base_url="http://test", headers={"x-internal-auth": token})


@pytest.mark.asyncio
async def test_health_check(client):
    resp = await client.get("/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "healthy"
    assert data["service"] == "ai-copilot-service"


# ──────────────────────────────────────────────
#  Copilot / Chat
# ──────────────────────────────────────────────

@pytest.mark.asyncio
async def test_chat_basic(client):
    resp = await client.post("/api/v1/copilot/chat", json={
        "message": "What is the current headcount?",
    })
    assert resp.status_code == 200
    data = resp.json()
    assert "reply" in data
    assert "suggested_actions" in data
    assert "session_id" in data
    assert len(data["reply"]) > 0
    assert len(data["session_id"]) > 0


@pytest.mark.asyncio
async def test_chat_with_session(client):
    resp1 = await client.post("/api/v1/copilot/chat", json={
        "message": "Hello",
    })
    sid = resp1.json()["session_id"]

    resp2 = await client.post("/api/v1/copilot/chat", json={
        "message": "Tell me about attrition",
        "session_id": sid,
    })
    assert resp2.status_code == 200
    assert resp2.json()["session_id"] == sid


@pytest.mark.asyncio
async def test_chat_with_context(client):
    resp = await client.post("/api/v1/copilot/chat", json={
        "message": "How is my team doing?",
        "context": {"employee_id": "E12345", "department": "Engineering"},
    })
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_get_session_not_found(client):
    resp = await client.get("/api/v1/copilot/sessions/nonexistent")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_get_session_success(client):
    chat_resp = await client.post("/api/v1/copilot/chat", json={"message": "Hi"})
    sid = chat_resp.json()["session_id"]
    resp = await client.get(f"/api/v1/copilot/sessions/{sid}")
    assert resp.status_code == 200
    data = resp.json()
    assert data["session_id"] == sid
    assert len(data["messages"]) > 0


@pytest.mark.asyncio
async def test_delete_session(client):
    chat_resp = await client.post("/api/v1/copilot/chat", json={"message": "Hi"})
    sid = chat_resp.json()["session_id"]
    resp = await client.delete(f"/api/v1/copilot/sessions/{sid}")
    assert resp.status_code == 200
    assert resp.json()["status"] == "deleted"

    resp2 = await client.get(f"/api/v1/copilot/sessions/{sid}")
    assert resp2.status_code == 404


# ──────────────────────────────────────────────
#  Predictive Analytics
# ──────────────────────────────────────────────

@pytest.mark.asyncio
async def test_attrition_risk(client):
    resp = await client.post("/api/v1/predict/attrition-risk", json={
        "employees": [
            {
                "employee_id": "E001",
                "department": "Engineering",
                "tenure_years": 1.5,
                "age": 25,
                "satisfaction_score": 0.3,
                "performance_score": 0.6,
                "overtime_hours": 20,
                "promotions": 0,
                "absences": 8,
            },
            {
                "employee_id": "E002",
                "department": "Operations",
                "tenure_years": 6,
                "age": 40,
                "satisfaction_score": 0.9,
                "performance_score": 0.8,
                "overtime_hours": 5,
                "promotions": 2,
                "absences": 1,
            },
        ]
    })
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["predictions"]) == 2
    p1 = data["predictions"][0]
    assert p1["employee_id"] == "E001"
    assert 0.0 <= p1["risk_score"] <= 1.0
    assert p1["risk_level"] in ("LOW", "MEDIUM", "HIGH", "CRITICAL")
    assert len(p1["top_factors"]) > 0


@pytest.mark.asyncio
async def test_performance_prediction(client):
    resp = await client.post("/api/v1/predict/performance", json={
        "employee_id": "E001",
        "historical_scores": [3.5, 3.8, 4.0, 4.2, 4.1],
        "months_ahead": 3,
    })
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["predicted_scores"]) == 3
    assert all(1.0 <= s <= 5.0 for s in data["predicted_scores"])
    assert data["confidence_interval"]["lower"] <= data["confidence_interval"]["upper"]


@pytest.mark.asyncio
async def test_retention_drivers(client):
    resp = await client.get("/api/v1/predict/retention-drivers")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["drivers"]) > 0
    for d in data["drivers"]:
        assert "factor" in d
        assert "weight" in d


# ──────────────────────────────────────────────
#  Workforce Forecasting
# ──────────────────────────────────────────────

@pytest.mark.asyncio
async def test_hiring_demand(client):
    resp = await client.post("/api/v1/forecast/hiring-demand", json={
        "current_headcount": 150,
        "growth_rate": 0.15,
        "attrition_rate": 0.08,
        "months": 3,
    })
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["forecast"]) == 3
    for m in data["forecast"]:
        assert "month" in m
        assert m["total"] > 0
        assert m["new_hires"] >= 0
        assert m["attrition"] >= 0


@pytest.mark.asyncio
async def test_skill_gap(client):
    resp = await client.post("/api/v1/forecast/skill-gap", json={
        "current_skills": {"Python": 20, "Java": 15, "Go": 5},
        "target_skills": {"Python": 30, "Java": 15, "Go": 15},
    })
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["gaps"]) > 0
    assert len(data["recommendations"]) > 0
    for g in data["gaps"]:
        assert g["severity"] in ("LOW", "MEDIUM", "HIGH")


@pytest.mark.asyncio
async def test_department_growth(client):
    resp = await client.get("/api/v1/forecast/department-growth?months=12")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["departments"]) > 0
    for d in data["departments"]:
        assert d["projected"] >= d["current"]


# ──────────────────────────────────────────────
#  Resume Screening
# ──────────────────────────────────────────────

@pytest.mark.asyncio
async def test_resume_score(client):
    resp = await client.post("/api/v1/resume/score", json={
        "resume_text": "Experienced Python developer with AWS and Docker expertise. "
                       "5 years building microservices and CI/CD pipelines.",
        "job_description": "Looking for a Senior Python developer with AWS and Kubernetes experience.",
        "job_requirements": ["Python", "AWS", "Kubernetes", "Docker"],
    })
    assert resp.status_code == 200
    data = resp.json()
    assert 0.0 <= data["overall_score"] <= 1.0
    assert 0.0 <= data["skill_match"] <= 1.0
    assert "Python" in data["matched_skills"]
    assert len(data["missing_skills"]) >= 0
    assert len(data["summary"]) > 0


@pytest.mark.asyncio
async def test_resume_analyze(client):
    resp = await client.post("/api/v1/resume/analyze", json={
        "resume_text": "John Smith\njohn@email.com\n(555) 123-4567\n\n"
                       "EXPERIENCE\nSenior Engineer at Acme Corp 2019-2023\n"
                       "Skills: Python, AWS, React\n"
                       "EDUCATION\nB.S. Computer Science, MIT 2015",
    })
    assert resp.status_code == 200
    data = resp.json()
    assert data["name"] == "John Smith"
    assert data["email"] == "john@email.com"
    assert data["phone"] is not None
    assert len(data["skills"]) > 0
    assert len(data["experience"]) > 0
    assert len(data["education"]) > 0


# ──────────────────────────────────────────────
#  Sentiment Analysis
# ──────────────────────────────────────────────

@pytest.mark.asyncio
async def test_sentiment_positive(client):
    resp = await client.post("/api/v1/sentiment/analyze", json={
        "text": "I am very happy with the great work environment and supportive team.",
        "context": "survey",
    })
    assert resp.status_code == 200
    data = resp.json()
    assert data["sentiment"] in ("POSITIVE", "NEUTRAL", "NEGATIVE")
    assert 0.0 <= data["score"] <= 1.0
    assert "satisfaction" in data["emotions"]
    assert "frustration" in data["emotions"]


@pytest.mark.asyncio
async def test_sentiment_negative(client):
    resp = await client.post("/api/v1/sentiment/analyze", json={
        "text": "I am extremely frustrated with the poor management and toxic culture.",
    })
    assert resp.status_code == 200
    data = resp.json()
    assert data["sentiment"] == "NEGATIVE"
    assert data["score"] < 0.5


@pytest.mark.asyncio
async def test_survey_analysis(client):
    resp = await client.post("/api/v1/sentiment/survey", json={
        "responses": [
            {"employee_id": "E001", "question_id": "Q1", "answer_text": "Great culture and team!", "rating": 5},
            {"employee_id": "E002", "question_id": "Q1", "answer_text": "Management needs improvement", "rating": 3},
            {"employee_id": "E003", "question_id": "Q2", "answer_text": "Poor compensation and benefits", "rating": 2},
            {"employee_id": "E004", "question_id": "Q2", "answer_text": "Good work-life balance", "rating": 4},
        ]
    })
    assert resp.status_code == 200
    data = resp.json()
    assert 0.0 <= data["overall_sentiment"] <= 1.0
    assert "categories" in data
    assert data["trend"] in ("improving", "declining", "stable")


# ──────────────────────────────────────────────
#  Strategic Insights
# ──────────────────────────────────────────────

@pytest.mark.asyncio
async def test_org_health(client):
    resp = await client.get("/api/v1/insights/organizational-health")
    assert resp.status_code == 200
    data = resp.json()
    assert 0.0 <= data["health_score"] <= 1.0
    assert "dimensions" in data
    assert len(data["recommendations"]) > 0
    assert len(data["risk_flags"]) > 0


@pytest.mark.asyncio
async def test_strategic_recommendations(client):
    resp = await client.post("/api/v1/insights/strategic-recommendations", json={
        "context": {
            "industry": "tech",
            "headcount": 500,
            "growth_rate": 0.2,
            "challenges": ["retention", "skill_gaps"],
        }
    })
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["recommendations"]) > 0
    for r in data["recommendations"]:
        assert "area" in r
        assert "priority" in r
        assert "action" in r
        assert "impact" in r
        assert "timeline" in r


@pytest.mark.asyncio
async def test_attrition_batch_cap_rejects_oversize(client):
    employees = [{"employee_id": f"E{i:04d}"} for i in range(101)]
    resp = await client.post("/api/v1/predict/attrition-risk", json={"employees": employees})
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_attrition_batch_empty_rejected(client):
    resp = await client.post("/api/v1/predict/attrition-risk", json={"employees": []})
    assert resp.status_code == 422


def test_session_expiry_evicts_stale():
    import time as _time
    from models import SessionStore
    SessionStore._sessions.clear()
    SessionStore._ttl_seconds = 60
    sess = SessionStore.get_or_create(None)
    sid = sess.session_id
    assert SessionStore.get(sid) is not None
    sess.last_activity = _time.time() - 3600
    assert SessionStore.get(sid) is None
    SessionStore._sessions.clear()
    SessionStore._ttl_seconds = 3600


def test_session_cleanup_counts_expired():
    import time as _time
    from models import SessionStore
    SessionStore._sessions.clear()
    SessionStore._ttl_seconds = 60
    s1 = SessionStore.get_or_create(None)
    s2 = SessionStore.get_or_create(None)
    s1.last_activity = _time.time() - 3600
    removed = SessionStore.cleanup_expired()
    assert removed == 1
    assert SessionStore.get(s2.session_id) is not None
    SessionStore._sessions.clear()
    SessionStore._ttl_seconds = 3600


@pytest.mark.asyncio
async def test_expired_session_returns_404(client):
    import time as _time
    from models import SessionStore
    chat = await client.post("/api/v1/copilot/chat", json={"message": "Hi"})
    sid = chat.json()["session_id"]
    sess = SessionStore._sessions.get(sid)
    assert sess is not None
    sess.last_activity = _time.time() - (SessionStore._ttl_seconds + 10)
    resp = await client.get(f"/api/v1/copilot/sessions/{sid}")
    assert resp.status_code == 404


def test_resume_parser_uses_utc_clock():
    from datetime import datetime, timezone
    from resume_parser import extract_experience
    text = "Senior Engineer at Acme Corp 2020-Present"
    entries = extract_experience(text)
    assert len(entries) >= 1
    expected = datetime.now(timezone.utc).year - 2020
    assert entries[0]["years"] == expected


def test_resume_parser_ongoing_variants_use_utc_year():
    from datetime import datetime, timezone
    from resume_parser import extract_experience
    current = datetime.now(timezone.utc).year
    for marker in ("Current", "Now", "Ongoing"):
        entries = extract_experience(f"Lead at Globex 2019-{marker}")
        assert entries, marker
        assert entries[0]["years"] == current - 2019


# ──────────────────────────────────────────────
#  Input size limits (#662)
# ──────────────────────────────────────────────

from schemas import (
    MAX_CHAT_MESSAGE_CHARS, MAX_JOB_DESCRIPTION_CHARS, MAX_JOB_REQUIREMENT_CHARS,
    MAX_JOB_REQUIREMENTS, MAX_RESUME_TEXT_CHARS,
)

_SCORE_STUB = {
    "overall_score": 0.5, "skill_match": 0.5, "experience_match": 0.5, "education_match": 0.5,
    "matched_skills": [], "missing_skills": [], "summary": "stub",
}
_ANALYZE_STUB = {"skills": [], "experience": [], "education": []}


@pytest.fixture
def stub_resume(monkeypatch):
    import main
    monkeypatch.setattr(main, "score_resume", lambda *a, **k: _SCORE_STUB)
    monkeypatch.setattr(main, "parse_resume", lambda *a, **k: _ANALYZE_STUB)


def _error_locs(resp):
    return [e["loc"] for e in resp.json()["detail"]]


@pytest.mark.asyncio
async def test_chat_message_at_limit_accepted(client):
    resp = await client.post("/api/v1/copilot/chat", json={"message": "a" * MAX_CHAT_MESSAGE_CHARS})
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_chat_message_one_over_limit_rejected(client):
    resp = await client.post("/api/v1/copilot/chat", json={"message": "a" * (MAX_CHAT_MESSAGE_CHARS + 1)})
    assert resp.status_code == 422
    assert ["body", "message"] in _error_locs(resp)


@pytest.mark.asyncio
@pytest.mark.parametrize("message", ["", "   ", " \n\t "])
async def test_chat_message_empty_or_blank_rejected(client, message):
    resp = await client.post("/api/v1/copilot/chat", json={"message": message})
    assert resp.status_code == 422
    assert ["body", "message"] in _error_locs(resp)


@pytest.mark.asyncio
async def test_chat_message_multibyte_counted_by_code_point(client):
    # Each emoji is 4 bytes in UTF-8; the limit is on characters, not bytes.
    at_limit = await client.post("/api/v1/copilot/chat", json={"message": "😀" * MAX_CHAT_MESSAGE_CHARS})
    assert at_limit.status_code == 200
    over = await client.post("/api/v1/copilot/chat", json={"message": "😀" * (MAX_CHAT_MESSAGE_CHARS + 1)})
    assert over.status_code == 422


@pytest.mark.asyncio
async def test_resume_score_boundaries(client, stub_resume):
    base = {"resume_text": "Python developer", "job_description": "Python role"}
    ok = await client.post("/api/v1/resume/score", json={
        "resume_text": "r" * MAX_RESUME_TEXT_CHARS,
        "job_description": "j" * MAX_JOB_DESCRIPTION_CHARS,
        "job_requirements": ["q" * MAX_JOB_REQUIREMENT_CHARS] * MAX_JOB_REQUIREMENTS,
    })
    assert ok.status_code == 200

    cases = [
        ({"resume_text": "r" * (MAX_RESUME_TEXT_CHARS + 1)}, ["body", "resume_text"]),
        ({"job_description": "j" * (MAX_JOB_DESCRIPTION_CHARS + 1)}, ["body", "job_description"]),
        ({"job_requirements": ["Python"] * (MAX_JOB_REQUIREMENTS + 1)}, ["body", "job_requirements"]),
        ({"job_requirements": ["q" * (MAX_JOB_REQUIREMENT_CHARS + 1)]}, ["body", "job_requirements", 0]),
    ]
    for override, loc in cases:
        resp = await client.post("/api/v1/resume/score", json={**base, **override})
        assert resp.status_code == 422, loc
        assert loc in _error_locs(resp)


@pytest.mark.asyncio
async def test_resume_analyze_boundaries_multibyte(client, stub_resume):
    ok = await client.post("/api/v1/resume/analyze", json={"resume_text": "漢" * MAX_RESUME_TEXT_CHARS})
    assert ok.status_code == 200
    over = await client.post("/api/v1/resume/analyze", json={"resume_text": "漢" * (MAX_RESUME_TEXT_CHARS + 1)})
    assert over.status_code == 422
    assert ["body", "resume_text"] in _error_locs(over)


@pytest.mark.asyncio
async def test_oversized_input_rejected_before_model_call(client, monkeypatch):
    import main
    calls = []

    async def fake_chat(**kwargs):
        calls.append(kwargs)
        raise AssertionError("model must not be called")

    monkeypatch.setattr(main, "handle_chat_message", fake_chat)
    monkeypatch.setattr(main, "score_resume", lambda *a, **k: calls.append(a))
    monkeypatch.setattr(main, "parse_resume", lambda *a, **k: calls.append(a))

    big = "x" * 900_000
    assert (await client.post("/api/v1/copilot/chat", json={"message": big})).status_code == 422
    assert (await client.post("/api/v1/resume/score", json={
        "resume_text": big, "job_description": "Python role"})).status_code == 422
    assert (await client.post("/api/v1/resume/analyze", json={"resume_text": big})).status_code == 422
    assert calls == []


@pytest.mark.asyncio
async def test_validation_error_does_not_echo_or_log_input(client, caplog):
    marker = "SECRET-PROMPT-CONTENT-"
    payload = marker * (MAX_CHAT_MESSAGE_CHARS // len(marker) + 1)
    with caplog.at_level("WARNING"):
        resp = await client.post("/api/v1/copilot/chat", json={"message": payload})
    assert resp.status_code == 422
    assert marker not in resp.text
    assert all("input" not in e for e in resp.json()["detail"])
    assert len(resp.content) < 1_000
    assert "request.validation_rejected" in caplog.text
    assert f"size={len(payload)}" in caplog.text
    assert marker not in caplog.text
