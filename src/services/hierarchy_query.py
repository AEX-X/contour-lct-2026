"""Facility hierarchy traversal with descendant sensor telemetry summaries."""

from datetime import datetime, timezone

from sqlalchemy import select, text, true
from sqlalchemy.ext.asyncio import AsyncSession

from src.models.sensor import SensorChannel, SensorReading
from src.schemas.hierarchy import HierarchyNodeOut
from src.services.risk_leveling import compute_data_health

_STATE_RANK = {
    "normal": 0,
    "unknown": 1,
    "warning": 2,
    "fault": 3,
    "alarm": 4,
}
_ATTENTION_STATES = {"warning", "fault", "alarm"}

_RECURSIVE_TREE_SQL = text(
    """
    WITH RECURSIVE tree AS (
        SELECT id, parent_id, facility_id, entity_type, entity_id, display_name
        FROM hierarchy_nodes
        WHERE facility_id = :facility_id AND parent_id IS NULL
        UNION ALL
        SELECT c.id, c.parent_id, c.facility_id, c.entity_type, c.entity_id, c.display_name
        FROM hierarchy_nodes c
        JOIN tree t ON c.parent_id = t.id
    )
    SELECT id, parent_id, entity_type, entity_id, display_name FROM tree
    """
)


def _sensor_state(
    *,
    occurred_at: datetime | None,
    is_alarm: bool | None,
    is_anomaly: bool | None,
    now: datetime,
) -> str:
    """Derive the last known sensor state without overstating stale data."""
    if occurred_at is None:
        return "unknown"

    data_health = compute_data_health(occurred_at, now=now)
    if data_health == "unavailable":
        return "unknown"
    if is_anomaly:
        return "fault"
    if is_alarm:
        return "alarm"
    if data_health in {"delayed", "stale"}:
        return "warning"
    return "normal"


async def _sensor_snapshots(
    session: AsyncSession, facility_id: str
) -> list[tuple[str | None, datetime | None, bool | None, bool | None]]:
    """Load every facility channel and its deterministic latest reading."""
    latest = (
        select(
            SensorReading.occurred_at.label("occurred_at"),
            SensorReading.is_alarm.label("is_alarm"),
            SensorReading.is_anomaly.label("is_anomaly"),
        )
        .where(SensorReading.channel_id == SensorChannel.channel_id)
        .order_by(SensorReading.occurred_at.desc(), SensorReading.id.desc())
        .limit(1)
        .correlate(SensorChannel)
        .lateral("latest_hierarchy_reading")
    )
    return list(
        (
            await session.execute(
                select(
                    SensorChannel.hierarchy_node_id,
                    latest.c.occurred_at,
                    latest.c.is_alarm,
                    latest.c.is_anomaly,
                )
                .select_from(SensorChannel)
                .outerjoin(latest, true())
                .where(SensorChannel.facility_id == facility_id)
            )
        ).all()
    )


async def get_facility_hierarchy(
    session: AsyncSession,
    facility_id: str,
    *,
    now: datetime | None = None,
) -> list[HierarchyNodeOut]:
    """Fetch every hierarchy node with aggregated descendant sensor state.

    Args:
        session: An active async database session.
        facility_id: The facility whose tree to fetch.
        now: Optional UTC reference time for deterministic freshness bucketing.

    Returns:
        All reachable nodes as HierarchyNodeOut. ``sensor_count`` is the number
        of linked SensorChannel rows anchored at the node or any descendant.
        ``attention_count`` is the subset whose usable latest snapshot is
        warning, fault, or alarm. ``current_state`` is the worst descendant
        state using alarm > fault > warning > unknown > normal. Missing or
        unavailable telemetry stays unknown. ``risk_level`` remains unknown
        because risks do not yet have an unambiguous hierarchy-node binding.
    """
    now = now or datetime.now(timezone.utc)
    rows = (
        (await session.execute(_RECURSIVE_TREE_SQL, {"facility_id": facility_id}))
        .mappings()
        .all()
    )

    by_id = {row["id"]: dict(row) for row in rows}
    children_count: dict[str, int] = {row_id: 0 for row_id in by_id}
    for row in rows:
        if row["parent_id"] is not None and row["parent_id"] in children_count:
            children_count[row["parent_id"]] += 1

    def _path(node_id: str) -> list[str]:
        chain: list[str] = []
        current: str | None = node_id
        while current is not None:
            chain.append(current)
            current = by_id[current]["parent_id"]
        return list(reversed(chain))

    paths = {node_id: _path(node_id) for node_id in by_id}
    sensor_count = {node_id: 0 for node_id in by_id}
    attention_count = {node_id: 0 for node_id in by_id}
    current_state: dict[str, str | None] = {node_id: None for node_id in by_id}

    for hierarchy_node_id, occurred_at, is_alarm, is_anomaly in await _sensor_snapshots(
        session, facility_id
    ):
        if hierarchy_node_id not in paths:
            continue
        state = _sensor_state(
            occurred_at=occurred_at,
            is_alarm=is_alarm,
            is_anomaly=is_anomaly,
            now=now,
        )
        for node_id in paths[hierarchy_node_id]:
            sensor_count[node_id] += 1
            if state in _ATTENTION_STATES:
                attention_count[node_id] += 1
            previous = current_state[node_id]
            if previous is None or _STATE_RANK[state] > _STATE_RANK[previous]:
                current_state[node_id] = state

    return [
        HierarchyNodeOut(
            id=row["id"],
            parent_id=row["parent_id"],
            entity_type=row["entity_type"],
            entity_id=row["entity_id"],
            display_name=row["display_name"],
            path=paths[row["id"]],
            children_count=children_count[row["id"]],
            sensor_count=sensor_count[row["id"]],
            attention_count=attention_count[row["id"]],
            current_state=current_state[row["id"]] or "unknown",
            risk_level="unknown",
            has_children=children_count[row["id"]] > 0,
        )
        for row in rows
    ]
