"""Work-order creation, projection, detail, and scope-filtered listing."""

from datetime import datetime, timedelta, timezone
from uuid import uuid4

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.errors import ApiError
from src.models.auth import User
from src.models.work_order import WorkOrder, WorkOrderAccessGrant, WorkOrderAssignment
from src.schemas.work_order import (
    AccessGrantOut,
    CreateWorkOrderRequest,
    SlaOut,
    UserRefOut,
    WorkOrderAssignmentOut,
    WorkOrderOut,
)
from src.services.work_order_numbering import generate_display_number

_ACTION_PERMISSIONS = {
    "edit": "work_order.edit_draft",
    "submit": "work_order.submit",
    "start_triage": "work_order.triage",
    "request_clarification": "work_order.request_clarification",
    "resubmit_clarification": "work_order.submit",
    "finalize_priority": "work_order.priority.finalize",
    "assign": "work_order.assign_engineer",
    "reassign": "work_order.reassign_engineer",
    "accept": "work_order.accept_assignment",
    "decline": "work_order.decline_assignment",
    "mark_en_route": "work_order.execute",
    "start_work": "work_order.execute",
    "wait_access": "work_order.execute",
    "wait_parts": "work_order.execute",
    "resume_work": "work_order.execute",
    "submit_result": "work_order.submit_result",
    "start_verification": "work_order.verify",
    "return_for_rework": "work_order.return_for_rework",
    "close": "work_order.close",
    "cancel": "work_order.cancel",
    "override": "work_order.override",
}

_TRANSITION_SOURCES: dict[str, set[str]] = {
    "edit": {"draft"},
    "submit": {"draft"},
    "start_triage": {"submitted"},
    "request_clarification": {"submitted", "triage"},
    "resubmit_clarification": {"needs_clarification"},
    "finalize_priority": {"triage"},
    "assign": {"triage"},
    "reassign": {
        "assigned",
        "accepted",
        "en_route",
        "in_progress",
        "waiting_access",
        "waiting_parts",
        "rework",
    },
    "accept": {"assigned"},
    "decline": {"assigned"},
    "mark_en_route": {"accepted"},
    "start_work": {"accepted", "en_route", "rework"},
    "wait_access": {"en_route", "in_progress"},
    "wait_parts": {"in_progress"},
    "resume_work": {"waiting_access", "waiting_parts"},
    "submit_result": {"in_progress"},
    "start_verification": {"completed_by_engineer"},
    "return_for_rework": {"verification"},
    "close": {"verification"},
    "cancel": {
        "draft",
        "submitted",
        "triage",
        "needs_clarification",
        "assigned",
        "accepted",
        "en_route",
        "in_progress",
        "waiting_access",
        "waiting_parts",
        "completed_by_engineer",
        "verification",
        "rework",
    },
    "override": {
        "draft",
        "submitted",
        "triage",
        "needs_clarification",
        "assigned",
        "accepted",
        "en_route",
        "in_progress",
        "waiting_access",
        "waiting_parts",
        "completed_by_engineer",
        "verification",
        "rework",
    },
}


def allowed_actions_for(
    work_order: WorkOrder,
    permissions: set[str],
    actor_id: str,
    actor_role: str,
    grant: WorkOrderAccessGrant | None = None,
    now: datetime | None = None,
) -> list[str]:
    """Return server-authoritative actions for the current state and actor."""
    now = now or datetime.now(timezone.utc)
    actions: list[str] = []
    for action, sources in _TRANSITION_SOURCES.items():
        if (
            work_order.status not in sources
            or _ACTION_PERMISSIONS[action] not in permissions
        ):
            continue
        if (
            action
            in {
                "accept",
                "decline",
                "mark_en_route",
                "start_work",
                "wait_access",
                "wait_parts",
                "resume_work",
                "submit_result",
            }
            and actor_role != "manager"
        ):
            if work_order.assigned_engineer_id != actor_id:
                continue
            if (
                grant is None
                or grant.user_id != actor_id
                or grant.status != "active"
                or grant.revoked_at is not None
                or grant.starts_at > now
                or (grant.expires_at is not None and grant.expires_at <= now)
            ):
                continue
        if action == "assign" and not work_order.sla_policy_id:
            continue
        actions.append(action)
    return actions


def _sla_for(work_order: WorkOrder, now: datetime) -> SlaOut | None:
    if not work_order.sla_policy_id:
        return None
    started = work_order.submitted_at
    acceptance_due = started + timedelta(minutes=30) if started else None
    arrival_due = started + timedelta(hours=2) if started else None
    resolution_due = work_order.due_at
    if work_order.status in {"closed", "cancelled"}:
        stage, state, remaining, breach = "completed", "completed", 0, None
    elif work_order.status in {"waiting_access", "waiting_parts"}:
        stage, state, remaining, breach = "resolution", "paused", None, None
    elif work_order.status in {"assigned"}:
        stage = "acceptance"
        remaining = (
            int((acceptance_due - now).total_seconds()) if acceptance_due else None
        )
        breach = "acceptance" if remaining is not None and remaining < 0 else None
        state = (
            "breached"
            if breach
            else (
                "at_risk" if remaining is not None and remaining < 600 else "on_track"
            )
        )
    elif work_order.status in {"accepted", "en_route"}:
        stage = "arrival"
        remaining = int((arrival_due - now).total_seconds()) if arrival_due else None
        breach = "arrival" if remaining is not None and remaining < 0 else None
        state = (
            "breached"
            if breach
            else (
                "at_risk" if remaining is not None and remaining < 1800 else "on_track"
            )
        )
    else:
        stage = "resolution"
        remaining = int((resolution_due - now).total_seconds())
        breach = "resolution" if remaining < 0 else None
        state = (
            "breached" if breach else ("at_risk" if remaining < 3600 else "on_track")
        )
    return SlaOut(
        policy_id=work_order.sla_policy_id,
        started_at=started,
        acceptance_due_at=acceptance_due,
        arrival_due_at=arrival_due,
        resolution_due_at=resolution_due,
        current_stage=stage,
        state=state,
        paused_at=work_order.updated_at if state == "paused" else None,
        pause_reason=work_order.comment if state == "paused" else None,
        breach_stage=breach,
        remaining_seconds=remaining,
        server_time=now,
    )


async def _latest_assignment(
    session: AsyncSession, work_order_id: str
) -> WorkOrderAssignment | None:
    return (
        await session.execute(
            select(WorkOrderAssignment)
            .where(WorkOrderAssignment.work_order_id == work_order_id)
            .order_by(WorkOrderAssignment.assigned_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()


async def _latest_grant(
    session: AsyncSession, work_order_id: str
) -> WorkOrderAccessGrant | None:
    return (
        await session.execute(
            select(WorkOrderAccessGrant)
            .where(WorkOrderAccessGrant.work_order_id == work_order_id)
            .order_by(WorkOrderAccessGrant.starts_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()


async def build_work_order_out(
    session: AsyncSession,
    work_order: WorkOrder,
    *,
    permissions: set[str] | None = None,
    actor_id: str = "",
    actor_role: str = "",
) -> WorkOrderOut:
    assignment = await _latest_assignment(session, work_order.id)
    grant = await _latest_grant(session, work_order.id)
    now = datetime.now(timezone.utc)
    assignment_out = None
    if assignment:
        assigner = await session.get(User, assignment.assigned_by_id)
        assignment_out = WorkOrderAssignmentOut(
            id=assignment.id,
            work_order_id=assignment.work_order_id,
            engineer_id=assignment.engineer_id,
            assigned_by=UserRefOut(
                id=assignment.assigned_by_id,
                display_name=assigner.display_name
                if assigner
                else assignment.assigned_by_id,
            ),
            assigned_at=assignment.assigned_at,
            accepted_at=assignment.accepted_at,
            declined_at=assignment.declined_at,
            decline_reason=assignment.decline_reason,
            completed_at=assignment.completed_at,
            status=assignment.status,
            version=assignment.version,
        )
    grant_out = (
        AccessGrantOut(
            id=grant.id,
            work_order_id=grant.work_order_id,
            facility_id=grant.facility_id,
            user_id=grant.user_id,
            access_level="technical_full",
            starts_at=grant.starts_at,
            expires_at=grant.expires_at,
            revoked_at=grant.revoked_at,
            status=(
                "revoked"
                if grant.revoked_at is not None or grant.status == "revoked"
                else (
                    "scheduled"
                    if grant.starts_at > now
                    else (
                        "expired"
                        if grant.expires_at is not None and grant.expires_at <= now
                        else grant.status
                    )
                )
            ),
            offline_cache_expires_at=grant.offline_cache_expires_at,
            version=grant.version,
        )
        if grant
        else None
    )
    return WorkOrderOut(
        id=work_order.id,
        display_number=work_order.display_number,
        source_risk_id=work_order.source_risk_id,
        facility_id=work_order.facility_id,
        target_entity_type=work_order.target_entity_type,
        target_entity_id=work_order.target_entity_id,
        work_type=work_order.work_type,
        priority=work_order.priority,
        due_at=work_order.due_at,
        description=work_order.description,
        symptoms=list(work_order.symptoms or []),
        comment=work_order.comment,
        status=work_order.status,
        created_by=work_order.created_by,
        created_at=work_order.created_at,
        updated_at=work_order.updated_at,
        version=work_order.version,
        assigned_engineer_id=work_order.assigned_engineer_id,
        coordinator_id=work_order.coordinator_id,
        submitted_at=work_order.submitted_at,
        closed_at=work_order.closed_at,
        sla_policy_id=work_order.sla_policy_id,
        sla=_sla_for(work_order, now),
        repair_result=work_order.repair_result,
        active_assignment=assignment_out,
        access_grant=grant_out,
        allowed_actions=(
            allowed_actions_for(
                work_order,
                permissions,
                actor_id,
                actor_role,
                grant=grant,
                now=now,
            )
            if permissions is not None
            else []
        ),
    )


async def create_work_order(
    session: AsyncSession, body: CreateWorkOrderRequest, created_by: str
) -> WorkOrder:
    now = datetime.now(timezone.utc)
    work_order = WorkOrder(
        id=f"wo_{uuid4().hex[:20]}",
        display_number=await generate_display_number(session, now=now),
        source_risk_id=body.source_risk_id,
        facility_id=body.facility_id,
        target_entity_type=body.target_entity_type,
        target_entity_id=body.target_entity_id,
        work_type=body.work_type,
        priority=body.priority,
        due_at=body.due_at,
        description=body.description,
        symptoms=list(body.symptoms),
        comment=body.comment,
        status="draft",
        created_by=created_by,
        created_at=now,
        updated_at=now,
        version=1,
    )
    session.add(work_order)
    await session.flush()
    return work_order


async def get_work_order(
    session: AsyncSession, work_order_id: str, allowed_facility_ids: set[str] | None
) -> WorkOrder:
    work_order = await session.get(WorkOrder, work_order_id)
    if work_order is None:
        raise ApiError(404, "NOT_FOUND", "Заявка не найдена")
    if (
        allowed_facility_ids is not None
        and work_order.facility_id not in allowed_facility_ids
    ):
        raise ApiError(
            403, "FACILITY_ACCESS_DENIED", "Недостаточно прав для просмотра заявки"
        )
    return work_order


async def list_work_orders(
    session: AsyncSession,
    allowed_facility_ids: set[str] | None,
    *,
    facility_id: str | None = None,
    status: str | None = None,
    work_type: str | None = None,
    assigned_engineer_id: str | None = None,
    cursor: str | None = None,
    limit: int = 50,
) -> tuple[list[WorkOrder], str | None, int]:
    if allowed_facility_ids is not None and not allowed_facility_ids:
        return [], None, 0

    stmt = select(WorkOrder)
    if allowed_facility_ids is not None:
        stmt = stmt.where(WorkOrder.facility_id.in_(allowed_facility_ids))
    if facility_id:
        stmt = stmt.where(WorkOrder.facility_id == facility_id)
    if status:
        stmt = stmt.where(WorkOrder.status == status)
    if work_type:
        stmt = stmt.where(WorkOrder.work_type == work_type)
    if assigned_engineer_id:
        stmt = stmt.where(WorkOrder.assigned_engineer_id == assigned_engineer_id)

    all_matching = (await session.execute(stmt)).scalars().all()
    all_matching = sorted(all_matching, key=lambda wo: wo.created_at, reverse=True)
    total = len(all_matching)
    start = (
        next((i + 1 for i, item in enumerate(all_matching) if item.id == cursor), 0)
        if cursor
        else 0
    )
    if cursor and start == 0:
        start = total
    page = all_matching[start : start + limit]
    next_cursor = (
        page[-1].id if len(page) == limit and (start + limit) < total else None
    )
    return page, next_cursor, total


async def count_active_engineer_orders(session: AsyncSession, engineer_id: str) -> int:
    return int(
        (
            await session.execute(
                select(func.count())
                .select_from(WorkOrder)
                .where(
                    WorkOrder.assigned_engineer_id == engineer_id,
                    WorkOrder.status.not_in(["closed", "cancelled"]),
                )
            )
        ).scalar_one()
    )
