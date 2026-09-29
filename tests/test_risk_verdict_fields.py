"""verdict and blind_spots from the ML object models reach the risk card."""
import json
from datetime import datetime, timezone

import httpx
import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from src.db import async_session_factory
from src.main import app
from src.models.hierarchy import Facility
from src.models.risk import Risk
from src.models.sensor import SensorChannel, SensorReading
from src.services.demo_seed import seed_demo_users
from src.services.ml_port import PredictionInput, PredictionResult
from src.services.object_risk_sync import sync_object_risks
from src.services.risk_sync import sync_risks

NOW = datetime(2044, 2, 1, tzinfo=timezone.utc)
TAG = "vbs"


def _row(object_id: str, **extra) -> dict:
    return {
        "status": "ok", "object_id": object_id, "alert": True, "probability": 0.7, "model_name": f"vbs-{object_id}",
        "model_threshold": 0.6, "top_factors": [], "suspect_channels": [], **extra,
    }


async def _seed() -> None:
    async with async_session_factory() as session:
        await seed_demo_users(session)
        for suffix in ("full", "bare", "broken", "sensor"):
            facility_id = f"fac_{TAG}_{suffix}"
            if await session.get(Facility, facility_id) is None:
                session.add(Facility(id=facility_id, display_name=facility_id, facility_type="test", district_id=None))
        await session.commit()


async def _sync_facilities() -> None:
    rows = [
        _row(f"{TAG}_full", verdict="Инцидент на объекте с вероятностью 0,70 за 72 ч", blind_spots=["нет датчиков затопления", "2 канала без записей за 30 суток"]),
        _row(f"{TAG}_bare"),
        _row(f"{TAG}_broken", verdict=123, blind_spots="нет датчиков дыма"),
    ]

    def handle(request: httpx.Request) -> httpx.Response:
        target = json.loads(request.content)["target"]
        return httpx.Response(200, json={"horizon_hours": 72, "objects": rows if target == "incident" else []})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handle), base_url="http://ml")
    async with client, async_session_factory() as session:
        assert await sync_object_risks(session, client, now=NOW) == 3


async def _card(target_id: str, facility_id: str | None = None) -> tuple[dict, dict]:
    async with async_session_factory() as session:
        risk_id = (await session.execute(select(Risk.id).where(Risk.target_id == target_id))).scalar_one()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        token = (await client.post("/api/v1/auth/login", json={"username": "manager", "password": "manager123"})).json()["token"]
        headers = {"Authorization": f"Bearer {token}"}
        card = await client.get(f"/api/v1/risks/{risk_id}", headers=headers)
        listing = await client.get("/api/v1/risks", headers=headers, params={"facility_id": facility_id or target_id, "limit": 200})
    assert card.status_code == 200, card.text
    item = next(r for r in listing.json()["data"] if r["id"] == risk_id)
    return card.json(), item


@pytest.mark.asyncio
async def test_verdict_and_blind_spots_reach_card_and_list() -> None:
    await _seed()
    await _sync_facilities()
    card, item = await _card(f"fac_{TAG}_full")
    for body in (card, item):
        assert body["verdict"] == "Инцидент на объекте с вероятностью 0,70 за 72 ч"
        assert body["blind_spots"] == ["нет датчиков затопления", "2 канала без записей за 30 суток"]


@pytest.mark.asyncio
async def test_absent_fields_give_null_and_empty_list() -> None:
    card, item = await _card(f"fac_{TAG}_bare")
    for body in (card, item):
        assert body["verdict"] is None
        assert body["blind_spots"] == []


@pytest.mark.asyncio
async def test_malformed_fields_are_ignored_but_the_risk_is_kept() -> None:
    card, _ = await _card(f"fac_{TAG}_broken")
    assert card["verdict"] is None
    assert card["blind_spots"] == []
    assert card["risk_level"] == "medium", "the forecast itself must still be stored"


class _Predictor:
    async def predict(self, _: PredictionInput) -> PredictionResult:
        return PredictionResult(
            probability=0.5, lead_min_hours=0.0, prediction_window_hours=24.0, top_factors=["f"],
            recommendation="r", model_name="vbs-sensor",
        )


@pytest.mark.asyncio
async def test_sensor_risks_have_null_verdict_and_empty_blind_spots() -> None:
    channel_id = f"{TAG}_sensor_channel"
    async with async_session_factory() as session:
        session.add(
            SensorChannel(
                id=f"sensor_{channel_id}", channel_id=channel_id, tag="", sensor_type_id="smoke_detector",
                system_type="fire_protection", display_name=channel_id, facility_id=f"fac_{TAG}_sensor", hierarchy_node_id=None,
            )
        )
        session.add(
            SensorReading(
                channel_id=channel_id, occurred_at=NOW, is_alarm=True, raw_value="x", numeric_value=None,
                is_anomaly=False, source_event_id=f"{TAG}_sensor", origin="historical",
            )
        )
        await session.commit()
    async with async_session_factory() as session:
        await sync_risks(session, _Predictor(), now=NOW)
    card, _ = await _card(f"sensor_{channel_id}", f"fac_{TAG}_sensor")
    assert card["verdict"] is None
    assert card["blind_spots"] == []
