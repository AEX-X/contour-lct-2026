"""Sensor forecasts and facility forecasts apply the one shared model-alert rule."""
import json
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from sqlalchemy import select

from src.db import async_session_factory
from src.models.hierarchy import Facility
from src.models.risk import Risk
from src.models.sensor import SensorChannel, SensorReading
from src.services.ml_port import PredictionInput, PredictionResult
from src.services.object_risk_sync import sync_object_risks
from src.services.risk_sync import sync_risks

HORIZON = 72.0
MODEL_THRESHOLD = 0.4


class _AlertPredictor:
    def __init__(self, probability: float) -> None:
        self.probability = probability

    async def predict(self, _: PredictionInput) -> PredictionResult:
        return PredictionResult(
            probability=self.probability, lead_min_hours=0.0, prediction_window_hours=HORIZON, top_factors=["f"],
            recommendation="r", model_name="consistency", alert=True, model_threshold=MODEL_THRESHOLD,
            horizon_hours=HORIZON,
        )


async def _sensor_risk(tag: str, probability: float, now: datetime) -> Risk:
    facility_id, channel_id = f"fac_vbc_{tag}", f"vbc_{tag}"
    async with async_session_factory() as session:
        session.add(Facility(id=facility_id, display_name=facility_id, facility_type="test", district_id=None))
        session.add(
            SensorChannel(
                id=f"sensor_{channel_id}", channel_id=channel_id, tag="", sensor_type_id="smoke_detector",
                system_type="fire_protection", display_name=channel_id, facility_id=facility_id, hierarchy_node_id=None,
            )
        )
        session.add(
            SensorReading(
                channel_id=channel_id, occurred_at=now - timedelta(minutes=5), is_alarm=True, raw_value="x",
                numeric_value=None, is_anomaly=False, source_event_id=f"vbc_{tag}", origin="historical",
            )
        )
        await session.commit()
    async with async_session_factory() as session:
        await sync_risks(session, _AlertPredictor(probability), now=now)
        return (await session.execute(select(Risk).where(Risk.target_id == f"sensor_{channel_id}"))).scalar_one()


async def _facility_risk(tag: str, probability: float, now: datetime) -> Risk:
    facility_id = f"fac_vbc_obj_{tag}"
    async with async_session_factory() as session:
        session.add(Facility(id=facility_id, display_name=facility_id, facility_type="test", district_id=None))
        await session.commit()

    def handle(request: httpx.Request) -> httpx.Response:
        if json.loads(request.content)["target"] != "incident":
            return httpx.Response(200, json={"horizon_hours": 168, "objects": []})
        row = {
            "status": "ok", "object_id": f"vbc_obj_{tag}", "alert": True, "probability": probability,
            "model_name": f"consistency-{tag}", "model_threshold": MODEL_THRESHOLD, "top_factors": [], "suspect_channels": [],
        }
        return httpx.Response(200, json={"horizon_hours": HORIZON, "objects": [row]})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handle), base_url="http://ml")
    async with client, async_session_factory() as session:
        await sync_object_risks(session, client, now=now)
    async with async_session_factory() as session:
        return (await session.execute(select(Risk).where(Risk.target_id == facility_id))).scalar_one()


@pytest.mark.asyncio
@pytest.mark.parametrize(("tag", "probability", "expected_level"), [("mid", 0.5, "medium"), ("top", 0.9, "high")])
async def test_both_paths_give_the_same_level_threshold_and_sla(tag: str, probability: float, expected_level: str) -> None:
    now = datetime(2043, 1, 1, tzinfo=timezone.utc)
    sensor = await _sensor_risk(tag, probability, now)
    facility = await _facility_risk(tag, probability, now)

    assert sensor.risk_level == facility.risk_level == expected_level
    assert sensor.threshold == facility.threshold
    assert sensor.sla_due_at - sensor.as_of == facility.sla_due_at - facility.as_of == timedelta(hours=HORIZON / 3)
    assert sensor.alert is facility.alert is True
    assert sensor.model_threshold == facility.model_threshold == MODEL_THRESHOLD
