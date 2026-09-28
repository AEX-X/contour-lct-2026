"""Scope-filtered facility catalogue with live operational summaries."""

import hashlib
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import case, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.errors import ApiError
from src.models.emulation_providers import EquipmentRegistryItem
from src.models.event import Event
from src.models.hierarchy import Facility, HierarchyNode
from src.models.risk import Risk
from src.models.sensor import SensorChannel, SensorReading
from src.models.work_order import FacilityDispatcherAssignment
from src.schemas.facility import (
    Assets,
    DataHealth,
    FacilityOut,
    Forecast,
    Incidents,
    Location,
    SourceHealthEntry,
)
from src.services.reference_data import FRESHNESS_BOUNDARIES
from src.services.source_health import get_source_health

_LON_MIN, _LON_MAX = 37.3, 38.0
_LAT_MIN, _LAT_MAX = 55.5, 56.0
_RISK_RANK = {"unknown": 0, "low": 1, "medium": 2, "high": 3, "critical": 4}
_FRESHNESS_RANK = {"fresh": 0, "delayed": 1, "stale": 2, "unavailable": 3}
_FRESH_MAX_AGE = next(
    item.max_age_seconds for item in FRESHNESS_BOUNDARIES if item.id == "fresh"
)
_DELAYED_MAX_AGE = next(
    item.max_age_seconds for item in FRESHNESS_BOUNDARIES if item.id == "delayed"
)
_STALE_MAX_AGE = next(
    item.max_age_seconds for item in FRESHNESS_BOUNDARIES if item.id == "stale"
)


@dataclass
class _FacilityMetrics:
    collector_count: int = 0
    equipment_count: int = 0
    sensor_count: int = 0
    available_sensor_count: int = 0
    last_event_at: datetime | None = None
    event_count: int = 0
    confirmed_incident_count: int = 0
    critical_incident_count: int = 0
    risk_level: str = "unknown"
    max_probability: float = 0.0
    active_risk_count: int = 0
    earliest_window_start: datetime | None = None
    priority_score: float = 0.0
    updated_at: datetime | None = None
    has_dispatcher_assignment_history: bool = False
    effective_responsible_dispatcher_id: str | None = None


def _deterministic_point(facility_id: str) -> tuple[float, float]:
    """Return stable demo geometry; the source dataset has no coordinates."""
    digest = hashlib.md5(facility_id.encode("utf-8")).hexdigest()
    lon = _LON_MIN + (int(digest[:8], 16) % 10_000) / 10_000 * (_LON_MAX - _LON_MIN)
    lat = _LAT_MIN + (int(digest[8:16], 16) % 10_000) / 10_000 * (_LAT_MAX - _LAT_MIN)
    return round(lon, 6), round(lat, 6)


async def _load_source_health(session: AsyncSession) -> list[SourceHealthEntry]:
    entries = await get_source_health(session)
    return [
        SourceHealthEntry(
            source=item.source,
            display_name=item.display_name,
            status=item.status,
            last_success_at=item.last_success_at,
            delay_seconds=item.delay_seconds,
        )
        for item in entries
    ]


def _touch(metrics: _FacilityMetrics, occurred_at: datetime | None) -> None:
    if occurred_at is not None and (
        metrics.updated_at is None or occurred_at > metrics.updated_at
    ):
        metrics.updated_at = occurred_at


async def _load_metrics(
    session: AsyncSession, facility_ids: list[str], now: datetime
) -> dict[str, _FacilityMetrics]:
    metrics = {facility_id: _FacilityMetrics() for facility_id in facility_ids}
    if not facility_ids:
        return metrics

    hierarchy_rows = (
        await session.execute(
            select(HierarchyNode.facility_id, func.count(HierarchyNode.id))
            .where(
                HierarchyNode.facility_id.in_(facility_ids),
                HierarchyNode.entity_type == "collector",
            )
            .group_by(HierarchyNode.facility_id)
        )
    ).all()
    for facility_id, count in hierarchy_rows:
        metrics[facility_id].collector_count = int(count)

    equipment_rows = (
        await session.execute(
            select(
                EquipmentRegistryItem.facility_id,
                func.count(EquipmentRegistryItem.id),
            )
            .where(EquipmentRegistryItem.facility_id.in_(facility_ids))
            .group_by(EquipmentRegistryItem.facility_id)
        )
    ).all()
    for facility_id, count in equipment_rows:
        metrics[facility_id].equipment_count = int(count)

    latest_reading = (
        select(
            SensorReading.channel_id.label("channel_id"),
            func.max(SensorReading.occurred_at).label("last_at"),
        )
        .join(
            SensorChannel,
            SensorChannel.channel_id == SensorReading.channel_id,
        )
        .where(SensorChannel.facility_id.in_(facility_ids))
        .group_by(SensorReading.channel_id)
        .subquery()
    )
    stale_cutoff = now - timedelta(seconds=_STALE_MAX_AGE)
    sensor_rows = (
        await session.execute(
            select(
                SensorChannel.facility_id,
                func.count(SensorChannel.id),
                func.sum(case((latest_reading.c.last_at >= stale_cutoff, 1), else_=0)),
                func.max(latest_reading.c.last_at),
            )
            .outerjoin(
                latest_reading,
                latest_reading.c.channel_id == SensorChannel.channel_id,
            )
            .where(SensorChannel.facility_id.in_(facility_ids))
            .group_by(SensorChannel.facility_id)
        )
    ).all()
    for facility_id, total, available, last_at in sensor_rows:
        item = metrics[facility_id]
        item.sensor_count = int(total)
        item.available_sensor_count = int(available or 0)
        item.last_event_at = last_at
        _touch(item, last_at)

    active_risks = (
        (
            await session.execute(
                select(Risk).where(
                    Risk.facility_id.in_(facility_ids),
                    Risk.decision_status.in_(["open", "acknowledged"]),
                    Risk.prediction_window_end > now,
                )
            )
        )
        .scalars()
        .all()
    )
    for risk in active_risks:
        if risk.facility_id not in metrics:
            continue
        item = metrics[risk.facility_id]
        item.active_risk_count += 1
        item.max_probability = max(item.max_probability, risk.probability)
        item.priority_score = max(item.priority_score, risk.priority_score)
        if _RISK_RANK.get(risk.risk_level, 0) > _RISK_RANK[item.risk_level]:
            item.risk_level = risk.risk_level
        if (
            item.earliest_window_start is None
            or risk.prediction_window_start < item.earliest_window_start
        ):
            item.earliest_window_start = risk.prediction_window_start
        _touch(item, risk.updated_at)

    open_events = (
        (
            await session.execute(
                select(Event).where(
                    Event.facility_id.in_(facility_ids), Event.resolved_at.is_(None)
                )
            )
        )
        .scalars()
        .all()
    )
    for event in open_events:
        if event.facility_id not in metrics:
            continue
        item = metrics[event.facility_id]
        item.event_count += 1
        if event.is_confirmed_incident:
            item.confirmed_incident_count += 1
            state = event.state.lower()
            if any(marker in state for marker in ("alarm", "critical", "fire")):
                item.critical_incident_count += 1
        _touch(item, event.occurred_at)

    dispatcher_assignments = (
        (
            await session.execute(
                select(FacilityDispatcherAssignment).where(
                    FacilityDispatcherAssignment.facility_id.in_(facility_ids)
                )
            )
        )
        .scalars()
        .all()
    )
    for assignment in dispatcher_assignments:
        item = metrics[assignment.facility_id]
        item.has_dispatcher_assignment_history = True
        if (
            assignment.status == "active"
            and assignment.starts_at <= now < assignment.ends_at
        ):
            item.effective_responsible_dispatcher_id = assignment.dispatcher_id

    return metrics


def _freshness(
    metrics: _FacilityMetrics,
    source_health: list[SourceHealthEntry],
    now: datetime,
) -> str:
    if metrics.sensor_count == 0 or metrics.last_event_at is None:
        reading_state = "unavailable"
    else:
        age = max(0.0, (now - metrics.last_event_at).total_seconds())
        if age <= _FRESH_MAX_AGE:
            reading_state = "fresh"
        elif age <= _DELAYED_MAX_AGE:
            reading_state = "delayed"
        elif age <= _STALE_MAX_AGE:
            reading_state = "stale"
        else:
            reading_state = "unavailable"

    smvu = next((item for item in source_health if item.source == "smvu"), None)
    source_state = (
        {"online": "fresh", "delayed": "delayed"}.get(smvu.status, "unavailable")
        if smvu
        else "unavailable"
    )
    return max((reading_state, source_state), key=_FRESHNESS_RANK.__getitem__)


def _build_facility_out(
    facility: Facility,
    metrics: _FacilityMetrics,
    source_health: list[SourceHealthEntry],
    now: datetime,
) -> FacilityOut:
    freshness = _freshness(metrics, source_health, now)
    offline_count = max(0, metrics.sensor_count - metrics.available_sensor_count)
    coverage = (
        metrics.available_sensor_count / metrics.sensor_count
        if metrics.sensor_count
        else 0.0
    )
    if metrics.critical_incident_count or metrics.risk_level == "critical":
        current_state = "critical"
    elif (
        metrics.event_count
        or _RISK_RANK[metrics.risk_level] >= _RISK_RANK["medium"]
        or offline_count
    ):
        current_state = "attention"
    elif metrics.sensor_count and freshness in {"fresh", "delayed"}:
        current_state = "normal"
    else:
        current_state = "unknown"

    updated_candidates = [
        metrics.updated_at,
        *(item.last_success_at for item in source_health),
    ]
    updated_at = max((item for item in updated_candidates if item), default=now)
    return FacilityOut(
        id=facility.id,
        version=facility.version,
        responsible_dispatcher_id=(
            metrics.effective_responsible_dispatcher_id
            if metrics.has_dispatcher_assignment_history
            else facility.responsible_dispatcher_id
        ),
        display_name=facility.display_name,
        facility_type=facility.facility_type,
        address=None,
        internal_code=facility.id.removeprefix("fac_"),
        rosta_code=None,
        location=Location(coordinates=_deterministic_point(facility.id)),
        current_state=current_state,
        forecast=Forecast(
            risk_level=metrics.risk_level,
            max_probability=metrics.max_probability,
            active_count=metrics.active_risk_count,
            earliest_window_start=metrics.earliest_window_start,
        ),
        incidents=Incidents(
            open_count=metrics.confirmed_incident_count,
            critical_count=metrics.critical_incident_count,
        ),
        assets=Assets(
            collector_count=metrics.collector_count,
            equipment_count=metrics.equipment_count,
            sensor_count=metrics.sensor_count,
            offline_sensor_count=offline_count,
        ),
        data_health=DataHealth(
            freshness=freshness,
            last_event_at=metrics.last_event_at,
            coverage=round(coverage, 4),
        ),
        priority_score=metrics.priority_score,
        source_health=source_health,
        updated_at=updated_at,
    )


async def list_facilities(
    session: AsyncSession,
    allowed_facility_ids: set[str] | None,
    query: str | None = None,
    current_state: str | None = None,
    risk_level: str | None = None,
    district: str | None = None,
    bbox: str | None = None,
    cursor: str | None = None,
    limit: int = 50,
) -> tuple[list[FacilityOut], str | None, int]:
    stmt = select(Facility).order_by(Facility.id)
    if allowed_facility_ids is not None:
        if not allowed_facility_ids:
            return [], None, 0
        stmt = stmt.where(Facility.id.in_(allowed_facility_ids))
    if query:
        like = f"%{query.strip()}%"
        stmt = stmt.where(
            or_(Facility.display_name.ilike(like), Facility.id.ilike(like))
        )
    if district:
        stmt = stmt.where(Facility.district_id == district)

    facilities = list((await session.execute(stmt)).scalars().all())
    if bbox:
        try:
            min_lon, min_lat, max_lon, max_lat = (
                float(part) for part in bbox.split(",")
            )
        except ValueError as exc:
            raise ApiError(
                400,
                "VALIDATION_ERROR",
                "bbox must be 'min_lon,min_lat,max_lon,max_lat'",
            ) from exc
        facilities = [
            item
            for item in facilities
            if min_lon <= _deterministic_point(item.id)[0] <= max_lon
            and min_lat <= _deterministic_point(item.id)[1] <= max_lat
        ]

    now = datetime.now(timezone.utc)
    source_health = await _load_source_health(session)
    metrics = await _load_metrics(session, [item.id for item in facilities], now)
    outputs = [
        _build_facility_out(item, metrics[item.id], source_health, now)
        for item in facilities
    ]
    if current_state:
        outputs = [item for item in outputs if item.current_state == current_state]
    if risk_level:
        outputs = [item for item in outputs if item.forecast.risk_level == risk_level]

    total = len(outputs)
    start = 0
    if cursor:
        start = next(
            (index + 1 for index, item in enumerate(outputs) if item.id == cursor),
            total,
        )
    page = outputs[start : start + limit]
    next_cursor = page[-1].id if len(page) == limit and start + limit < total else None
    return page, next_cursor, total


async def get_facility_detail(
    session: AsyncSession, facility_id: str, allowed_facility_ids: set[str] | None
) -> FacilityOut:
    facility = await session.scalar(select(Facility).where(Facility.id == facility_id))
    if facility is None:
        raise ApiError(404, "NOT_FOUND", "Объект не найден")
    if allowed_facility_ids is not None and facility_id not in allowed_facility_ids:
        raise ApiError(
            403, "FACILITY_ACCESS_DENIED", "Недостаточно прав для просмотра объекта"
        )
    now = datetime.now(timezone.utc)
    source_health = await _load_source_health(session)
    metrics = await _load_metrics(session, [facility_id], now)
    return _build_facility_out(facility, metrics[facility_id], source_health, now)
