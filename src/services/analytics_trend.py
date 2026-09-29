"""Daily trend for the analytics page: incidents, new risks, closed work orders.

Days are Moscow calendar days (UTC+3, no DST since 2014), the timezone the
dispatchers work in; every day of the period is present, zero when empty.
"""
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone

from sqlalchemy import Date, cast, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import InstrumentedAttribute

from src.models.event import Event
from src.models.risk import Risk
from src.models.work_order import WorkOrder

MSK = timezone(timedelta(hours=3), "MSK")
MSK_ZONE_NAME = "Europe/Moscow"
DEFAULT_DAYS = 7
MAX_DAYS = 92


@dataclass(frozen=True)
class TrendDay:
    """Counts for one Moscow calendar day."""

    day: date
    incidents: int
    risks: int
    closed: int


def msk_today(now: datetime | None = None) -> date:
    """Return the current Moscow calendar date.

    Args:
        now: Wall-clock time (defaults to real UTC now).

    Returns:
        Today's date in Moscow.
    """
    return (now or datetime.now(timezone.utc)).astimezone(MSK).date()


def _msk_day(column: InstrumentedAttribute):
    # timezone(zone, timestamptz) даёт локальное время Москвы; от него берём дату.
    return cast(func.timezone(MSK_ZONE_NAME, column), Date)


async def _count_by_day(session: AsyncSession, column, *conditions) -> dict[date, int]:
    day = _msk_day(column)
    rows = await session.execute(
        select(day, func.count()).where(*conditions).group_by(day)
    )
    return {row[0]: row[1] for row in rows}


async def daily_trend(
    session: AsyncSession,
    first_day: date,
    last_day: date,
    allowed_facility_ids: set[str] | None,
) -> list[TrendDay]:
    """Count confirmed incidents, new risks and closed work orders per MSK day.

    Args:
        session: An active async database session.
        first_day: First Moscow day, inclusive.
        last_day: Last Moscow day, inclusive (not before first_day).
        allowed_facility_ids: None for all_facilities scope, else visible ids;
            rows without a facility count only for the all_facilities scope.

    Returns:
        One TrendDay per day from first_day to last_day, in order.
    """
    days = [first_day + timedelta(days=i) for i in range((last_day - first_day).days + 1)]
    if allowed_facility_ids is not None and not allowed_facility_ids:
        return [TrendDay(day, 0, 0, 0) for day in days]

    start = datetime.combine(first_day, time.min, MSK)
    end = datetime.combine(last_day + timedelta(days=1), time.min, MSK)

    def scoped(column):
        return [] if allowed_facility_ids is None else [column.in_(allowed_facility_ids)]

    incidents = await _count_by_day(
        session,
        Event.occurred_at,
        Event.is_confirmed_incident.is_(True),
        Event.occurred_at >= start,
        Event.occurred_at < end,
        *scoped(Event.facility_id),
    )
    risks = await _count_by_day(
        session,
        Risk.created_at,
        Risk.is_invalidated.is_(False),
        Risk.created_at >= start,
        Risk.created_at < end,
        *scoped(Risk.facility_id),
    )
    closed = await _count_by_day(
        session,
        WorkOrder.closed_at,
        WorkOrder.status == "closed",
        WorkOrder.closed_at >= start,
        WorkOrder.closed_at < end,
        *scoped(WorkOrder.facility_id),
    )
    return [
        TrendDay(day, incidents.get(day, 0), risks.get(day, 0), closed.get(day, 0))
        for day in days
    ]
