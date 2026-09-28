"""Tests for concurrency-safe work-order display-number generation."""
import asyncio
from datetime import datetime, timezone
from uuid import uuid4

import pytest
from sqlalchemy import delete

from src.db import async_session_factory
from src.models.auth import User
from src.models.work_order import WorkOrder
from src.services.work_order_numbering import generate_display_number


async def _seed_user(user_id: str) -> None:
    async with async_session_factory() as session:
        if await session.get(User, user_id) is None:
            session.add(
                User(
                    id=user_id,
                    username=user_id,
                    password_hash="x",
                    display_name=user_id,
                    role="test",
                )
            )
            await session.commit()


async def _delete_test_orders(user_id: str) -> None:
    async with async_session_factory() as session:
        await session.execute(delete(WorkOrder).where(WorkOrder.created_by == user_id))
        await session.commit()


async def _insert(work_order_id: str, display_number: str, created_at: datetime) -> None:
    async with async_session_factory() as session:
        session.add(
            WorkOrder(
                id=work_order_id,
                display_number=display_number,
                source_risk_id=None,
                facility_id=None,
                target_entity_type="sensor",
                target_entity_id="sensor_numbering_test",
                work_type="inspection",
                priority="medium",
                due_at=created_at,
                description="test",
                comment=None,
                status="draft",
                created_by="usr_wo_numbering_test",
                created_at=created_at,
                updated_at=created_at,
            )
        )
        await session.commit()


@pytest.mark.asyncio
async def test_display_numbers_are_sequential_within_a_year() -> None:
    await _seed_user("usr_wo_numbering_test")
    await _delete_test_orders("usr_wo_numbering_test")
    year = datetime(2044, 6, 1, tzinfo=timezone.utc)

    async with async_session_factory() as session:
        first = await generate_display_number(session, now=year)
    assert first == "ЗН-2044-0001"
    await _insert("wo_numbering_1", first, year)

    async with async_session_factory() as session:
        second = await generate_display_number(session, now=year)
    assert second == "ЗН-2044-0002"
    await _insert("wo_numbering_2", second, year)

    async with async_session_factory() as session:
        third = await generate_display_number(session, now=year)
    assert third == "ЗН-2044-0003"


@pytest.mark.asyncio
async def test_different_year_starts_a_fresh_sequence() -> None:
    await _seed_user("usr_wo_numbering_test")
    await _delete_test_orders("usr_wo_numbering_test")
    async with async_session_factory() as session:
        number = await generate_display_number(
            session, now=datetime(2045, 6, 1, tzinfo=timezone.utc)
        )
    assert number == "ЗН-2045-0001"


@pytest.mark.asyncio
async def test_concurrent_transactions_receive_unique_sequential_numbers() -> None:
    """Twenty independent PostgreSQL transactions must never collide."""
    await _seed_user("usr_wo_numbering_concurrency")
    await _delete_test_orders("usr_wo_numbering_concurrency")
    year = datetime(2046, 6, 1, tzinfo=timezone.utc)

    async def create_one(index: int) -> str:
        async with async_session_factory() as session:
            display_number = await generate_display_number(session, now=year)
            now = datetime(2046, 6, index + 1, tzinfo=timezone.utc)
            session.add(
                WorkOrder(
                    id=f"wo_numbering_concurrent_{uuid4().hex}",
                    display_number=display_number,
                    source_risk_id=None,
                    facility_id=None,
                    target_entity_type="sensor",
                    target_entity_id=f"sensor_numbering_concurrent_{index}",
                    work_type="inspection",
                    priority="medium",
                    due_at=now,
                    description="concurrent numbering test",
                    comment=None,
                    status="draft",
                    created_by="usr_wo_numbering_concurrency",
                    created_at=year,
                    updated_at=year,
                )
            )
            await session.commit()
            return display_number

    numbers = await asyncio.gather(*(create_one(index) for index in range(20)))

    assert len(numbers) == len(set(numbers)) == 20
    assert sorted(numbers) == [f"ЗН-2046-{index:04d}" for index in range(1, 21)]
