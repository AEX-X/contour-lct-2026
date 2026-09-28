"""CORS for a browser frontend on another origin."""
import pytest
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from httpx import ASGITransport, AsyncClient

from src.api.me import router as me_router
from src.config import get_settings
from src.cors import install_cors, parse_origins
from src.errors import register_exception_handlers
from src.main import app as real_app
from src.services.audit_recorder import AuditMiddleware

FRONT = "http://localhost:5173"
STRANGER = "https://evil.example"


def _app_like_main(origins: list[str]) -> FastAPI:
    """Same middleware composition as src/main.py, with explicit origins."""
    app = FastAPI()
    app.add_middleware(AuditMiddleware)
    install_cors(app, origins)
    register_exception_handlers(app)
    app.include_router(me_router)
    return app


async def _request(app: FastAPI, method: str, path: str, headers: dict) -> object:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        return await client.request(method, path, headers=headers)


def test_parse_origins() -> None:
    assert parse_origins(None) == []
    assert parse_origins("") == []
    assert parse_origins(" https://front.example.ru/ , http://localhost:5173 ,") == [
        "https://front.example.ru",
        "http://localhost:5173",
    ]


@pytest.mark.asyncio
async def test_preflight_from_allowed_origin_is_accepted() -> None:
    response = await _request(
        _app_like_main([FRONT]),
        "OPTIONS",
        "/api/v1/me",
        {"Origin": FRONT, "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization"},
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == FRONT
    assert "authorization" in response.headers["access-control-allow-headers"].lower()
    assert "access-control-allow-credentials" not in response.headers, "bearer tokens need no cookies"


@pytest.mark.asyncio
async def test_preflight_from_other_origin_is_refused() -> None:
    response = await _request(
        _app_like_main([FRONT]),
        "OPTIONS",
        "/api/v1/me",
        {"Origin": STRANGER, "Access-Control-Request-Method": "GET"},
    )
    assert response.status_code == 400
    assert "access-control-allow-origin" not in response.headers


@pytest.mark.asyncio
async def test_error_responses_carry_cors_headers_and_expose_trace_id() -> None:
    response = await _request(_app_like_main([FRONT]), "GET", "/api/v1/me", {"Origin": FRONT})
    assert response.status_code == 401  # no token: the frontend must be able to read this error
    assert response.headers["access-control-allow-origin"] == FRONT
    assert "x-trace-id" in response.headers["access-control-expose-headers"].lower()


@pytest.mark.asyncio
async def test_empty_origin_list_disables_cors() -> None:
    response = await _request(_app_like_main([]), "GET", "/api/v1/me", {"Origin": FRONT})
    assert "access-control-allow-origin" not in response.headers


def test_main_app_installs_cors_from_settings() -> None:
    configured = bool(parse_origins(get_settings().cors_allowed_origins))
    installed = any(m.cls is CORSMiddleware for m in real_app.user_middleware)
    assert installed == configured
