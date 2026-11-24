from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from sqlalchemy.orm import Session

from main import get_db
import crud
import schemas

router = APIRouter(tags=["offers"])


@router.get("/offers", response_model=schemas.OfferListResponse, summary="List offers")
def list_offers(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    status: Optional[str] = Query(None, pattern=r"^(DRAFT|SENT|ACCEPTED|DECLINED|EXPIRED)$"),
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    return crud.list_offers(db, x_tenant_id, page, page_size, status)


@router.post("/offers", response_model=schemas.OfferResponse, status_code=201, summary="Create offer")
def create_offer(
    data: schemas.OfferCreate,
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    offer = crud.create_offer(db, x_tenant_id, data)
    if not offer:
        raise HTTPException(status_code=400, detail="Application not found")
    return offer


@router.put("/offers/{offer_id}", response_model=schemas.OfferResponse, summary="Update offer")
def update_offer(
    offer_id: str,
    data: schemas.OfferUpdate,
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    offer = crud.update_offer(db, offer_id, x_tenant_id, data)
    if not offer:
        raise HTTPException(status_code=404, detail="Offer not found")
    return offer


@router.post("/offers/{offer_id}/send", response_model=schemas.OfferResponse, summary="Send offer")
def send_offer(
    offer_id: str,
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    offer = crud.send_offer(db, offer_id, x_tenant_id)
    if not offer:
        raise HTTPException(status_code=404, detail="Offer not found")
    return offer


@router.post("/offers/{offer_id}/accept", response_model=schemas.OfferResponse, summary="Accept offer")
def accept_offer(
    offer_id: str,
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    offer = crud.accept_offer(db, offer_id, x_tenant_id)
    if not offer:
        raise HTTPException(status_code=404, detail="Offer not found")
    return offer


@router.post("/offers/{offer_id}/decline", response_model=schemas.OfferResponse, summary="Decline offer")
def decline_offer(
    offer_id: str,
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    offer = crud.decline_offer(db, offer_id, x_tenant_id)
    if not offer:
        raise HTTPException(status_code=404, detail="Offer not found")
    return offer
