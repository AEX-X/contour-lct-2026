"""The risk report for management: one table shared by every export format.

Values stay typed (float probability, datetime time) so each format can
render them its own way: numbers and dates in XLSX, locale-specific text in CSV.
"""
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.models.hierarchy import Facility
from src.models.risk import Risk, RiskDecision
from src.models.work_order import WorkOrder
from src.services.reference_data import DECISION_STATUSES, REJECT_REASONS, RISK_LEVELS, RISK_TYPES

# Moscow has no daylight saving time since 2014; a fixed offset needs no tz database.
MSK = timezone(timedelta(hours=3), "MSK")

COLUMNS = [
    "Риск",
    "Объект",
    "Название объекта",
    "Тип риска",
    "Вероятность",
    "Уровень",
    "Время прогноза (МСК)",
    "Решение",
    "Причина отклонения",
    "Комментарий",
    "Заявка",
]
PROBABILITY_COLUMN = COLUMNS.index("Вероятность")
TIME_COLUMN = COLUMNS.index("Время прогноза (МСК)")

_RISK_TYPE_NAMES = {item.id: item.display_name for item in RISK_TYPES}
_LEVEL_NAMES = {item.id: item.display_name for item in RISK_LEVELS}
_DECISION_NAMES = {item.id: item.display_name for item in DECISION_STATUSES}
_REASON_NAMES = {item.id: item.display_name for item in REJECT_REASONS}


@dataclass(frozen=True)
class ReportTable:
    """Header row plus typed data rows, in COLUMNS order."""

    headers: list[str]
    rows: list[list[Any]]


def to_msk_naive(moment: datetime) -> datetime:
    """Convert an aware UTC time to naive Moscow time (spreadsheets have no time zones)."""
    return moment.astimezone(MSK).replace(tzinfo=None)


async def build_risk_report(
    session: AsyncSession,
    allowed_facility_ids: set[str] | None,
    *,
    date_from: datetime | None = None,
    date_to: datetime | None = None,
) -> ReportTable:
    """Collect risks of a period with the dispatcher's decision and linked work orders.

    Args:
        session: An active async database session.
        allowed_facility_ids: None for all_facilities scope, else the caller's
            facilities (risks without a facility are then excluded).
        date_from: Inclusive lower bound on the forecast time, or None.
        date_to: Inclusive upper bound on the forecast time, or None.

    Returns:
        The report table, ordered by forecast time then risk id.
    """
    stmt = select(Risk)
    if allowed_facility_ids is not None:
        stmt = stmt.where(Risk.facility_id.in_(allowed_facility_ids))
    if date_from is not None:
        stmt = stmt.where(Risk.as_of >= date_from)
    if date_to is not None:
        stmt = stmt.where(Risk.as_of <= date_to)
    risks = (await session.execute(stmt.order_by(Risk.as_of, Risk.id))).scalars().all()
    if not risks:
        return ReportTable(headers=list(COLUMNS), rows=[])

    risk_ids = [risk.id for risk in risks]
    facility_ids = {risk.facility_id for risk in risks if risk.facility_id}
    facility_names = dict(
        (await session.execute(select(Facility.id, Facility.display_name).where(Facility.id.in_(facility_ids)))).all()
    )

    latest_decision: dict[str, RiskDecision] = {}
    decisions = (
        await session.execute(
            select(RiskDecision).where(RiskDecision.risk_id.in_(risk_ids)).order_by(RiskDecision.decided_at, RiskDecision.id)
        )
    ).scalars().all()
    for decision in decisions:
        latest_decision[decision.risk_id] = decision

    work_orders: dict[str, list[str]] = {}
    for risk_id, number in (
        await session.execute(
            select(WorkOrder.source_risk_id, WorkOrder.display_number)
            .where(WorkOrder.source_risk_id.in_(risk_ids))
            .order_by(WorkOrder.display_number)
        )
    ).all():
        work_orders.setdefault(risk_id, []).append(number)

    rows = []
    for risk in risks:
        decision = latest_decision.get(risk.id)
        reason = decision.reason_code if decision else None
        rows.append(
            [
                risk.id,
                risk.facility_id or "",
                facility_names.get(risk.facility_id, "") if risk.facility_id else "",
                _RISK_TYPE_NAMES.get(risk.risk_type, risk.risk_type),
                float(risk.probability),
                _LEVEL_NAMES.get(risk.risk_level, risk.risk_level),
                to_msk_naive(risk.as_of),
                _DECISION_NAMES.get(risk.decision_status, risk.decision_status),
                _REASON_NAMES.get(reason, reason) if reason else "",
                (decision.comment or "") if decision else "",
                ", ".join(work_orders.get(risk.id, [])),
            ]
        )
    return ReportTable(headers=list(COLUMNS), rows=rows)
