"""Index efficient latest-reading lookups by sensor channel.

Revision ID: f3c4d5e6f7a8
Revises: f2b3c4d5e6f7
Create Date: 2026-09-28 20:00:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "f3c4d5e6f7a8"
down_revision: str | Sequence[str] | None = "f2b3c4d5e6f7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Support bounded latest-reading scans for a page of sensor channels."""
    op.create_index(
        "ix_sensor_readings_channel_occurred_id",
        "sensor_readings",
        ["channel_id", "occurred_at", "id"],
        unique=False,
    )


def downgrade() -> None:
    """Remove the composite latest-reading index."""
    op.drop_index(
        "ix_sensor_readings_channel_occurred_id",
        table_name="sensor_readings",
    )
