"""calls.telephony_provider (plivo | twilio)

Revision ID: 0003_telephony_provider
Revises: 0002_karthick_flow
Create Date: 2026-10-08
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0003_telephony_provider"
down_revision: Union[str, None] = "0002_karthick_flow"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("calls", sa.Column("telephony_provider", sa.String(16), nullable=False, server_default="plivo"))


def downgrade() -> None:
    with op.batch_alter_table("calls") as b:
        b.drop_column("telephony_provider")
