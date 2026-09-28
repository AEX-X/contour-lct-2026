"""Index confirmed incidents for operational UI queries.

Revision ID: f5e6f7a8b9c0
Revises: f4d5e6f7a8b9
Create Date: 2026-09-29 00:10:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "f5e6f7a8b9c0"
down_revision: str | Sequence[str] | None = "f4d5e6f7a8b9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Make the sparse confirmed-incident filter efficient."""
    op.create_index(
        op.f("ix_events_is_confirmed_incident"),
        "events",
        ["is_confirmed_incident"],
        unique=False,
    )


def downgrade() -> None:
    """Remove the confirmed-incident lookup index."""
    op.drop_index(
        op.f("ix_events_is_confirmed_incident"),
        table_name="events",
    )
