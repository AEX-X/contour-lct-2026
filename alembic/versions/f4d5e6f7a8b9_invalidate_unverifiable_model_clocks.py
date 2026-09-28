"""Invalidate legacy real-model risks with unverifiable model clocks.

Revision ID: f4d5e6f7a8b9
Revises: f3c4d5e6f7a8
Create Date: 2026-09-28 22:10:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "f4d5e6f7a8b9"
down_revision: str | Sequence[str] | None = "f3c4d5e6f7a8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Archive unverifiable predictions and allow their sources to refresh."""
    op.add_column(
        "risks",
        sa.Column(
            "is_invalidated",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )
    op.create_index(
        op.f("ix_risks_is_invalidated"),
        "risks",
        ["is_invalidated"],
        unique=False,
    )

    # Before demo_clock existed, Full-mode historical predictions were saved
    # with wall-clock as_of. Keep them for audit/detail links, but never mix
    # them into the active queue or let them block a correctly clocked refresh.
    op.execute(
        """
        UPDATE risks
        SET is_invalidated = true
        WHERE demo_clock IS NULL
          AND model <> 'stub-v1'
        """
    )
    op.execute(
        """
        UPDATE events
        SET related_risk_id = NULL
        WHERE related_risk_id IN (
            SELECT id FROM risks
            WHERE is_invalidated = true AND target_type = 'sensor'
        )
        """
    )
    op.execute(
        """
        UPDATE risk_sync_state
        SET last_synced_event_id = ''
        WHERE EXISTS (
            SELECT 1 FROM risks
            WHERE is_invalidated = true AND target_type = 'sensor'
        )
        """
    )


def downgrade() -> None:
    """Remove the invalidation marker; refreshed source links stay intact."""
    op.drop_index(op.f("ix_risks_is_invalidated"), table_name="risks")
    op.drop_column("risks", "is_invalidated")
