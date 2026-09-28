"""Persist ML model-clock provenance on risks.

Revision ID: f2b3c4d5e6f7
Revises: f1a2b3c4d5e6
Create Date: 2026-09-28 16:45:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "f2b3c4d5e6f7"
down_revision: str | Sequence[str] | None = "f1a2b3c4d5e6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Add optional, explicitly declared historical-demo clock metadata."""
    op.add_column("risks", sa.Column("demo_clock", sa.JSON(), nullable=True))


def downgrade() -> None:
    """Remove ML demo-clock provenance."""
    op.drop_column("risks", "demo_clock")
