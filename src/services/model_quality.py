"""Model-quality metrics prepared by the ML team, passed through unchanged.

Primary source: GET {ML_PREDICTOR_URL}/quality of the running ML service.
Fallback: the same JSON as a file in the ML repository (ml/), so the
"model quality" tab works even when the ML service is not started.
"""
import asyncio
import json
import logging
from pathlib import Path
from typing import Any

import httpx

logger = logging.getLogger(__name__)

ML_QUALITY_TIMEOUT_SECONDS = 5.0
SOURCE_ML_SERVICE = "ml_service"
SOURCE_FILE = "file"


class ModelQualityUnavailable(Exception):
    """Neither the ML service nor the metrics file produced a JSON object."""


async def fetch_from_ml(client: httpx.AsyncClient, *, timeout: float = ML_QUALITY_TIMEOUT_SECONDS) -> dict[str, Any] | None:
    """Ask the ML service for its metrics.

    Args:
        client: HTTP client pointed at ML_PREDICTOR_URL.
        timeout: Upper bound for the whole call, whatever the transport does.

    Returns:
        The JSON object, or None if the service is down, answers non-200
        (e.g. 404 when started without --quality) or returns something else.
    """
    try:
        response = await asyncio.wait_for(client.get("/quality"), timeout=timeout)
    except (httpx.HTTPError, TimeoutError) as exc:
        logger.warning("model quality: ML service unavailable: %s", exc or type(exc).__name__)
        return None
    if response.status_code != 200:
        logger.warning("model quality: ML service answered %s", response.status_code)
        return None
    try:
        data = response.json()
    except ValueError:
        logger.warning("model quality: ML service answered non-JSON")
        return None
    if not isinstance(data, dict):
        logger.warning("model quality: ML service answered a non-object JSON")
        return None
    return data


def read_file(path: Path) -> dict[str, Any] | None:
    """Read the metrics file.

    Args:
        path: Path to the ML team's quality JSON.

    Returns:
        The JSON object, or None if the file is missing, unreadable or not an object.
    """
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        logger.warning("model quality: file %s unusable: %s", path, exc)
        return None
    return data if isinstance(data, dict) else None


async def load_model_quality(
    client: httpx.AsyncClient | None,
    file_path: Path | None,
    *,
    timeout: float = ML_QUALITY_TIMEOUT_SECONDS,
) -> tuple[dict[str, Any], str]:
    """Return the metrics and where they came from.

    Args:
        client: Client for the ML service, or None when ML_PREDICTOR_URL is unset.
        file_path: Fallback metrics file, or None.
        timeout: Upper bound for the ML call.

    Returns:
        (metrics JSON object, SOURCE_ML_SERVICE or SOURCE_FILE).

    Raises:
        ModelQualityUnavailable: Neither source produced a JSON object.
    """
    if client is not None:
        data = await fetch_from_ml(client, timeout=timeout)
        if data is not None:
            return data, SOURCE_ML_SERVICE
    if file_path is not None:
        data = read_file(file_path)
        if data is not None:
            return data, SOURCE_FILE
    raise ModelQualityUnavailable("model quality metrics are unavailable: ML service and metrics file both failed")
