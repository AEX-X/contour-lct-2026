"""Manual work-order lifecycle, engineer roster, and notifications."""

import hashlib
import json
from datetime import datetime, timezone
from uuid import uuid4

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import select

from src.db import async_session_factory
from src.deps.auth import require_any_permission, require_permission
from src.errors import ApiError
from src.models.auth import User
from src.models.emulation_providers import EquipmentRegistryItem
from src.models.hierarchy import Facility, HierarchyNode
from src.models.risk import Risk
from src.models.sensor import SensorChannel
from src.models.work_order import Notification, WorkOrderCreateMutation
from src.schemas.work_order import (
    CreateWorkOrderRequest,
    EngineerListEnvelope,
    EngineerListMeta,
    NotificationListEnvelope,
    NotificationListMeta,
    NotificationOut,
    WorkOrderActionRequest,
    WorkOrderActionResponse,
    WorkOrderListEnvelope,
    WorkOrderListMeta,
    WorkOrderOut,
)
from src.services.reference_data import RISK_LEVELS, WORK_TYPES
from src.services.scope import resolve_permissions, resolve_scope
from src.services.work_order_actions import (
    apply_work_order_action,
    engineer_candidates,
    replay_work_order_action,
)
from src.services.work_order_query import (
    build_work_order_out,
    create_work_order,
    get_work_order,
    list_work_orders,
)

router = APIRouter(prefix="/api/v1", tags=["work-orders"])

_VALID_WORK_TYPES = {item.id for item in WORK_TYPES}
_VALID_PRIORITIES = {item.id for item in RISK_LEVELS}
_VALID_TARGET_ENTITY_TYPES = {
    "sensor",
    "facility",
    "hierarchy_node",
    "building",
    "collector",
    "section",
    "equipment",
}


def _notification_out(item: Notification) -> NotificationOut:
    return NotificationOut(
        id=item.id,
        user_id=item.user_id,
        type=item.type,
        priority=item.priority,
        title=item.title,
        body=item.body,
        entity_type=item.entity_type,
        entity_id=item.entity_id,
        deep_link=item.deep_link,
        created_at=item.created_at,
        read_at=item.read_at,
        group_key=item.group_key,
    )


def _create_fingerprint(body: CreateWorkOrderRequest) -> str:
    payload = body.model_dump(mode="json", exclude={"idempotency_key"})
    return hashlib.sha256(
        json.dumps(payload, ensure_ascii=False, sort_keys=True).encode()
    ).hexdigest()


async def _validate_work_order_links(session, body: CreateWorkOrderRequest) -> None:
    facility = await session.get(Facility, body.facility_id)
    if facility is None:
        raise ApiError(422, "DOMAIN_VALIDATION_ERROR", "Объект заявки не найден")

    belongs_to_facility = False
    if body.target_entity_type == "facility":
        belongs_to_facility = body.target_entity_id == body.facility_id
    elif body.target_entity_type == "sensor":
        target = await session.get(SensorChannel, body.target_entity_id)
        belongs_to_facility = bool(target and target.facility_id == body.facility_id)
    elif body.target_entity_type == "equipment":
        target = await session.get(EquipmentRegistryItem, body.target_entity_id)
        belongs_to_facility = bool(target and target.facility_id == body.facility_id)
    else:
        target = (
            await session.execute(
                select(HierarchyNode)
                .where(
                    (HierarchyNode.id == body.target_entity_id)
                    | (HierarchyNode.entity_id == body.target_entity_id)
                )
                .limit(1)
            )
        ).scalar_one_or_none()
        belongs_to_facility = bool(target and target.facility_id == body.facility_id)
        if (
            belongs_to_facility
            and body.target_entity_type != "hierarchy_node"
            and target.entity_type != body.target_entity_type
        ):
            belongs_to_facility = False
    if not belongs_to_facility:
        raise ApiError(
            422,
            "DOMAIN_VALIDATION_ERROR",
            "Цель заявки не найдена на выбранном объекте",
        )

    if body.source_risk_id:
        source_risk = await session.get(Risk, body.source_risk_id)
        if source_risk is None or source_risk.facility_id != body.facility_id:
            raise ApiError(
                422,
                "DOMAIN_VALIDATION_ERROR",
                "Источник риска не принадлежит выбранному объекту",
            )


@router.post("/work-orders", response_model=WorkOrderOut, status_code=201)
async def post_work_order(
    body: CreateWorkOrderRequest,
    request: Request,
    user: User = Depends(
        require_any_permission(
            "work_order.create_draft", "work_order.create", "work_order.submit"
        )
    ),
) -> WorkOrderOut:
    request.state.audit["details"] = {"facility_id": body.facility_id}
    if body.mode != "draft":
        raise ApiError(
            422, "DOMAIN_VALIDATION_ERROR", "Создание поддерживает только mode='draft'"
        )
    if body.work_type not in _VALID_WORK_TYPES:
        raise ApiError(
            422, "DOMAIN_VALIDATION_ERROR", f"Неизвестный work_type: {body.work_type}"
        )
    if body.priority not in _VALID_PRIORITIES:
        raise ApiError(
            422, "DOMAIN_VALIDATION_ERROR", f"Неизвестный priority: {body.priority}"
        )
    if body.target_entity_type not in _VALID_TARGET_ENTITY_TYPES:
        raise ApiError(
            422,
            "DOMAIN_VALIDATION_ERROR",
            f"Неизвестный target_entity_type: {body.target_entity_type}",
        )
    if (body.idempotency_key is None) != (body.client_occurred_at is None):
        raise ApiError(
            422,
            "DOMAIN_VALIDATION_ERROR",
            "idempotency_key и client_occurred_at должны передаваться вместе",
        )

    async with async_session_factory() as session:
        create_fingerprint = _create_fingerprint(body)
        # Keep lock acquisition order deterministic for all creates:
        # actor row first, display-number advisory lock second.  If only
        # idempotent requests locked the actor, a regular create could hold the
        # number lock while waiting on that actor through a foreign key and
        # deadlock with the idempotent request waiting for the number lock.
        await session.execute(
            select(User.id).where(User.id == user.id).with_for_update()
        )
        if body.idempotency_key:
            existing = (
                await session.execute(
                    select(WorkOrderCreateMutation).where(
                        WorkOrderCreateMutation.actor_id == user.id,
                        WorkOrderCreateMutation.idempotency_key == body.idempotency_key,
                    )
                )
            ).scalar_one_or_none()
            if existing:
                if existing.fingerprint != create_fingerprint:
                    raise ApiError(
                        409,
                        "IDEMPOTENCY_KEY_REUSED",
                        "Ключ идемпотентности уже использован другим запросом",
                    )
                request.state.audit["target_type"] = "work_order"
                request.state.audit["target_id"] = existing.work_order_id
                return WorkOrderOut.model_validate(existing.response_payload)

        scope = await resolve_scope(session, user.id)
        if scope["type"] != "all_facilities" and body.facility_id not in scope.get(
            "facility_ids", []
        ):
            raise ApiError(
                403,
                "FACILITY_ACCESS_DENIED",
                "Недостаточно прав для создания заявки по этому объекту",
            )
        await _validate_work_order_links(session, body)
        work_order = await create_work_order(session, body, user.id)
        permissions = set(await resolve_permissions(session, user.id))
        result = await build_work_order_out(
            session,
            work_order,
            permissions=permissions,
            actor_id=user.id,
            actor_role=user.role,
        )
        if body.idempotency_key:
            session.add(
                WorkOrderCreateMutation(
                    id=f"create_mut_{uuid4().hex[:20]}",
                    work_order_id=work_order.id,
                    actor_id=user.id,
                    idempotency_key=body.idempotency_key,
                    fingerprint=create_fingerprint,
                    response_payload=result.model_dump(mode="json"),
                    created_at=datetime.now(timezone.utc),
                )
            )
        await session.commit()
    request.state.audit["target_type"] = "work_order"
    request.state.audit["target_id"] = work_order.id
    return result


@router.get("/work-orders", response_model=WorkOrderListEnvelope)
async def get_work_orders(
    facility_id: str | None = Query(default=None),
    status: str | None = Query(default=None),
    work_type: str | None = Query(default=None),
    assigned_to_current_user: bool = Query(default=False),
    cursor: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    user: User = Depends(require_permission("work_order.read")),
) -> WorkOrderListEnvelope:
    async with async_session_factory() as session:
        scope = await resolve_scope(session, user.id)
        allowed_ids = (
            None
            if scope["type"] == "all_facilities"
            else set(scope.get("facility_ids", []))
        )
        permissions = set(await resolve_permissions(session, user.id))
        items, next_cursor, total = await list_work_orders(
            session,
            allowed_facility_ids=allowed_ids,
            facility_id=facility_id,
            status=status,
            work_type=work_type,
            assigned_engineer_id=user.id if assigned_to_current_user else None,
            cursor=cursor,
            limit=limit,
        )
        output = [
            await build_work_order_out(
                session,
                item,
                permissions=permissions,
                actor_id=user.id,
                actor_role=user.role,
            )
            for item in items
        ]
    return WorkOrderListEnvelope(
        data=output,
        meta=WorkOrderListMeta(
            next_cursor=next_cursor,
            total=total,
            generated_at=datetime.now(timezone.utc),
        ),
    )


@router.get("/work-orders/{work_order_id}", response_model=WorkOrderOut)
async def get_work_order_detail(
    work_order_id: str,
    user: User = Depends(require_permission("work_order.read")),
) -> WorkOrderOut:
    async with async_session_factory() as session:
        scope = await resolve_scope(session, user.id)
        allowed_ids = (
            None
            if scope["type"] == "all_facilities"
            else set(scope.get("facility_ids", []))
        )
        work_order = await get_work_order(session, work_order_id, allowed_ids)
        permissions = set(await resolve_permissions(session, user.id))
        return await build_work_order_out(
            session,
            work_order,
            permissions=permissions,
            actor_id=user.id,
            actor_role=user.role,
        )


@router.post(
    "/work-orders/{work_order_id}/actions", response_model=WorkOrderActionResponse
)
async def post_work_order_action(
    work_order_id: str,
    body: WorkOrderActionRequest,
    request: Request,
    user: User = Depends(require_permission("work_order.read")),
) -> WorkOrderActionResponse:
    async with async_session_factory() as session:
        replay = await replay_work_order_action(session, work_order_id, body, user.id)
        if replay is not None:
            return replay
        scope = await resolve_scope(session, user.id)
        allowed_ids = (
            None
            if scope["type"] == "all_facilities"
            else set(scope.get("facility_ids", []))
        )
        await get_work_order(session, work_order_id, allowed_ids)
        permissions = set(await resolve_permissions(session, user.id))
        result = await apply_work_order_action(
            session,
            work_order_id,
            body,
            user,
            permissions,
            getattr(request.state, "trace_id", ""),
        )
    request.state.audit["target_type"] = "work_order"
    request.state.audit["target_id"] = work_order_id
    request.state.audit["details"] = {
        "action": body.action,
        "domain_audit_event_id": result.audit_event_id,
    }
    return result


@router.get("/engineers", response_model=EngineerListEnvelope)
async def get_engineers(
    _: User = Depends(
        require_any_permission("engineer_workload.read", "engineer_assignment.manage")
    ),
) -> EngineerListEnvelope:
    async with async_session_factory() as session:
        data = await engineer_candidates(session)
    return EngineerListEnvelope(
        data=data,
        meta=EngineerListMeta(total=len(data), generated_at=datetime.now(timezone.utc)),
    )


@router.get(
    "/work-orders/{work_order_id}/engineer-candidates",
    response_model=EngineerListEnvelope,
)
async def get_work_order_engineer_candidates(
    work_order_id: str,
    user: User = Depends(
        require_any_permission("engineer_workload.read", "engineer_assignment.manage")
    ),
) -> EngineerListEnvelope:
    async with async_session_factory() as session:
        scope = await resolve_scope(session, user.id)
        allowed_ids = (
            None
            if scope["type"] == "all_facilities"
            else set(scope.get("facility_ids", []))
        )
        work_order = await get_work_order(session, work_order_id, allowed_ids)
        data = await engineer_candidates(session, work_order)
    return EngineerListEnvelope(
        data=data,
        meta=EngineerListMeta(total=len(data), generated_at=datetime.now(timezone.utc)),
    )


@router.get("/notifications", response_model=NotificationListEnvelope)
async def get_notifications(
    user: User = Depends(require_permission("notification.read")),
) -> NotificationListEnvelope:
    async with async_session_factory() as session:
        items = (
            (
                await session.execute(
                    select(Notification)
                    .where(Notification.user_id == user.id)
                    .order_by(Notification.created_at.desc())
                )
            )
            .scalars()
            .all()
        )
    return NotificationListEnvelope(
        data=[_notification_out(item) for item in items],
        meta=NotificationListMeta(
            total=len(items),
            unread=sum(item.read_at is None for item in items),
            generated_at=datetime.now(timezone.utc),
        ),
    )


@router.post("/notifications/{notification_id}/read", response_model=NotificationOut)
async def read_notification(
    notification_id: str,
    request: Request,
    user: User = Depends(require_permission("notification.read")),
) -> NotificationOut:
    async with async_session_factory() as session:
        item = await session.get(Notification, notification_id)
        if item is None:
            raise ApiError(404, "NOT_FOUND", "Уведомление не найдено")
        if item.user_id != user.id and user.role != "manager":
            raise ApiError(
                403, "PERMISSION_DENIED", "Нельзя изменить чужое уведомление"
            )
        if item.read_at is None:
            item.read_at = datetime.now(timezone.utc)
            await session.commit()
    request.state.audit["target_type"] = "notification"
    request.state.audit["target_id"] = notification_id
    return _notification_out(item)
