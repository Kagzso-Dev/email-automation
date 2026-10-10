"""calls.voice_id (voice used when CARTESIA_VOICE_ROTATION is on)

Revision ID: 0004_call_voice
Revises: 0003_telephony_provider
Create Date: 2026-10-09
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0004_call_voice"
down_revision: Union[str, None] = "0003_telephony_provider"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("calls", sa.Column("voice_id", sa.String(100), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("calls") as b:
        b.drop_column("voice_id")
