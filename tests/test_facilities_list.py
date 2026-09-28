"""Tests for GET /api/v1/facilities."""

from datetime import datetime, timedelta, timezone

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from src.db import async_session_factory
from src.main import app
from src.models.emulation_providers import EquipmentRegistryItem
from src.models.hierarchy import Facility, HierarchyNode
from src.models.replay import ReplayState
from src.models.risk import Risk
from src.models.sensor import SensorChannel, SensorReading
from src.models.source_health import SourceHealthOverride
from src.services.demo_seed import seed_demo_users
from src.services.facility_query import _deterministic_point
from src.services.facility_seed import seed_facility_catalogue


async def _seed_all() -> None:
    async with async_session_factory() as session:
        await seed_facility_catalogue(session)
        await seed_demo_users(session)


async def _login(username: str, password: str) -> str:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/api/v1/auth/login", json={"username": username, "password": password}
        )
    assert response.status_code == 200
    return response.json()["token"]


async def _get_facilities(token: str, **params):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.get(
            "/api/v1/facilities",
            headers={"Authorization": f"Bearer {token}"},
            params=params,
        )


@pytest.mark.asyncio
async def test_manager_sees_all_78_facilities() -> None:
    await _seed_all()
    token = await _login("manager", "manager123")
    response = await _get_facilities(token, limit=200)
    assert response.status_code == 200
    body = response.json()
    # >= (not ==): ticket 06's provider tests seed a handful of their own
    # dedicated, non-catalogue Facility rows into this same shared database
    # when the whole suite runs together; the manager's all_facilities scope
    # legitimately sees those too. The real catalogue's 78 are always a
    # subset, so this still proves the manager sees the whole real catalogue.
    assert body["meta"]["total"] >= 78
    assert len(body["data"]) == body["meta"]["total"]


@pytest.mark.asyncio
async def test_dispatcher_sees_only_assigned_facilities() -> None:
    await _seed_all()
    token = await _login("dispatcher", "dispatcher123")
    response = await _get_facilities(token, limit=200)
    assert response.status_code == 200
    body = response.json()
    assert body["meta"]["total"] == 1
    assert {item["id"] for item in body["data"]} == {"fac_5122"}


@pytest.mark.asyncio
async def test_search_matches_name_and_real_internal_id_without_scope_leak() -> None:
    await _seed_all()
    manager = await _login("manager", "manager123")
    by_id = await _get_facilities(manager, query="5122", limit=200)
    assert {item["id"] for item in by_id.json()["data"]} == {"fac_5122"}
    assert by_id.json()["data"][0]["internal_code"] == "5122"
    assert by_id.json()["data"][0]["address"] is None
    assert by_id.json()["data"][0]["rosta_code"] is None

    by_name = await _get_facilities(manager, query="Пси", limit=200)
    assert any(item["id"] == "fac_5339" for item in by_name.json()["data"])

    dispatcher = await _login("dispatcher", "dispatcher123")
    out_of_scope = await _get_facilities(dispatcher, query="5339", limit=200)
    assert out_of_scope.json()["data"] == []


@pytest.mark.asyncio
async def test_facility_item_has_four_independent_status_fields() -> None:
    await _seed_all()
    token = await _login("manager", "manager123")
    response = await _get_facilities(token, limit=1)
    item = response.json()["data"][0]
    for field in (
        "current_state",
        "forecast",
        "incidents",
        "assets",
        "data_health",
        "priority_score",
    ):
        assert field in item, f"missing field: {field}"
    assert isinstance(item["forecast"], dict)
    assert isinstance(item["incidents"], dict)
    assert isinstance(item["assets"], dict)
    assert isinstance(
        item["current_state"], str
    )  # never collapsed into a nested object with the others


@pytest.mark.asyncio
async def test_facility_root_is_not_counted_as_a_collector() -> None:
    await _seed_all()
    token = await _login("manager", "manager123")
    response = await _get_facilities(token, query="5122", limit=200)

    assert response.status_code == 200
    assert response.json()["data"][0]["assets"]["collector_count"] == 0


@pytest.mark.asyncio
async def test_facility_summary_uses_live_risk_sensor_and_asset_data() -> None:
    await _seed_all()
    now = datetime.now(timezone.utc)
    facility_id = "fac_status_metrics"
    async with async_session_factory() as session:
        session.add(
            Facility(
                id=facility_id,
                display_name="Северный тестовый объект",
                facility_type="collector",
            )
        )
        await session.flush()
        session.add(
            HierarchyNode(
                id="node_status_metrics",
                parent_id=None,
                facility_id=facility_id,
                entity_type="collector",
                entity_id="collector_status_metrics",
                display_name="Тестовый коллектор",
            )
        )
        await session.flush()
        session.add(
            SensorChannel(
                id="sensor_status_metrics",
                channel_id="channel_status_metrics",
                tag="STATUS",
                sensor_type_id="temperature_sensor",
                system_type="temperature",
                display_name="Контрольный датчик",
                facility_id=facility_id,
                hierarchy_node_id="node_status_metrics",
            )
        )
        session.add(
            SensorReading(
                channel_id="channel_status_metrics",
                occurred_at=now,
                is_alarm=False,
                raw_value="22.0",
                numeric_value=22.0,
                is_anomaly=False,
                source_event_id="status-metrics-reading",
                origin="fixture",
            )
        )
        session.add(
            EquipmentRegistryItem(
                id="equipment_status_metrics",
                facility_id=facility_id,
                system_type="temperature",
                channel_count=1,
                display_name="Контрольное оборудование",
                install_year=2024,
                last_inspected_at=now,
            )
        )
        session.add(
            Risk(
                id="risk_status_metrics",
                forecast_id="forecast_status_metrics",
                risk_type="fire",
                target_type="sensor",
                target_id="sensor_status_metrics",
                facility_id=facility_id,
                as_of=now,
                lead_min_hours=1.0,
                horizon_hours=8.0,
                prediction_window_start=now + timedelta(hours=1),
                prediction_window_end=now + timedelta(hours=8),
                probability=0.91,
                threshold=0.85,
                risk_level="critical",
                priority_score=91.0,
                decision_status="open",
                sla_due_at=now + timedelta(hours=2),
                data_health="fresh",
                model="test",
                top_factors=["temperature"],
                recommendation="Проверить объект",
                version=1,
                created_at=now,
                updated_at=now,
            )
        )
        replay = await session.get(ReplayState, "singleton")
        if replay is None:
            session.add(
                ReplayState(
                    id="singleton",
                    virtual_cursor=now,
                    last_tick_at=now,
                    tick_count=1,
                )
            )
        else:
            replay.last_tick_at = now
        smvu_override = await session.get(SourceHealthOverride, "smvu")
        if smvu_override is not None:
            await session.delete(smvu_override)
        await session.commit()

    token = await _login("manager", "manager123")
    response = await _get_facilities(
        token,
        query="status_metrics",
        current_state="critical",
        risk_level="critical",
    )
    assert response.status_code == 200, response.text
    item = response.json()["data"][0]
    assert item["current_state"] == "critical"
    assert item["forecast"]["active_count"] == 1
    assert item["forecast"]["max_probability"] == pytest.approx(0.91)
    assert item["assets"] == {
        "collector_count": 1,
        "equipment_count": 1,
        "sensor_count": 1,
        "offline_sensor_count": 0,
    }
    assert item["data_health"]["freshness"] == "fresh"
    assert item["data_health"]["coverage"] == 1.0

    async with async_session_factory() as session:
        risk = await session.get(Risk, "risk_status_metrics")
        risk.decision_status = "deferred"
        await session.commit()
    deferred = await _get_facilities(token, query="status_metrics")
    deferred_item = deferred.json()["data"][0]
    assert deferred_item["forecast"]["active_count"] == 0
    assert deferred_item["current_state"] == "normal"

    async with async_session_factory() as session:
        risk = await session.get(Risk, "risk_status_metrics")
        risk.decision_status = "open"
        risk.prediction_window_end = now - timedelta(seconds=1)
        await session.commit()
    expired = await _get_facilities(token, query="status_metrics")
    expired_item = expired.json()["data"][0]
    assert expired_item["forecast"]["active_count"] == 0
    assert expired_item["current_state"] == "normal"


@pytest.mark.asyncio
async def test_district_filter_narrows_results() -> None:
    await _seed_all()
    token = await _login("manager", "manager123")
    full = await _get_facilities(token, limit=200)
    some_district = full.json()["data"][0]

    async with async_session_factory() as session:
        facility = (
            await session.execute(
                select(Facility).where(Facility.id == some_district["id"])
            )
        ).scalar_one()
        district_id = facility.district_id

    filtered = await _get_facilities(token, district=district_id, limit=200)
    assert filtered.status_code == 200
    assert filtered.json()["meta"]["total"] >= 1

    async with async_session_factory() as session:
        expected_ids = set(
            (
                await session.execute(
                    select(Facility.id).where(Facility.district_id == district_id)
                )
            )
            .scalars()
            .all()
        )
    assert {item["id"] for item in filtered.json()["data"]} == expected_ids


@pytest.mark.asyncio
async def test_bbox_filter_matches_the_deterministic_point() -> None:
    await _seed_all()
    token = await _login("manager", "manager123")
    lon, lat = _deterministic_point("fac_5122")

    matching = await _get_facilities(
        token,
        bbox=f"{lon - 0.001},{lat - 0.001},{lon + 0.001},{lat + 0.001}",
        limit=200,
    )
    assert any(item["id"] == "fac_5122" for item in matching.json()["data"])

    non_matching = await _get_facilities(token, bbox="0,0,0.001,0.001", limit=200)
    assert non_matching.json()["meta"]["total"] == 0


@pytest.mark.asyncio
async def test_pagination_cursor_advances_through_pages() -> None:
    await _seed_all()
    token = await _login("manager", "manager123")

    page1 = await _get_facilities(token, limit=30)
    assert page1.status_code == 200
    body1 = page1.json()
    assert len(body1["data"]) == 30
    assert body1["meta"]["next_cursor"] is not None

    page2 = await _get_facilities(token, limit=30, cursor=body1["meta"]["next_cursor"])
    body2 = page2.json()
    assert len(body2["data"]) == 30
    ids_page1 = {item["id"] for item in body1["data"]}
    ids_page2 = {item["id"] for item in body2["data"]}
    assert ids_page1.isdisjoint(ids_page2)


@pytest.mark.asyncio
async def test_facilities_requires_authentication() -> None:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/api/v1/facilities")
    assert response.status_code == 401
