"""Work-order domain (ticket 09): the whole lifecycle is emulated locally --
the real external help-desk system does not exist and never will
(QA_ORGANIZERS_CLARIFICATIONS.md section 5). Never confuse with ticket 06's
`ExternalWorkOrderRecord`, a fully separate, isolated synthetic-backlog
table used only for source-health realism.
"""

from datetime import datetime

from sqlalchemy import JSON, DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from src.models.base import Base


class WorkOrder(Base):
    """One repair/maintenance work order, owned end to end by this backend."""

    __tablename__ = "work_orders"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    display_number: Mapped[str] = mapped_column(String, unique=True, index=True)
    source_risk_id: Mapped[str | None] = mapped_column(
        ForeignKey("risks.id"), nullable=True
    )
    facility_id: Mapped[str | None] = mapped_column(
        ForeignKey("facilities.id"), nullable=True
    )
    target_entity_type: Mapped[str] = mapped_column(String)
    target_entity_id: Mapped[str] = mapped_column(String)
    work_type: Mapped[str] = mapped_column(String)
    priority: Mapped[str] = mapped_column(String)
    due_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    description: Mapped[str] = mapped_column(String)
    symptoms: Mapped[list] = mapped_column(JSON, default=list)
    comment: Mapped[str | None] = mapped_column(String, nullable=True)
    status: Mapped[str] = mapped_column(String, default="draft", index=True)
    assigned_engineer_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id"), nullable=True, index=True
    )
    coordinator_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id"), nullable=True
    )
    sla_policy_id: Mapped[str | None] = mapped_column(String, nullable=True)
    repair_result: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    submitted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    closed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_by: Mapped[str] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    version: Mapped[int] = mapped_column(Integer, default=1)


class WorkOrderAssignment(Base):
    """One engineer assignment; previous rows remain as immutable history."""

    __tablename__ = "work_order_assignments"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    work_order_id: Mapped[str] = mapped_column(ForeignKey("work_orders.id"), index=True)
    engineer_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    assigned_by_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    assigned_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    accepted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    declined_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    decline_reason: Mapped[str | None] = mapped_column(String, nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    status: Mapped[str] = mapped_column(String, index=True)
    version: Mapped[int] = mapped_column(Integer, default=1)


class WorkOrderAccessGrant(Base):
    """Temporary facility access bound to an engineer assignment."""

    __tablename__ = "work_order_access_grants"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    work_order_id: Mapped[str] = mapped_column(ForeignKey("work_orders.id"), index=True)
    facility_id: Mapped[str] = mapped_column(ForeignKey("facilities.id"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    access_level: Mapped[str] = mapped_column(String, default="technical_full")
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    revoked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    status: Mapped[str] = mapped_column(String, default="active", index=True)
    offline_cache_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    version: Mapped[int] = mapped_column(Integer, default=1)


class WorkOrderActionMutation(Base):
    """Durable action response used to make retries exactly idempotent."""

    __tablename__ = "work_order_action_mutations"
    __table_args__ = (
        UniqueConstraint(
            "actor_id", "idempotency_key", name="uq_work_order_action_actor_key"
        ),
    )

    id: Mapped[str] = mapped_column(String, primary_key=True)
    work_order_id: Mapped[str] = mapped_column(ForeignKey("work_orders.id"), index=True)
    actor_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    idempotency_key: Mapped[str] = mapped_column(String)
    fingerprint: Mapped[str] = mapped_column(String)
    action: Mapped[str] = mapped_column(String)
    response_payload: Mapped[dict] = mapped_column(JSON)
    audit_event_id: Mapped[str] = mapped_column(String)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class WorkOrderCreateMutation(Base):
    """Durable response for idempotent work-order draft creation."""

    __tablename__ = "work_order_create_mutations"
    __table_args__ = (
        UniqueConstraint(
            "actor_id", "idempotency_key", name="uq_work_order_create_actor_key"
        ),
    )

    id: Mapped[str] = mapped_column(String, primary_key=True)
    work_order_id: Mapped[str] = mapped_column(ForeignKey("work_orders.id"), index=True)
    actor_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    idempotency_key: Mapped[str] = mapped_column(String)
    fingerprint: Mapped[str] = mapped_column(String)
    response_payload: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class Notification(Base):
    """Persistent in-product notification for one user."""

    __tablename__ = "notifications"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    type: Mapped[str] = mapped_column(String)
    priority: Mapped[str] = mapped_column(String, default="info")
    title: Mapped[str] = mapped_column(String)
    body: Mapped[str] = mapped_column(String)
    entity_type: Mapped[str] = mapped_column(String)
    entity_id: Mapped[str] = mapped_column(String)
    deep_link: Mapped[str] = mapped_column(String)
    group_key: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    read_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class FacilityDispatcherAssignment(Base):
    """History of facility-dispatcher assignments."""

    __tablename__ = "facility_dispatcher_assignments"
    __table_args__ = (
        UniqueConstraint(
            "assigned_by_id", "idempotency_key", name="uq_facility_assignment_actor_key"
        ),
    )

    id: Mapped[str] = mapped_column(String, primary_key=True)
    facility_id: Mapped[str] = mapped_column(ForeignKey("facilities.id"), index=True)
    dispatcher_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    assigned_by_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    ends_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(String, default="active")
    version: Mapped[int] = mapped_column(Integer, default=1)
    facility_version: Mapped[int] = mapped_column(Integer)
    idempotency_key: Mapped[str] = mapped_column(String)
    fingerprint: Mapped[str] = mapped_column(String)
    audit_event_id: Mapped[str] = mapped_column(String)
    response_payload: Mapped[dict] = mapped_column(JSON)
