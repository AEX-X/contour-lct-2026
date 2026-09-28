"""Facility reads and dispatcher assignment management."""

import hashlib
import json
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import delete, or_, select

from src.db import async_session_factory
from src.deps.auth import require_any_permission, require_permission
from src.errors import ApiError
from src.models.audit import AuditLogEntry
from src.models.auth import User, UserScope, UserScopeFacility
from src.models.hierarchy import Facility
from src.models.work_order import FacilityDispatcherAssignment
from src.schemas.facility import FacilityListEnvelope, FacilityListMeta, FacilityOut
from src.schemas.work_order import (
    AssignFacilityDispatcherRequest,
    AssignFacilityDispatcherResponse,
    FacilityDispatcherAssignmentOut,
    FacilityDispatcherList,
    FacilityDispatcherOut,
    UserRefOut,
)
from src.services.facility_query import get_facility_detail, list_facilities
from src.services.scope import resolve_scope

router = APIRouter(prefix="/api/v1", tags=["facilities"])


@router.get("/facilities", response_model=FacilityListEnvelope)
async def get_facilities(
    query: str | None = Query(default=None),
    current_state: str | None = Query(default=None),
    risk_level: str | None = Query(default=None),
    district: str | None = Query(default=None),
    bbox: str | None = Query(default=None),
    cursor: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    user: User = Depends(
        require_any_permission(
            "facility.read.all", "facility.read.assigned", "facility.read.temporary"
        )
    ),
) -> FacilityListEnvelope:
    """List facilities within the caller's scope.

    Args:
        query: Optional case-insensitive substring match on display_name.
        current_state: Accepted for contract completeness (see facility_query).
        risk_level: Accepted for contract completeness (see facility_query).
        district: Optional district_id filter.
        bbox: Optional "min_lon,min_lat,max_lon,max_lat" filter.
        cursor: Opaque pagination cursor.
        limit: Page size, 1-200.
        user: The authenticated caller, injected by get_current_user.

    Returns:
        A FacilityListEnvelope containing only facilities the caller may see.
    """
    async with async_session_factory() as session:
        scope = await resolve_scope(session, user.id)
        allowed_ids = (
            None if scope["type"] == "all_facilities" else set(scope["facility_ids"])
        )

        items, next_cursor, total = await list_facilities(
            session,
            allowed_facility_ids=allowed_ids,
            query=query,
            current_state=current_state,
            risk_level=risk_level,
            district=district,
            bbox=bbox,
            cursor=cursor,
            limit=limit,
        )

    return FacilityListEnvelope(
        data=items,
        meta=FacilityListMeta(
            next_cursor=next_cursor,
            total=total,
            generated_at=datetime.now(timezone.utc),
        ),
    )


@router.get("/facilities/{facility_id}", response_model=FacilityOut)
async def get_facility(
    facility_id: str,
    user: User = Depends(
        require_any_permission(
            "facility.read.all", "facility.read.assigned", "facility.read.temporary"
        )
    ),
) -> FacilityOut:
    """Fetch one facility's detail, enforcing the caller's scope.

    Args:
        facility_id: The requested facility id.
        user: The authenticated caller, injected by get_current_user.

    Returns:
        The facility's full detail (same shape as a list item).

    Raises:
        ApiError: 403 if the facility exists but is out of scope; 404 if
            it does not exist.
    """
    async with async_session_factory() as session:
        scope = await resolve_scope(session, user.id)
        allowed_ids = (
            None if scope["type"] == "all_facilities" else set(scope["facility_ids"])
        )
        return await get_facility_detail(session, facility_id, allowed_ids)


@router.get("/facility-dispatchers", response_model=FacilityDispatcherList)
async def get_facility_dispatchers(
    _: User = Depends(require_permission("facility.dispatcher.assign")),
) -> FacilityDispatcherList:
    async with async_session_factory() as session:
        users = (
            (
                await session.execute(
                    select(User)
                    .where(User.role == "facility_dispatcher", User.is_active.is_(True))
                    .order_by(User.display_name)
                )
            )
            .scalars()
            .all()
        )
    return FacilityDispatcherList(
        data=[
            FacilityDispatcherOut(id=user.id, display_name=user.display_name)
            for user in users
        ]
    )


@router.post(
    "/facilities/{facility_id}/dispatcher-assignment",
    response_model=AssignFacilityDispatcherResponse,
)
async def assign_facility_dispatcher(
    facility_id: str,
    body: AssignFacilityDispatcherRequest,
    request: Request,
    user: User = Depends(require_permission("facility.dispatcher.assign")),
) -> AssignFacilityDispatcherResponse:
    """Assign exactly one facility to a technical dispatcher."""
    fingerprint = hashlib.sha256(
        json.dumps(
            {
                "facility_id": facility_id,
                **body.model_dump(mode="json"),
            },
            sort_keys=True,
        ).encode()
    ).hexdigest()
    async with async_session_factory() as session:
        # One actor lock makes idempotency reliable under concurrent retries,
        # including requests that target different facilities.
        await session.execute(
            select(User.id).where(User.id == user.id).with_for_update()
        )
        existing = (
            await session.execute(
                select(FacilityDispatcherAssignment).where(
                    FacilityDispatcherAssignment.assigned_by_id == user.id,
                    FacilityDispatcherAssignment.idempotency_key
                    == body.idempotency_key,
                )
            )
        ).scalar_one_or_none()
        if existing:
            if existing.fingerprint != fingerprint:
                raise ApiError(
                    409,
                    "IDEMPOTENCY_KEY_REUSED",
                    "Ключ идемпотентности уже использован",
                )
            return AssignFacilityDispatcherResponse.model_validate(
                existing.response_payload
            )

        scope = await resolve_scope(session, user.id)
        if scope["type"] != "all_facilities" and facility_id not in scope.get(
            "facility_ids", []
        ):
            raise ApiError(
                403,
                "FACILITY_ACCESS_DENIED",
                "Недостаточно прав для назначения на этот объект",
            )
        now = datetime.now(timezone.utc)
        if body.ends_at <= body.starts_at:
            raise ApiError(
                422, "DOMAIN_VALIDATION_ERROR", "ends_at должен быть позже starts_at"
            )
        if body.starts_at > now + timedelta(minutes=5) or body.ends_at <= now:
            raise ApiError(
                422,
                "DOMAIN_VALIDATION_ERROR",
                "Назначение должно быть активно сейчас; отложенные назначения не поддерживаются",
            )

        # A dispatcher may be assigned to only one facility. Lock the
        # dispatcher before the facility so concurrent moves of that dispatcher
        # are serialized even when they target different facilities.
        dispatcher = (
            await session.execute(
                select(User)
                .where(User.id == body.dispatcher_id)
                .with_for_update()
                .execution_options(populate_existing=True)
            )
        ).scalar_one_or_none()
        if (
            dispatcher is None
            or dispatcher.role != "facility_dispatcher"
            or not dispatcher.is_active
        ):
            raise ApiError(
                422, "DOMAIN_VALIDATION_ERROR", "Активный диспетчер объекта не найден"
            )

        facility = (
            await session.execute(
                select(Facility)
                .where(Facility.id == facility_id)
                .with_for_update()
                .execution_options(populate_existing=True)
            )
        ).scalar_one_or_none()
        if facility is None:
            raise ApiError(404, "NOT_FOUND", "Объект не найден")

        # Defensive replay check after the aggregate lock. The actor lock above
        # normally makes this redundant, but keeping it here preserves exact
        # replay semantics if locking is refactored later.
        existing = (
            await session.execute(
                select(FacilityDispatcherAssignment).where(
                    FacilityDispatcherAssignment.assigned_by_id == user.id,
                    FacilityDispatcherAssignment.idempotency_key
                    == body.idempotency_key,
                )
            )
        ).scalar_one_or_none()
        if existing:
            if existing.fingerprint != fingerprint:
                raise ApiError(
                    409,
                    "IDEMPOTENCY_KEY_REUSED",
                    "Ключ идемпотентности уже использован",
                )
            return AssignFacilityDispatcherResponse.model_validate(
                existing.response_payload
            )
        if facility.version != body.expected_version:
            raise ApiError(
                409,
                "VERSION_CONFLICT",
                "Объект уже изменён",
                details={"current_version": facility.version},
            )

        previous = (
            (
                await session.execute(
                    select(FacilityDispatcherAssignment)
                    .where(
                        FacilityDispatcherAssignment.status == "active",
                        or_(
                            FacilityDispatcherAssignment.facility_id == facility_id,
                            FacilityDispatcherAssignment.dispatcher_id == dispatcher.id,
                        ),
                    )
                    .with_for_update()
                )
            )
            .scalars()
            .all()
        )
        for assignment in previous:
            assignment.status = "superseded"
            assignment.version += 1
            if assignment.dispatcher_id != dispatcher.id:
                await session.execute(
                    delete(UserScopeFacility).where(
                        UserScopeFacility.user_id == assignment.dispatcher_id,
                        UserScopeFacility.facility_id == facility_id,
                    )
                )
            if assignment.facility_id != facility_id:
                former_facility = (
                    await session.execute(
                        select(Facility)
                        .where(Facility.id == assignment.facility_id)
                        .with_for_update()
                        .execution_options(populate_existing=True)
                    )
                ).scalar_one_or_none()
                if (
                    former_facility
                    and former_facility.responsible_dispatcher_id == dispatcher.id
                ):
                    former_facility.responsible_dispatcher_id = None
                    former_facility.version += 1

        # A technical dispatcher is assigned to exactly one facility.
        await session.execute(
            delete(UserScopeFacility).where(UserScopeFacility.user_id == dispatcher.id)
        )
        session.add(UserScopeFacility(user_id=dispatcher.id, facility_id=facility_id))
        dispatcher_scope = await session.get(UserScope, dispatcher.id)
        if dispatcher_scope is None:
            session.add(
                UserScope(user_id=dispatcher.id, scope_type="assigned_facilities")
            )
        else:
            dispatcher_scope.scope_type = "assigned_facilities"

        facility.responsible_dispatcher_id = dispatcher.id
        facility.version += 1
        audit = AuditLogEntry(
            occurred_at=now,
            user_id=user.id,
            username=user.username,
            action="facility.dispatcher.assign",
            target_type="facility",
            target_id=facility.id,
            result="success",
            status_code=200,
            ip=None,
            trace_id=getattr(request.state, "trace_id", ""),
            details={
                "dispatcher_id": dispatcher.id,
                "facility_version": facility.version,
            },
        )
        session.add(audit)
        await session.flush()
        assignment = FacilityDispatcherAssignment(
            id=f"fda_{uuid4().hex[:20]}",
            facility_id=facility.id,
            dispatcher_id=dispatcher.id,
            assigned_by_id=user.id,
            starts_at=body.starts_at,
            ends_at=body.ends_at,
            status="active",
            version=1,
            facility_version=facility.version,
            idempotency_key=body.idempotency_key,
            fingerprint=fingerprint,
            audit_event_id=str(audit.id),
            response_payload={},
        )
        session.add(assignment)
        response = AssignFacilityDispatcherResponse(
            assignment=FacilityDispatcherAssignmentOut(
                id=assignment.id,
                facility_id=assignment.facility_id,
                dispatcher_id=assignment.dispatcher_id,
                assigned_by=UserRefOut(id=user.id, display_name=user.display_name),
                starts_at=assignment.starts_at,
                ends_at=assignment.ends_at,
                status=assignment.status,
                version=assignment.version,
            ),
            facility_id=facility.id,
            facility_version=facility.version,
            audit_event_id=str(audit.id),
        )
        assignment.response_payload = response.model_dump(mode="json")
        await session.commit()

    request.state.audit["target_type"] = "facility"
    request.state.audit["target_id"] = facility_id
    return response
