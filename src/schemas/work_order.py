"""API contracts for the manual work-order lifecycle."""

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

WorkOrderAction = Literal[
    "edit",
    "submit",
    "start_triage",
    "request_clarification",
    "resubmit_clarification",
    "finalize_priority",
    "assign",
    "reassign",
    "accept",
    "decline",
    "mark_en_route",
    "start_work",
    "wait_access",
    "wait_parts",
    "resume_work",
    "submit_result",
    "start_verification",
    "return_for_rework",
    "close",
    "cancel",
    "override",
]


class CreateWorkOrderRequest(BaseModel):
    """Backward-compatible draft creation request."""

    mode: str
    source_risk_id: str | None = None
    facility_id: str
    target_entity_type: str
    target_entity_id: str
    work_type: str
    priority: str
    due_at: datetime
    description: str
    symptoms: list[str] = Field(default_factory=list)
    comment: str | None = None
    idempotency_key: str | None = Field(default=None, min_length=8, max_length=200)
    client_occurred_at: datetime | None = None


class UserRefOut(BaseModel):
    id: str
    display_name: str


class WorkOrderAssignmentOut(BaseModel):
    id: str
    work_order_id: str
    engineer_id: str
    assigned_by: UserRefOut
    assigned_at: datetime
    accepted_at: datetime | None
    declined_at: datetime | None
    decline_reason: str | None
    completed_at: datetime | None
    status: str
    version: int


class AccessGrantOut(BaseModel):
    id: str
    work_order_id: str
    facility_id: str
    user_id: str
    access_level: Literal["technical_full"] = "technical_full"
    starts_at: datetime
    expires_at: datetime | None
    revoked_at: datetime | None
    status: str
    offline_cache_expires_at: datetime | None
    version: int


class SlaOut(BaseModel):
    policy_id: str
    started_at: datetime | None
    acceptance_due_at: datetime | None
    arrival_due_at: datetime | None
    resolution_due_at: datetime | None
    current_stage: str
    state: str
    paused_at: datetime | None
    pause_reason: str | None
    breach_stage: str | None
    remaining_seconds: int | None
    server_time: datetime


class PartUsage(BaseModel):
    part_code: str
    name: str
    quantity: float = Field(ge=0)
    unit: str


class RepairResultInput(BaseModel):
    failure_confirmed: bool | None
    root_cause_code: str | None
    diagnosis: str
    actions: list[str]
    parts: list[PartUsage]
    labor_minutes: int | None = Field(default=None, ge=0)
    equipment_restored: bool | None
    control_check_result: str | None
    residual_risk: Literal["none", "low", "medium", "high"] | None
    recommendations: str
    requires_follow_up: bool


class RepairResultOut(RepairResultInput):
    completed_at: datetime | None
    author: UserRefOut | None


class WorkOrderOut(BaseModel):
    """One work order plus its current assignment, grant, SLA, and actions."""

    id: str
    display_number: str
    source_risk_id: str | None
    facility_id: str | None
    target_entity_type: str
    target_entity_id: str
    work_type: str
    priority: str
    due_at: datetime
    description: str
    symptoms: list[str] = Field(default_factory=list)
    comment: str | None
    status: str
    created_by: str
    created_at: datetime
    updated_at: datetime
    version: int
    assigned_engineer_id: str | None = None
    coordinator_id: str | None = None
    submitted_at: datetime | None = None
    closed_at: datetime | None = None
    sla_policy_id: str | None = None
    sla: SlaOut | None = None
    repair_result: RepairResultOut | None = None
    active_assignment: WorkOrderAssignmentOut | None = None
    access_grant: AccessGrantOut | None = None
    allowed_actions: list[str] = Field(default_factory=list)


class WorkOrderActionRequest(BaseModel):
    action: WorkOrderAction
    expected_version: int = Field(ge=1)
    idempotency_key: str = Field(min_length=8, max_length=200)
    client_occurred_at: datetime
    payload: dict[str, Any]


class WorkOrderActionResponse(BaseModel):
    work_order: WorkOrderOut
    applied_action: WorkOrderAction
    audit_event_id: str


class WorkOrderListMeta(BaseModel):
    next_cursor: str | None
    total: int
    generated_at: datetime


class WorkOrderListEnvelope(BaseModel):
    data: list[WorkOrderOut]
    meta: WorkOrderListMeta


class EngineerUserOut(BaseModel):
    id: str
    display_name: str
    availability: str
    specialization_codes: list[str]


class EngineerCandidateOut(BaseModel):
    user: EngineerUserOut
    active_work_order_count: int
    eligible: bool
    eligibility_reason: str


class EngineerListMeta(BaseModel):
    total: int
    generated_at: datetime


class EngineerListEnvelope(BaseModel):
    data: list[EngineerCandidateOut]
    meta: EngineerListMeta


class NotificationOut(BaseModel):
    id: str
    user_id: str
    type: str
    priority: str
    title: str
    body: str
    entity_type: str
    entity_id: str
    deep_link: str
    created_at: datetime
    read_at: datetime | None
    group_key: str | None


class NotificationListMeta(BaseModel):
    total: int
    unread: int
    generated_at: datetime


class NotificationListEnvelope(BaseModel):
    data: list[NotificationOut]
    meta: NotificationListMeta


class FacilityDispatcherOut(BaseModel):
    id: str
    display_name: str


class FacilityDispatcherList(BaseModel):
    data: list[FacilityDispatcherOut]


class AssignFacilityDispatcherRequest(BaseModel):
    dispatcher_id: str
    starts_at: datetime
    ends_at: datetime
    expected_version: int = Field(ge=1)
    idempotency_key: str = Field(min_length=8, max_length=200)
    client_occurred_at: datetime


class FacilityDispatcherAssignmentOut(BaseModel):
    id: str
    facility_id: str
    dispatcher_id: str
    assigned_by: UserRefOut
    starts_at: datetime
    ends_at: datetime
    status: str
    version: int


class AssignFacilityDispatcherResponse(BaseModel):
    assignment: FacilityDispatcherAssignmentOut
    facility_id: str
    facility_version: int
    audit_event_id: str
