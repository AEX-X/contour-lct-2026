"""Fail when an active real-model risk lacks model-clock provenance."""

import asyncio

from sqlalchemy import func, select

from src.db import async_session_factory
from src.models.risk import Risk


async def main() -> None:
    """Check the invariant used by Full-mode smoke tests."""
    async with async_session_factory() as session:
        count = (
            await session.execute(
                select(func.count())
                .select_from(Risk)
                .where(
                    Risk.model != "stub-v1",
                    Risk.demo_clock.is_(None),
                    Risk.is_invalidated.is_(False),
                )
            )
        ).scalar_one()
    if count:
        raise SystemExit(
            f"{count} active real-model risk(s) lack demo_clock provenance"
        )


if __name__ == "__main__":
    asyncio.run(main())
