"""manual work-order operations and five-role support

Revision ID: e3f6a7b8c9d0
Revises: d8e4f2a9c1b3
Create Date: 2026-09-28 19:30:00
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "e3f6a7b8c9d0"
down_revision: Union[str, Sequence[str], None] = "d8e4f2a9c1b3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "organization_id",
            sa.String(),
            nullable=False,
            server_default="org_moscollector",
        ),
    )
    op.add_column(
        "users",
        sa.Column(
            "specialization_codes",
            sa.JSON(),
            nullable=False,
            server_default=sa.text("'[]'::json"),
        ),
    )
    op.add_column(
        "users",
        sa.Column(
            "availability", sa.String(), nullable=False, server_default="available"
        ),
    )

    op.add_column(
        "facilities", sa.Column("responsible_dispatcher_id", sa.String(), nullable=True)
    )
    op.add_column(
        "facilities",
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
    )
    op.create_foreign_key(
        "fk_facilities_responsible_dispatcher",
        "facilities",
        "users",
        ["responsible_dispatcher_id"],
        ["id"],
    )

    op.add_column(
        "work_orders", sa.Column("assigned_engineer_id", sa.String(), nullable=True)
    )
    op.add_column(
        "work_orders", sa.Column("coordinator_id", sa.String(), nullable=True)
    )
    op.add_column("work_orders", sa.Column("sla_policy_id", sa.String(), nullable=True))
    op.add_column("work_orders", sa.Column("repair_result", sa.JSON(), nullable=True))
    op.add_column(
        "work_orders",
        sa.Column(
            "symptoms",
            sa.JSON(),
            nullable=False,
            server_default=sa.text("'[]'::json"),
        ),
    )
    op.add_column(
        "work_orders",
        sa.Column("submitted_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "work_orders", sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.create_foreign_key(
        "fk_work_orders_engineer",
        "work_orders",
        "users",
        ["assigned_engineer_id"],
        ["id"],
    )
    op.create_foreign_key(
        "fk_work_orders_coordinator", "work_orders", "users", ["coordinator_id"], ["id"]
    )
    op.create_index(
        "ix_work_orders_assigned_engineer_id", "work_orders", ["assigned_engineer_id"]
    )

    op.create_table(
        "work_order_assignments",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "work_order_id",
            sa.String(),
            sa.ForeignKey("work_orders.id"),
            nullable=False,
        ),
        sa.Column(
            "engineer_id", sa.String(), sa.ForeignKey("users.id"), nullable=False
        ),
        sa.Column(
            "assigned_by_id", sa.String(), sa.ForeignKey("users.id"), nullable=False
        ),
        sa.Column("assigned_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("accepted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("declined_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("decline_reason", sa.String(), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
    )
    op.create_index(
        "ix_work_order_assignments_work_order_id",
        "work_order_assignments",
        ["work_order_id"],
    )
    op.create_index(
        "ix_work_order_assignments_engineer_id",
        "work_order_assignments",
        ["engineer_id"],
    )
    op.create_index(
        "ix_work_order_assignments_status", "work_order_assignments", ["status"]
    )

    op.create_table(
        "work_order_access_grants",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "work_order_id",
            sa.String(),
            sa.ForeignKey("work_orders.id"),
            nullable=False,
        ),
        sa.Column(
            "facility_id", sa.String(), sa.ForeignKey("facilities.id"), nullable=False
        ),
        sa.Column("user_id", sa.String(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column(
            "access_level", sa.String(), nullable=False, server_default="technical_full"
        ),
        sa.Column("starts_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("status", sa.String(), nullable=False, server_default="active"),
        sa.Column(
            "offline_cache_expires_at", sa.DateTime(timezone=True), nullable=True
        ),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
    )
    op.create_index(
        "ix_work_order_access_grants_work_order_id",
        "work_order_access_grants",
        ["work_order_id"],
    )
    op.create_index(
        "ix_work_order_access_grants_facility_id",
        "work_order_access_grants",
        ["facility_id"],
    )
    op.create_index(
        "ix_work_order_access_grants_user_id", "work_order_access_grants", ["user_id"]
    )
    op.create_index(
        "ix_work_order_access_grants_status", "work_order_access_grants", ["status"]
    )

    op.create_table(
        "work_order_action_mutations",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "work_order_id",
            sa.String(),
            sa.ForeignKey("work_orders.id"),
            nullable=False,
        ),
        sa.Column("actor_id", sa.String(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("idempotency_key", sa.String(), nullable=False),
        sa.Column("fingerprint", sa.String(), nullable=False),
        sa.Column("action", sa.String(), nullable=False),
        sa.Column("response_payload", sa.JSON(), nullable=False),
        sa.Column("audit_event_id", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint(
            "actor_id", "idempotency_key", name="uq_work_order_action_actor_key"
        ),
    )
    op.create_index(
        "ix_work_order_action_mutations_work_order_id",
        "work_order_action_mutations",
        ["work_order_id"],
    )
    op.create_index(
        "ix_work_order_action_mutations_actor_id",
        "work_order_action_mutations",
        ["actor_id"],
    )

    op.create_table(
        "work_order_create_mutations",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "work_order_id",
            sa.String(),
            sa.ForeignKey("work_orders.id"),
            nullable=False,
        ),
        sa.Column("actor_id", sa.String(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("idempotency_key", sa.String(), nullable=False),
        sa.Column("fingerprint", sa.String(), nullable=False),
        sa.Column("response_payload", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint(
            "actor_id", "idempotency_key", name="uq_work_order_create_actor_key"
        ),
    )
    op.create_index(
        "ix_work_order_create_mutations_work_order_id",
        "work_order_create_mutations",
        ["work_order_id"],
    )
    op.create_index(
        "ix_work_order_create_mutations_actor_id",
        "work_order_create_mutations",
        ["actor_id"],
    )

    op.create_table(
        "notifications",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("user_id", sa.String(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("type", sa.String(), nullable=False),
        sa.Column("priority", sa.String(), nullable=False, server_default="info"),
        sa.Column("title", sa.String(), nullable=False),
        sa.Column("body", sa.String(), nullable=False),
        sa.Column("entity_type", sa.String(), nullable=False),
        sa.Column("entity_id", sa.String(), nullable=False),
        sa.Column("deep_link", sa.String(), nullable=False),
        sa.Column("group_key", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_notifications_user_id", "notifications", ["user_id"])
    op.create_index("ix_notifications_created_at", "notifications", ["created_at"])

    op.create_table(
        "facility_dispatcher_assignments",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "facility_id", sa.String(), sa.ForeignKey("facilities.id"), nullable=False
        ),
        sa.Column(
            "dispatcher_id", sa.String(), sa.ForeignKey("users.id"), nullable=False
        ),
        sa.Column(
            "assigned_by_id", sa.String(), sa.ForeignKey("users.id"), nullable=False
        ),
        sa.Column("starts_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ends_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("status", sa.String(), nullable=False, server_default="active"),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("facility_version", sa.Integer(), nullable=False),
        sa.Column("idempotency_key", sa.String(), nullable=False),
        sa.Column("fingerprint", sa.String(), nullable=False),
        sa.Column("audit_event_id", sa.String(), nullable=False),
        sa.Column("response_payload", sa.JSON(), nullable=False),
        sa.UniqueConstraint(
            "assigned_by_id", "idempotency_key", name="uq_facility_assignment_actor_key"
        ),
    )
    op.create_index(
        "ix_facility_dispatcher_assignments_facility_id",
        "facility_dispatcher_assignments",
        ["facility_id"],
    )
    op.create_index(
        "ix_facility_dispatcher_assignments_dispatcher_id",
        "facility_dispatcher_assignments",
        ["dispatcher_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_work_order_create_mutations_actor_id",
        table_name="work_order_create_mutations",
    )
    op.drop_index(
        "ix_work_order_create_mutations_work_order_id",
        table_name="work_order_create_mutations",
    )
    op.drop_table("work_order_create_mutations")
    op.drop_index(
        "ix_facility_dispatcher_assignments_dispatcher_id",
        table_name="facility_dispatcher_assignments",
    )
    op.drop_index(
        "ix_facility_dispatcher_assignments_facility_id",
        table_name="facility_dispatcher_assignments",
    )
    op.drop_table("facility_dispatcher_assignments")
    op.drop_index("ix_notifications_created_at", table_name="notifications")
    op.drop_index("ix_notifications_user_id", table_name="notifications")
    op.drop_table("notifications")
    op.drop_index(
        "ix_work_order_action_mutations_actor_id",
        table_name="work_order_action_mutations",
    )
    op.drop_index(
        "ix_work_order_action_mutations_work_order_id",
        table_name="work_order_action_mutations",
    )
    op.drop_table("work_order_action_mutations")
    op.drop_index(
        "ix_work_order_access_grants_status", table_name="work_order_access_grants"
    )
    op.drop_index(
        "ix_work_order_access_grants_user_id", table_name="work_order_access_grants"
    )
    op.drop_index(
        "ix_work_order_access_grants_facility_id", table_name="work_order_access_grants"
    )
    op.drop_index(
        "ix_work_order_access_grants_work_order_id",
        table_name="work_order_access_grants",
    )
    op.drop_table("work_order_access_grants")
    op.drop_index(
        "ix_work_order_assignments_status", table_name="work_order_assignments"
    )
    op.drop_index(
        "ix_work_order_assignments_engineer_id", table_name="work_order_assignments"
    )
    op.drop_index(
        "ix_work_order_assignments_work_order_id", table_name="work_order_assignments"
    )
    op.drop_table("work_order_assignments")
    op.drop_index("ix_work_orders_assigned_engineer_id", table_name="work_orders")
    op.drop_constraint("fk_work_orders_coordinator", "work_orders", type_="foreignkey")
    op.drop_constraint("fk_work_orders_engineer", "work_orders", type_="foreignkey")
    for column in (
        "closed_at",
        "submitted_at",
        "repair_result",
        "symptoms",
        "sla_policy_id",
        "coordinator_id",
        "assigned_engineer_id",
    ):
        op.drop_column("work_orders", column)
    op.drop_constraint(
        "fk_facilities_responsible_dispatcher", "facilities", type_="foreignkey"
    )
    op.drop_column("facilities", "version")
    op.drop_column("facilities", "responsible_dispatcher_id")
    op.drop_column("users", "availability")
    op.drop_column("users", "specialization_codes")
    op.drop_column("users", "organization_id")
