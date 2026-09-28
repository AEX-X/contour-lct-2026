"""CORS for the browser frontend served from another origin.

The frontend authenticates with a bearer token in the Authorization header,
not with cookies, so credentials are not allowed: a page from an allowed
origin can call the API, but the browser never attaches cookies to it.
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from src.services.audit_recorder import TRACE_HEADER

ALLOWED_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
ALLOWED_HEADERS = ["Authorization", "Content-Type"]


def parse_origins(raw: str | None) -> list[str]:
    """Split the comma-separated CORS_ALLOWED_ORIGINS value.

    Args:
        raw: E.g. "https://front.example.ru, http://localhost:5173"; "*" allows any origin.

    Returns:
        Origins without surrounding spaces or a trailing slash; empty list disables CORS.
    """
    if not raw:
        return []
    return [origin.strip().rstrip("/") for origin in raw.split(",") if origin.strip()]


def install_cors(app: FastAPI, origins: list[str]) -> None:
    """Allow cross-origin browser calls from the given origins; do nothing for an empty list.

    Args:
        app: The application to wrap. Call after other middleware so CORS is
            outermost and error responses carry CORS headers too.
        origins: Allowed origins, as returned by parse_origins.
    """
    if not origins:
        return
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=False,
        allow_methods=ALLOWED_METHODS,
        allow_headers=ALLOWED_HEADERS,
        expose_headers=[TRACE_HEADER],
        max_age=600,
    )
