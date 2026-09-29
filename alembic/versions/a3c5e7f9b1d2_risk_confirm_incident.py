"""risk confirmation as a confirmed incident

Revision ID: a3c5e7f9b1d2
Revises: e1a7c3d5b902
Create Date: 2026-09-29 12:00:00.000000

A confirmed incident is an Event row without a source sensor reading, so
events.source_reading_id becomes nullable. A partial unique index keeps one
confirmed incident per risk; risk_confirm_mutations stores idempotent replies.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a3c5e7f9b1d2'
down_revision: Union[str, Sequence[str], None] = 'e1a7c3d5b902'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.alter_column('events', 'source_reading_id', existing_type=sa.Integer(), nullable=True)
    op.create_index(
        'uq_events_confirmed_incident_risk',
        'events',
        ['related_risk_id'],
        unique=True,
        postgresql_where=sa.text('is_confirmed_incident AND source_reading_id IS NULL'),
    )
    op.create_table(
        'risk_confirm_mutations',
        sa.Column('id', sa.String(), nullable=False),
        sa.Column('risk_id', sa.String(), nullable=False),
        sa.Column('actor_id', sa.String(), nullable=False),
        sa.Column('idempotency_key', sa.String(), nullable=False),
        sa.Column('fingerprint', sa.String(), nullable=False),
        sa.Column('response_payload', sa.JSON(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['risk_id'], ['risks.id']),
        sa.ForeignKeyConstraint(['actor_id'], ['users.id']),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('actor_id', 'idempotency_key', name='uq_risk_confirm_actor_key'),
    )
    op.create_index(
        op.f('ix_risk_confirm_mutations_risk_id'), 'risk_confirm_mutations', ['risk_id']
    )
    op.create_index(
        op.f('ix_risk_confirm_mutations_actor_id'), 'risk_confirm_mutations', ['actor_id']
    )


def downgrade() -> None:
    """Downgrade schema; confirmed incidents without a source reading are dropped."""
    op.drop_index(op.f('ix_risk_confirm_mutations_actor_id'), table_name='risk_confirm_mutations')
    op.drop_index(op.f('ix_risk_confirm_mutations_risk_id'), table_name='risk_confirm_mutations')
    op.drop_table('risk_confirm_mutations')
    op.drop_index('uq_events_confirmed_incident_risk', table_name='events')
    op.execute('DELETE FROM events WHERE source_reading_id IS NULL')
    op.alter_column('events', 'source_reading_id', existing_type=sa.Integer(), nullable=False)
