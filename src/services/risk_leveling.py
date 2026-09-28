"""Pure risk-level/priority/data-health derivation (ticket 08).

Reuses reference_data.py's RISK_LEVELS/SLA_PARAMS/FRESHNESS_BOUNDARIES
(ticket 02) as the single source of truth for thresholds -- never
re-declares them here.
"""
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from src.services.reference_data import (
    FRESHNESS_BOUNDARIES,
    MODEL_ALERT_HIGH_MIN_PROBABILITY,
    MODEL_ALERT_SLA_HORIZON_FRACTION,
    RISK_LEVELS,
    SLA_PARAMS,
)

_PROBABILITY_WEIGHT = 70.0
_URGENCY_WEIGHT = 30.0


def risk_level_for_probability(probability: float) -> tuple[str, float]:
    """Map a probability to its RISK_LEVELS bucket.

    Args:
        probability: A value in [0, 1].

    Returns:
        (risk_level_id, threshold) where threshold is that bucket's
        min_probability -- the value the API exposes as `threshold`.
    """
    for level in RISK_LEVELS:
        if level.min_probability <= probability < level.max_probability:
            return level.id, level.min_probability
    last = RISK_LEVELS[-1]
    return last.id, last.min_probability


def sla_due_at_for_risk_level(
    risk_level: str, operational_at: datetime
) -> datetime:
    """Compute the SLA deadline for a risk level, reusing SLA_PARAMS.

    Args:
        risk_level: A RISK_LEVELS id.
        operational_at: Wall-clock time when backend accepted the forecast.

    Returns:
        operational_at + that risk level's documented response_minutes.
    """
    param = next(p for p in SLA_PARAMS if p.risk_level == risk_level)
    return operational_at + timedelta(minutes=param.response_minutes)


@dataclass(frozen=True)
class RiskAssessment:
    """Level, level boundary and SLA deadline assigned to one forecast."""

    risk_level: str
    threshold: float
    sla_due_at: datetime


def assess_forecast(
    probability: float,
    operational_at: datetime,
    *,
    alert: bool | None,
    horizon_hours: float,
    model_threshold: float | None = None,
) -> RiskAssessment | None:
    """Decide whether a forecast becomes a risk, at which level and with which SLA.

    Two rules, chosen by whether the model reported its own alert:

    - `alert` is None (the model does not send it): the shared probability
      scale of RISK_LEVELS and the per-level SLA_PARAMS, as before.
    - `alert` is set: the model's own threshold decides. No alert -> no risk.
      Alert -> "medium", or "high" from MODEL_ALERT_HIGH_MIN_PROBABILITY;
      "critical" is never produced. SLA is MODEL_ALERT_SLA_HORIZON_FRACTION
      of the forecast horizon, so the reaction happens before the window.

    Args:
        probability: The forecast probability in [0, 1].
        operational_at: Wall-clock time when backend accepted the forecast.
            This deliberately stays separate from a historical model as_of.
        alert: The model's alert flag, or None if the model does not send one.
        horizon_hours: The forecast horizon (used by the model-alert rule).
        model_threshold: The model's working threshold, if known.

    Returns:
        The assessment, or None when the model reported no alert.
    """
    if alert is None:
        risk_level, threshold = risk_level_for_probability(probability)
        return RiskAssessment(
            risk_level,
            threshold,
            sla_due_at_for_risk_level(risk_level, operational_at),
        )
    if not alert:
        return None

    if probability >= MODEL_ALERT_HIGH_MIN_PROBABILITY:
        risk_level, threshold = "high", MODEL_ALERT_HIGH_MIN_PROBABILITY
    else:
        # Нижняя граница «Среднего» — сама тревога модели, то есть её порог.
        risk_level, threshold = "medium", model_threshold if model_threshold is not None else 0.0
    sla_due_at = operational_at + timedelta(
        hours=horizon_hours * MODEL_ALERT_SLA_HORIZON_FRACTION
    )
    return RiskAssessment(risk_level, threshold, sla_due_at)


def compute_priority_score(
    probability: float,
    operational_started_at: datetime,
    sla_due_at: datetime,
    *,
    now: datetime | None = None,
) -> float:
    """Compute a ranking score independent of probability alone.

    Args:
        probability: The forecast's probability.
        operational_started_at: Wall-clock time when SLA tracking started.
        sla_due_at: The SLA deadline for this forecast's risk level.
        now: Wall-clock time to evaluate urgency against (tests pass an
            explicit value; production uses real UTC now).

    Returns:
        probability*70 + urgency*30, where urgency in [0, 1] grows as
        `now` approaches `sla_due_at` -- two forecasts with equal
        probability but different SLA urgency rank differently.
    """
    now = now or datetime.now(timezone.utc)
    total_seconds = (sla_due_at - operational_started_at).total_seconds()
    elapsed_seconds = (now - operational_started_at).total_seconds()
    urgency = 0.0 if total_seconds <= 0 else max(0.0, min(1.0, elapsed_seconds / total_seconds))
    return round(probability * _PROBABILITY_WEIGHT + urgency * _URGENCY_WEIGHT, 2)


def compute_data_health(as_of: datetime, *, now: datetime | None = None) -> str:
    """Bucket a forecast's data freshness, reusing FRESHNESS_BOUNDARIES.

    Args:
        as_of: The forecast's snapshot time.
        now: Wall-clock time to evaluate age against.

    Returns:
        A FRESHNESS_BOUNDARIES id.
    """
    now = now or datetime.now(timezone.utc)
    age_seconds = (now - as_of).total_seconds()
    for boundary in FRESHNESS_BOUNDARIES:
        if boundary.max_age_seconds is not None and age_seconds <= boundary.max_age_seconds:
            return boundary.id
    return FRESHNESS_BOUNDARIES[-1].id
