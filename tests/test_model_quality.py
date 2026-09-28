"""GET /api/v1/model-quality: ML service first, the ML metrics file as fallback, 503 otherwise."""
import asyncio
import json
import time
from pathlib import Path

import httpx
import pytest
from httpx import ASGITransport, AsyncClient

from src.api.model_quality import QualitySources, quality_sources
from src.config import get_settings
from src.db import async_session_factory
from src.main import app
from src.services.demo_seed import seed_demo_users

SERVICE_JSON = {"incident": {"total": {"precision": 0.83, "recall": 0.62}}, "source": "service"}
FILE_JSON = {"incident": {"total": {"precision": 0.8271, "recall": 0.6155}}, "source": "file"}


def _ml(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="http://ml")


async def _get(username: str, password: str, sources: QualitySources):
    async def override():
        yield sources

    async with async_session_factory() as session:
        await seed_demo_users(session)
    app.dependency_overrides[quality_sources] = override
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            token = (await client.post("/api/v1/auth/login", json={"username": username, "password": password})).json()["token"]
            return await client.get("/api/v1/model-quality", headers={"Authorization": f"Bearer {token}"})
    finally:
        app.dependency_overrides.pop(quality_sources, None)


@pytest.fixture
def metrics_file(tmp_path: Path) -> Path:
    path = tmp_path / "quality.json"
    path.write_text(json.dumps(FILE_JSON), encoding="utf-8")
    return path


@pytest.mark.asyncio
async def test_ml_service_json_is_passed_through_unchanged(metrics_file: Path) -> None:
    response = await _get("manager", "manager123", QualitySources(_ml(lambda _: httpx.Response(200, json=SERVICE_JSON)), metrics_file))
    assert response.status_code == 200
    assert response.json() == SERVICE_JSON
    assert response.headers["X-Data-Source"] == "ml_service"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "ml_answer",
    [
        lambda _: httpx.Response(404, json={"error": "not_found"}),  # started without --quality
        lambda _: httpx.Response(200, json=[1, 2, 3]),  # not a JSON object
        lambda _: httpx.Response(200, content=b"<html>oops</html>"),
    ],
)
async def test_bad_ml_answers_fall_back_to_the_file(metrics_file: Path, ml_answer) -> None:
    response = await _get("manager", "manager123", QualitySources(_ml(ml_answer), metrics_file))
    assert response.status_code == 200
    assert response.json() == FILE_JSON
    assert response.headers["X-Data-Source"] == "file"


@pytest.mark.asyncio
async def test_unreachable_ml_falls_back_to_the_file(metrics_file: Path) -> None:
    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    response = await _get("manager", "manager123", QualitySources(_ml(refuse), metrics_file))
    assert response.headers["X-Data-Source"] == "file"


@pytest.mark.asyncio
async def test_no_ml_url_uses_the_file(metrics_file: Path) -> None:
    response = await _get("manager", "manager123", QualitySources(None, metrics_file))
    assert (response.status_code, response.headers["X-Data-Source"]) == (200, "file")


@pytest.mark.asyncio
async def test_nothing_available_is_503(tmp_path: Path) -> None:
    response = await _get("manager", "manager123", QualitySources(None, tmp_path / "missing.json"))
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "SOURCE_UNAVAILABLE"


@pytest.mark.asyncio
async def test_hanging_ml_is_cut_by_the_timeout(metrics_file: Path) -> None:
    async def hang(_: httpx.Request) -> httpx.Response:
        await asyncio.sleep(30)
        return httpx.Response(200, json=SERVICE_JSON)

    started = time.monotonic()
    response = await _get("manager", "manager123", QualitySources(_ml(hang), metrics_file, timeout=0.5))
    assert time.monotonic() - started < 10
    assert response.headers["X-Data-Source"] == "file"


@pytest.mark.asyncio
async def test_dispatcher_is_denied(metrics_file: Path) -> None:
    response = await _get("dispatcher", "dispatcher123", QualitySources(None, metrics_file))
    assert response.status_code == 403


def test_endpoint_is_in_openapi() -> None:
    assert "get" in app.openapi()["paths"]["/api/v1/model-quality"]


def test_default_file_is_the_real_ml_metrics_file() -> None:
    path = Path(get_settings().ml_quality_file)
    data = json.loads(path.read_text(encoding="utf-8"))
    assert isinstance(data, dict) and "incident" in data, "default ML_QUALITY_FILE must point at the ML team's metrics"
