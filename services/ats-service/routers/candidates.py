from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from sqlalchemy.orm import Session

from main import get_db
import crud
import schemas

router = APIRouter(tags=["candidates"])


@router.get("/candidates", response_model=schemas.CandidateListResponse, summary="List candidates")
def list_candidates(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    status: Optional[str] = Query(None, pattern=r"^(NEW|SCREENING|INTERVIEWING|OFFER|HIRED|REJECTED|WITHDRAWN)$"),
    skills: Optional[str] = Query(None, description="Comma-separated skills"),
    source: Optional[str] = Query(None, pattern=r"^(LINKEDIN|INDEED|REFERRAL|COMPANY_SITE|RECRUITER|OTHER)$"),
    search: Optional[str] = Query(None, description="Search by name, email, company, position"),
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    skill_list = skills.split(",") if skills else None
    return crud.list_candidates(db, x_tenant_id, page, page_size, status, skill_list, source, search)


@router.post("/candidates", response_model=schemas.CandidateResponse, status_code=201, summary="Create candidate")
def create_candidate(
    data: schemas.CandidateCreate,
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    return crud.create_candidate(db, x_tenant_id, data)


@router.get("/candidates/{candidate_id}",
            response_model=schemas.CandidateWithApplications,
            summary="Get candidate with application history")
def get_candidate(
    candidate_id: str,
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    candidate = crud.get_candidate(db, candidate_id, x_tenant_id)
    if not candidate:
        raise HTTPException(status_code=404, detail="Candidate not found")
    return candidate


@router.put("/candidates/{candidate_id}", response_model=schemas.CandidateResponse, summary="Update candidate")
def update_candidate(
    candidate_id: str,
    data: schemas.CandidateUpdate,
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    candidate = crud.update_candidate(db, candidate_id, x_tenant_id, data)
    if not candidate:
        raise HTTPException(status_code=404, detail="Candidate not found")
    return candidate


@router.delete("/candidates/{candidate_id}", summary="Delete candidate (soft delete)")
def delete_candidate(
    candidate_id: str,
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    if not crud.delete_candidate(db, candidate_id, x_tenant_id):
        raise HTTPException(status_code=404, detail="Candidate not found")
    return {"message": "Candidate withdrawn successfully"}


@router.get("/candidates/{candidate_id}/applications",
            response_model=schemas.ApplicationListResponse,
            summary="Get applications by candidate")
def get_candidate_applications(
    candidate_id: str,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    return crud.get_candidate_applications(db, candidate_id, x_tenant_id, page, page_size)


@router.post("/candidates/{candidate_id}/skills",
             response_model=schemas.CandidateResponse,
             summary="Add skills to candidate")
def add_candidate_skills(
    candidate_id: str,
    data: schemas.AddSkillsRequest,
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    candidate = crud.add_candidate_skills(db, candidate_id, x_tenant_id, data.skills)
    if not candidate:
        raise HTTPException(status_code=404, detail="Candidate not found")
    return candidate
