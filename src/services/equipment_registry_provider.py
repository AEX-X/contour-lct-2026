"""Synthetic equipment registry generator and hierarchy materializer (ticket 06).

Fully deterministic -- no RNG at all: one registry item per (facility_id,
system_type) actually present in the real sensor-channel catalogue
(ticket 05), with a stable pseudo install_year derived by hashing the
facility_id+system_type key (never random per run).

The registry is also exposed through the facility hierarchy as an explicitly
derived equipment grouping.  It does not invent buildings, collectors,
sections, or physical geometry: each group only connects the real facility
root to sensor channels that share the registry item's real system_type.
"""

import hashlib
from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.models.emulation_providers import EquipmentRegistryItem, SyntheticProviderRun
from src.models.hierarchy import Facility, HierarchyNode
from src.models.sensor import SensorChannel

PROVIDER = "equipment_registry"

_SYSTEM_DISPLAY_NAMES = {
    "fire_protection": "Пожарная защита",
    "dispatch_control": "Диспетчерский контроль",
    "security": "Охрана",
    "temperature": "Температурный контроль",
    "gas_protection": "Газовая защита",
    "diagnostic": "Диагностика",
    "unknown": "Неизвестная система",
}

_INSTALL_YEAR_BASE = 2005
_INSTALL_YEAR_SPAN = 15


def _stable_install_year(key: str) -> int:
    digest = hashlib.md5(key.encode("utf-8")).hexdigest()
    return _INSTALL_YEAR_BASE + (int(digest[:8], 16) % _INSTALL_YEAR_SPAN)


def _equipment_node_id(equipment_id: str) -> str:
    return f"node_{equipment_id}"


def _derived_equipment_display_name(item: EquipmentRegistryItem) -> str:
    label = item.display_name.removeprefix("Группа:").strip()
    return f"Расчетная группа оборудования: {label}"


async def generate_equipment_registry(
    session: AsyncSession, *, now: datetime | None = None
) -> int:
    """Seed one deterministic equipment-registry item per real (facility, system_type), idempotently.

    Args:
        session: An active async database session.
        now: Wall-clock time recorded as this run's last_run_at.

    Returns:
        The number of items inserted (0 if already seeded).
    """
    already_run = await session.get(SyntheticProviderRun, PROVIDER)
    if already_run is not None:
        return 0

    now = now or datetime.now(timezone.utc)
    groups = (
        await session.execute(
            select(
                SensorChannel.facility_id,
                SensorChannel.system_type,
                func.count(SensorChannel.id),
            )
            .where(SensorChannel.facility_id.isnot(None))
            .group_by(SensorChannel.facility_id, SensorChannel.system_type)
        )
    ).all()

    for facility_id, system_type, channel_count in groups:
        key = f"{facility_id}:{system_type}"
        session.add(
            EquipmentRegistryItem(
                id=f"eq_{key}",
                facility_id=facility_id,
                system_type=system_type,
                channel_count=channel_count,
                display_name=f"Группа: {_SYSTEM_DISPLAY_NAMES.get(system_type, system_type)}",
                install_year=_stable_install_year(key),
                last_inspected_at=None,
            )
        )

    session.add(
        SyntheticProviderRun(provider=PROVIDER, last_run_at=now, row_count=len(groups))
    )
    await session.commit()
    return len(groups)


async def materialize_equipment_hierarchy(session: AsyncSession) -> int:
    """Materialize and repair ``facility -> equipment -> sensor`` links.

    Equipment nodes are deterministic projections of ``EquipmentRegistryItem``
    rows, not claims about a physical topology.  Sensor nodes are grouped only
    by their real ``facility_id`` and ``system_type``.  Re-running this function
    is safe: it creates missing nodes, repairs stale parent links and names, and
    returns zero when the hierarchy is already current.

    Existing databases are deliberately handled even when the synthetic
    provider's idempotency marker already exists.  No building, collector,
    section, or geometry rows are created here.

    Args:
        session: An active async database session.

    Returns:
        Number of inserted or repaired rows/links.

    Raises:
        RuntimeError: If a deterministic hierarchy-node id is already occupied
            by an unrelated entity, because silently attaching the wrong node
            would corrupt the hierarchy.
    """
    equipment_items = list(
        (
            await session.execute(
                select(EquipmentRegistryItem).order_by(EquipmentRegistryItem.id)
            )
        )
        .scalars()
        .all()
    )
    if not equipment_items:
        return 0

    facility_ids = sorted({item.facility_id for item in equipment_items})
    facilities = {
        facility.id: facility
        for facility in (
            (
                await session.execute(
                    select(Facility).where(Facility.id.in_(facility_ids))
                )
            )
            .scalars()
            .all()
        )
    }
    nodes = list(
        (
            await session.execute(
                select(HierarchyNode)
                .where(HierarchyNode.facility_id.in_(facility_ids))
                .order_by(HierarchyNode.id)
            )
        )
        .scalars()
        .all()
    )
    nodes_by_id = {node.id: node for node in nodes}
    semantic_nodes: dict[tuple[str, str, str], list[HierarchyNode]] = {}
    for node in nodes:
        semantic_nodes.setdefault(
            (node.facility_id, node.entity_type, node.entity_id), []
        ).append(node)

    changed = 0
    roots_by_facility: dict[str, HierarchyNode] = {}
    for facility_id in facility_ids:
        facility = facilities.get(facility_id)
        if facility is None:
            # The FK normally makes this impossible, but do not fabricate a
            # facility if a legacy/corrupt database violates that invariant.
            continue

        candidates = semantic_nodes.get((facility_id, "facility", facility_id), [])
        root = next((node for node in candidates if node.parent_id is None), None)
        if root is None and candidates:
            root = candidates[0]
            root.parent_id = None
            changed += 1
        if root is None:
            root_id = f"node_{facility_id}"
            occupied = nodes_by_id.get(root_id)
            if occupied is not None:
                raise RuntimeError(
                    f"Hierarchy node id {root_id!r} is occupied by "
                    f"{occupied.entity_type}:{occupied.entity_id}"
                )
            root = HierarchyNode(
                id=root_id,
                parent_id=None,
                facility_id=facility_id,
                entity_type="facility",
                entity_id=facility_id,
                display_name=facility.display_name,
            )
            session.add(root)
            nodes_by_id[root.id] = root
            semantic_nodes.setdefault(
                (facility_id, "facility", facility_id), []
            ).append(root)
            changed += 1
        roots_by_facility[facility_id] = root

    # Flush roots before inserting their self-referencing children.  This is
    # still one atomic transaction and remains safe to roll back on failure.
    await session.flush()

    equipment_nodes: dict[tuple[str, str], HierarchyNode] = {}
    for item in equipment_items:
        root = roots_by_facility.get(item.facility_id)
        if root is None:
            continue

        semantic_key = (item.facility_id, "equipment", item.id)
        candidates = semantic_nodes.get(semantic_key, [])
        expected_id = _equipment_node_id(item.id)
        node = next(
            (candidate for candidate in candidates if candidate.id == expected_id), None
        )
        if node is None and candidates:
            node = candidates[0]
        if node is None:
            occupied = nodes_by_id.get(expected_id)
            if occupied is not None:
                raise RuntimeError(
                    f"Hierarchy node id {expected_id!r} is occupied by "
                    f"{occupied.entity_type}:{occupied.entity_id}"
                )
            node = HierarchyNode(
                id=expected_id,
                parent_id=root.id,
                facility_id=item.facility_id,
                entity_type="equipment",
                entity_id=item.id,
                display_name=_derived_equipment_display_name(item),
            )
            session.add(node)
            nodes_by_id[node.id] = node
            semantic_nodes.setdefault(semantic_key, []).append(node)
            changed += 1
        else:
            expected_name = _derived_equipment_display_name(item)
            if node.parent_id != root.id:
                node.parent_id = root.id
                changed += 1
            if node.display_name != expected_name:
                node.display_name = expected_name
                changed += 1
        equipment_nodes[(item.facility_id, item.system_type)] = node

    await session.flush()

    channels = list(
        (
            await session.execute(
                select(SensorChannel)
                .where(SensorChannel.facility_id.in_(facility_ids))
                .order_by(SensorChannel.id)
            )
        )
        .scalars()
        .all()
    )
    for channel in channels:
        if channel.facility_id is None:
            continue
        equipment_node = equipment_nodes.get((channel.facility_id, channel.system_type))
        if equipment_node is None:
            continue

        semantic_key = (channel.facility_id, "sensor", channel.id)
        candidates = semantic_nodes.get(semantic_key, [])
        pointed_node = nodes_by_id.get(channel.hierarchy_node_id or "")
        node = (
            pointed_node
            if pointed_node is not None
            and pointed_node.facility_id == channel.facility_id
            and pointed_node.entity_type == "sensor"
            and pointed_node.entity_id == channel.id
            else None
        )
        if node is None:
            expected_id = f"node_{channel.id}"
            node = next(
                (candidate for candidate in candidates if candidate.id == expected_id),
                candidates[0] if candidates else None,
            )
        if node is None:
            expected_id = f"node_{channel.id}"
            occupied = nodes_by_id.get(expected_id)
            if occupied is not None:
                raise RuntimeError(
                    f"Hierarchy node id {expected_id!r} is occupied by "
                    f"{occupied.entity_type}:{occupied.entity_id}"
                )
            node = HierarchyNode(
                id=expected_id,
                parent_id=equipment_node.id,
                facility_id=channel.facility_id,
                entity_type="sensor",
                entity_id=channel.id,
                display_name=channel.display_name,
            )
            session.add(node)
            nodes_by_id[node.id] = node
            semantic_nodes.setdefault(semantic_key, []).append(node)
            changed += 1
        else:
            if node.parent_id != equipment_node.id:
                node.parent_id = equipment_node.id
                changed += 1
            if node.display_name != channel.display_name:
                node.display_name = channel.display_name
                changed += 1
        if channel.hierarchy_node_id != node.id:
            channel.hierarchy_node_id = node.id
            changed += 1

    await session.commit()
    return changed
