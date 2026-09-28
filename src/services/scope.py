"""Resolve a user's scope (all_facilities, or assigned + district-expanded)."""

from datetime import datetime, timezone

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.models.auth import (
    DistrictFacility,
    User,
    UserPermission,
    UserScope,
    UserScopeDistrict,
    UserScopeFacility,
)
from src.models.work_order import FacilityDispatcherAssignment, WorkOrderAccessGrant


async def resolve_scope(session: AsyncSession, user_id: str) -> dict:
    """Resolve a user's scope to the API contract shape.

    Args:
        session: An active async database session.
        user_id: The id of the user to resolve scope for.

    Returns:
        {"type": "all_facilities"} or
        {"type": "assigned_facilities", "facility_ids": [...]} where the
        facility_ids are the union of directly-assigned facilities and
        every facility belonging to an assigned district, deduplicated.
    """
    user_scope = (
        await session.execute(select(UserScope).where(UserScope.user_id == user_id))
    ).scalar_one_or_none()

    # Missing scope configuration must never widen access implicitly. Demo and
    # production users are expected to have an explicit UserScope row; a
    # partially-provisioned identity therefore receives an empty scope.
    if user_scope is None:
        return {"type": "assigned_facilities", "facility_ids": []}

    if user_scope.scope_type == "all_facilities":
        return {"type": "all_facilities"}

    if user_scope.scope_type == "work_order_grants":
        now = datetime.now(timezone.utc)
        grant_ids = (
            (
                await session.execute(
                    select(WorkOrderAccessGrant.facility_id).where(
                        WorkOrderAccessGrant.user_id == user_id,
                        WorkOrderAccessGrant.status == "active",
                        WorkOrderAccessGrant.revoked_at.is_(None),
                        WorkOrderAccessGrant.starts_at <= now,
                        or_(
                            WorkOrderAccessGrant.expires_at.is_(None),
                            WorkOrderAccessGrant.expires_at > now,
                        ),
                    )
                )
            )
            .scalars()
            .all()
        )
        return {"type": "work_order_grants", "facility_ids": sorted(set(grant_ids))}

    role = await session.scalar(select(User.role).where(User.id == user_id))
    if role == "facility_dispatcher":
        has_assignment_history = await session.scalar(
            select(FacilityDispatcherAssignment.id)
            .where(FacilityDispatcherAssignment.dispatcher_id == user_id)
            .limit(1)
        )
        if has_assignment_history is not None:
            now = datetime.now(timezone.utc)
            facility_ids = (
                (
                    await session.execute(
                        select(FacilityDispatcherAssignment.facility_id).where(
                            FacilityDispatcherAssignment.dispatcher_id == user_id,
                            FacilityDispatcherAssignment.status == "active",
                            FacilityDispatcherAssignment.starts_at <= now,
                            FacilityDispatcherAssignment.ends_at > now,
                        )
                    )
                )
                .scalars()
                .all()
            )
            return {
                "type": "assigned_facilities",
                "facility_ids": sorted(set(facility_ids)),
            }

    direct_ids = (
        (
            await session.execute(
                select(UserScopeFacility.facility_id).where(
                    UserScopeFacility.user_id == user_id
                )
            )
        )
        .scalars()
        .all()
    )

    district_ids = (
        (
            await session.execute(
                select(UserScopeDistrict.district_id).where(
                    UserScopeDistrict.user_id == user_id
                )
            )
        )
        .scalars()
        .all()
    )

    expanded_ids: list[str] = []
    if district_ids:
        expanded_ids = (
            (
                await session.execute(
                    select(DistrictFacility.facility_id).where(
                        DistrictFacility.district_id.in_(district_ids)
                    )
                )
            )
            .scalars()
            .all()
        )

    facility_ids = sorted(set(direct_ids) | set(expanded_ids))
    return {"type": "assigned_facilities", "facility_ids": facility_ids}


async def resolve_permissions(session: AsyncSession, user_id: str) -> list[str]:
    """Resolve the sorted list of permission strings granted to a user.

    Args:
        session: An active async database session.
        user_id: The id of the user to resolve permissions for.

    Returns:
        A sorted list of permission strings.
    """
    permissions = (
        (
            await session.execute(
                select(UserPermission.permission).where(
                    UserPermission.user_id == user_id
                )
            )
        )
        .scalars()
        .all()
    )
    return sorted(permissions)
