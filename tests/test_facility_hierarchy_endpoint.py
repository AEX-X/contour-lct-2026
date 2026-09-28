"""Tests for GET /api/v1/facilities/{facility_id}/hierarchy."""

from datetime import datetime, timedelta, timezone

import pytest
from httpx import ASGITransport, AsyncClient

from src.db import async_session_factory
from src.main import app
from src.models.hierarchy import Facility, HierarchyNode
from src.models.sensor import SensorChannel, SensorReading
from src.services.demo_seed import seed_demo_users
from src.services.facility_seed import seed_facility_catalogue


async def _seed_isolated_test_facility(facility_id: str) -> None:
    # A facility outside the real 78-row catalogue, so ticket 05's sensor
    # channel seeding (which only processes real catalogue rows) never
    # attaches sensor nodes to it -- real facilities like fac_5122 legitimately
    # gain ~100+ sensor child nodes once the whole suite shares one database.
    async with async_session_factory() as session:
        session.add(
            Facility(
                id=facility_id,
                display_name="Isolated Test Facility",
                facility_type="controlHouse",
            )
        )
        session.add(
            HierarchyNode(
                id=f"node_{facility_id}",
                parent_id=None,
                facility_id=facility_id,
                entity_type="facility",
                entity_id=facility_id,
                display_name="Isolated Test Facility",
            )
        )
        await session.commit()


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


async def _get_hierarchy(token: str, facility_id: str):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.get(
            f"/api/v1/facilities/{facility_id}/hierarchy",
            headers={"Authorization": f"Bearer {token}"},
        )


@pytest.mark.asyncio
async def test_freshly_seeded_facility_has_a_single_leaf_root_node() -> None:
    await _seed_all()
    await _seed_isolated_test_facility("fac_hierarchy_pristine")
    token = await _login("manager", "manager123")
    response = await _get_hierarchy(token, "fac_hierarchy_pristine")
    assert response.status_code == 200
    nodes = response.json()
    assert len(nodes) == 1
    assert nodes[0]["parent_id"] is None
    assert nodes[0]["has_children"] is False
    assert nodes[0]["children_count"] == 0
    assert nodes[0]["path"] == [nodes[0]["id"]]
    assert nodes[0]["sensor_count"] == 0
    assert nodes[0]["attention_count"] == 0
    assert nodes[0]["current_state"] == "unknown"
    assert nodes[0]["risk_level"] == "unknown"


@pytest.mark.asyncio
async def test_manually_inserted_deeper_chain_is_returned_intact() -> None:
    await _seed_all()
    await _seed_isolated_test_facility("fac_hierarchy_deep_chain")
    async with async_session_factory() as session:
        session.add(
            HierarchyNode(
                id="node_building_1",
                parent_id="node_fac_hierarchy_deep_chain",
                facility_id="fac_hierarchy_deep_chain",
                entity_type="building",
                entity_id="b1",
                display_name="Корпус 1",
            )
        )
        session.add(
            HierarchyNode(
                id="node_collector_1",
                parent_id="node_building_1",
                facility_id="fac_hierarchy_deep_chain",
                entity_type="collector",
                entity_id="c1",
                display_name="Коллектор 1",
            )
        )
        await session.commit()

    token = await _login("manager", "manager123")
    response = await _get_hierarchy(token, "fac_hierarchy_deep_chain")
    nodes = {n["id"]: n for n in response.json()}
    assert len(nodes) == 3

    root = nodes["node_fac_hierarchy_deep_chain"]
    assert root["has_children"] is True
    assert root["children_count"] == 1

    building = nodes["node_building_1"]
    assert building["path"] == ["node_fac_hierarchy_deep_chain", "node_building_1"]
    assert building["has_children"] is True

    collector = nodes["node_collector_1"]
    assert collector["path"] == [
        "node_fac_hierarchy_deep_chain",
        "node_building_1",
        "node_collector_1",
    ]
    assert collector["has_children"] is False
    assert collector["entity_type"] == "collector"


@pytest.mark.asyncio
async def test_hierarchy_aggregates_real_descendant_sensor_snapshots() -> None:
    facility_id = "fac_hierarchy_sensor_metrics"
    await _seed_all()
    await _seed_isolated_test_facility(facility_id)
    now = datetime.now(timezone.utc)
    sensor_specs = [
        ("normal", now - timedelta(minutes=1), False, False, "normal", 0),
        ("alarm", now - timedelta(minutes=1), True, False, "alarm", 1),
        ("delayed", now - timedelta(minutes=10), False, False, "warning", 1),
        ("fault", now - timedelta(minutes=1), True, True, "fault", 1),
        ("unavailable", now - timedelta(hours=2), True, False, "unknown", 0),
    ]
    async with async_session_factory() as session:
        session.add(
            HierarchyNode(
                id="node_equipment_sensor_metrics",
                parent_id=f"node_{facility_id}",
                facility_id=facility_id,
                entity_type="equipment",
                entity_id="equipment_sensor_metrics",
                display_name="Расчетная группа оборудования: тест",
            )
        )
        for suffix, occurred_at, is_alarm, is_anomaly, _, _ in sensor_specs:
            sensor_id = f"sensor_hierarchy_metrics_{suffix}"
            channel_id = f"channel_hierarchy_metrics_{suffix}"
            node_id = f"node_{sensor_id}"
            session.add(
                HierarchyNode(
                    id=node_id,
                    parent_id="node_equipment_sensor_metrics",
                    facility_id=facility_id,
                    entity_type="sensor",
                    entity_id=sensor_id,
                    display_name=f"Датчик {suffix}",
                )
            )
            session.add(
                SensorChannel(
                    id=sensor_id,
                    channel_id=channel_id,
                    tag=suffix,
                    sensor_type_id="temperature_sensor",
                    system_type="temperature",
                    display_name=f"Датчик {suffix}",
                    facility_id=facility_id,
                    hierarchy_node_id=node_id,
                )
            )
            session.add(
                SensorReading(
                    channel_id=channel_id,
                    occurred_at=occurred_at,
                    is_alarm=is_alarm,
                    raw_value=suffix,
                    numeric_value=None,
                    is_anomaly=is_anomaly,
                    source_event_id=f"hierarchy-metrics-{suffix}",
                    origin="fixture",
                )
            )
        await session.commit()

    token = await _login("manager", "manager123")
    response = await _get_hierarchy(token, facility_id)
    assert response.status_code == 200
    nodes = {node["id"]: node for node in response.json()}

    root = nodes[f"node_{facility_id}"]
    equipment = nodes["node_equipment_sensor_metrics"]
    for aggregate in (root, equipment):
        assert aggregate["sensor_count"] == 5
        assert aggregate["attention_count"] == 3
        assert aggregate["current_state"] == "alarm"
        assert aggregate["risk_level"] == "unknown"

    for suffix, _, _, _, expected_state, expected_attention in sensor_specs:
        sensor = nodes[f"node_sensor_hierarchy_metrics_{suffix}"]
        assert sensor["sensor_count"] == 1
        assert sensor["attention_count"] == expected_attention
        assert sensor["current_state"] == expected_state


@pytest.mark.asyncio
async def test_hierarchy_for_out_of_scope_facility_returns_403() -> None:
    await _seed_all()
    token = await _login("dispatcher", "dispatcher123")
    response = await _get_hierarchy(token, "fac_20")
    assert response.status_code == 403


@pytest.mark.asyncio
async def test_hierarchy_for_nonexistent_facility_returns_404() -> None:
    await _seed_all()
    token = await _login("manager", "manager123")
    response = await _get_hierarchy(token, "fac_does_not_exist")
    assert response.status_code == 404
