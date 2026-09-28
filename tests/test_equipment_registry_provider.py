"""Tests for the synthetic equipment registry provider (leaf 1.2.2)."""

import pytest
from sqlalchemy import select

from src.db import async_session_factory
from src.models.emulation_providers import EquipmentRegistryItem, SyntheticProviderRun
from src.models.hierarchy import Facility, HierarchyNode
from src.models.sensor import SensorChannel
from src.services.equipment_registry_provider import (
    PROVIDER,
    generate_equipment_registry,
    materialize_equipment_hierarchy,
)


async def _reset_provider_run() -> None:
    async with async_session_factory() as session:
        existing = await session.get(SyntheticProviderRun, PROVIDER)
        if existing is not None:
            await session.delete(existing)
        await session.execute(EquipmentRegistryItem.__table__.delete())
        await session.commit()


async def _seed_test_catalogue() -> str:
    """One dedicated, non-catalogue facility with channels in 2 systems."""
    facility_id = "fac_equip_test"
    async with async_session_factory() as session:
        if await session.get(Facility, facility_id) is None:
            session.add(
                Facility(
                    id=facility_id,
                    display_name=facility_id,
                    facility_type="test",
                    district_id=None,
                )
            )
        if await session.get(HierarchyNode, f"node_{facility_id}") is None:
            session.add(
                HierarchyNode(
                    id=f"node_{facility_id}",
                    parent_id=None,
                    facility_id=facility_id,
                    entity_type="facility",
                    entity_id=facility_id,
                    display_name=facility_id,
                )
            )
        for i, system_type in enumerate(["temperature", "temperature", "security"]):
            channel_id = f"equip_test_channel_{i}"
            if await session.get(SensorChannel, f"sensor_{channel_id}") is None:
                session.add(
                    SensorChannel(
                        id=f"sensor_{channel_id}",
                        channel_id=channel_id,
                        tag="",
                        sensor_type_id="temperature_sensor"
                        if system_type == "temperature"
                        else "door_contact",
                        system_type=system_type,
                        display_name=channel_id,
                        facility_id=facility_id,
                        hierarchy_node_id=None,
                    )
                )
        await session.commit()
    return facility_id


@pytest.mark.asyncio
async def test_one_item_per_real_facility_system_type_pair() -> None:
    await _reset_provider_run()
    facility_id = await _seed_test_catalogue()

    async with async_session_factory() as session:
        count = await generate_equipment_registry(session)
    assert count > 0

    async with async_session_factory() as session:
        items = (
            (
                await session.execute(
                    select(EquipmentRegistryItem).where(
                        EquipmentRegistryItem.facility_id == facility_id
                    )
                )
            )
            .scalars()
            .all()
        )
    by_system = {item.system_type: item.channel_count for item in items}
    assert by_system == {"temperature": 2, "security": 1}


@pytest.mark.asyncio
async def test_generation_is_idempotent() -> None:
    await _reset_provider_run()
    await _seed_test_catalogue()
    async with async_session_factory() as session:
        first_count = await generate_equipment_registry(session)
    async with async_session_factory() as session:
        second_count = await generate_equipment_registry(session)
    assert first_count > 0
    assert second_count == 0


@pytest.mark.asyncio
async def test_install_year_is_fully_deterministic_across_runs() -> None:
    facility_id = await _seed_test_catalogue()

    await _reset_provider_run()
    async with async_session_factory() as session:
        await generate_equipment_registry(session)
    async with async_session_factory() as session:
        first_years = dict(
            (
                await session.execute(
                    select(
                        EquipmentRegistryItem.system_type,
                        EquipmentRegistryItem.install_year,
                    ).where(EquipmentRegistryItem.facility_id == facility_id)
                )
            ).all()
        )

    await _reset_provider_run()
    async with async_session_factory() as session:
        await generate_equipment_registry(session)
    async with async_session_factory() as session:
        second_years = dict(
            (
                await session.execute(
                    select(
                        EquipmentRegistryItem.system_type,
                        EquipmentRegistryItem.install_year,
                    ).where(EquipmentRegistryItem.facility_id == facility_id)
                )
            ).all()
        )

    assert first_years == second_years


@pytest.mark.asyncio
async def test_hierarchy_materialization_repairs_and_is_idempotent() -> None:
    await _reset_provider_run()
    facility_id = await _seed_test_catalogue()

    async with async_session_factory() as session:
        await generate_equipment_registry(session)
        await materialize_equipment_hierarchy(session)

    async with async_session_factory() as session:
        root = await session.get(HierarchyNode, f"node_{facility_id}")
        equipment_nodes = list(
            (
                await session.execute(
                    select(HierarchyNode)
                    .where(
                        HierarchyNode.facility_id == facility_id,
                        HierarchyNode.entity_type == "equipment",
                    )
                    .order_by(HierarchyNode.entity_id)
                )
            )
            .scalars()
            .all()
        )
        assert root is not None
        assert len(equipment_nodes) == 2
        assert all(node.parent_id == root.id for node in equipment_nodes)
        assert all(
            node.display_name.startswith("Расчетная группа оборудования:")
            for node in equipment_nodes
        )

        channels = list(
            (
                await session.execute(
                    select(SensorChannel)
                    .where(SensorChannel.facility_id == facility_id)
                    .order_by(SensorChannel.id)
                )
            )
            .scalars()
            .all()
        )
        equipment_by_system = {
            item.system_type: node.id
            for item, node in (
                await session.execute(
                    select(EquipmentRegistryItem, HierarchyNode)
                    .join(
                        HierarchyNode,
                        (HierarchyNode.entity_type == "equipment")
                        & (HierarchyNode.entity_id == EquipmentRegistryItem.id),
                    )
                    .where(EquipmentRegistryItem.facility_id == facility_id)
                )
            ).all()
        }
        for channel in channels:
            node = await session.get(HierarchyNode, channel.hierarchy_node_id)
            assert node is not None
            assert node.entity_type == "sensor"
            assert node.entity_id == channel.id
            assert node.parent_id == equipment_by_system[channel.system_type]

        # Simulate a database created by the previous startup code: the
        # provider marker and registry remain, but one sensor is flat and one
        # sensor hierarchy row is missing entirely.
        first_node = await session.get(HierarchyNode, channels[0].hierarchy_node_id)
        first_node.parent_id = root.id
        second_node = await session.get(HierarchyNode, channels[1].hierarchy_node_id)
        channels[1].hierarchy_node_id = None
        await session.flush()
        await session.delete(second_node)
        equipment_nodes[0].display_name = "Старое название"
        await session.commit()

    async with async_session_factory() as session:
        assert await generate_equipment_registry(session) == 0
        repaired = await materialize_equipment_hierarchy(session)
        assert repaired >= 3

    async with async_session_factory() as session:
        assert await materialize_equipment_hierarchy(session) == 0
        channels = list(
            (
                await session.execute(
                    select(SensorChannel)
                    .where(SensorChannel.facility_id == facility_id)
                    .order_by(SensorChannel.id)
                )
            )
            .scalars()
            .all()
        )
        for channel in channels:
            sensor_node = await session.get(HierarchyNode, channel.hierarchy_node_id)
            equipment_node = await session.get(HierarchyNode, sensor_node.parent_id)
            assert equipment_node.entity_type == "equipment"
            assert equipment_node.parent_id == f"node_{facility_id}"
