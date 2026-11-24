from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from sqlalchemy.orm import Session

from main import get_db
import crud
import schemas

router = APIRouter(tags=["applications"])


@router.get("/applications", response_model=schemas.ApplicationListResponse, summary="List applications")
def list_applications(
        page: int = Query(
            1,
            ge=1),
    page_size: int = Query(
            20,
            ge=1,
            le=100),
        job_id: Optional[str] = Query(None),
        candidate_id: Optional[str] = Query(None),
        status: Optional[str] = Query(
            None,
            pattern=r"^(APPLIED|SCREENING|INTERVIEW_STAGE_1|INTERVIEW_STAGE_2|FINAL_INTERVIEW|OFFER_EXTENDED|OFFER_ACCEPTED|HIRED|REJECTED)$"),
        x_tenant_id: str = Header(
            "default",
            alias="X-Tenant-Id"),
        db: Session = Depends(get_db),
):
    return crud.list_applications(db, x_tenant_id, page, page_size, job_id, candidate_id, status)


@router.post("/applications", response_model=schemas.ApplicationResponse, status_code=201, summary="Submit application")
def create_application(
    data: schemas.ApplicationCreate,
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    app = crud.create_application(db, x_tenant_id, data)
    if not app:
        raise HTTPException(status_code=400, detail="Invalid job/candidate or duplicate application")
    return app


@router.get("/applications/{application_id}",
            response_model=schemas.ApplicationResponse,
            summary="Get application with interviews and offers")
def get_application(
    application_id: str,
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    app = crud.get_application(db, application_id, x_tenant_id)
    if not app:
        raise HTTPException(status_code=404, detail="Application not found")
    return app


@router.put("/applications/{application_id}/status",
            response_model=schemas.ApplicationResponse,
            summary="Update application status")
def update_application_status(
    application_id: str,
    data: schemas.ApplicationUpdateStatus,
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    app = crud.update_application_status(db, application_id, x_tenant_id, data.status)
    if not app:
        raise HTTPException(status_code=400, detail="Invalid status transition or application not found")
    return app


@router.get("/applications/{application_id}/timeline",
            response_model=list[schemas.ApplicationTimelineEvent],
            summary="Get application timeline")
def get_application_timeline(
    application_id: str,
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    timeline = crud.get_application_timeline(db, application_id, x_tenant_id)
    if timeline is None:
        raise HTTPException(status_code=404, detail="Application not found")
    return timeline
