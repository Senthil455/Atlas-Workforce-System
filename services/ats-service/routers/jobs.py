from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from sqlalchemy.orm import Session

from main import get_db
import crud
import schemas

router = APIRouter(tags=["jobs"])


@router.get("/jobs", response_model=schemas.JobListResponse, summary="List jobs")
def list_jobs(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    status: Optional[str] = Query(None, pattern=r"^(DRAFT|PUBLISHED|CLOSED|FILLED)$"),
    department: Optional[str] = Query(None),
    employment_type: Optional[str] = Query(None, pattern=r"^(FULL_TIME|PART_TIME|CONTRACT|INTERNSHIP)$"),
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    return crud.list_jobs(db, x_tenant_id, page, page_size, status, department, employment_type)


@router.post("/jobs", response_model=schemas.JobResponse, status_code=201, summary="Create job")
def create_job(
    data: schemas.JobCreate,
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    return crud.create_job(db, x_tenant_id, data)


@router.get("/jobs/{job_id}", response_model=schemas.JobResponse, summary="Get job details")
def get_job(
    job_id: str,
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    job = crud.get_job(db, job_id, x_tenant_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@router.put("/jobs/{job_id}", response_model=schemas.JobResponse, summary="Update job")
def update_job(
    job_id: str,
    data: schemas.JobUpdate,
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    job = crud.update_job(db, job_id, x_tenant_id, data)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@router.delete("/jobs/{job_id}", summary="Delete job")
def delete_job(
    job_id: str,
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    if not crud.delete_job(db, job_id, x_tenant_id):
        raise HTTPException(status_code=404, detail="Job not found")
    return {"message": "Job deleted successfully"}


@router.post("/jobs/{job_id}/publish", response_model=schemas.JobResponse, summary="Publish job")
def publish_job(
    job_id: str,
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    job = crud.publish_job(db, job_id, x_tenant_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@router.post("/jobs/{job_id}/close", response_model=schemas.JobResponse, summary="Close job")
def close_job(
    job_id: str,
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    job = crud.close_job(db, job_id, x_tenant_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@router.get("/jobs/{job_id}/applications",
            response_model=schemas.ApplicationListResponse,
            summary="Get applications for a job")
def get_job_applications(
    job_id: str,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    return crud.get_job_applications(db, job_id, x_tenant_id, page, page_size)
