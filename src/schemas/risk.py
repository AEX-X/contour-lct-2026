"""Pydantic response models for GET /api/v1/risks[...] (ticket 08)."""

from datetime import datetime

from pydantic import BaseModel, Field


class RiskTarget(BaseModel):
    """What this forecast is about -- always a sensor in this ticket's scope."""

    type: str
    id: str
    facility_id: str | None


class PredictionWindow(BaseModel):
    """The forecast's predicted incident window (as_of + lead_min_hours .. + horizon_hours)."""

    start: datetime
    end: datetime


class DemoClockOut(BaseModel):
    """Historical model clock declared by the ML service."""

    requested_as_of_utc: datetime
    anchor_utc: datetime


class RiskOut(BaseModel):
    """The full risk forecast card."""

    id: str
    forecast_id: str
    risk_type: str
    target: RiskTarget
    as_of: datetime
    demo_clock: DemoClockOut | None = None
    is_invalidated: bool
    lead_min_hours: float
    horizon_hours: float
    prediction_window: PredictionWindow
    probability: float
    threshold: float
    alert: bool | None = None
    model_threshold: float | None = None
    verdict: str | None = None
    blind_spots: list[str] = Field(default_factory=list)
    risk_level: str
    priority_score: float
    decision_status: str
    sla_due_at: datetime
    data_health: str
    model: str
    top_factors: list[str]
    recommendation: str
    version: int
    created_at: datetime
    updated_at: datetime


class RiskListMeta(BaseModel):
    """Cursor-pagination metadata for the risk list envelope."""

    next_cursor: str | None
    total: int
    generated_at: datetime


class RiskListEnvelope(BaseModel):
    """The standard {data, meta} envelope for GET /api/v1/risks."""

    data: list[RiskOut]
    meta: RiskListMeta


class AcknowledgeRequest(BaseModel):
    """Body for POST /api/v1/risks/{risk_id}/acknowledge."""

    expected_version: int


class DeferRequest(BaseModel):
    """Body for POST /api/v1/risks/{risk_id}/defer."""

    expected_version: int


class RejectRequest(BaseModel):
    """Body for POST /api/v1/risks/{risk_id}/reject.

    reason_code is Optional at the schema level -- its presence is a
    domain rule (contract: "reject requires reason_code"), enforced as a
    422 DOMAIN_VALIDATION_ERROR by the endpoint, not a 400 structural
    validation error.
    """

    expected_version: int
    reason_code: str | None = None
    comment: str | None = None


class ConfirmRequest(BaseModel):
    """Body for POST /api/v1/risks/{risk_id}/confirm.

    idempotency_key and client_occurred_at come together or not at all,
    the same rule as work-order mutations (enforced by the endpoint).
    """

    expected_version: int
    comment: str = Field(min_length=1, max_length=2000)
    idempotency_key: str | None = Field(default=None, min_length=8, max_length=200)
    client_occurred_at: datetime | None = None


class UserRef(BaseModel):
    """A user reference: id and display name."""

    id: str
    display_name: str


class IncidentTarget(BaseModel):
    """The confirmed incident's target, taken from the source risk."""

    type: str
    id: str
    facility_id: str | None
    display_name: str


class IncidentOut(BaseModel):
    """A confirmed incident; its id is the Event id in GET /api/v1/events."""

    id: str
    version: int
    facility_id: str | None
    target: IncidentTarget
    source_risk_id: str
    title: str
    description: str
    severity: str
    status: str
    confirmed_at: datetime
    confirmed_by: UserRef
    resolved_at: datetime | None
    failure_episode_id: str | None


class RiskConfirmResponse(BaseModel):
    """Reply of POST /api/v1/risks/{risk_id}/confirm."""

    risk: RiskOut
    incident: IncidentOut
    audit_event_id: str
