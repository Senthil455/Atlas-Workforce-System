from typing import Optional
from fastapi import APIRouter, Depends, Header, HTTPException, Query
from sqlalchemy.orm import Session
from main import get_db
import crud
import schemas

router = APIRouter(tags=["referral-management"])


@router.get("/referrals", response_model=schemas.ReferralListResponse, summary="List referrals")
def list_referrals(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    status: Optional[str] = Query(None, pattern=r"^(PENDING|CONTACTED|APPLIED|INTERVIEWING|HIRED|REJECTED)$"),
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    return crud.list_referrals(db, x_tenant_id, page, page_size, status)


@router.post("/referrals", response_model=schemas.ReferralResponse, status_code=201, summary="Create referral")
def create_referral(
    data: schemas.ReferralCreate,
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    return crud.create_referral(db, x_tenant_id, data)


@router.get("/referrals/{referral_id}", response_model=schemas.ReferralResponse, summary="Get referral")
def get_referral(
    referral_id: str,
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    referral = crud.get_referral(db, referral_id, x_tenant_id)
    if not referral:
        raise HTTPException(status_code=404, detail="Referral not found")
    return referral


@router.put("/referrals/{referral_id}", response_model=schemas.ReferralResponse, summary="Update referral")
def update_referral(
    referral_id: str,
    data: schemas.ReferralUpdate,
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    referral = crud.update_referral(db, referral_id, x_tenant_id, data)
    if not referral:
        raise HTTPException(status_code=404, detail="Referral not found")
    return referral


@router.get("/referrals/stats/overview", response_model=schemas.ReferralStatsResponse, summary="Referral program stats")
def get_referral_stats(
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    return crud.get_referral_stats(db, x_tenant_id)
