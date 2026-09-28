"""Tests for POST /api/v1/work-orders (leaf 1.2.1)."""

import asyncio
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
from httpx import ASGITransport, AsyncClient

from src.db import async_session_factory
from src.main import app
from src.models.auth import User, UserPermission, UserScope
from src.models.risk import Risk
from src.services.auth_service import hash_password
from src.services.demo_seed import seed_demo_users
from src.services.facility_seed import seed_facility_catalogue


async def _seed_all() -> None:
    async with async_session_factory() as session:
        await seed_facility_catalogue(session)
        await seed_demo_users(session)


async def _seed_custom_user(user_id: str, permissions: list[str]) -> None:
    async with async_session_factory() as session:
        if await session.get(User, user_id) is not None:
            return
        session.add(
            User(
                id=user_id,
                username=user_id,
                password_hash=hash_password("password123"),
                display_name=user_id,
                role="test",
            )
        )
        for permission in permissions:
            session.add(UserPermission(user_id=user_id, permission=permission))
        session.add(UserScope(user_id=user_id, scope_type="all_facilities"))
        await session.commit()


async def _login(username: str, password: str) -> str:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/api/v1/auth/login", json={"username": username, "password": password}
        )
    assert response.status_code == 200
    return response.json()["token"]


def _valid_body(**overrides) -> dict:
    body = {
        "mode": "draft",
        "source_risk_id": None,
        "facility_id": "fac_5122",
        "target_entity_type": "facility",
        "target_entity_id": "fac_5122",
        "work_type": "inspection",
        "priority": "medium",
        "due_at": datetime(2051, 1, 1, tzinfo=timezone.utc).isoformat(),
        "description": "test description",
        "comment": None,
    }
    body.update(overrides)
    return body


async def _create(token: str, body: dict):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.post(
            "/api/v1/work-orders",
            headers={"Authorization": f"Bearer {token}"},
            json=body,
        )


@pytest.mark.asyncio
async def test_valid_draft_creates_work_order_with_number_and_audit_metadata() -> None:
    await _seed_all()
    token = await _login("manager", "manager123")
    response = await _create(token, _valid_body())
    assert response.status_code == 201
    body = response.json()
    assert body["status"] == "draft"
    assert body["display_number"].startswith("ЗН-")
    assert body["created_by"]
    assert body["created_at"]
    assert body["version"] == 1


@pytest.mark.asyncio
async def test_create_is_exactly_idempotent_when_mutation_meta_is_sent() -> None:
    await _seed_all()
    token = await _login("manager", "manager123")
    request_body = _valid_body(
        idempotency_key=f"create-{uuid4()}",
        client_occurred_at=datetime.now(timezone.utc).isoformat(),
    )
    first = await _create(token, request_body)
    replay = await _create(token, request_body)
    assert first.status_code == replay.status_code == 201
    assert replay.json() == first.json()

    reused = await _create(
        token,
        {**request_body, "description": "Другой черновик с тем же ключом"},
    )
    assert reused.status_code == 409
    assert reused.json()["error"]["code"] == "IDEMPOTENCY_KEY_REUSED"


@pytest.mark.asyncio
async def test_concurrent_create_is_unique_and_idempotent() -> None:
    """Concurrent API writes get unique numbers while an exact retry replays."""
    await _seed_all()
    manager = await _login("manager", "manager123")
    senior = await _login("senior_dispatcher", "senior123")
    dispatcher = await _login("dispatcher", "dispatcher123")
    tokens = (manager, senior, dispatcher)

    # Three actors reproduce the original production race.  The lower-level
    # numbering test separately exercises twenty independent transactions.
    regular_requests = [
        _create(
            tokens[index % len(tokens)],
            _valid_body(description=f"concurrent request {index}"),
        )
        for index in range(3)
    ]
    idempotency_key = f"concurrent-create-{uuid4()}"
    idempotent_body = _valid_body(
        description="concurrent exact retry",
        idempotency_key=idempotency_key,
        client_occurred_at=datetime.now(timezone.utc).isoformat(),
    )
    responses = await asyncio.gather(
        *regular_requests,
        _create(manager, idempotent_body),
        _create(manager, idempotent_body),
    )

    assert all(response.status_code == 201 for response in responses), [
        response.text for response in responses if response.status_code != 201
    ]
    regular_payloads = [response.json() for response in responses[:3]]
    assert len({item["id"] for item in regular_payloads}) == 3
    assert len({item["display_number"] for item in regular_payloads}) == 3
    assert responses[3].json() == responses[4].json()
    assert responses[3].json()["display_number"] not in {
        item["display_number"] for item in regular_payloads
    }


@pytest.mark.asyncio
async def test_mode_other_than_draft_is_422() -> None:
    await _seed_all()
    token = await _login("manager", "manager123")
    response = await _create(token, _valid_body(mode="submitted"))
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_unknown_work_type_is_422() -> None:
    await _seed_all()
    token = await _login("manager", "manager123")
    response = await _create(token, _valid_body(work_type="not_a_real_work_type"))
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_unknown_priority_is_422() -> None:
    await _seed_all()
    token = await _login("manager", "manager123")
    response = await _create(token, _valid_body(priority="not_a_real_priority"))
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_unknown_target_entity_type_is_422() -> None:
    await _seed_all()
    token = await _login("manager", "manager123")
    response = await _create(token, _valid_body(target_entity_type="not_a_real_type"))
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_target_must_exist_inside_selected_facility() -> None:
    await _seed_all()
    token = await _login("manager", "manager123")
    response = await _create(
        token,
        _valid_body(target_entity_type="facility", target_entity_id="fac_5339"),
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "DOMAIN_VALIDATION_ERROR"


@pytest.mark.asyncio
async def test_source_risk_must_belong_to_selected_facility() -> None:
    await _seed_all()
    now = datetime.now(timezone.utc)
    risk_id = f"risk_other_facility_for_order_{uuid4().hex}"
    async with async_session_factory() as session:
        session.add(
            Risk(
                id=risk_id,
                forecast_id=f"forecast_other_facility_for_order_{uuid4().hex}",
                risk_type="fire",
                target_type="facility",
                target_id="fac_5339",
                facility_id="fac_5339",
                as_of=now,
                lead_min_hours=1.0,
                horizon_hours=4.0,
                prediction_window_start=now + timedelta(hours=1),
                prediction_window_end=now + timedelta(hours=4),
                probability=0.8,
                threshold=0.6,
                risk_level="high",
                priority_score=80,
                decision_status="open",
                sla_due_at=now + timedelta(hours=2),
                data_health="fresh",
                model="test",
                top_factors=[],
                recommendation="Проверить",
                version=1,
                created_at=now,
                updated_at=now,
            )
        )
        await session.commit()

    token = await _login("manager", "manager123")
    response = await _create(
        token, _valid_body(source_risk_id=risk_id)
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "DOMAIN_VALIDATION_ERROR"


@pytest.mark.asyncio
async def test_out_of_scope_facility_is_403() -> None:
    await _seed_all()
    token = await _login("dispatcher", "dispatcher123")
    response = await _create(
        token, _valid_body(facility_id="fac_20")
    )  # not assigned to dispatcher
    assert response.status_code == 403


@pytest.mark.asyncio
async def test_caller_with_only_submit_permission_can_still_create() -> None:
    await _seed_all()
    await _seed_custom_user("usr_wo_submit_only", ["work_order.submit"])
    token = await _login("usr_wo_submit_only", "password123")
    response = await _create(token, _valid_body())
    assert response.status_code == 201


@pytest.mark.asyncio
async def test_caller_with_neither_permission_gets_403() -> None:
    await _seed_all()
    await _seed_custom_user("usr_wo_no_permission", ["facility.read.all"])
    token = await _login("usr_wo_no_permission", "password123")
    response = await _create(token, _valid_body())
    assert response.status_code == 403
