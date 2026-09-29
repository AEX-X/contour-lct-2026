"""Confirming a risk forecast as an incident.

The incident is stored as an Event row (is_confirmed_incident=True,
related_risk_id=risk.id, no source reading), so the existing
GET /api/v1/events?is_confirmed_incident=true journal lists it with no
extra read path.
"""
import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.errors import ApiError
from src.models.audit import AuditLogEntry
from src.models.auth import User
from src.models.event import Event
from src.models.hierarchy import Facility
from src.models.risk import Risk, RiskConfirmMutation, RiskDecision
from src.schemas.risk import (
    ConfirmRequest,
    IncidentOut,
    IncidentTarget,
    RiskConfirmResponse,
    UserRef,
)
from src.services.risk_query import get_risk_detail, to_risk_out

INCIDENT_SOURCE = "risk_confirmation"
CONFIRMED = "confirmed"
# Decisions after which a risk can no longer become an incident.
FINAL_STATUSES = frozenset({CONFIRMED, "rejected", "resolved"})
# Event.state drives the frontend incident severity: alarm -> critical,
# warning -> high, anything else -> medium.
_STATE_BY_LEVEL = {"critical": "alarm", "high": "warning"}


@dataclass(frozen=True)
class ConfirmOutcome:
    """Result of a confirmation: the reply and whether it was a replay."""

    response: RiskConfirmResponse
    replayed: bool


def confirm_fingerprint(risk_id: str, body: ConfirmRequest) -> str:
    """Hash the target risk and the request body without its idempotency key.

    Args:
        risk_id: The risk the request confirms, so one key cannot span risks.
        body: The confirmation request.

    Returns:
        A sha256 hex digest of the canonical JSON payload.
    """
    payload = body.model_dump(mode="json", exclude={"idempotency_key"})
    payload["risk_id"] = risk_id
    return hashlib.sha256(
        json.dumps(payload, ensure_ascii=False, sort_keys=True).encode()
    ).hexdigest()


async def _replay(
    session: AsyncSession, actor_id: str, body: ConfirmRequest, fingerprint: str
) -> RiskConfirmResponse | None:
    if body.idempotency_key is None:
        return None
    existing = (
        await session.execute(
            select(RiskConfirmMutation).where(
                RiskConfirmMutation.actor_id == actor_id,
                RiskConfirmMutation.idempotency_key == body.idempotency_key,
            )
        )
    ).scalar_one_or_none()
    if existing is None:
        return None
    if existing.fingerprint != fingerprint:
        raise ApiError(
            409,
            "IDEMPOTENCY_KEY_REUSED",
            "Ключ идемпотентности уже использован другим запросом",
        )
    return RiskConfirmResponse.model_validate(existing.response_payload)


async def _target_display_name(session: AsyncSession, risk: Risk) -> str:
    if risk.target_type == "facility" and risk.facility_id:
        facility = await session.get(Facility, risk.facility_id)
        if facility is not None:
            return facility.display_name
    return risk.target_id


def _check_transition(risk: Risk, expected_version: int) -> None:
    current = {"current": to_risk_out(risk).model_dump(mode="json")}
    if risk.version != expected_version:
        raise ApiError(
            409, "VERSION_CONFLICT", "Прогноз был изменён другим пользователем", details=current
        )
    if risk.decision_status in FINAL_STATUSES:
        raise ApiError(409, "INVALID_TRANSITION", "Решение по прогнозу уже принято", details=current)


async def confirm_risk(
    session: AsyncSession,
    risk_id: str,
    allowed_facility_ids: set[str] | None,
    actor: User,
    body: ConfirmRequest,
    *,
    trace_id: str,
    now: datetime | None = None,
) -> ConfirmOutcome:
    """Confirm a risk as an incident, idempotently and with optimistic locking.

    Lock order: actor row, then risk row, so concurrent confirmations of one
    risk serialize and the loser sees the bumped version.

    Args:
        session: An active async database session (committed here on success).
        risk_id: The risk to confirm.
        allowed_facility_ids: None for all_facilities scope, else visible ids.
        actor: The confirming user (permission already checked).
        body: expected_version, comment and optional idempotency fields.
        trace_id: The request trace id stored on the domain audit entry.
        now: Wall-clock time (defaults to real UTC now).

    Returns:
        The reply and whether it replayed an earlier identical request.

    Raises:
        ApiError: 404/403 per scope; 409 VERSION_CONFLICT, INVALID_TRANSITION
            or IDEMPOTENCY_KEY_REUSED.
    """
    now = now or datetime.now(timezone.utc)
    fingerprint = confirm_fingerprint(risk_id, body)
    await session.execute(select(User.id).where(User.id == actor.id).with_for_update())

    replay = await _replay(session, actor.id, body, fingerprint)
    if replay is not None:
        return ConfirmOutcome(response=replay, replayed=True)

    risk = await get_risk_detail(session, risk_id, allowed_facility_ids, for_update=True)
    _check_transition(risk, body.expected_version)

    before_version = risk.version
    risk.decision_status = CONFIRMED
    risk.version += 1
    risk.updated_at = now
    session.add(
        RiskDecision(
            id=f"riskdec_{uuid4().hex[:20]}",
            risk_id=risk.id,
            user_id=actor.id,
            decision=CONFIRMED,
            reason_code=None,
            comment=body.comment,
            decided_at=now,
        )
    )

    # Id по времени: журнал событий листается по id по убыванию, новые сверху.
    incident = Event(
        id=f"evt_inc_{now:%Y%m%d%H%M%S%f}_{uuid4().hex[:6]}",
        source_reading_id=None,
        event_type=risk.risk_type,
        source=INCIDENT_SOURCE,
        facility_id=risk.facility_id,
        sensor_id=risk.target_id,
        occurred_at=now,
        ingested_at=now,
        state=_STATE_BY_LEVEL.get(risk.risk_level, CONFIRMED),
        value=body.comment,
        is_confirmed_incident=True,
        verification_result=CONFIRMED,
        resolved_at=None,
        related_risk_id=risk.id,
    )
    session.add(incident)

    audit = AuditLogEntry(
        occurred_at=now,
        user_id=actor.id,
        username=actor.username,
        action="risk.confirm",
        target_type="risk",
        target_id=risk.id,
        result="success",
        status_code=200,
        ip=None,
        trace_id=trace_id,
        details={
            "before_version": before_version,
            "after_version": risk.version,
            "incident_id": incident.id,
            "comment": body.comment,
            "client_occurred_at": (
                body.client_occurred_at.isoformat() if body.client_occurred_at else None
            ),
        },
    )
    session.add(audit)
    await session.flush()

    display_name = await _target_display_name(session, risk)
    response = RiskConfirmResponse(
        risk=to_risk_out(risk),
        incident=IncidentOut(
            id=incident.id,
            version=1,
            facility_id=risk.facility_id,
            target=IncidentTarget(
                type=risk.target_type,
                id=risk.target_id,
                facility_id=risk.facility_id,
                display_name=display_name,
            ),
            source_risk_id=risk.id,
            title=f"Подтверждена необходимость проверки: {display_name}",
            description=body.comment,
            severity=risk.risk_level,
            status="open",
            confirmed_at=now,
            confirmed_by=UserRef(id=actor.id, display_name=actor.display_name),
            resolved_at=None,
            failure_episode_id=None,
        ),
        audit_event_id=str(audit.id),
    )
    if body.idempotency_key is not None:
        session.add(
            RiskConfirmMutation(
                id=f"riskconf_{uuid4().hex[:20]}",
                risk_id=risk.id,
                actor_id=actor.id,
                idempotency_key=body.idempotency_key,
                fingerprint=fingerprint,
                response_payload=response.model_dump(mode="json"),
                created_at=now,
            )
        )
    await session.commit()
    return ConfirmOutcome(response=response, replayed=False)
