"""Dispatchers reject and defer risk forecasts inside their own scope."""
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from src.db import async_session_factory
from src.main import app
from src.models.audit import AuditLogEntry
from src.models.risk import Risk
from src.services.demo_seed import seed_demo_users
from src.services.facility_seed import seed_facility_catalogue

OWN_FACILITY = "fac_5122"
SENIOR_ONLY_FACILITY = "fac_5339"
FOREIGN_FACILITY = "fac_20"

DISPATCHERS = [("dispatcher", "dispatcher123"), ("senior_dispatcher", "senior123")]
NON_DECIDERS = [("coordinator", "coordinator123"), ("engineer", "engineer123")]


async def _seed() -> None:
    async with async_session_factory() as session:
        await seed_facility_catalogue(session)
        await seed_demo_users(session)


async def _add_risk(facility_id: str) -> str:
    risk_id = f"risk_dd_{uuid.uuid4().hex[:10]}"
    as_of = datetime(2041, 1, 1, tzinfo=timezone.utc)
    async with async_session_factory() as session:
        session.add(
            Risk(
                id=risk_id, forecast_id=risk_id, risk_type="fire", target_type="sensor",
                target_id=f"sensor_{risk_id}", facility_id=facility_id, as_of=as_of,
                lead_min_hours=2.0, horizon_hours=6.0,
                prediction_window_start=as_of + timedelta(hours=2),
                prediction_window_end=as_of + timedelta(hours=8), probability=0.6,
                threshold=0.3, risk_level="high", priority_score=0.0, decision_status="open",
                sla_due_at=as_of + timedelta(hours=1), data_health="fresh", model="test",
                top_factors=["f"], recommendation="r", version=1, created_at=as_of,
                updated_at=as_of,
            )
        )
        await session.commit()
    return risk_id


async def _call(username: str, password: str, method: str, path: str, body: dict | None = None):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        login = await client.post(
            "/api/v1/auth/login", json={"username": username, "password": password}
        )
        assert login.status_code == 200, login.text
        headers = {"Authorization": f"Bearer {login.json()['token']}"}
        if method == "GET":
            return await client.get(path, headers=headers)
        return await client.post(path, headers=headers, json=body)


async def _reason_codes(username: str, password: str) -> dict[str, bool]:
    response = await _call(username, password, "GET", "/api/v1/config")
    assert response.status_code == 200, response.text
    return {r["id"]: r["requires_comment"] for r in response.json()["data"]["reject_reasons"]}


@pytest.mark.asyncio
@pytest.mark.parametrize("username,password", DISPATCHERS)
async def test_dispatchers_reject_own_facility_risk_with_config_reason(
    username: str, password: str
) -> None:
    await _seed()
    reasons = await _reason_codes(username, password)
    plain = next(code for code, needs_comment in reasons.items() if not needs_comment)
    risk_id = await _add_risk(OWN_FACILITY)

    response = await _call(
        username, password, "POST", f"/api/v1/risks/{risk_id}/reject",
        {"expected_version": 1, "reason_code": plain},
    )

    assert response.status_code == 200, response.text
    assert (response.json()["decision_status"], response.json()["version"]) == ("rejected", 2)


@pytest.mark.asyncio
@pytest.mark.parametrize("username,password", DISPATCHERS)
async def test_dispatchers_other_reason_requires_comment(username: str, password: str) -> None:
    await _seed()
    reasons = await _reason_codes(username, password)
    assert reasons.get("other") is True, "the 'Другое' reason must require a comment"
    risk_id = await _add_risk(OWN_FACILITY)
    path = f"/api/v1/risks/{risk_id}/reject"

    missing = await _call(
        username, password, "POST", path, {"expected_version": 1, "reason_code": "other"}
    )
    assert missing.status_code == 422, missing.text

    ok = await _call(
        username, password, "POST", path,
        {"expected_version": 1, "reason_code": "other", "comment": "Проверено на месте"},
    )
    assert ok.status_code == 200, ok.text
    assert ok.json()["decision_status"] == "rejected"


@pytest.mark.asyncio
@pytest.mark.parametrize("username,password", DISPATCHERS)
async def test_dispatchers_defer_own_facility_risk(username: str, password: str) -> None:
    await _seed()
    risk_id = await _add_risk(OWN_FACILITY)

    response = await _call(
        username, password, "POST", f"/api/v1/risks/{risk_id}/defer", {"expected_version": 1}
    )

    assert response.status_code == 200, response.text
    assert response.json()["decision_status"] == "deferred"


@pytest.mark.asyncio
async def test_senior_dispatcher_decides_on_every_assigned_facility() -> None:
    await _seed()
    risk_id = await _add_risk(SENIOR_ONLY_FACILITY)
    response = await _call(
        "senior_dispatcher", "senior123", "POST", f"/api/v1/risks/{risk_id}/defer",
        {"expected_version": 1},
    )
    assert response.status_code == 200, response.text


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "username,password,facility_id",
    [
        ("dispatcher", "dispatcher123", FOREIGN_FACILITY),
        ("dispatcher", "dispatcher123", SENIOR_ONLY_FACILITY),
        ("senior_dispatcher", "senior123", FOREIGN_FACILITY),
    ],
)
async def test_dispatchers_get_403_outside_scope(
    username: str, password: str, facility_id: str
) -> None:
    await _seed()
    risk_id = await _add_risk(facility_id)

    reject = await _call(
        username, password, "POST", f"/api/v1/risks/{risk_id}/reject",
        {"expected_version": 1, "reason_code": "false_alarm"},
    )
    defer = await _call(
        username, password, "POST", f"/api/v1/risks/{risk_id}/defer", {"expected_version": 1}
    )

    assert reject.status_code == 403 and reject.json()["error"]["code"] == "FACILITY_ACCESS_DENIED"
    assert defer.status_code == 403 and defer.json()["error"]["code"] == "FACILITY_ACCESS_DENIED"
    async with async_session_factory() as session:
        risk = await session.get(Risk, risk_id)
        assert (risk.decision_status, risk.version) == ("open", 1), "a denied call must not decide"


@pytest.mark.asyncio
@pytest.mark.parametrize("username,password", NON_DECIDERS)
async def test_coordinator_and_engineer_cannot_reject_or_defer(
    username: str, password: str
) -> None:
    await _seed()
    risk_id = await _add_risk(OWN_FACILITY)

    reject = await _call(
        username, password, "POST", f"/api/v1/risks/{risk_id}/reject",
        {"expected_version": 1, "reason_code": "false_alarm"},
    )
    defer = await _call(
        username, password, "POST", f"/api/v1/risks/{risk_id}/defer", {"expected_version": 1}
    )

    assert reject.status_code == 403 and reject.json()["error"]["code"] == "PERMISSION_DENIED"
    assert defer.status_code == 403 and defer.json()["error"]["code"] == "PERMISSION_DENIED"


@pytest.mark.asyncio
async def test_decisions_and_denials_are_journaled() -> None:
    await _seed()
    own = await _add_risk(OWN_FACILITY)
    foreign = await _add_risk(FOREIGN_FACILITY)

    ok = await _call(
        "dispatcher", "dispatcher123", "POST", f"/api/v1/risks/{own}/reject",
        {"expected_version": 1, "reason_code": "false_alarm"},
    )
    out_of_scope = await _call(
        "dispatcher", "dispatcher123", "POST", f"/api/v1/risks/{foreign}/defer",
        {"expected_version": 1},
    )
    no_right = await _call(
        "coordinator", "coordinator123", "POST", f"/api/v1/risks/{own}/defer",
        {"expected_version": 2},
    )
    traces = [r.headers["X-Trace-Id"] for r in (ok, out_of_scope, no_right)]

    async with async_session_factory() as session:
        rows = {
            e.trace_id: e
            for e in (
                await session.execute(
                    select(AuditLogEntry).where(AuditLogEntry.trace_id.in_(traces))
                )
            ).scalars()
        }
    assert len(rows) == 3, f"every call must be journaled, got {len(rows)}"
    decided, scoped, denied = (rows[t] for t in traces)
    assert (decided.action, decided.user_id, decided.result, decided.target_id) == (
        "POST /api/v1/risks/{risk_id}/reject", "usr_dispatcher", "success", own,
    )
    assert (scoped.user_id, scoped.result, scoped.status_code, scoped.target_id) == (
        "usr_dispatcher", "denied", 403, foreign,
    )
    assert (denied.user_id, denied.result, denied.status_code) == ("usr_coordinator", "denied", 403)
