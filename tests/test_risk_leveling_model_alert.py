"""The model-alert leveling rule (variant B) and its fallback to the shared scale."""
from datetime import datetime, timedelta, timezone

import pytest

from src.services.reference_data import MODEL_ALERT_HIGH_MIN_PROBABILITY, SLA_PARAMS
from src.services.risk_leveling import assess_forecast, risk_level_for_probability

AS_OF = datetime(2040, 6, 1, 12, 0, tzinfo=timezone.utc)


@pytest.mark.parametrize("probability", [0.05, 0.3, 0.6, 0.9])
def test_without_alert_field_the_shared_scale_applies(probability: float) -> None:
    assessment = assess_forecast(probability, AS_OF, alert=None, horizon_hours=24)
    level, bucket_min = risk_level_for_probability(probability)
    minutes = next(p.response_minutes for p in SLA_PARAMS if p.risk_level == level)
    assert (assessment.risk_level, assessment.threshold) == (level, bucket_min)
    assert assessment.sla_due_at == AS_OF + timedelta(minutes=minutes)


@pytest.mark.parametrize("probability", [0.0, 0.5, 0.99])
def test_no_alert_means_no_risk(probability: float) -> None:
    assert assess_forecast(probability, AS_OF, alert=False, horizon_hours=24, model_threshold=0.147) is None


@pytest.mark.parametrize(
    ("probability", "expected"),
    [(0.16, "medium"), (0.849999, "medium"), (MODEL_ALERT_HIGH_MIN_PROBABILITY, "high"), (0.99, "high"), (1.0, "high")],
)
def test_alert_levels_are_medium_or_high_never_critical(probability: float, expected: str) -> None:
    assessment = assess_forecast(probability, AS_OF, alert=True, horizon_hours=72, model_threshold=0.147)
    assert assessment.risk_level == expected
    assert assessment.risk_level != "critical"


def test_threshold_is_the_level_lower_bound() -> None:
    high = assess_forecast(0.9, AS_OF, alert=True, horizon_hours=72, model_threshold=0.147)
    medium = assess_forecast(0.3, AS_OF, alert=True, horizon_hours=72, model_threshold=0.147)
    medium_unknown = assess_forecast(0.3, AS_OF, alert=True, horizon_hours=72, model_threshold=None)
    assert high.threshold == MODEL_ALERT_HIGH_MIN_PROBABILITY
    assert medium.threshold == 0.147
    assert medium_unknown.threshold == 0.0


@pytest.mark.parametrize(("horizon", "expected_hours"), [(24, 8), (72, 24), (168, 56)])
def test_sla_is_a_third_of_the_horizon(horizon: float, expected_hours: float) -> None:
    assessment = assess_forecast(0.4, AS_OF, alert=True, horizon_hours=horizon)
    assert assessment.sla_due_at == AS_OF + timedelta(hours=expected_hours)
