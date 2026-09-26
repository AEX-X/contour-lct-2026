"""risk model alert fields

Revision ID: d8e4f2a9c1b3
Revises: c52a8d1f3e96
Create Date: 2026-09-26 20:00:00.000000

Adds the model's own alert flag and threshold to risks. Existing rows keep
NULL (forecasts made on the shared probability scale).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'd8e4f2a9c1b3'
down_revision: Union[str, Sequence[str], None] = 'c52a8d1f3e96'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('risks', sa.Column('alert', sa.Boolean(), nullable=True))
    op.add_column('risks', sa.Column('model_threshold', sa.Float(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('risks', 'model_threshold')
    op.drop_column('risks', 'alert')
