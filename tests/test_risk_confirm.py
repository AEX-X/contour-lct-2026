"""POST /api/v1/risks/{risk_id}/confirm: a risk becomes a confirmed incident."""
import json
import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select

from src.db import async_session_factory
from src.main import app
from src.models.audit import AuditLogEntry
from src.models.event import Event
from src.models.risk import Risk, RiskDecision
from src.services.demo_seed import seed_demo_users
from src.services.facility_seed import seed_facility_catalogue

OWN_FACILITY = "fac_5122"
FOREIGN_FACILITY = "fac_20"
COMMENT = "Прогноз проверен диспетчером. Требуется выезд"
CONFIRMERS = [
    ("manager", "manager123"),
    ("senior_dispatcher", "senior123"),
    ("dispatcher", "dispatcher123"),
]
INCIDENT_FIELDS = {
    "id", "version", "facility_id", "target", "source_risk_id", "title", "description",
    "severity", "status", "confirmed_at", "confirmed_by", "resolved_at", "failure_episode_id",
}


async def _seed() -> None:
    async with async_session_factory() as session:
        await seed_facility_catalogue(session)
        await seed_demo_users(session)


async def _add_risk(
    facility_id: str, *, level: str = "high", target_type: str = "sensor", status: str = "open"
) -> str:
    risk_id = f"risk_cf_{uuid.uuid4().hex[:10]}"
    as_of = datetime(2041, 1, 1, tzinfo=timezone.utc)
    target_id = facility_id if target_type == "facility" else f"sensor_{risk_id}"
    async with async_session_factory() as session:
        session.add(
            Risk(
                id=risk_id, forecast_id=risk_id, risk_type="fire", target_type=target_type,
                target_id=target_id, facility_id=facility_id, as_of=as_of,
                lead_min_hours=2.0, horizon_hours=6.0,
                prediction_window_start=as_of + timedelta(hours=2),
                prediction_window_end=as_of + timedelta(hours=8), probability=0.8,
                threshold=0.6, risk_level=level, priority_score=0.0, decision_status=status,
                sla_due_at=as_of + timedelta(hours=1), data_health="fresh", model="test",
                top_factors=["f"], recommendation="r", version=1, created_at=as_of,
                updated_at=as_of,
            )
        )
        await session.commit()
    return risk_id


class Api:
    """A logged-in test client for one demo user."""

    def __init__(self, client: AsyncClient, token: str) -> None:
        self.client = client
        self.headers = {"Authorization": f"Bearer {token}"}

    async def confirm(self, risk_id: str, body: dict):
        return await self.client.post(
            f"/api/v1/risks/{risk_id}/confirm", headers=self.headers, json=body
        )

    async def get(self, path: str, params: dict | None = None):
        return await self.client.get(path, headers=self.headers, params=params)

    async def post(self, path: str, body: dict):
        return await self.client.post(path, headers=self.headers, json=body)


async def _api(client: AsyncClient, username: str, password: str) -> Api:
    login = await client.post(
        "/api/v1/auth/login", json={"username": username, "password": password}
    )
    assert login.status_code == 200, login.text
    return Api(client, login.json()["token"])


@pytest.fixture
async def client():
    await _seed()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


def _body(version: int = 1, **extra) -> dict:
    return {"expected_version": version, "comment": COMMENT, **extra}


@pytest.mark.asyncio
@pytest.mark.parametrize("username,password", CONFIRMERS)
async def test_confirm_returns_risk_incident_and_audit(client, username, password) -> None:
    api = await _api(client, username, password)
    risk_id = await _add_risk(OWN_FACILITY)

    response = await api.confirm(risk_id, _body())

    assert response.status_code == 200, response.text
    payload = response.json()
    assert set(payload) == {"risk", "incident", "audit_event_id"}
    risk = payload["risk"]
    assert (risk["id"], risk["decision_status"], risk["version"]) == (risk_id, "confirmed", 2)
    incident = payload["incident"]
    assert set(incident) == INCIDENT_FIELDS, "incident must cover the frontend Incident model"
    assert incident["source_risk_id"] == risk_id
    assert incident["facility_id"] == OWN_FACILITY
    assert incident["target"]["type"] == "sensor"
    assert incident["target"]["id"] == f"sensor_{risk_id}"
    assert (incident["status"], incident["severity"], incident["version"]) == ("open", "high", 1)
    assert incident["description"] == COMMENT
    assert incident["title"].startswith("Подтверждена необходимость проверки")
    assert incident["confirmed_by"]["id"] == f"usr_{username}"
    assert incident["resolved_at"] is None

    async with async_session_factory() as session:
        audit = await session.get(AuditLogEntry, int(payload["audit_event_id"]))
        stored = await session.get(Risk, risk_id)
        decisions = (
            await session.execute(select(RiskDecision).where(RiskDecision.risk_id == risk_id))
        ).scalars().all()
    assert audit is not None, "audit_event_id must point to a journal row"
    assert (audit.action, audit.target_type, audit.target_id, audit.user_id) == (
        "risk.confirm", "risk", risk_id, f"usr_{username}",
    )
    assert audit.details["incident_id"] == incident["id"]
    assert (audit.details["before_version"], audit.details["after_version"]) == (1, 2)
    assert (stored.decision_status, stored.version) == ("confirmed", 2)
    assert [(d.decision, d.comment) for d in decisions] == [("confirmed", COMMENT)]


@pytest.mark.asyncio
async def test_facility_target_uses_facility_name_and_critical_maps_to_alarm(client) -> None:
    api = await _api(client, "manager", "manager123")
    risk_id = await _add_risk(OWN_FACILITY, level="critical", target_type="facility")

    response = await api.confirm(risk_id, _body())

    assert response.status_code == 200, response.text
    incident = response.json()["incident"]
    assert incident["target"]["type"] == "facility"
    assert incident["target"]["display_name"] != OWN_FACILITY, "facility name, not its id"
    assert incident["title"].endswith(incident["target"]["display_name"])
    async with async_session_factory() as session:
        event = await session.get(Event, incident["id"])
    assert event.state == "alarm", "a critical risk must read as a critical incident"


@pytest.mark.asyncio
async def test_confirmed_incident_is_listed_in_event_journal(client) -> None:
    api = await _api(client, "dispatcher", "dispatcher123")
    risk_id = await _add_risk(OWN_FACILITY)
    confirmed = (await api.confirm(risk_id, _body())).json()

    listed = await api.get(
        "/api/v1/events",
        {"is_confirmed_incident": "true", "facility_id": OWN_FACILITY, "limit": 200},
    )

    assert listed.status_code == 200, listed.text
    rows = {row["id"]: row for row in listed.json()["data"]}
    assert confirmed["incident"]["id"] in rows, "the incident must appear in the journal at once"
    row = rows[confirmed["incident"]["id"]]
    assert row["is_confirmed_incident"] is True
    assert row["related_risk_id"] == risk_id
    assert row["facility_id"] == OWN_FACILITY
    assert row["sensor_id"] == f"sensor_{risk_id}"
    assert row["state"] == "warning" and row["value"] == COMMENT
    assert row["resolved_at"] is None

    dump_path = os.environ.get("CONTOUR_CONFIRMED_INCIDENT_DUMP")
    if dump_path:
        with open(dump_path, "w", encoding="utf-8") as fh:
            json.dump(
                {
                    "events": {"data": [row], "meta": listed.json()["meta"]},
                    "risk": confirmed["risk"],
                    "incident": confirmed["incident"],
                },
                fh,
                ensure_ascii=False,
            )

    foreign = await _api(client, "senior_dispatcher", "senior123")
    other_risk = await _add_risk(OWN_FACILITY)
    await foreign.confirm(other_risk, _body())
    outsider = await _api(client, "engineer", "engineer123")
    hidden = await outsider.get("/api/v1/events", {"is_confirmed_incident": "true"})
    if hidden.status_code == 200:
        assert not {r["related_risk_id"] for r in hidden.json()["data"]} & {risk_id, other_risk}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "username,password", [("coordinator", "coordinator123"), ("engineer", "engineer123")]
)
async def test_roles_without_risk_confirm_get_403(client, username, password) -> None:
    api = await _api(client, username, password)
    risk_id = await _add_risk(OWN_FACILITY)

    response = await api.confirm(risk_id, _body())

    assert response.status_code == 403
    assert response.json()["error"]["code"] == "PERMISSION_DENIED"


@pytest.mark.asyncio
async def test_risk_outside_scope_is_403_and_untouched(client) -> None:
    api = await _api(client, "dispatcher", "dispatcher123")
    risk_id = await _add_risk(FOREIGN_FACILITY)

    response = await api.confirm(risk_id, _body())

    assert response.status_code == 403
    assert response.json()["error"]["code"] == "FACILITY_ACCESS_DENIED"
    assert "details" not in response.json()["error"] or not response.json()["error"]["details"]
    async with async_session_factory() as session:
        stored = await session.get(Risk, risk_id)
        incidents = await session.scalar(
            select(func.count()).select_from(Event).where(Event.related_risk_id == risk_id)
        )
    assert (stored.decision_status, stored.version, incidents) == ("open", 1, 0)


@pytest.mark.asyncio
async def test_unknown_risk_is_404(client) -> None:
    api = await _api(client, "manager", "manager123")
    response = await api.confirm("risk_does_not_exist", _body())
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_stale_version_is_409_with_current_risk(client) -> None:
    api = await _api(client, "manager", "manager123")
    risk_id = await _add_risk(OWN_FACILITY)
    acknowledged = await api.post(f"/api/v1/risks/{risk_id}/acknowledge", {"expected_version": 1})
    assert acknowledged.status_code == 200

    response = await api.confirm(risk_id, _body(version=1))

    assert response.status_code == 409
    error = response.json()["error"]
    assert error["code"] == "VERSION_CONFLICT"
    assert error["details"]["current"]["id"] == risk_id
    assert error["details"]["current"]["version"] == 2
    assert error["details"]["current"]["decision_status"] == "acknowledged"

    ok = await api.confirm(risk_id, _body(version=2))
    assert ok.status_code == 200, "an acknowledged risk can still be confirmed"


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["rejected", "confirmed"])
async def test_final_decision_cannot_be_confirmed(client, status: str) -> None:
    api = await _api(client, "manager", "manager123")
    risk_id = await _add_risk(OWN_FACILITY, status=status)

    response = await api.confirm(risk_id, _body())

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "INVALID_TRANSITION"


@pytest.mark.asyncio
async def test_second_confirmation_is_rejected_and_creates_no_second_incident(client) -> None:
    api = await _api(client, "manager", "manager123")
    risk_id = await _add_risk(OWN_FACILITY)
    assert (await api.confirm(risk_id, _body())).status_code == 200

    again = await api.confirm(risk_id, _body(version=2))

    assert again.status_code == 409
    assert again.json()["error"]["code"] == "INVALID_TRANSITION"
    async with async_session_factory() as session:
        incidents = await session.scalar(
            select(func.count()).select_from(Event).where(Event.related_risk_id == risk_id)
        )
    assert incidents == 1


@pytest.mark.asyncio
async def test_confirmed_risk_cannot_be_rejected_or_deferred_afterwards(client) -> None:
    api = await _api(client, "manager", "manager123")
    risk_id = await _add_risk(OWN_FACILITY)
    assert (await api.confirm(risk_id, _body())).status_code == 200

    reject = await api.post(
        f"/api/v1/risks/{risk_id}/reject", {"expected_version": 2, "reason_code": "false_alarm"}
    )
    defer = await api.post(f"/api/v1/risks/{risk_id}/defer", {"expected_version": 2})

    assert reject.status_code == 409 and reject.json()["error"]["code"] == "INVALID_TRANSITION"
    assert defer.status_code == 409 and defer.json()["error"]["code"] == "INVALID_TRANSITION"


@pytest.mark.asyncio
async def test_confirmed_status_is_in_config_catalogue(client) -> None:
    api = await _api(client, "manager", "manager123")
    config = await api.get("/api/v1/config")
    statuses = {s["id"] for s in config.json()["data"]["decision_statuses"]}
    assert "confirmed" in statuses


@pytest.mark.asyncio
async def test_confirm_requires_a_comment(client) -> None:
    api = await _api(client, "manager", "manager123")
    risk_id = await _add_risk(OWN_FACILITY)
    response = await api.confirm(risk_id, {"expected_version": 1, "comment": ""})
    assert response.status_code in (400, 422)


@pytest.mark.asyncio
async def test_confirm_and_denial_are_journaled(client) -> None:
    manager = await _api(client, "manager", "manager123")
    coordinator = await _api(client, "coordinator", "coordinator123")
    risk_id = await _add_risk(OWN_FACILITY)

    ok = await manager.confirm(risk_id, _body())
    denied = await coordinator.confirm(risk_id, _body(version=2))
    traces = [ok.headers["X-Trace-Id"], denied.headers["X-Trace-Id"]]

    async with async_session_factory() as session:
        rows = (
            await session.execute(select(AuditLogEntry).where(AuditLogEntry.trace_id.in_(traces)))
        ).scalars().all()
    http_ok = [r for r in rows if r.trace_id == traces[0] and r.action.startswith("POST ")]
    domain = [r for r in rows if r.trace_id == traces[0] and r.action == "risk.confirm"]
    refused = [r for r in rows if r.trace_id == traces[1]]
    assert len(http_ok) == 1 and http_ok[0].action == "POST /api/v1/risks/{risk_id}/confirm"
    assert http_ok[0].details["incident_id"] == ok.json()["incident"]["id"]
    assert len(domain) == 1 and str(domain[0].id) == ok.json()["audit_event_id"]
    assert len(refused) == 1
    assert (refused[0].result, refused[0].status_code, refused[0].user_id) == (
        "denied", 403, "usr_coordinator",
    )
