"""End-to-end tests for the five-role manual work-order workflow."""

import asyncio
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from src.db import async_session_factory
from src.main import app
from src.models.work_order import FacilityDispatcherAssignment, WorkOrderAccessGrant
from src.services.demo_seed import seed_demo_users
from src.services.facility_seed import seed_facility_catalogue


async def _seed() -> None:
    async with async_session_factory() as session:
        await seed_facility_catalogue(session)
        await seed_demo_users(session)


async def _login(username: str, password: str) -> str:
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.post(
            "/api/v1/auth/login", json={"username": username, "password": password}
        )
    assert response.status_code == 200, response.text
    return response.json()["token"]


async def _request(method: str, path: str, token: str, *, json: dict | None = None):
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        return await client.request(
            method, path, headers={"Authorization": f"Bearer {token}"}, json=json
        )


async def _create(token: str, facility_id: str = "fac_5122") -> dict:
    response = await _request(
        "POST",
        "/api/v1/work-orders",
        token,
        json={
            "mode": "draft",
            "source_risk_id": None,
            "facility_id": facility_id,
            "target_entity_type": "facility",
            "target_entity_id": facility_id,
            "work_type": "repair",
            "priority": "medium",
            "due_at": (datetime.now(timezone.utc) + timedelta(days=2)).isoformat(),
            "description": "Проверить и восстановить датчик",
            "comment": None,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def _action(
    action: str,
    expected_version: int,
    payload: dict | None = None,
    *,
    key: str | None = None,
) -> dict:
    return {
        "action": action,
        "expected_version": expected_version,
        "idempotency_key": key or f"test-{uuid4()}",
        "client_occurred_at": datetime.now(timezone.utc).isoformat(),
        "payload": payload or {},
    }


@pytest.mark.asyncio
async def test_full_dispatcher_coordinator_engineer_verification_close_flow() -> None:
    await _seed()
    dispatcher = await _login("dispatcher", "dispatcher123")
    coordinator = await _login("coordinator", "coordinator123")
    engineer = await _login("engineer", "engineer123")

    order = await _create(dispatcher)
    order_id = order["id"]
    assert order["allowed_actions"] == ["edit", "submit"]

    response = await _request(
        "POST",
        f"/api/v1/work-orders/{order_id}/actions",
        dispatcher,
        json=_action("submit", 1),
    )
    assert response.status_code == 200, response.text
    assert response.json()["work_order"]["status"] == "submitted"

    response = await _request(
        "POST",
        f"/api/v1/work-orders/{order_id}/actions",
        coordinator,
        json=_action("start_triage", 2),
    )
    assert response.status_code == 200, response.text

    response = await _request(
        "POST",
        f"/api/v1/work-orders/{order_id}/actions",
        coordinator,
        json=_action(
            "finalize_priority", 3, {"priority": "P2", "slaPolicyId": "sla-p2"}
        ),
    )
    assert response.status_code == 200, response.text
    assert response.json()["work_order"]["sla"]["policy_id"] == "sla-p2"
    assert "assign" in response.json()["work_order"]["allowed_actions"]

    candidates = await _request(
        "GET", f"/api/v1/work-orders/{order_id}/engineer-candidates", coordinator
    )
    assert candidates.status_code == 200
    assert any(
        item["user"]["id"] == "usr_engineer" and item["eligible"]
        for item in candidates.json()["data"]
    )

    response = await _request(
        "POST",
        f"/api/v1/work-orders/{order_id}/actions",
        coordinator,
        json=_action("assign", 4, {"engineerId": "usr_engineer"}),
    )
    assert response.status_code == 200, response.text
    assigned = response.json()["work_order"]
    assert assigned["status"] == "assigned"
    assert assigned["active_assignment"]["engineer_id"] == "usr_engineer"
    assert assigned["access_grant"]["status"] == "active"

    async with async_session_factory() as session:
        grant = (
            await session.execute(
                select(WorkOrderAccessGrant).where(
                    WorkOrderAccessGrant.work_order_id == order_id,
                    WorkOrderAccessGrant.status == "active",
                )
            )
        ).scalar_one()
        grant.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        await session.commit()
    effective_grant = await _request(
        "GET", f"/api/v1/work-orders/{order_id}", coordinator
    )
    assert effective_grant.json()["access_grant"]["status"] == "expired"
    async with async_session_factory() as session:
        grant = (
            await session.execute(
                select(WorkOrderAccessGrant).where(
                    WorkOrderAccessGrant.work_order_id == order_id,
                    WorkOrderAccessGrant.status == "active",
                )
            )
        ).scalar_one()
        grant.expires_at = datetime.now(timezone.utc) + timedelta(days=2)
        await session.commit()

    engineer_detail = await _request("GET", f"/api/v1/work-orders/{order_id}", engineer)
    assert engineer_detail.status_code == 200
    assert "accept" in engineer_detail.json()["allowed_actions"]

    for action, version in (("accept", 5), ("mark_en_route", 6), ("start_work", 7)):
        response = await _request(
            "POST",
            f"/api/v1/work-orders/{order_id}/actions",
            engineer,
            json=_action(action, version),
        )
        assert response.status_code == 200, response.text

    incomplete = await _request(
        "POST",
        f"/api/v1/work-orders/{order_id}/actions",
        engineer,
        json=_action("submit_result", 8, {"repairResult": {}}),
    )
    assert incomplete.status_code == 422
    assert incomplete.json()["error"]["code"] == "DOMAIN_VALIDATION_ERROR"

    response = await _request(
        "POST",
        f"/api/v1/work-orders/{order_id}/actions",
        engineer,
        json=_action(
            "submit_result",
            8,
            {
                "repairResult": {
                    "failureConfirmed": True,
                    "rootCauseCode": "sensor_contact",
                    "diagnosis": "Ослаблен контакт",
                    "actions": ["Контакт восстановлен"],
                    "parts": [],
                    "laborMinutes": 25,
                    "equipmentRestored": True,
                    "controlCheckResult": "Норма",
                    "residualRisk": "low",
                    "recommendations": "Контроль через месяц",
                    "requiresFollowUp": False,
                }
            },
        ),
    )
    assert response.status_code == 200, response.text
    completed = response.json()["work_order"]
    assert completed["status"] == "completed_by_engineer"
    assert completed["repair_result"]["failure_confirmed"] is True
    assert completed["active_assignment"]["status"] == "completed"

    response = await _request(
        "POST",
        f"/api/v1/work-orders/{order_id}/actions",
        dispatcher,
        json=_action("start_verification", 9),
    )
    assert response.status_code == 200, response.text

    response = await _request(
        "POST",
        f"/api/v1/work-orders/{order_id}/actions",
        dispatcher,
        json=_action("close", 10, {"equipmentOperational": True}),
    )
    assert response.status_code == 200, response.text
    closed = response.json()["work_order"]
    assert closed["status"] == "closed"
    assert closed["closed_at"]
    assert closed["access_grant"]["status"] == "revoked"

    # The engineer's temporary facility scope disappears immediately on close.
    denied = await _request("GET", f"/api/v1/work-orders/{order_id}", engineer)
    assert denied.status_code == 403


@pytest.mark.asyncio
async def test_action_idempotency_version_conflict_rbac_and_scope() -> None:
    await _seed()
    manager = await _login("manager", "manager123")
    dispatcher = await _login("dispatcher", "dispatcher123")
    coordinator = await _login("coordinator", "coordinator123")
    order = await _create(dispatcher)
    path = f"/api/v1/work-orders/{order['id']}/actions"

    command = _action("submit", 1, key=f"stable-{uuid4()}")
    first = await _request("POST", path, dispatcher, json=command)
    replay = await _request("POST", path, dispatcher, json=command)
    assert first.status_code == replay.status_code == 200
    assert replay.json() == first.json()

    reused = {
        **command,
        "action": "edit",
        "payload": {"description": "другая операция"},
    }
    response = await _request("POST", path, dispatcher, json=reused)
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "IDEMPOTENCY_KEY_REUSED"

    stale = await _request("POST", path, coordinator, json=_action("start_triage", 1))
    assert stale.status_code == 409
    assert stale.json()["error"]["code"] == "VERSION_CONFLICT"
    assert stale.json()["error"]["details"]["current_version"] == 2

    forbidden = await _request(
        "POST", path, dispatcher, json=_action("start_triage", 2)
    )
    assert forbidden.status_code == 403
    assert forbidden.json()["error"]["code"] == "PERMISSION_DENIED"

    out_of_scope = await _create(manager, "fac_5339")
    response = await _request(
        "GET", f"/api/v1/work-orders/{out_of_scope['id']}", dispatcher
    )
    assert response.status_code == 403

    concurrent_order = await _create(dispatcher)
    concurrent_path = f"/api/v1/work-orders/{concurrent_order['id']}/actions"
    concurrent_command = _action("submit", 1, key=f"concurrent-{uuid4()}")
    concurrent_first, concurrent_retry = await asyncio.gather(
        _request("POST", concurrent_path, dispatcher, json=concurrent_command),
        _request("POST", concurrent_path, dispatcher, json=concurrent_command),
    )
    assert concurrent_first.status_code == concurrent_retry.status_code == 200
    assert concurrent_first.json() == concurrent_retry.json()

    engineer = await _login("engineer", "engineer123")
    decline_order = await _create(dispatcher)
    decline_path = f"/api/v1/work-orders/{decline_order['id']}/actions"
    for token, command in (
        (dispatcher, _action("submit", 1)),
        (coordinator, _action("start_triage", 2)),
        (
            coordinator,
            _action(
                "finalize_priority",
                3,
                {"priority": "P2", "slaPolicyId": "sla-p2"},
            ),
        ),
        (coordinator, _action("assign", 4, {"engineerId": "usr_engineer"})),
    ):
        prepared = await _request("POST", decline_path, token, json=command)
        assert prepared.status_code == 200, prepared.text
    decline_command = _action("decline", 5, {"reason": "Нужна другая специализация"})
    declined = await _request("POST", decline_path, engineer, json=decline_command)
    assert declined.status_code == 200, declined.text
    assert declined.json()["work_order"]["status"] == "triage"
    replay_after_scope_revoked = await _request(
        "POST", decline_path, engineer, json=decline_command
    )
    assert replay_after_scope_revoked.status_code == 200
    assert replay_after_scope_revoked.json() == declined.json()


@pytest.mark.asyncio
async def test_five_demo_role_codes_and_notification_read() -> None:
    await _seed()
    credentials = {
        "manager": ("manager", "manager123"),
        "senior_dispatcher": ("senior_dispatcher", "senior123"),
        "facility_dispatcher": ("dispatcher", "dispatcher123"),
        "maintenance_coordinator": ("coordinator", "coordinator123"),
        "engineer": ("engineer", "engineer123"),
    }
    for expected_role, (username, password) in credentials.items():
        token = await _login(username, password)
        me = await _request("GET", "/api/v1/me", token)
        assert me.status_code == 200
        assert me.json()["role"] == expected_role
        assert me.json()["user_id"]
        if expected_role == "engineer":
            assert "risk.read" in me.json()["permissions"]

    dispatcher = await _login("dispatcher", "dispatcher123")
    coordinator = await _login("coordinator", "coordinator123")
    order = await _create(dispatcher)
    await _request(
        "POST",
        f"/api/v1/work-orders/{order['id']}/actions",
        dispatcher,
        json=_action("submit", 1),
    )
    notifications = await _request("GET", "/api/v1/notifications", coordinator)
    assert notifications.status_code == 200
    item = next(
        entry
        for entry in notifications.json()["data"]
        if entry["entity_id"] == order["id"]
    )
    read = await _request(
        "POST", f"/api/v1/notifications/{item['id']}/read", coordinator
    )
    assert read.status_code == 200
    assert read.json()["read_at"] is not None


@pytest.mark.asyncio
async def test_senior_dispatcher_assigns_single_facility_idempotently() -> None:
    await _seed()
    senior = await _login("senior_dispatcher", "senior123")
    dispatcher = await _login("dispatcher", "dispatcher123")
    facility = await _request("GET", "/api/v1/facilities/fac_5339", senior)
    assert facility.status_code == 200
    key = f"facility-{uuid4()}"
    command = {
        "dispatcher_id": "usr_dispatcher",
        "starts_at": datetime.now(timezone.utc).isoformat(),
        "ends_at": (datetime.now(timezone.utc) + timedelta(days=30)).isoformat(),
        "expected_version": facility.json()["version"],
        "idempotency_key": key,
        "client_occurred_at": datetime.now(timezone.utc).isoformat(),
    }
    path = "/api/v1/facilities/fac_5339/dispatcher-assignment"
    first = await _request("POST", path, senior, json=command)
    replay = await _request("POST", path, senior, json=command)
    assert first.status_code == replay.status_code == 200
    assert first.json() == replay.json()

    moved_scope = await _request("GET", "/api/v1/me", dispatcher)
    assert moved_scope.json()["scope"]["facility_ids"] == ["fac_5339"]

    # Startup demo seeding must not overwrite a real dispatcher assignment.
    async with async_session_factory() as session:
        await seed_demo_users(session)
    scope_after_restart_seed = await _request("GET", "/api/v1/me", dispatcher)
    assert scope_after_restart_seed.json()["scope"]["facility_ids"] == ["fac_5339"]

    # Moving the same dispatcher keeps exactly one active facility and does not
    # change the historical response of the first idempotency key.
    second_facility = await _request("GET", "/api/v1/facilities/fac_5122", senior)
    second_command = {
        **command,
        "expected_version": second_facility.json()["version"],
        "idempotency_key": f"facility-{uuid4()}",
    }
    moved = await _request(
        "POST",
        "/api/v1/facilities/fac_5122/dispatcher-assignment",
        senior,
        json=second_command,
    )
    assert moved.status_code == 200, moved.text
    moved_scope = await _request("GET", "/api/v1/me", dispatcher)
    assert moved_scope.json()["scope"]["facility_ids"] == ["fac_5122"]

    former_facility = await _request("GET", "/api/v1/facilities/fac_5339", senior)
    assert former_facility.json()["responsible_dispatcher_id"] is None

    historical_replay = await _request("POST", path, senior, json=command)
    assert historical_replay.status_code == 200
    assert historical_replay.json() == first.json()

    async with async_session_factory() as session:
        active_assignment = (
            await session.execute(
                select(FacilityDispatcherAssignment).where(
                    FacilityDispatcherAssignment.dispatcher_id == "usr_dispatcher",
                    FacilityDispatcherAssignment.status == "active",
                )
            )
        ).scalar_one()
        active_assignment.ends_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        await session.commit()
    expired_scope = await _request("GET", "/api/v1/me", dispatcher)
    assert expired_scope.json()["scope"]["facility_ids"] == []
    expired_facility = await _request("GET", "/api/v1/facilities/fac_5122", senior)
    assert expired_facility.json()["responsible_dispatcher_id"] is None
    async with async_session_factory() as session:
        active_assignment = (
            await session.execute(
                select(FacilityDispatcherAssignment).where(
                    FacilityDispatcherAssignment.dispatcher_id == "usr_dispatcher",
                    FacilityDispatcherAssignment.status == "active",
                )
            )
        ).scalar_one()
        active_assignment.ends_at = datetime.now(timezone.utc) + timedelta(days=30)
        await session.commit()
