from typing import Optional
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from sqlalchemy.orm import Session

from main import get_db, logger
from models import Application as ApplicationModel, InterviewSlot as InterviewSlotModel
import crud
import schemas

router = APIRouter(tags=["interviews"])


@router.get("/interviews", response_model=schemas.InterviewListResponse, summary="List interviews")
def list_interviews(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    interviewer_id: Optional[str] = Query(None),
    date_from: Optional[datetime] = Query(None),
    date_to: Optional[datetime] = Query(None),
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    return crud.list_interviews(db, x_tenant_id, page, page_size, interviewer_id, date_from, date_to)


@router.post("/interviews", response_model=schemas.InterviewResponse, status_code=201, summary="Schedule interview")
def create_interview(
    data: schemas.InterviewCreate,
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    if data.interviewer_id and crud.check_interview_overlap(db, data.interviewer_id, data.scheduled_at, data.duration_minutes):
        logger.warning("interview.overlap_rejected", extra={"interviewer_id": data.interviewer_id, "scheduled_at": data.scheduled_at.isoformat() if data.scheduled_at else None})
        raise HTTPException(status_code=409, detail="Interviewer already has an interview scheduled at this time")
    interview = crud.create_interview(db, x_tenant_id, data)
    if not interview:
        raise HTTPException(status_code=400, detail="Application not found")
    return interview


@router.put("/interviews/{interview_id}", response_model=schemas.InterviewResponse, summary="Update interview")
def update_interview(
    interview_id: str,
    data: schemas.InterviewUpdate,
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    interview = crud.update_interview(db, interview_id, x_tenant_id, data)
    if interview is None:
        raise HTTPException(status_code=404, detail="Interview not found or time slot conflict")
    return interview


@router.put("/interviews/{interview_id}/feedback",
            response_model=schemas.InterviewResponse,
            summary="Submit interview feedback")
def submit_interview_feedback(
    interview_id: str,
    data: schemas.InterviewFeedback,
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    interview = crud.submit_interview_feedback(db, interview_id, x_tenant_id, data)
    if not interview:
        raise HTTPException(status_code=404, detail="Interview not found")
    return interview


@router.put("/interviews/{interview_id}/status",
            response_model=schemas.InterviewResponse,
            summary="Update interview status")
def update_interview_status(
    interview_id: str,
    data: schemas.InterviewStatusUpdate,
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    interview = crud.update_interview_status(db, interview_id, x_tenant_id, data.status)
    if not interview:
        raise HTTPException(status_code=404, detail="Interview not found")
    return interview


# --- Interview slots (candidate self-scheduling, issue #502) ---

@router.get("/interview-slots", response_model=schemas.InterviewSlotListResponse,
            summary="List interview slots")
def list_interview_slots(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    application_id: Optional[str] = Query(None),
    status: Optional[str] = Query(None, pattern=r"^(OPEN|CONFIRMED)$"),
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    q = db.query(InterviewSlotModel).filter(InterviewSlotModel.tenant_id == x_tenant_id)
    if application_id:
        q = q.filter(InterviewSlotModel.application_id == application_id)
    if status:
        q = q.filter(InterviewSlotModel.status == status)
    q = q.order_by(InterviewSlotModel.scheduled_at.asc())
    total = q.count()
    items = crud.apply_pagination(q, page, page_size).all()
    return crud.paginated_response([crud.serialize_uuid(s) for s in items], total, page, page_size)


@router.post("/interview-slots", response_model=schemas.InterviewSlotResponse, status_code=201,
             summary="Publish an interview slot")
def publish_interview_slot(
    data: schemas.InterviewSlotCreate,
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    application = (
        db.query(ApplicationModel)
        .filter(
            ApplicationModel.id == data.application_id,
            ApplicationModel.tenant_id == x_tenant_id,
        )
        .first()
    )
    if not application:
        raise HTTPException(status_code=404, detail="Application not found")

    scheduled_at = data.scheduled_at
    if scheduled_at.tzinfo is None:
        scheduled_at = scheduled_at.replace(tzinfo=timezone.utc)
    if scheduled_at <= datetime.now(timezone.utc):
        raise HTTPException(status_code=400, detail="Slot time must be in the future")
    if data.interviewer_id and crud.check_interview_overlap(db, data.interviewer_id, scheduled_at, data.duration_minutes):
        raise HTTPException(status_code=409, detail="Interviewer already has an interview scheduled at this time")

    slot = InterviewSlotModel(
        id=uuid.uuid4(),
        tenant_id=x_tenant_id,
        application_id=application.id,
        interview_type=data.interview_type,
        interviewer_id=data.interviewer_id,
        scheduled_at=scheduled_at,
        duration_minutes=data.duration_minutes,
        location=data.location,
        meeting_link=data.meeting_link,
        status="OPEN",
    )
    db.add(slot)
    db.commit()
    db.refresh(slot)
    return crud.serialize_uuid(slot)


@router.post("/interview-slots/{slot_id}/remind", response_model=schemas.InterviewSlotResponse,
             summary="Record a reminder sent for a confirmed slot")
def remind_interview_slot(
    slot_id: str,
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    slot = (
        db.query(InterviewSlotModel)
        .filter(
            InterviewSlotModel.id == slot_id,
            InterviewSlotModel.tenant_id == x_tenant_id,
        )
        .first()
    )
    if not slot:
        raise HTTPException(status_code=404, detail="Slot not found")
    if slot.status != "CONFIRMED":
        raise HTTPException(status_code=400, detail="Only confirmed slots can trigger a reminder")
    if slot.scheduled_at and slot.scheduled_at <= datetime.now(timezone.utc):
        raise HTTPException(status_code=400, detail="Slot time has already passed")

    slot.reminded_at = datetime.now(timezone.utc)
    slot.updated_at = slot.reminded_at
    db.commit()
    return crud.serialize_uuid(slot)
