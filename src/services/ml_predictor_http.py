"""HTTP implementation of the ML Prediction Port (ticket 08).

Calls out to an externally-deployed ML service over plain HTTP/JSON --
the ML team can implement this contract in any language/framework and
deploy it fully independently; swapping the backend from StubPredictor to
this implementation requires no backend code change (see
`ml_predictor_factory.py`).
"""
import math

import httpx

from src.services.ml_port import PredictionInput, PredictionResult


class MLPredictorError(Exception):
    """Raised when the external ML service fails or returns a malformed response."""


def _optional_number(data: dict, key: str) -> float | None:
    value = data.get(key)
    if value is None:
        return None
    # bool is an int subclass in Python; true/false is not a threshold or horizon.
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{key} must be a finite number, got {value!r}")
    return float(value)


def parse_model_alert_fields(data: dict) -> tuple[bool | None, float | None, float | None]:
    """Read the optional model-alert fields agreed with the ML team.

    Args:
        data: A decoded forecast object from the ML service.

    Returns:
        (alert, model_threshold, horizon_hours); an absent key or JSON null
        gives None, meaning "not provided by this model".

    Raises:
        ValueError: A field is present with the wrong type, or horizon_hours
            is not positive.
    """
    alert = data.get("alert")
    if alert is not None and not isinstance(alert, bool):
        raise ValueError(f"alert must be a boolean, got {alert!r}")
    model_threshold = _optional_number(data, "model_threshold")
    horizon_hours = _optional_number(data, "horizon_hours")
    if horizon_hours is not None and horizon_hours <= 0:
        raise ValueError(f"horizon_hours must be positive, got {horizon_hours!r}")
    return alert, model_threshold, horizon_hours


class HttpMLPredictor:
    """Calls POST {base_url}/predict with the documented JSON contract."""

    def __init__(self, client: httpx.AsyncClient) -> None:
        """Args:
        client: A pre-configured AsyncClient (base_url set to the ML
            service's root). Callers own its lifecycle.
        """
        self._client = client

    async def predict(self, prediction_input: PredictionInput) -> PredictionResult:
        """Send one prediction request and parse the response.

        Args:
            prediction_input: The target and its recent signal counts.

        Returns:
            The parsed PredictionResult.

        Raises:
            MLPredictorError: The service returned a non-2xx status, or its
                response body does not match the documented contract.
        """
        payload = {
            "target_type": prediction_input.target_type,
            "target_id": prediction_input.target_id,
            "risk_type": prediction_input.risk_type,
            "as_of": prediction_input.as_of.isoformat(),
            "recent_alarm_count": prediction_input.recent_alarm_count,
            "recent_anomaly_count": prediction_input.recent_anomaly_count,
            "window_hours": prediction_input.window_hours,
        }

        try:
            response = await self._client.post("/predict", json=payload)
        except httpx.HTTPError as exc:
            raise MLPredictorError(f"ML predictor request failed: {exc}") from exc

        if response.status_code != 200:
            raise MLPredictorError(f"ML predictor returned {response.status_code}: {response.text}")

        try:
            data = response.json()
            alert, model_threshold, horizon_hours = parse_model_alert_fields(data)
            return PredictionResult(
                probability=float(data["probability"]),
                lead_min_hours=float(data["lead_min_hours"]),
                prediction_window_hours=float(data["prediction_window_hours"]),
                top_factors=list(data["top_factors"]),
                recommendation=str(data["recommendation"]),
                model_name=str(data["model_name"]),
                alert=alert,
                model_threshold=model_threshold,
                horizon_hours=horizon_hours,
            )
        except (KeyError, TypeError, ValueError, AttributeError) as exc:
            raise MLPredictorError(f"malformed ML predictor response: {response.text}") from exc
