"""Karthick call flow: agent first_message, contact gender/business_type, outcome names

Revision ID: 0002_karthick_flow
Revises: 0001_initial
Create Date: 2026-10-06
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0002_karthick_flow"
down_revision: Union[str, None] = "0001_initial"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

OUTCOME_RENAMES = {
    "dnd": "do_not_call",
    "wrong_number": "wrong_person",
    "callback": "callback_requested",
    "failed": "call_failed",
}


def upgrade() -> None:
    op.add_column("agents", sa.Column("first_message", sa.Text(), nullable=True))
    op.add_column("contacts", sa.Column("gender", sa.String(10), nullable=True))
    op.add_column("contacts", sa.Column("business_type", sa.String(100), nullable=True))
    calls = sa.table("calls", sa.column("outcome", sa.String))
    for old, new in OUTCOME_RENAMES.items():
        op.execute(calls.update().where(calls.c.outcome == old).values(outcome=new))


def downgrade() -> None:
    calls = sa.table("calls", sa.column("outcome", sa.String))
    for old, new in OUTCOME_RENAMES.items():
        op.execute(calls.update().where(calls.c.outcome == new).values(outcome=old))
    op.execute(calls.update().where(calls.c.outcome == "voicemail").values(outcome="unknown"))
    with op.batch_alter_table("contacts") as b:
        b.drop_column("business_type")
        b.drop_column("gender")
    with op.batch_alter_table("agents") as b:
        b.drop_column("first_message")
