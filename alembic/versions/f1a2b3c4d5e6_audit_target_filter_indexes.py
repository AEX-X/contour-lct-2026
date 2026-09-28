"""Add indexes for server-side audit target filtering.

Revision ID: f1a2b3c4d5e6
Revises: e3f6a7b8c9d0
Create Date: 2026-09-28 12:00:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "f1a2b3c4d5e6"
down_revision: str | Sequence[str] | None = "e3f6a7b8c9d0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Index both independently supported exact-match target filters."""
    op.create_index(
        op.f("ix_audit_log_target_type"),
        "audit_log",
        ["target_type"],
        unique=False,
    )
    op.create_index(
        op.f("ix_audit_log_target_id"),
        "audit_log",
        ["target_id"],
        unique=False,
    )


def downgrade() -> None:
    """Remove audit target-filter indexes."""
    op.drop_index(op.f("ix_audit_log_target_id"), table_name="audit_log")
    op.drop_index(op.f("ix_audit_log_target_type"), table_name="audit_log")
