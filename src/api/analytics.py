"""GET /api/v1/analytics/daily-trend -- per-day dynamics for the analytics page."""
from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, ConfigDict, Field

from src.db import async_session_factory
from src.deps.auth import require_permission
from src.errors import ApiError
from src.models.auth import User
from src.services.analytics_trend import (
    DEFAULT_DAYS,
    MAX_DAYS,
    MSK_ZONE_NAME,
    daily_trend,
    msk_today,
)
from src.services.scope import resolve_scope

router = APIRouter(prefix="/api/v1", tags=["analytics"])


class TrendDayOut(BaseModel):
    """Counts for one Moscow calendar day."""

    day: date
    incidents: int
    risks: int
    closed: int


class TrendMeta(BaseModel):
    """The resolved period and when the numbers were computed."""

    model_config = ConfigDict(populate_by_name=True)

    from_: date = Field(alias="from")
    to: date
    timezone: str
    generated_at: datetime


class DailyTrendEnvelope(BaseModel):
    """The standard {data, meta} envelope for the daily trend."""

    data: list[TrendDayOut]
    meta: TrendMeta


def _parse_day(raw: str, field_name: str) -> date:
    try:
        return date.fromisoformat(raw)
    except ValueError as exc:
        raise ApiError(
            400, "VALIDATION_ERROR", f"{field_name} должен быть датой в формате YYYY-MM-DD"
        ) from exc


def resolve_period(raw_from: str | None, raw_to: str | None, today: date) -> tuple[date, date]:
    """Resolve and validate the requested period.

    Args:
        raw_from: Requested first day (YYYY-MM-DD) or None.
        raw_to: Requested last day (YYYY-MM-DD) or None.
        today: Today's Moscow date, the default last day.

    Returns:
        (first_day, last_day), both inclusive.

    Raises:
        ApiError: 400 for a malformed date, from after to, or a period
            longer than MAX_DAYS days.
    """
    last_day = _parse_day(raw_to, "to") if raw_to else None
    first_day = _parse_day(raw_from, "from") if raw_from else None
    if last_day is None:
        last_day = (
            first_day + timedelta(days=DEFAULT_DAYS - 1) if first_day else today
        )
    if first_day is None:
        first_day = last_day - timedelta(days=DEFAULT_DAYS - 1)
    if first_day > last_day:
        raise ApiError(400, "VALIDATION_ERROR", "from не может быть позже to")
    if (last_day - first_day).days + 1 > MAX_DAYS:
        raise ApiError(
            400, "VALIDATION_ERROR", f"Период не может быть длиннее {MAX_DAYS} дней"
        )
    return first_day, last_day


@router.get("/analytics/daily-trend", response_model=DailyTrendEnvelope)
async def get_daily_trend(
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = Query(default=None),
    user: User = Depends(require_permission("analytics.read.summary")),
) -> DailyTrendEnvelope:
    """Per-day confirmed incidents, new risk forecasts and closed work orders.

    Days are Moscow calendar days; every day of the period is present, zero
    when nothing happened. Counts are limited to the caller's scope.

    Args:
        from_: First day, YYYY-MM-DD, inclusive (default: 6 days before to).
        to: Last day, YYYY-MM-DD, inclusive (default: today in Moscow, or
            6 days after from when only from is given).
        user: The authenticated caller, injected by require_permission.

    Returns:
        {data: [{day, incidents, risks, closed}], meta: {from, to, timezone,
        generated_at}}.

    Raises:
        ApiError: 400 for a malformed or too long period; 403 without
            analytics.read.summary.
    """
    first_day, last_day = resolve_period(from_, to, msk_today())
    async with async_session_factory() as session:
        scope = await resolve_scope(session, user.id)
        allowed_ids = (
            None if scope["type"] == "all_facilities" else set(scope.get("facility_ids", []))
        )
        days = await daily_trend(session, first_day, last_day, allowed_ids)
    return DailyTrendEnvelope(
        data=[
            TrendDayOut(day=d.day, incidents=d.incidents, risks=d.risks, closed=d.closed)
            for d in days
        ],
        meta=TrendMeta(
            from_=first_day,
            to=last_day,
            timezone=MSK_ZONE_NAME,
            generated_at=datetime.now(timezone.utc),
        ),
    )
