"""GET /api/v1/model-quality -- the ML team's model-quality metrics for the frontend tab."""
from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path

import httpx
from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from src.config import get_settings
from src.deps.auth import require_permission
from src.errors import ApiError
from src.models.auth import User
from src.services.model_quality import ML_QUALITY_TIMEOUT_SECONDS, ModelQualityUnavailable, load_model_quality

router = APIRouter(prefix="/api/v1", tags=["model-quality"])

DATA_SOURCE_HEADER = "X-Data-Source"


@dataclass
class QualitySources:
    """Where the metrics may come from; tests override the dependency that builds it."""

    client: httpx.AsyncClient | None
    file_path: Path | None
    timeout: float = ML_QUALITY_TIMEOUT_SECONDS


async def quality_sources() -> AsyncIterator[QualitySources]:
    """Build the sources from settings: ML service (if configured) and the metrics file."""
    settings = get_settings()
    file_path = Path(settings.ml_quality_file) if settings.ml_quality_file else None
    if not settings.ml_predictor_url:
        yield QualitySources(client=None, file_path=file_path)
        return
    async with httpx.AsyncClient(base_url=settings.ml_predictor_url, timeout=ML_QUALITY_TIMEOUT_SECONDS) as client:
        yield QualitySources(client=client, file_path=file_path)


@router.get(
    "/model-quality",
    responses={
        200: {"description": "Метрики моделей от ML-команды без изменений; заголовок X-Data-Source: ml_service | file"},
        503: {"description": "Ни ML-сервис, ни файл метрик недоступны"},
    },
)
async def get_model_quality(
    sources: QualitySources = Depends(quality_sources),
    _: User = Depends(require_permission("analytics.read.technical")),
) -> JSONResponse:
    """Return the model-quality JSON exactly as the ML team provides it.

    Args:
        sources: The ML service client and fallback file.
        _: The caller; must hold analytics.read.technical.

    Returns:
        The metrics JSON with the source in the X-Data-Source header.

    Raises:
        ApiError: 503 SOURCE_UNAVAILABLE when neither source works.
    """
    try:
        data, source = await load_model_quality(sources.client, sources.file_path, timeout=sources.timeout)
    except ModelQualityUnavailable as exc:
        raise ApiError(503, "SOURCE_UNAVAILABLE", "Метрики качества модели недоступны: нет ни ML-сервиса, ни файла метрик", retryable=True) from exc
    return JSONResponse(content=data, headers={DATA_SOURCE_HEADER: source})
