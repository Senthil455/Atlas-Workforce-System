"""Tests for the public career portal surface (issue #188).

The career endpoints must be reachable without x-internal-auth, the tenant
for an application must come from the job posting (never from caller
headers), and the anti-abuse controls (honeypot + per-email cap) must hold.

These tests override the get_db dependency with an in-memory fake, so no
database is needed to run them.
"""

import uuid

import pytest
from fastapi.testclient import TestClient

from main import app, get_db
from models import Job as JobModel, Candidate as CandidateModel, Application as ApplicationModel


class _FakeQuery:
    def __init__(self, first=None, items=(), total=0):
        self._first = first
        self._items = list(items)
        self._total = total

    def filter(self, *args, **kwargs):
        return self

    def order_by(self, *args, **kwargs):
        return self

    def offset(self, *args, **kwargs):
        return self

    def limit(self, *args, **kwargs):
        return self

    def join(self, *args, **kwargs):
        return self

    def first(self):
        return self._first

    def all(self):
        return list(self._items)

    def count(self):
        return self._total


class _FakeDB:
    """Minimal stand-in for a SQLAlchemy session."""

    def __init__(self):
        self.jobs = []
        self.candidate = None
        self.application = None
        self.recent_application_count = 0
        self.added = []

    def query(self, model):
        if model is JobModel:
            return _FakeQuery(first=self.jobs[0] if self.jobs else None,
                              items=self.jobs, total=len(self.jobs))
        if model is CandidateModel:
            return _FakeQuery(first=self.candidate)
        if model is ApplicationModel:
            return _FakeQuery(first=self.application,
                              total=self.recent_application_count)
        return _FakeQuery()

    def add(self, obj):
        self.added.append(obj)

    def commit(self):
        pass

    def refresh(self, obj):
        pass


def _make_job(tenant_id="acme"):
    return JobModel(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        title="Backend Engineer",
        department="Engineering",
        status="PUBLISHED",
    )


def _make_candidate(tenant_id="acme"):
    return CandidateModel(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        first_name="Ada",
        last_name="Lovelace",
        email="ada@example.com",
        status="NEW",
    )


def _client_with_db(fake_db):
    app.dependency_overrides[get_db] = lambda: fake_db
    return TestClient(app)


@pytest.fixture(autouse=True)
def _clean_overrides():
    yield
    app.dependency_overrides.clear()


def test_career_jobs_reachable_without_internal_auth():
    fake_db = _FakeDB()
    fake_db.jobs = [_make_job()]
    client = _client_with_db(fake_db)

    response = client.get("/api/v1/career/jobs")

    assert response.status_code == 200
    data = response.json()
    assert data["total"] == 1
    assert data["items"][0]["title"] == "Backend Engineer"
    # tenant must not leak into the public listing
    assert "tenant_id" not in data["items"][0]


def test_career_job_details_reachable_without_internal_auth():
    job = _make_job()
    fake_db = _FakeDB()
    fake_db.jobs = [job]
    client = _client_with_db(fake_db)

    response = client.get(f"/api/v1/career/jobs/{job.id}")

    assert response.status_code == 200
    assert response.json()["title"] == "Backend Engineer"


def test_apply_rejects_spoofed_tenant_header():
    fake_db = _FakeDB()
    fake_db.jobs = [_make_job(tenant_id="acme")]
    client = _client_with_db(fake_db)

    response = client.post(
        "/api/v1/career/apply",
        params={"job_id": str(fake_db.jobs[0].id), "first_name": "Ada",
                "last_name": "Lovelace", "email": "ada@example.com"},
        headers={"X-Tenant-Id": "evil-tenant"},
    )

    assert response.status_code == 403
    assert fake_db.added == []


def test_apply_files_into_job_tenant():
    fake_db = _FakeDB()
    fake_db.jobs = [_make_job(tenant_id="acme")]
    fake_db.candidate = _make_candidate(tenant_id="acme")
    client = _client_with_db(fake_db)

    response = client.post(
        "/api/v1/career/apply",
        params={"job_id": str(fake_db.jobs[0].id), "first_name": "Ada",
                "last_name": "Lovelace", "email": "ada@example.com"},
    )

    assert response.status_code == 201
    applications = [o for o in fake_db.added if isinstance(o, ApplicationModel)]
    assert len(applications) == 1
    assert applications[0].tenant_id == "acme"
    assert response.json()["email"] == "ada@example.com"


def test_apply_honeypot_stores_nothing():
    fake_db = _FakeDB()
    fake_db.jobs = [_make_job(tenant_id="acme")]
    client = _client_with_db(fake_db)

    response = client.post(
        "/api/v1/career/apply",
        params={"job_id": str(fake_db.jobs[0].id), "first_name": "Bot",
                "last_name": "Bot", "email": "bot@example.com",
                "company_website": "http://spam.example.com"},
    )

    # bots get a plausible success, but nothing is stored
    assert response.status_code == 201
    assert fake_db.added == []


def test_apply_rejects_too_many_applications_per_email():
    fake_db = _FakeDB()
    fake_db.jobs = [_make_job(tenant_id="acme")]
    fake_db.candidate = _make_candidate(tenant_id="acme")
    fake_db.recent_application_count = 5
    client = _client_with_db(fake_db)

    response = client.post(
        "/api/v1/career/apply",
        params={"job_id": str(fake_db.jobs[0].id), "first_name": "Ada",
                "last_name": "Lovelace", "email": "ada@example.com"},
    )

    assert response.status_code == 429
    assert fake_db.added == []
