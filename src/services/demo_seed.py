"""Idempotent five-role demo identity and RBAC seed."""

from dataclasses import dataclass

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.models.auth import User, UserPermission, UserScope, UserScopeFacility
from src.models.work_order import FacilityDispatcherAssignment
from src.services.auth_service import hash_password
from src.services.permissions import PERMISSIONS


@dataclass(frozen=True)
class _DemoUser:
    id: str
    username: str
    password: str
    display_name: str
    role: str
    organization_id: str
    permissions: frozenset[str]
    scope_type: str
    facility_ids: tuple[str, ...] = ()
    specialization_codes: tuple[str, ...] = ()
    availability: str = "available"


_FACILITY_DISPATCHER = frozenset(
    {
        "facility.read.assigned",
        "facility.technical_context.read",
        "sensor.read",
        "risk.read",
        "risk.acknowledge",
        "work_order.read",
        "work_order.create_draft",
        "work_order.create",
        "work_order.edit_draft",
        "work_order.submit",
        "work_order.priority.propose",
        "work_order.verify",
        "work_order.return_for_rework",
        "work_order.close",
        "notification.read",
        "analytics.facility.read",
        "report.export",
    }
)

_SENIOR_DISPATCHER = _FACILITY_DISPATCHER | frozenset(
    {
        "facility.dispatcher.assign",
        "work_order.cancel",
        "engineer_workload.read",
        "analytics.read.summary",
        "analytics.read.technical",
    }
)

_COORDINATOR = frozenset(
    {
        "facility.read.all",
        "facility.technical_context.read",
        "sensor.read",
        "risk.read",
        "work_order.read",
        "work_order.triage",
        "work_order.request_clarification",
        "work_order.priority.finalize",
        "work_order.sla.finalize",
        "work_order.assign_engineer",
        "work_order.reassign_engineer",
        "work_order.cancel",
        "engineer_workload.read",
        "engineer_assignment.manage",
        "notification.read",
        "audit.read",
    }
)

_ENGINEER = frozenset(
    {
        "facility.read.temporary",
        "facility.technical_context.read",
        "sensor.read",
        "risk.read",
        "work_order.read",
        "work_order.accept_assignment",
        "work_order.decline_assignment",
        "work_order.execute",
        "work_order.submit_result",
        "work_order.costs.write",
        "offline_package.download",
        "offline_mutation.sync",
        "notification.read",
    }
)

DEMO_USERS: tuple[_DemoUser, ...] = (
    _DemoUser(
        "usr_manager",
        "manager",
        "manager123",
        "Руководитель (демо)",
        "manager",
        "org_moscollector",
        PERMISSIONS,
        "all_facilities",
    ),
    _DemoUser(
        "usr_senior_dispatcher",
        "senior_dispatcher",
        "senior123",
        "Старший диспетчер (демо)",
        "senior_dispatcher",
        "org_moscollector",
        _SENIOR_DISPATCHER,
        "assigned_facilities",
        ("fac_5122", "fac_5339"),
    ),
    # Legacy login is retained so existing local demos continue to work.
    _DemoUser(
        "usr_dispatcher",
        "dispatcher",
        "dispatcher123",
        "Диспетчер объекта (демо)",
        "facility_dispatcher",
        "org_moscollector",
        _FACILITY_DISPATCHER,
        "assigned_facilities",
        ("fac_5122",),
    ),
    _DemoUser(
        "usr_coordinator",
        "coordinator",
        "coordinator123",
        "Координатор ремонтов (демо)",
        "maintenance_coordinator",
        "org_maintenance",
        _COORDINATOR,
        "all_facilities",
    ),
    _DemoUser(
        "usr_engineer",
        "engineer",
        "engineer123",
        "Инженер выездной бригады (демо)",
        "engineer",
        "org_maintenance",
        _ENGINEER,
        "work_order_grants",
        (),
        ("inspection", "repair", "replacement", "maintenance"),
    ),
)


async def seed_demo_users(session: AsyncSession) -> None:
    """Create or repair all five demo identities, permissions, and scopes."""
    for spec in DEMO_USERS:
        user = await session.get(User, spec.id)
        if user is None:
            user = User(
                id=spec.id,
                username=spec.username,
                password_hash=hash_password(spec.password),
                display_name=spec.display_name,
                role=spec.role,
            )
            session.add(user)
        user.username = spec.username
        user.display_name = spec.display_name
        user.role = spec.role
        user.organization_id = spec.organization_id
        user.specialization_codes = list(spec.specialization_codes)
        user.availability = spec.availability

        granted = set(
            (
                await session.execute(
                    select(UserPermission.permission).where(
                        UserPermission.user_id == spec.id
                    )
                )
            )
            .scalars()
            .all()
        )
        for permission in spec.permissions - granted:
            session.add(UserPermission(user_id=spec.id, permission=permission))
        stale_permissions = granted - spec.permissions
        if stale_permissions:
            await session.execute(
                delete(UserPermission).where(
                    UserPermission.user_id == spec.id,
                    UserPermission.permission.in_(stale_permissions),
                )
            )

        scope = await session.get(UserScope, spec.id)
        if scope is None:
            session.add(UserScope(user_id=spec.id, scope_type=spec.scope_type))
        else:
            scope.scope_type = spec.scope_type

        dynamic_assignment_exists = False
        if spec.role == "facility_dispatcher":
            dynamic_assignment_exists = (
                await session.scalar(
                    select(FacilityDispatcherAssignment.id)
                    .where(FacilityDispatcherAssignment.dispatcher_id == spec.id)
                    .limit(1)
                )
                is not None
            )
        if not dynamic_assignment_exists:
            await session.execute(
                delete(UserScopeFacility).where(UserScopeFacility.user_id == spec.id)
            )
            for facility_id in spec.facility_ids:
                session.add(UserScopeFacility(user_id=spec.id, facility_id=facility_id))

    await session.commit()
