"""risk verdict and blind spots

Revision ID: e1a7c3d5b902
Revises: f5e6f7a8b9c0
Create Date: 2026-09-28 18:00:00.000000

Existing risks get an empty blind_spots list, so the column can be NOT NULL.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e1a7c3d5b902'
down_revision: Union[str, Sequence[str], None] = 'f5e6f7a8b9c0'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('risks', sa.Column('verdict', sa.String(), nullable=True))
    op.add_column('risks', sa.Column('blind_spots', sa.JSON(), nullable=True))
    op.execute("UPDATE risks SET blind_spots = '[]'::json WHERE blind_spots IS NULL")
    op.alter_column('risks', 'blind_spots', nullable=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('risks', 'blind_spots')
    op.drop_column('risks', 'verdict')
