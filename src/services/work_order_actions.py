"""Transactional, permissioned, idempotent manual work-order actions."""

import hashlib
import json
import re
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import uuid4

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.errors import ApiError
from src.models.audit import AuditLogEntry
from src.models.auth import User
from src.models.work_order import (
    Notification,
    WorkOrder,
    WorkOrderAccessGrant,
    WorkOrderActionMutation,
    WorkOrderAssignment,
)
from src.schemas.work_order import (
    RepairResultInput,
    WorkOrderActionRequest,
    WorkOrderActionResponse,
)
from src.services.work_order_query import (
    allowed_actions_for,
    build_work_order_out,
    count_active_engineer_orders,
)

_ACTION_PERMISSION = {
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

_SOURCES: dict[str, set[str]] = {
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

_TARGET_STATUS = {
    "submit": "submitted",
    "start_triage": "triage",
    "request_clarification": "needs_clarification",
    "resubmit_clarification": "submitted",
    "assign": "assigned",
    "reassign": "assigned",
    "accept": "accepted",
    "decline": "triage",
    "mark_en_route": "en_route",
    "start_work": "in_progress",
    "wait_access": "waiting_access",
    "wait_parts": "waiting_parts",
    "resume_work": "in_progress",
    "submit_result": "completed_by_engineer",
    "start_verification": "verification",
    "return_for_rework": "rework",
    "close": "closed",
    "cancel": "cancelled",
}


def _snake(value: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", value).lower()


def _snake_data(value: Any) -> Any:
    if isinstance(value, dict):
        return {_snake(str(key)): _snake_data(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_snake_data(item) for item in value]
    return value


def _fingerprint(work_order_id: str, body: WorkOrderActionRequest) -> str:
    canonical = {
        "work_order_id": work_order_id,
        "action": body.action,
        "expected_version": body.expected_version,
        "client_occurred_at": body.client_occurred_at.isoformat(),
        "payload": body.payload,
    }
    return hashlib.sha256(
        json.dumps(canonical, ensure_ascii=False, sort_keys=True).encode()
    ).hexdigest()


def _required(payload: dict[str, Any], snake_name: str) -> Any:
    normalized = _snake_data(payload)
    value = normalized.get(snake_name)
    if value is None or value == "" or value == []:
        raise ApiError(
            422,
            "DOMAIN_VALIDATION_ERROR",
            f"Для действия обязательно поле payload.{snake_name}",
            details={"field": snake_name},
        )
    return value


async def replay_work_order_action(
    session: AsyncSession,
    work_order_id: str,
    body: WorkOrderActionRequest,
    actor_id: str,
) -> WorkOrderActionResponse | None:
    """Return an immutable prior response before scope checks on a retry.

    A successful action can revoke the actor's temporary scope (decline,
    cancel, close). The same actor and idempotency key must still be able to
    recover a lost response without re-authorizing the already-applied action.
    """
    existing = (
        await session.execute(
            select(WorkOrderActionMutation).where(
                WorkOrderActionMutation.actor_id == actor_id,
                WorkOrderActionMutation.idempotency_key == body.idempotency_key,
            )
        )
    ).scalar_one_or_none()
    if existing is None:
        return None
    if existing.fingerprint != _fingerprint(work_order_id, body):
        raise ApiError(
            409,
            "IDEMPOTENCY_KEY_REUSED",
            "Ключ идемпотентности уже использован другим запросом",
        )
    return WorkOrderActionResponse.model_validate(existing.response_payload)


async def _current_assignment(
    session: AsyncSession, work_order_id: str
) -> WorkOrderAssignment | None:
    return (
        await session.execute(
            select(WorkOrderAssignment)
            .where(
                WorkOrderAssignment.work_order_id == work_order_id,
                WorkOrderAssignment.status.in_(["assigned", "accepted"]),
            )
            .order_by(WorkOrderAssignment.assigned_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()


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


async def _current_grant(
    session: AsyncSession, work_order_id: str
) -> WorkOrderAccessGrant | None:
    return (
        await session.execute(
            select(WorkOrderAccessGrant)
            .where(
                WorkOrderAccessGrant.work_order_id == work_order_id,
                WorkOrderAccessGrant.status == "active",
            )
            .order_by(WorkOrderAccessGrant.starts_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()


async def _revoke_current_assignment(
    session: AsyncSession, work_order_id: str, now: datetime
) -> None:
    assignment = await _current_assignment(session, work_order_id)
    if assignment:
        assignment.status = "superseded"
        assignment.version += 1
    grant = await _current_grant(session, work_order_id)
    if grant:
        grant.status = "revoked"
        grant.revoked_at = now
        grant.version += 1


async def _notify(
    session: AsyncSession,
    user_id: str,
    work_order: WorkOrder,
    *,
    event_type: str,
    title: str,
    body: str,
    priority: str = "info",
) -> None:
    session.add(
        Notification(
            id=f"ntf_{uuid4().hex[:20]}",
            user_id=user_id,
            type=event_type,
            priority=priority,
            title=title,
            body=body,
            entity_type="work_order",
            entity_id=work_order.id,
            deep_link=f"/work-orders/{work_order.id}",
            group_key=f"work_order:{work_order.id}",
            created_at=datetime.now(timezone.utc),
        )
    )


async def _notify_role(
    session: AsyncSession, role: str, work_order: WorkOrder, **kwargs: Any
) -> None:
    users = (
        (
            await session.execute(
                select(User).where(User.role == role, User.is_active.is_(True))
            )
        )
        .scalars()
        .all()
    )
    for user in users:
        await _notify(session, user.id, work_order, **kwargs)


async def _assign(
    session: AsyncSession,
    work_order: WorkOrder,
    actor: User,
    engineer_id: str,
    now: datetime,
    *,
    reassign: bool,
) -> None:
    engineer = await session.get(User, engineer_id)
    if engineer is None or engineer.role != "engineer" or not engineer.is_active:
        raise ApiError(422, "NO_SUITABLE_ENGINEER", "Инженер не найден или недоступен")
    specializations = set(engineer.specialization_codes or [])
    if specializations and work_order.work_type not in specializations:
        raise ApiError(
            422,
            "NO_SUITABLE_ENGINEER",
            "Специализация инженера не соответствует типу работ",
            details={"work_type": work_order.work_type},
        )
    if engineer.availability == "off_shift":
        raise ApiError(422, "NO_SUITABLE_ENGINEER", "Инженер сейчас не на смене")
    if reassign:
        await _revoke_current_assignment(session, work_order.id, now)
    work_order.assigned_engineer_id = engineer.id
    work_order.coordinator_id = actor.id
    session.add(
        WorkOrderAssignment(
            id=f"asg_{uuid4().hex[:20]}",
            work_order_id=work_order.id,
            engineer_id=engineer.id,
            assigned_by_id=actor.id,
            assigned_at=now,
            status="assigned",
            version=1,
        )
    )
    if work_order.facility_id is None:
        raise ApiError(
            422, "DOMAIN_VALIDATION_ERROR", "Нельзя выдать доступ к заявке без объекта"
        )
    session.add(
        WorkOrderAccessGrant(
            id=f"grant_{uuid4().hex[:20]}",
            work_order_id=work_order.id,
            facility_id=work_order.facility_id,
            user_id=engineer.id,
            starts_at=now,
            expires_at=work_order.due_at + timedelta(hours=24),
            offline_cache_expires_at=work_order.due_at + timedelta(hours=26),
            status="active",
            version=1,
        )
    )
    await _notify(
        session,
        engineer.id,
        work_order,
        event_type="work_order_assigned",
        title="Назначена новая заявка",
        body=f"Тебе назначена заявка {work_order.display_number}",
        priority="warning",
    )


async def apply_work_order_action(
    session: AsyncSession,
    work_order_id: str,
    body: WorkOrderActionRequest,
    actor: User,
    permissions: set[str],
    trace_id: str,
) -> WorkOrderActionResponse:
    """Apply one action atomically, with optimistic locking and idempotency."""
    fingerprint = _fingerprint(work_order_id, body)

    # Serialize keys per actor. This closes the race where two concurrent
    # retries both miss the idempotency record before either inserts it.
    await session.execute(select(User.id).where(User.id == actor.id).with_for_update())
    existing = (
        await session.execute(
            select(WorkOrderActionMutation).where(
                WorkOrderActionMutation.actor_id == actor.id,
                WorkOrderActionMutation.idempotency_key == body.idempotency_key,
            )
        )
    ).scalar_one_or_none()
    if existing:
        if existing.fingerprint != fingerprint:
            raise ApiError(
                409,
                "IDEMPOTENCY_KEY_REUSED",
                "Ключ идемпотентности уже использован другим запросом",
            )
        return WorkOrderActionResponse.model_validate(existing.response_payload)

    work_order = (
        await session.execute(
            select(WorkOrder)
            .where(WorkOrder.id == work_order_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    ).scalar_one_or_none()
    if work_order is None:
        raise ApiError(404, "NOT_FOUND", "Заявка не найдена")

    # Keep the replay check next to the locked aggregate too. It protects the
    # contract even if actor-level serialization changes in the future.
    existing = (
        await session.execute(
            select(WorkOrderActionMutation).where(
                WorkOrderActionMutation.actor_id == actor.id,
                WorkOrderActionMutation.idempotency_key == body.idempotency_key,
            )
        )
    ).scalar_one_or_none()
    if existing:
        if existing.fingerprint != fingerprint:
            raise ApiError(
                409,
                "IDEMPOTENCY_KEY_REUSED",
                "Ключ идемпотентности уже использован другим запросом",
            )
        return WorkOrderActionResponse.model_validate(existing.response_payload)

    if work_order.version != body.expected_version:
        raise ApiError(
            409,
            "VERSION_CONFLICT",
            "Заявка уже изменена другим пользователем",
            details={"current_version": work_order.version},
        )
    required_permission = _ACTION_PERMISSION[body.action]
    if required_permission not in permissions:
        raise ApiError(
            403, "PERMISSION_DENIED", f"Недостаточно прав: {required_permission}"
        )
    if work_order.status not in _SOURCES[body.action]:
        raise ApiError(
            409,
            "INVALID_TRANSITION",
            "Действие недоступно в текущем статусе",
            details={
                "current_status": work_order.status,
                "action": body.action,
                "allowed_actions": allowed_actions_for(
                    work_order, permissions, actor.id, actor.role
                ),
            },
        )
    if body.action == "assign" and not work_order.sla_policy_id:
        raise ApiError(
            409,
            "INVALID_TRANSITION",
            "Перед назначением инженера необходимо зафиксировать приоритет и SLA",
            details={"current_status": work_order.status, "action": body.action},
        )
    engineer_actions = {
        "accept",
        "decline",
        "mark_en_route",
        "start_work",
        "wait_access",
        "wait_parts",
        "resume_work",
        "submit_result",
    }
    if body.action in engineer_actions and actor.role != "manager":
        if work_order.assigned_engineer_id != actor.id:
            raise ApiError(
                409, "ASSIGNMENT_CHANGED", "Заявка назначена другому инженеру"
            )
        grant = await _current_grant(session, work_order.id)
        now_check = datetime.now(timezone.utc)
        if (
            not grant
            or grant.user_id != actor.id
            or grant.status != "active"
            or grant.revoked_at
            or grant.starts_at > now_check
            or (grant.expires_at is not None and grant.expires_at <= now_check)
        ):
            raise ApiError(403, "ACCESS_EXPIRED", "Временный доступ к объекту истёк")

    now = datetime.now(timezone.utc)
    payload = _snake_data(body.payload)
    before_version = work_order.version

    if body.action == "edit":
        if "description" in payload:
            work_order.description = str(payload["description"])
        if "symptoms" in payload:
            symptoms = payload["symptoms"]
            if not isinstance(symptoms, list) or not all(
                isinstance(item, str) for item in symptoms
            ):
                raise ApiError(
                    422,
                    "DOMAIN_VALIDATION_ERROR",
                    "payload.symptoms должен быть массивом строк",
                )
            work_order.symptoms = [item.strip() for item in symptoms if item.strip()]
        if "comment" in payload:
            work_order.comment = (
                str(payload["comment"]) if payload["comment"] is not None else None
            )
        if "category_code" in payload:
            work_order.work_type = str(payload["category_code"])
        if payload.get("preliminary_priority"):
            work_order.priority = _priority_to_api(str(payload["preliminary_priority"]))
    elif body.action == "submit":
        work_order.submitted_at = now
        await _notify_role(
            session,
            "maintenance_coordinator",
            work_order,
            event_type="work_order_submitted",
            title="Новая заявка на триаж",
            body=f"Заявка {work_order.display_number} ожидает триажа",
            priority="warning",
        )
    elif body.action == "start_triage":
        work_order.coordinator_id = actor.id
    elif body.action == "request_clarification":
        work_order.comment = str(_required(payload, "reason"))
        await _notify(
            session,
            work_order.created_by,
            work_order,
            event_type="clarification_requested",
            title="Нужно уточнение по заявке",
            body=work_order.comment,
            priority="warning",
        )
    elif body.action == "resubmit_clarification":
        work_order.comment = str(_required(payload, "comment"))
    elif body.action == "finalize_priority":
        priority = str(_required(payload, "priority"))
        work_order.priority = _priority_to_api(priority)
        if work_order.priority not in {"critical", "high", "medium", "low"}:
            raise ApiError(
                422, "DOMAIN_VALIDATION_ERROR", "priority должен быть P1, P2, P3 или P4"
            )
        work_order.sla_policy_id = str(_required(payload, "sla_policy_id"))
        due_hours = {"critical": 4, "high": 8, "medium": 24, "low": 72}[
            work_order.priority
        ]
        work_order.due_at = now + timedelta(hours=due_hours)
        work_order.coordinator_id = actor.id
    elif body.action in {"assign", "reassign"}:
        await _assign(
            session,
            work_order,
            actor,
            str(_required(payload, "engineer_id")),
            now,
            reassign=body.action == "reassign",
        )
    elif body.action == "accept":
        assignment = await _current_assignment(session, work_order.id)
        if not assignment or assignment.engineer_id != work_order.assigned_engineer_id:
            raise ApiError(409, "ASSIGNMENT_CHANGED", "Назначение уже изменено")
        assignment.status = "accepted"
        assignment.accepted_at = now
        assignment.version += 1
    elif body.action == "decline":
        assignment = await _current_assignment(session, work_order.id)
        if not assignment:
            raise ApiError(409, "ASSIGNMENT_CHANGED", "Назначение уже изменено")
        assignment.status = "declined"
        assignment.declined_at = now
        assignment.decline_reason = str(_required(payload, "reason"))
        assignment.version += 1
        grant = await _current_grant(session, work_order.id)
        if grant:
            grant.status = "revoked"
            grant.revoked_at = now
            grant.version += 1
        work_order.assigned_engineer_id = None
        if work_order.coordinator_id:
            await _notify(
                session,
                work_order.coordinator_id,
                work_order,
                event_type="assignment_declined",
                title="Инженер отказался от заявки",
                body=assignment.decline_reason,
                priority="warning",
            )
    elif body.action in {"wait_access", "wait_parts"}:
        work_order.comment = str(_required(payload, "reason"))
    elif body.action == "submit_result":
        result = _required(payload, "repair_result")
        if not isinstance(result, dict):
            raise ApiError(
                422,
                "DOMAIN_VALIDATION_ERROR",
                "payload.repair_result должен быть объектом",
            )
        try:
            validated_result = RepairResultInput.model_validate(_snake_data(result))
        except ValidationError as exc:
            raise ApiError(
                422,
                "DOMAIN_VALIDATION_ERROR",
                "payload.repair_result не соответствует контракту",
                details={
                    "errors": [
                        {
                            "loc": list(error["loc"]),
                            "msg": error["msg"],
                            "type": error["type"],
                        }
                        for error in exc.errors()
                    ]
                },
            ) from exc
        result = validated_result.model_dump(mode="json")
        result["completed_at"] = now.isoformat()
        result["author"] = {"id": actor.id, "display_name": actor.display_name}
        work_order.repair_result = result
        assignment = await _current_assignment(session, work_order.id)
        if assignment:
            assignment.status = "completed"
            assignment.completed_at = now
            assignment.version += 1
        await _notify(
            session,
            work_order.created_by,
            work_order,
            event_type="repair_result_submitted",
            title="Ремонт ожидает проверки",
            body=f"Инженер завершил заявку {work_order.display_number}",
            priority="warning",
        )
    elif body.action == "return_for_rework":
        work_order.comment = str(_required(payload, "reason"))
        expected_changes = _required(payload, "expected_changes")
        if not isinstance(expected_changes, list):
            raise ApiError(
                422,
                "DOMAIN_VALIDATION_ERROR",
                "payload.expected_changes должен быть массивом",
            )
        assignment = await _latest_assignment(session, work_order.id)
        if assignment and assignment.engineer_id == work_order.assigned_engineer_id:
            assignment.status = "accepted"
            assignment.completed_at = None
            assignment.version += 1
        if work_order.assigned_engineer_id:
            await _notify(
                session,
                work_order.assigned_engineer_id,
                work_order,
                event_type="work_order_rework",
                title="Заявка возвращена на доработку",
                body=work_order.comment,
                priority="warning",
            )
    elif body.action == "close":
        if payload.get("equipment_operational") is not True:
            raise ApiError(
                422,
                "DOMAIN_VALIDATION_ERROR",
                "Закрыть можно только после подтверждения исправности",
            )
        work_order.closed_at = now
        await _revoke_current_assignment(session, work_order.id, now)
    elif body.action == "cancel":
        work_order.comment = str(_required(payload, "reason"))
        work_order.closed_at = now
        await _revoke_current_assignment(session, work_order.id, now)
    elif body.action == "override":
        work_order.comment = (
            f"{_required(payload, 'reason')}: {_required(payload, 'note')}"
        )

    if body.action in _TARGET_STATUS:
        work_order.status = _TARGET_STATUS[body.action]
    work_order.version += 1
    work_order.updated_at = now

    audit = AuditLogEntry(
        occurred_at=now,
        user_id=actor.id,
        username=actor.username,
        action=f"work_order.{body.action}",
        target_type="work_order",
        target_id=work_order.id,
        result="success",
        status_code=200,
        ip=None,
        trace_id=trace_id,
        details={
            "before_version": before_version,
            "after_version": work_order.version,
            "client_occurred_at": body.client_occurred_at.isoformat(),
            "payload": payload,
        },
    )
    session.add(audit)
    await session.flush()

    output = await build_work_order_out(
        session,
        work_order,
        permissions=permissions,
        actor_id=actor.id,
        actor_role=actor.role,
    )
    response = WorkOrderActionResponse(
        work_order=output,
        applied_action=body.action,
        audit_event_id=str(audit.id),
    )
    session.add(
        WorkOrderActionMutation(
            id=f"mut_{uuid4().hex[:20]}",
            work_order_id=work_order.id,
            actor_id=actor.id,
            idempotency_key=body.idempotency_key,
            fingerprint=fingerprint,
            action=body.action,
            response_payload=response.model_dump(mode="json"),
            audit_event_id=str(audit.id),
            created_at=now,
        )
    )
    await session.commit()
    return response


def _priority_to_api(priority: str) -> str:
    normalized = priority.upper()
    return {"P1": "critical", "P2": "high", "P3": "medium", "P4": "low"}.get(
        normalized, priority.lower()
    )


async def engineer_candidates(
    session: AsyncSession, work_order: WorkOrder | None = None
) -> list[dict[str, Any]]:
    engineers = (
        (
            await session.execute(
                select(User)
                .where(User.role == "engineer", User.is_active.is_(True))
                .order_by(User.display_name)
            )
        )
        .scalars()
        .all()
    )
    result: list[dict[str, Any]] = []
    for engineer in engineers:
        specializations = set(engineer.specialization_codes or [])
        eligible = engineer.availability != "off_shift" and (
            work_order is None
            or not specializations
            or work_order.work_type in specializations
        )
        if engineer.availability == "off_shift":
            reason = "Инженер не на смене"
        elif (
            work_order
            and specializations
            and work_order.work_type not in specializations
        ):
            reason = "Не подходит специализация"
        else:
            reason = "Подходит для назначения"
        result.append(
            {
                "user": {
                    "id": engineer.id,
                    "display_name": engineer.display_name,
                    "availability": engineer.availability,
                    "specialization_codes": list(engineer.specialization_codes or []),
                },
                "active_work_order_count": await count_active_engineer_orders(
                    session, engineer.id
                ),
                "eligible": eligible,
                "eligibility_reason": reason,
            }
        )
    return result
