from typing import Optional
from fastapi import APIRouter, Depends, Header, HTTPException, Query
from sqlalchemy.orm import Session
from main import get_db
import crud
import schemas

router = APIRouter(tags=["campus-recruitment"])


@router.get("/campus/drives", response_model=schemas.CampusDriveListResponse, summary="List campus drives")
def list_drives(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    status: Optional[str] = Query(None, pattern=r"^(PLANNED|UPCOMING|IN_PROGRESS|COMPLETED|CANCELLED)$"),
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    return crud.list_campus_drives(db, x_tenant_id, page, page_size, status)


@router.post("/campus/drives", response_model=schemas.CampusDriveResponse,
             status_code=201, summary="Create campus drive")
def create_drive(
    data: schemas.CampusDriveCreate,
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    return crud.create_campus_drive(db, x_tenant_id, data)


@router.get("/campus/drives/{drive_id}", response_model=schemas.CampusDriveResponse, summary="Get campus drive")
def get_drive(
    drive_id: str,
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    drive = crud.get_campus_drive(db, drive_id, x_tenant_id)
    if not drive:
        raise HTTPException(status_code=404, detail="Campus drive not found")
    return drive


@router.put("/campus/drives/{drive_id}", response_model=schemas.CampusDriveResponse, summary="Update campus drive")
def update_drive(
    drive_id: str,
    data: schemas.CampusDriveUpdate,
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    drive = crud.update_campus_drive(db, drive_id, x_tenant_id, data)
    if not drive:
        raise HTTPException(status_code=404, detail="Campus drive not found")
    return drive


@router.delete("/campus/drives/{drive_id}", summary="Delete campus drive")
def delete_drive(
    drive_id: str,
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    if not crud.delete_campus_drive(db, drive_id, x_tenant_id):
        raise HTTPException(status_code=404, detail="Campus drive not found")
    return {"message": "Campus drive deleted successfully"}


@router.get("/campus/registrations", response_model=schemas.CampusRegistrationListResponse, summary="List campus registrations")
def list_registrations(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    drive_id: Optional[str] = Query(None),
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    return crud.list_campus_registrations(db, x_tenant_id, page, page_size, drive_id)


@router.post("/campus/registrations", response_model=schemas.CampusRegistrationResponse,
             status_code=201, summary="Register for campus drive")
def create_registration(
    data: schemas.CampusRegistrationCreate,
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    reg = crud.create_campus_registration(db, x_tenant_id, data)
    if not reg:
        raise HTTPException(status_code=400, detail="Invalid campus drive or registration failed")
    return reg


@router.put("/campus/registrations/{reg_id}",
            response_model=schemas.CampusRegistrationResponse,
            summary="Update registration status")
def update_registration(
    reg_id: str,
    data: schemas.CampusRegistrationUpdate,
    x_tenant_id: str = Header("default", alias="X-Tenant-Id"),
    db: Session = Depends(get_db),
):
    reg = crud.update_campus_registration(db, reg_id, x_tenant_id, data)
    if not reg:
        raise HTTPException(status_code=404, detail="Registration not found")
    return reg
