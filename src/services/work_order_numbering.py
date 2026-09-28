"""Concurrency-safe human-readable work-order number generation."""
from datetime import datetime, timezone

from sqlalchemy import extract, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from src.models.work_order import WorkOrder

# PostgreSQL advisory locks share a global integer namespace.  The first key
# identifies Contour work-order numbering and the second key isolates years, so
# requests for different years do not block one another.
_WORK_ORDER_NUMBER_LOCK_NAMESPACE = 0x434F4E54  # ASCII "CONT"


async def generate_display_number(
    session: AsyncSession, *, now: datetime | None = None
) -> str:
    """Generate the next sequential display_number for the current year.

    The transaction-scoped PostgreSQL advisory lock is deliberately acquired
    before reading the current count.  It remains held through the caller's
    INSERT/flush and COMMIT, making ``count + 1`` safe across processes and
    backend replicas without a process-local mutex.

    Args:
        session: An active async database session.
        now: Wall-clock time to derive the year from (defaults to real UTC now).

    Returns:
        "ЗН-{year}-{seq:04d}", e.g. "ЗН-2026-0042".
    """
    now = now or datetime.now(timezone.utc)
    year = now.year
    await session.execute(
        text("SELECT pg_advisory_xact_lock(:namespace, :year)"),
        {"namespace": _WORK_ORDER_NUMBER_LOCK_NAMESPACE, "year": year},
    )
    count = (
        await session.execute(
            select(func.count())
            .select_from(WorkOrder)
            .where(extract("year", WorkOrder.created_at) == year)
        )
    ).scalar_one()
    return f"ЗН-{year}-{count + 1:04d}"
