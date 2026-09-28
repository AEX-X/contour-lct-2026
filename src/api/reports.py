"""GET /api/v1/reports/risks -- risk export for management (xlsx or csv)."""
from datetime import datetime

from fastapi import APIRouter, Depends, Query, Request, Response

from src.db import async_session_factory
from src.deps.auth import require_permission
from src.errors import ApiError
from src.models.auth import User
from src.services.report_formats import DEFAULT_FORMAT, RENDERERS, UnknownReportFormat, render
from src.services.risk_report import build_risk_report
from src.services.scope import resolve_scope

router = APIRouter(prefix="/api/v1/reports", tags=["reports"])


def _parse_iso_datetime(raw: str, field_name: str) -> datetime:
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ApiError(400, "VALIDATION_ERROR", f"{field_name} must be an ISO 8601 datetime") from exc


def _file_part(moment: datetime | None) -> str:
    return moment.date().isoformat() if moment else "all"


@router.get(
    "/risks",
    response_class=Response,
    responses={200: {"description": "Файл отчёта (xlsx или csv) как вложение"}},
)
async def export_risks(
    request: Request,
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = Query(default=None),
    report_format: str = Query(default=DEFAULT_FORMAT, alias="format", description="xlsx | csv_semicolon | csv_comma"),
    user: User = Depends(require_permission("report.export")),
) -> Response:
    """Download the risks of a period with decisions and linked work orders.

    Args:
        request: The current request (the export is written to the audit journal).
        from_: Optional ISO 8601 inclusive lower bound on the forecast time.
        to: Optional ISO 8601 inclusive upper bound on the forecast time.
        report_format: One of the supported formats; xlsx by default.
        user: The caller; must hold report.export. Only facilities in scope are exported.

    Returns:
        The file as an attachment.

    Raises:
        ApiError: 400 for an unknown format or a malformed date.
    """
    request.state.audit["details"] = {"from": from_, "to": to, "format": report_format}
    if report_format not in RENDERERS:
        raise ApiError(400, "VALIDATION_ERROR", f"format must be one of: {', '.join(RENDERERS)}")
    date_from = _parse_iso_datetime(from_, "from") if from_ else None
    date_to = _parse_iso_datetime(to, "to") if to else None

    async with async_session_factory() as session:
        scope = await resolve_scope(session, user.id)
        allowed_ids = None if scope["type"] == "all_facilities" else set(scope["facility_ids"])
        table = await build_risk_report(session, allowed_ids, date_from=date_from, date_to=date_to)

    try:
        report = render(table, report_format)
    except UnknownReportFormat as exc:
        raise ApiError(400, "VALIDATION_ERROR", f"unknown format: {report_format}") from exc
    request.state.audit["details"]["rows"] = len(table.rows)
    filename = f"risks_{_file_part(date_from)}_{_file_part(date_to)}.{report.extension}"
    return Response(
        content=report.content,
        media_type=report.media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
