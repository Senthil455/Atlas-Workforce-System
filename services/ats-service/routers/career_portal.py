from datetime import datetime, timedelta, timezone
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from sqlalchemy import or_
from sqlalchemy.orm import Session
from main import get_db
from models import Job as JobModel, Candidate as CandidateModel, Application as ApplicationModel
import crud
import schemas

router = APIRouter(tags=["career-portal"])

# Anti-abuse: max applications a single candidate email can submit per 24h.
MAX_APPLICATIONS_PER_EMAIL_PER_DAY = 5


@router.get("/career/jobs", summary="Public: List published jobs")
def public_list_jobs(
    department: Optional[str] = Query(None),
    employment_type: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
):
    q = db.query(JobModel).filter(JobModel.status == "PUBLISHED")
    if department:
        q = q.filter(JobModel.department == department)
    if employment_type:
        q = q.filter(JobModel.employment_type == employment_type)
    if search:
        pattern = f"%{search}%"
        q = q.filter(or_(
            JobModel.title.ilike(pattern),
            JobModel.department.ilike(pattern),
            JobModel.description.ilike(pattern),
        ))
    q = q.order_by(JobModel.posted_at.desc())
    total = q.count()
    items = q.offset((page - 1) * page_size).limit(page_size).all()
    result = []
    for job in items:
        j = crud.serialize_uuid(job)
        j.pop("tenant_id", None)
        result.append(j)
    return crud.paginated_response(result, total, page, page_size)


@router.get("/career/jobs/{job_id}", summary="Public: Get job details")
def public_get_job(job_id: str, db: Session = Depends(get_db)):
    job = db.query(JobModel).filter(
        JobModel.id == job_id,
        JobModel.status == "PUBLISHED",
    ).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    j = crud.serialize_uuid(job)
    j.pop("tenant_id", None)
    return j


@router.post("/career/apply", response_model=schemas.CandidateResponse,
             status_code=201, summary="Public: Apply to a job")
def public_apply(
    request: Request,
    job_id: str = Query(...),
    first_name: str = Query(...),
    last_name: str = Query(...),
    email: str = Query(...),
    phone: Optional[str] = Query(None),
    resume_url: Optional[str] = Query(None),
    cover_letter: Optional[str] = Query(None),
    # Honeypot field: hidden from the OpenAPI schema, only bots fill it in.
    # Pretend the application was accepted but store nothing.
    company_website: Optional[str] = Query(None, include_in_schema=False),
    db: Session = Depends(get_db),
):
    if company_website:
        return JSONResponse(
            status_code=201,
            content={"detail": "Application received. We will be in touch."},
        )

    job = db.query(JobModel).filter(
        JobModel.id == job_id,
        JobModel.status == "PUBLISHED",
    ).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found or not published")

    # The tenant always comes from the job posting. A caller-supplied
    # X-Tenant-Id is ignored, and a mismatched one is rejected outright so a
    # public application can never be filed into another tenant.
    tenant_id = job.tenant_id
    claimed_tenant = request.headers.get("x-tenant-id")
    if claimed_tenant and claimed_tenant != tenant_id:
        raise HTTPException(status_code=403, detail="Tenant mismatch")

    since = datetime.now(timezone.utc) - timedelta(hours=24)
    recent_applications = (
        db.query(ApplicationModel)
        .join(CandidateModel, ApplicationModel.candidate_id == CandidateModel.id)
        .filter(
            CandidateModel.email == email,
            CandidateModel.tenant_id == tenant_id,
            ApplicationModel.created_at >= since,
        )
        .count()
    )
    if recent_applications >= MAX_APPLICATIONS_PER_EMAIL_PER_DAY:
        raise HTTPException(
            status_code=429,
            detail="Too many applications submitted from this email address. Please try again tomorrow.",
        )

    existing_candidate = db.query(CandidateModel).filter(
        CandidateModel.email == email,
        CandidateModel.tenant_id == tenant_id,
    ).first()

    if existing_candidate:
        candidate_id = existing_candidate.id
    else:
        cand_data = schemas.CandidateCreate(
            first_name=first_name,
            last_name=last_name,
            email=email,
            phone=phone,
            resume_url=resume_url,
            source="COMPANY_SITE",
        )
        candidate = crud.create_candidate(db, tenant_id, cand_data)
        candidate_id = candidate["id"]

    existing_app = db.query(ApplicationModel).filter(
        ApplicationModel.job_id == job_id,
        ApplicationModel.candidate_id == candidate_id,
    ).first()
    if existing_app:
        raise HTTPException(status_code=400, detail="You have already applied to this job")

    app_data = schemas.ApplicationCreate(
        job_id=job_id,
        candidate_id=str(candidate_id),
        cover_letter=cover_letter,
    )
    app = crud.create_application(db, tenant_id, app_data)
    if not app:
        raise HTTPException(status_code=400, detail="Failed to submit application")

    return crud.get_candidate(db, str(candidate_id), tenant_id)
