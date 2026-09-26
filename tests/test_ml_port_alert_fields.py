"""Optional model-alert fields (alert, model_threshold, horizon_hours) in the ML Prediction Port."""
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
from src.services.ml_predictor_http import HttpMLPredictor, MLPredictorError
from src.services.risk_sync import sync_risks

_BASE = {
    "probability": 0.2,
    "lead_min_hours": 0,
    "prediction_window_hours": 24,
    "top_factors": ["f"],
    "recommendation": "r",
    "model_name": "m",
}
_INPUT = PredictionInput(
    target_type="sensor", target_id="sensor_1", risk_type="fire",
    as_of=datetime(2040, 1, 1, tzinfo=timezone.utc),
    recent_alarm_count=1, recent_anomaly_count=0, window_hours=1.0,
)


async def _predict_with(body: dict) -> PredictionResult:
    def handle(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=json.dumps(body))

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle), base_url="http://ml") as client:
        return await HttpMLPredictor(client).predict(_INPUT)


@pytest.mark.asyncio
async def test_response_without_new_fields_parses_as_before() -> None:
    result = await _predict_with(_BASE)
    assert (result.alert, result.model_threshold, result.horizon_hours) == (None, None, None)
    assert result.probability == 0.2


@pytest.mark.asyncio
async def test_new_fields_are_carried() -> None:
    result = await _predict_with({**_BASE, "alert": True, "model_threshold": 0.147, "horizon_hours": 24})
    assert (result.alert, result.model_threshold, result.horizon_hours) == (True, 0.147, 24.0)


@pytest.mark.asyncio
async def test_null_means_absent() -> None:
    result = await _predict_with({**_BASE, "alert": None, "model_threshold": None, "horizon_hours": None})
    assert (result.alert, result.model_threshold, result.horizon_hours) == (None, None, None)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "extra",
    [
        {"alert": "yes"},
        {"alert": 1},
        {"model_threshold": "0.1"},
        {"model_threshold": True},
        {"horizon_hours": 0},
        {"horizon_hours": -24},
        {"horizon_hours": "72"},
    ],
)
async def test_wrong_types_raise_ml_predictor_error(extra: dict) -> None:
    with pytest.raises(MLPredictorError):
        await _predict_with({**_BASE, **extra})


class _FixedPredictor:
    def __init__(self, result: PredictionResult) -> None:
        self.result = result

    async def predict(self, _: PredictionInput) -> PredictionResult:
        return self.result


async def _seed_channel(suffix: str) -> str:
    facility_id = "fac_port_fields"
    channel_id = f"port_fields_{suffix}"
    async with async_session_factory() as session:
        await seed_demo_users(session)
        if await session.get(Facility, facility_id) is None:
            session.add(Facility(id=facility_id, display_name=facility_id, facility_type="test", district_id=None))
        session.add(
            SensorChannel(
                id=f"sensor_{channel_id}", channel_id=channel_id, tag="", sensor_type_id="smoke_detector",
                system_type="fire_protection", display_name=channel_id, facility_id=facility_id, hierarchy_node_id=None,
            )
        )
        session.add(
            SensorReading(
                channel_id=channel_id, occurred_at=datetime(2040, 1, 1, tzinfo=timezone.utc), is_alarm=True,
                raw_value="x", numeric_value=None, is_anomaly=False, source_event_id=f"port_fields_{suffix}",
                origin="historical",
            )
        )
        await session.commit()
    return f"sensor_{channel_id}"


async def _risk_card(sensor_id: str) -> dict:
    async with async_session_factory() as session:
        risk_id = (await session.execute(select(Risk.id).where(Risk.target_id == sensor_id))).scalar_one()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        login = await client.post("/api/v1/auth/login", json={"username": "manager", "password": "manager123"})
        token = login.json()["token"]
        card = await client.get(f"/api/v1/risks/{risk_id}", headers={"Authorization": f"Bearer {token}"})
    assert card.status_code == 200, card.text
    return card.json()


@pytest.mark.asyncio
async def test_model_fields_reach_the_risk_card() -> None:
    sensor_id = await _seed_channel("with_fields")
    predictor = _FixedPredictor(
        PredictionResult(**{**_BASE, "top_factors": ["f"]}, alert=True, model_threshold=0.147, horizon_hours=24.0)
    )
    async with async_session_factory() as session:
        await sync_risks(session, predictor, now=datetime(2040, 1, 1, 1, tzinfo=timezone.utc))

    card = await _risk_card(sensor_id)
    assert card["alert"] is True
    assert card["model_threshold"] == 0.147


@pytest.mark.asyncio
async def test_without_model_fields_the_card_keeps_the_shared_scale() -> None:
    sensor_id = await _seed_channel("without_fields")
    async with async_session_factory() as session:
        await sync_risks(session, _FixedPredictor(PredictionResult(**_BASE)), now=datetime(2040, 1, 1, 1, tzinfo=timezone.utc))

    card = await _risk_card(sensor_id)
    assert card["alert"] is None
    assert card["model_threshold"] is None
    assert card["risk_level"] == "low"  # 0.2 on the shared 0.3/0.6/0.85 scale
    assert card["threshold"] == 0.0
