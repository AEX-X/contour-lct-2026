"""Facility-level risks from the ML service's object models (POST /risk_map).

For each target ("incident" 72h, "failure" 168h) the ML service ranks all
facilities; every facility with `alert` becomes one open Risk with
target_type="facility". A facility that already has an open risk of the
same model with an unfinished window is skipped, so repeated syncs do not
duplicate. Any ML-side problem surfaces as ObjectRiskError and nothing is
committed.

Every created risk carries a model alert, so it is leveled by the
model-alert rule (`assess_forecast`): "medium", or "high" from 0.85, never
"critical"; SLA is a third of the horizon (24 h for incidents, 56 h for
failures) instead of the 15 minutes the shared scale gave to multi-day forecasts.
"""

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.models.hierarchy import Facility
from src.models.risk import Risk
from src.services.ml_port import DemoClock
from src.services.ml_predictor_http import (
    parse_demo_clock,
    parse_ml_datetime,
    parse_model_alert_fields,
)
from src.services.reference_data import SENSOR_TYPES
from src.services.risk_leveling import (
    assess_forecast,
    compute_data_health,
    compute_priority_score,
)

OBJECT_TARGETS = ("incident", "failure")
_INCIDENT_RISK_TYPE_BY_SYSTEM_TYPE = {
    "fire_protection": "fire",
    "security": "unauthorized_access",
    "diagnostic": "flooding",
}
_FLOODING_SENSOR_NAMES = {"Состояние насоса", "Датчик затопления"}
_SYSTEM_TYPE_BY_SENSOR_NAME = {
    sensor.display_name: sensor.system_type for sensor in SENSOR_TYPES
}
_DEFAULT_INCIDENT_RISK_TYPE = "unauthorized_access"


class ObjectRiskError(Exception):
    """The ML service's /risk_map could not be used (unreachable, non-200 or malformed)."""


@dataclass(frozen=True)
class _RiskMap:
    horizon_hours: float
    objects: list[dict]
    effective_as_of: datetime
    demo_clock: DemoClock | None


def incident_risk_type(suspect_channels: list[dict]) -> str:
    """Pick a risk_type for an incident alert from the first recognizable suspect channel.

    Args:
        suspect_channels: The ML service's suspect channels, most suspicious first.

    Returns:
        "flooding" for pump/flood sensors, otherwise the risk_type of the
        channel's engineering system, or "unauthorized_access" if none is known.
    """
    for suspect in suspect_channels:
        name = suspect.get("sensor_type")
        if name in _FLOODING_SENSOR_NAMES:
            return "flooding"
        risk_type = _INCIDENT_RISK_TYPE_BY_SYSTEM_TYPE.get(
            _SYSTEM_TYPE_BY_SENSOR_NAME.get(name, "")
        )
        if risk_type is not None:
            return risk_type
    return _DEFAULT_INCIDENT_RISK_TYPE


def recommendation_for(target: str, suspect_channels: list[dict]) -> str:
    """Build the dispatcher-facing recommendation text, naming up to three suspect channels."""
    where = ", ".join(
        f"{s['target_id']} ({s.get('sensor_type') or 'тип неизвестен'})"
        for s in suspect_channels[:3]
    )
    action = (
        "Проверить оборудование объекта" if target == "failure" else "Проверить объект"
    )
    return f"{action}; в первую очередь каналы: {where}" if where else action


async def fetch_risk_map(
    client: httpx.AsyncClient, target: str, as_of: datetime
) -> _RiskMap:
    """Request the ML service's facility ranking for one target.

    Args:
        client: HTTP client pointed at ML_PREDICTOR_URL.
        target: "incident" or "failure".
        as_of: Forecast time.

    Returns:
        A validated response carrying the ML service's effective clock.

    Raises:
        ObjectRiskError: On transport error, non-200 status or malformed body.
    """
    try:
        response = await client.post(
            "/risk_map", json={"as_of": as_of.isoformat(), "target": target}
        )
    except httpx.HTTPError as exc:
        raise ObjectRiskError(f"risk_map request failed: {exc}") from exc
    if response.status_code != 200:
        raise ObjectRiskError(
            f"risk_map returned {response.status_code}: {response.text}"
        )
    try:
        data = response.json()
        horizon_hours = float(data["horizon_hours"])
        objects = list(data["objects"])
        effective_as_of = (
            parse_ml_datetime(data["as_of_utc"], "as_of_utc")
            if data.get("as_of_utc") is not None
            else as_of
        )
        demo_clock = parse_demo_clock(data.get("demo_clock"))
    except (KeyError, TypeError, ValueError) as exc:
        raise ObjectRiskError(f"malformed risk_map response: {response.text}") from exc
    return _RiskMap(
        horizon_hours=horizon_hours,
        objects=objects,
        effective_as_of=effective_as_of,
        demo_clock=demo_clock,
    )


async def _has_open_risk(
    session: AsyncSession, facility_id: str, model: str, now: datetime
) -> bool:
    found = await session.execute(
        select(Risk.id)
        .where(
            Risk.target_type == "facility",
            Risk.target_id == facility_id,
            Risk.model == model,
            Risk.decision_status == "open",
            Risk.is_invalidated.is_(False),
            Risk.prediction_window_end > now,
        )
        .limit(1)
    )
    return found.scalar_one_or_none() is not None


@dataclass(frozen=True)
class _AlertRow:
    facility_id: str
    model_name: str
    probability: float
    model_threshold: float | None
    factor_texts: list[str]
    suspects: list[dict]
    effective_as_of: datetime


def _parse_alert_row(row: dict, default_as_of: datetime) -> _AlertRow:
    # Битая строка ответа ML не должна ронять старт backend: превращаем в ObjectRiskError.
    try:
        _, model_threshold, _ = parse_model_alert_fields(row)
        if model_threshold is None:
            # Пока ML не шлёт model_threshold, берём порог из текущего поля threshold ответа /risk_map.
            _, model_threshold, _ = parse_model_alert_fields(
                {"model_threshold": row.get("threshold")}
            )
        return _AlertRow(
            facility_id=f"fac_{row['object_id']}",
            model_name=str(row["model_name"]),
            probability=float(row["probability"]),
            model_threshold=model_threshold,
            factor_texts=[
                str(factor["text"]) for factor in row.get("top_factors") or []
            ],
            suspects=list(row.get("suspect_channels") or []),
            effective_as_of=(
                parse_ml_datetime(row["as_of_utc"], "objects[].as_of_utc")
                if row.get("as_of_utc") is not None
                else default_as_of
            ),
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise ObjectRiskError(f"malformed risk_map row: {row!r}") from exc


async def sync_object_risks(
    session: AsyncSession, client: httpx.AsyncClient, *, now: datetime | None = None
) -> int:
    """Create facility risks for every object the ML service alerts on.

    Args:
        session: An active async database session.
        client: HTTP client pointed at ML_PREDICTOR_URL.
        now: Operational wall-clock time used for ingestion and SLA.

    Returns:
        The number of Risk rows created.

    Raises:
        ObjectRiskError: The ML service failed or answered malformed data;
            nothing is committed in that case.
    """
    now = now or datetime.now(timezone.utc)
    created_count = 0
    for target in OBJECT_TARGETS:
        data = await fetch_risk_map(client, target, now)
        horizon_hours = data.horizon_hours
        demo_clock = (
            {
                "requested_as_of_utc": data.demo_clock.requested_as_of_utc.isoformat(),
                "anchor_utc": data.demo_clock.anchor_utc.isoformat(),
            }
            if data.demo_clock is not None
            else None
        )
        for row in data.objects:
            if row.get("status") != "ok" or not row.get("alert"):
                continue
            parsed = _parse_alert_row(row, data.effective_as_of)
            facility_id, model_name, probability = (
                parsed.facility_id,
                parsed.model_name,
                parsed.probability,
            )
            if await session.get(Facility, facility_id) is None:
                continue
            if await _has_open_risk(
                session, facility_id, model_name, parsed.effective_as_of
            ):
                continue
            suspects = parsed.suspects
            risk_type = (
                "sensor_failure"
                if target == "failure"
                else incident_risk_type(suspects)
            )
            # Строка уже с тревогой модели, поэтому правило по порогу модели всегда даёт оценку.
            assessment = assess_forecast(
                probability,
                now,
                alert=True,
                horizon_hours=horizon_hours,
                model_threshold=parsed.model_threshold,
            )
            risk_level, threshold, sla_due_at = (
                assessment.risk_level,
                assessment.threshold,
                assessment.sla_due_at,
            )
            risk_id = f"risk_{uuid4().hex[:20]}"
            session.add(
                Risk(
                    id=risk_id,
                    forecast_id=risk_id,
                    risk_type=risk_type,
                    target_type="facility",
                    target_id=facility_id,
                    facility_id=facility_id,
                    as_of=parsed.effective_as_of,
                    demo_clock=demo_clock,
                    lead_min_hours=0.0,
                    horizon_hours=horizon_hours,
                    prediction_window_start=parsed.effective_as_of,
                    prediction_window_end=parsed.effective_as_of
                    + timedelta(hours=horizon_hours),
                    probability=probability,
                    threshold=threshold,
                    alert=True,
                    model_threshold=parsed.model_threshold,
                    risk_level=risk_level,
                    priority_score=compute_priority_score(
                        probability, now, sla_due_at, now=now
                    ),
                    decision_status="open",
                    sla_due_at=sla_due_at,
                    data_health=compute_data_health(
                        parsed.effective_as_of,
                        now=parsed.effective_as_of if demo_clock is not None else now,
                    ),
                    model=model_name,
                    top_factors=parsed.factor_texts,
                    recommendation=recommendation_for(target, suspects),
                    version=1,
                    created_at=now,
                    updated_at=now,
                )
            )
            created_count += 1
    await session.commit()
    return created_count
