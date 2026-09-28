"""Compatibility shim after replacing the time-based demo lifecycle.

Work orders now move only through authenticated action commands. These
functions intentionally never mutate state; old imports remain valid while
callers migrate to ``POST /work-orders/{id}/actions``.
"""

from datetime import datetime

from sqlalchemy.ext.asyncio import AsyncSession


def status_for_elapsed(created_at: datetime, now: datetime) -> str:
    """Return draft regardless of elapsed wall time.

    Time is no longer a business event and cannot progress a work order.
    """
    del created_at, now
    return "draft"


async def sync_work_order_statuses(
    session: AsyncSession, *, now: datetime | None = None
) -> int:
    """Do nothing; retained only for backward import compatibility."""
    del session, now
    return 0
