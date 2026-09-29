"""Idempotent and concurrent POST /api/v1/risks/{risk_id}/confirm."""
import asyncio

import pytest
from sqlalchemy import func, select

from src.db import async_session_factory
from src.models.audit import AuditLogEntry
from src.models.event import Event
from src.models.risk import RiskConfirmMutation
from tests.test_risk_confirm import OWN_FACILITY, _add_risk, _api, _body, client  # noqa: F401

CLIENT_AT = "2026-09-29T09:00:00Z"


def _keyed(key: str, version: int = 1, **extra) -> dict:
    return _body(version, idempotency_key=key, client_occurred_at=CLIENT_AT, **extra)


async def _incidents(risk_id: str) -> int:
    async with async_session_factory() as session:
        return await session.scalar(
            select(func.count()).select_from(Event).where(Event.related_risk_id == risk_id)
        )


async def _domain_audits(risk_id: str) -> int:
    async with async_session_factory() as session:
        return await session.scalar(
            select(func.count())
            .select_from(AuditLogEntry)
            .where(AuditLogEntry.action == "risk.confirm", AuditLogEntry.target_id == risk_id)
        )


@pytest.mark.asyncio
async def test_repeat_with_same_key_replays_the_first_reply(client) -> None:
    api = await _api(client, "dispatcher", "dispatcher123")
    risk_id = await _add_risk(OWN_FACILITY)
    body = _keyed(f"{risk_id}:1:confirm")

    first = await api.confirm(risk_id, body)
    second = await api.confirm(risk_id, body)

    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    assert second.json() == first.json(), "a replay returns the stored reply byte for byte"
    assert await _incidents(risk_id) == 1
    assert await _domain_audits(risk_id) == 1
    async with async_session_factory() as session:
        http = (
            await session.execute(
                select(AuditLogEntry).where(
                    AuditLogEntry.trace_id == second.headers["X-Trace-Id"],
                    AuditLogEntry.action == "POST /api/v1/risks/{risk_id}/confirm",
                )
            )
        ).scalar_one()
    assert http.details["replayed"] is True


@pytest.mark.asyncio
async def test_replay_survives_later_changes_to_the_risk(client) -> None:
    api = await _api(client, "manager", "manager123")
    risk_id = await _add_risk(OWN_FACILITY)
    body = _keyed(f"{risk_id}:replay-late")
    first = await api.confirm(risk_id, body)
    assert first.status_code == 200

    # The risk is now v2/confirmed; a naive retry would hit VERSION_CONFLICT.
    retry = await api.confirm(risk_id, body)

    assert retry.status_code == 200 and retry.json() == first.json()


@pytest.mark.asyncio
async def test_same_key_with_other_body_is_rejected(client) -> None:
    api = await _api(client, "manager", "manager123")
    risk_id = await _add_risk(OWN_FACILITY)
    key = f"{risk_id}:reuse"
    assert (await api.confirm(risk_id, _keyed(key))).status_code == 200

    other_comment = await api.confirm(risk_id, _keyed(key, comment="Другой текст"))

    assert other_comment.status_code == 409
    assert other_comment.json()["error"]["code"] == "IDEMPOTENCY_KEY_REUSED"
    assert await _incidents(risk_id) == 1


@pytest.mark.asyncio
async def test_same_key_for_another_risk_is_rejected(client) -> None:
    api = await _api(client, "manager", "manager123")
    first_risk = await _add_risk(OWN_FACILITY)
    second_risk = await _add_risk(OWN_FACILITY)
    key = f"{first_risk}:shared-key"
    assert (await api.confirm(first_risk, _keyed(key))).status_code == 200

    response = await api.confirm(second_risk, _keyed(key))

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "IDEMPOTENCY_KEY_REUSED"
    assert await _incidents(second_risk) == 0


@pytest.mark.asyncio
async def test_keys_are_per_user(client) -> None:
    manager = await _api(client, "manager", "manager123")
    dispatcher = await _api(client, "dispatcher", "dispatcher123")
    first_risk = await _add_risk(OWN_FACILITY)
    second_risk = await _add_risk(OWN_FACILITY)
    key = f"{first_risk}:per-user"

    assert (await manager.confirm(first_risk, _keyed(key))).status_code == 200
    other = await dispatcher.confirm(second_risk, _keyed(key))

    assert other.status_code == 200, "another user's key namespace is independent"
    assert other.json()["risk"]["id"] == second_risk


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "extra", [{"idempotency_key": "only-the-key-1"}, {"client_occurred_at": CLIENT_AT}]
)
async def test_key_and_client_time_go_together(client, extra: dict) -> None:
    api = await _api(client, "manager", "manager123")
    risk_id = await _add_risk(OWN_FACILITY)

    response = await api.confirm(risk_id, _body(**extra))

    assert response.status_code == 422
    assert await _incidents(risk_id) == 0


@pytest.mark.asyncio
async def test_mutation_row_stores_the_reply(client) -> None:
    api = await _api(client, "manager", "manager123")
    risk_id = await _add_risk(OWN_FACILITY)
    key = f"{risk_id}:stored"
    reply = await api.confirm(risk_id, _keyed(key))

    async with async_session_factory() as session:
        row = (
            await session.execute(
                select(RiskConfirmMutation).where(RiskConfirmMutation.idempotency_key == key)
            )
        ).scalar_one()
    assert (row.risk_id, row.actor_id) == (risk_id, "usr_manager")
    assert row.response_payload == reply.json()


@pytest.mark.asyncio
@pytest.mark.parametrize("round_no", range(5))
async def test_concurrent_confirmations_create_one_incident(client, round_no: int) -> None:
    manager = await _api(client, "manager", "manager123")
    dispatcher = await _api(client, "dispatcher", "dispatcher123")
    risk_id = await _add_risk(OWN_FACILITY)

    replies = await asyncio.gather(
        manager.confirm(risk_id, _keyed(f"{risk_id}:m:{round_no}")),
        dispatcher.confirm(risk_id, _keyed(f"{risk_id}:d:{round_no}")),
    )

    codes = sorted(r.status_code for r in replies)
    assert codes == [200, 409], [r.text for r in replies]
    loser = next(r for r in replies if r.status_code == 409)
    assert loser.json()["error"]["code"] in {"VERSION_CONFLICT", "INVALID_TRANSITION"}
    assert await _incidents(risk_id) == 1


@pytest.mark.asyncio
async def test_concurrent_retries_with_one_key_share_one_reply(client) -> None:
    api = await _api(client, "dispatcher", "dispatcher123")
    risk_id = await _add_risk(OWN_FACILITY)
    body = _keyed(f"{risk_id}:double-click")

    replies = await asyncio.gather(*(api.confirm(risk_id, body) for _ in range(3)))

    assert [r.status_code for r in replies] == [200, 200, 200], [r.text for r in replies]
    assert len({r.json()["incident"]["id"] for r in replies}) == 1
    assert await _incidents(risk_id) == 1
