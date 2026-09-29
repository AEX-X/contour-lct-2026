"""GET /api/v1/analytics/daily-trend: per-day incidents, new risks, closed work orders."""
import uuid
from datetime import date, datetime, timedelta, timezone

import pytest
from httpx import ASGITransport, AsyncClient

from src.db import async_session_factory
from src.main import app
from src.models.event import Event
from src.models.risk import Risk
from src.models.work_order import WorkOrder
from src.services.analytics_trend import MSK
from src.services.demo_seed import seed_demo_users
from src.services.facility_seed import seed_facility_catalogue

SENIOR_FACILITY = "fac_5122"
OTHER_FACILITY = "fac_20"


def _utc(*args: int) -> datetime:
    return datetime(*args, tzinfo=timezone.utc)


def _event(facility_id: str, at: datetime, confirmed: bool = True) -> Event:
    return Event(
        id=f"evt_tr_{uuid.uuid4().hex[:12]}", source_reading_id=None, event_type="fire",
        source="test", facility_id=facility_id, sensor_id="sensor_tr", occurred_at=at,
        ingested_at=at, state="alarm", value="1", is_confirmed_incident=confirmed,
        verification_result=None, resolved_at=None, related_risk_id=None,
    )


def _risk(facility_id: str, at: datetime, invalidated: bool = False) -> Risk:
    risk_id = f"risk_tr_{uuid.uuid4().hex[:12]}"
    return Risk(
        id=risk_id, forecast_id=risk_id, risk_type="fire", target_type="facility",
        target_id=facility_id, facility_id=facility_id, as_of=at, is_invalidated=invalidated,
        lead_min_hours=0.0, horizon_hours=24.0, prediction_window_start=at,
        prediction_window_end=at + timedelta(hours=24), probability=0.5, threshold=0.3,
        risk_level="medium", priority_score=0.0, decision_status="open",
        sla_due_at=at + timedelta(hours=4), data_health="fresh", model="test", top_factors=[],
        recommendation="r", version=1, created_at=at, updated_at=at,
    )


def _work_order(facility_id: str, closed_at: datetime, status: str = "closed") -> WorkOrder:
    tag = uuid.uuid4().hex[:12]
    return WorkOrder(
        id=f"wo_tr_{tag}", display_number=f"TR-{tag}", source_risk_id=None,
        facility_id=facility_id, target_entity_type="facility", target_entity_id=facility_id,
        work_type="inspection", priority="P3", due_at=closed_at, description="trend",
        symptoms=[], status=status, created_by="usr_manager", created_at=closed_at,
        updated_at=closed_at, closed_at=closed_at, version=1,
    )


async def _seed(rows: list) -> None:
    async with async_session_factory() as session:
        await seed_facility_catalogue(session)
        await seed_demo_users(session)
        session.add_all(rows)
        await session.commit()


async def _trend(username: str, password: str, params: dict | None = None):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        login = await client.post(
            "/api/v1/auth/login", json={"username": username, "password": password}
        )
        assert login.status_code == 200, login.text
        return await client.get(
            "/api/v1/analytics/daily-trend",
            headers={"Authorization": f"Bearer {login.json()['token']}"},
            params=params or {},
        )


def _by_day(response) -> dict[str, tuple[int, int, int]]:
    return {r["day"]: (r["incidents"], r["risks"], r["closed"]) for r in response.json()["data"]}


@pytest.mark.asyncio
async def test_counts_each_series_per_msk_day_with_zero_days() -> None:
    await _seed([
        # 00:30 MSK on June 1 is still May 31 in UTC: counts for June 1.
        _event(SENIOR_FACILITY, _utc(2048, 5, 31, 21, 30)),
        _event(SENIOR_FACILITY, _utc(2048, 6, 1, 12, 0)),
        _event(SENIOR_FACILITY, _utc(2048, 6, 1, 13, 0), confirmed=False),
        # 23:59 MSK on May 31: outside the period.
        _event(SENIOR_FACILITY, _utc(2048, 5, 31, 20, 59)),
        _event(SENIOR_FACILITY, _utc(2048, 6, 3, 8, 0)),
        _risk(SENIOR_FACILITY, _utc(2048, 6, 2, 1, 0)),
        _risk(SENIOR_FACILITY, _utc(2048, 6, 2, 9, 0)),
        _risk(SENIOR_FACILITY, _utc(2048, 6, 2, 20, 59, 59)),
        _risk(SENIOR_FACILITY, _utc(2048, 6, 2, 10, 0), invalidated=True),
        _work_order(SENIOR_FACILITY, _utc(2048, 6, 1, 10, 0)),
        _work_order(SENIOR_FACILITY, _utc(2048, 6, 1, 11, 0), status="cancelled"),
        # 23:59:59 MSK on June 7 counts; 00:00 MSK on June 8 does not.
        _work_order(SENIOR_FACILITY, _utc(2048, 6, 7, 20, 59, 59)),
        _work_order(SENIOR_FACILITY, _utc(2048, 6, 7, 21, 0)),
    ])

    response = await _trend("manager", "manager123", {"from": "2048-06-01", "to": "2048-06-07"})

    assert response.status_code == 200, response.text
    days = [r["day"] for r in response.json()["data"]]
    assert days == [(date(2048, 6, 1) + timedelta(days=i)).isoformat() for i in range(7)]
    assert _by_day(response) == {
        "2048-06-01": (2, 0, 1),
        "2048-06-02": (0, 3, 0),
        "2048-06-03": (1, 0, 0),
        "2048-06-04": (0, 0, 0),
        "2048-06-05": (0, 0, 0),
        "2048-06-06": (0, 0, 0),
        "2048-06-07": (0, 0, 1),
    }
    meta = response.json()["meta"]
    assert (meta["from"], meta["to"], meta["timezone"]) == (
        "2048-06-01", "2048-06-07", "Europe/Moscow",
    )


@pytest.mark.asyncio
async def test_scope_limits_counts_to_own_facilities() -> None:
    at = _utc(2049, 6, 1, 9, 0)
    await _seed([
        _event(SENIOR_FACILITY, at), _risk(SENIOR_FACILITY, at), _work_order(SENIOR_FACILITY, at),
        _event(OTHER_FACILITY, at), _risk(OTHER_FACILITY, at), _work_order(OTHER_FACILITY, at),
        _risk(OTHER_FACILITY, at),
    ])
    period = {"from": "2049-06-01", "to": "2049-06-01"}

    manager = await _trend("manager", "manager123", period)
    senior = await _trend("senior_dispatcher", "senior123", period)

    assert _by_day(manager) == {"2049-06-01": (2, 3, 2)}, "the manager sees every facility"
    assert _by_day(senior) == {"2049-06-01": (1, 1, 1)}, "a dispatcher sees only own facilities"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "username,password",
    [
        ("dispatcher", "dispatcher123"),
        ("coordinator", "coordinator123"),
        ("engineer", "engineer123"),
    ],
)
async def test_roles_without_summary_analytics_get_403(username: str, password: str) -> None:
    await _seed([])
    response = await _trend(username, password)
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "PERMISSION_DENIED"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "params",
    [
        {"from": "01.06.2048"},
        {"to": "2048-13-01"},
        {"from": "2048-06-08", "to": "2048-06-01"},
        {"from": "2048-01-01", "to": "2048-04-02"},
    ],
)
async def test_bad_or_too_long_period_is_400(params: dict) -> None:
    await _seed([])
    response = await _trend("manager", "manager123", params)
    assert response.status_code == 400, response.text
    error = response.json()["error"]
    assert error["code"] == "VALIDATION_ERROR" and error["message"]


@pytest.mark.asyncio
async def test_longest_allowed_period_is_92_days() -> None:
    await _seed([])
    response = await _trend("manager", "manager123", {"from": "2048-01-01", "to": "2048-03-31"})
    assert response.status_code == 200, response.text
    assert len(response.json()["data"]) == 91
    # 2048 is a leap year: January 1 to April 1 is exactly 92 days.
    response = await _trend("manager", "manager123", {"from": "2048-01-01", "to": "2048-04-01"})
    assert response.status_code == 200 and len(response.json()["data"]) == 92
    response = await _trend("manager", "manager123", {"from": "2048-01-01", "to": "2048-04-02"})
    assert response.status_code == 400


@pytest.mark.asyncio
async def test_default_period_is_last_seven_msk_days() -> None:
    await _seed([])
    today = datetime.now(timezone.utc).astimezone(MSK).date()

    response = await _trend("manager", "manager123")

    assert response.status_code == 200, response.text
    days = [r["day"] for r in response.json()["data"]]
    assert days[-1] in {today.isoformat(), (today + timedelta(days=1)).isoformat()}
    assert len(days) == 7

    only_from = await _trend("manager", "manager123", {"from": "2048-06-01"})
    assert [r["day"] for r in only_from.json()["data"]][-1] == "2048-06-07"
