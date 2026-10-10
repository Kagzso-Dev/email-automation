"""initial schema: agents, contacts, calls, call_events, transcripts, call_latency_metrics, followups

Revision ID: 0001_initial
Revises:
Create Date: 2026-10-06
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0001_initial"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

BigIntPK = sa.BigInteger().with_variant(sa.Integer(), "sqlite")
MYSQL_OPTS = {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4", "mysql_collate": "utf8mb4_unicode_ci"}


def upgrade() -> None:
    op.create_table(
        "agents",
        sa.Column("id", BigIntPK, primary_key=True, autoincrement=True),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("description", sa.String(500)),
        sa.Column("system_prompt", sa.Text(), nullable=False),
        sa.Column("language", sa.String(16), nullable=False, server_default="en"),
        sa.Column("stt_provider", sa.String(32), nullable=False, server_default="sarvam"),
        sa.Column("llm_provider", sa.String(32), nullable=False, server_default="gemini"),
        sa.Column("tts_provider", sa.String(32), nullable=False, server_default="cartesia"),
        sa.Column("voice_id", sa.String(100)),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        **MYSQL_OPTS,
    )
    op.create_table(
        "contacts",
        sa.Column("id", BigIntPK, primary_key=True, autoincrement=True),
        sa.Column("name", sa.String(150)),
        sa.Column("phone_number", sa.String(20), nullable=False),
        sa.Column("company_name", sa.String(200)),
        sa.Column("email", sa.String(255)),
        sa.Column("status", sa.String(32), nullable=False, server_default="new"),
        sa.Column("dnd", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        **MYSQL_OPTS,
    )
    op.create_index("ix_contacts_phone_number", "contacts", ["phone_number"], unique=True)

    op.create_table(
        "calls",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("provider_call_id", sa.String(64)),
        sa.Column("provider_request_id", sa.String(64)),
        sa.Column("stream_id", sa.String(64)),
        sa.Column("agent_id", BigIntPK, sa.ForeignKey("agents.id"), nullable=False),
        sa.Column("contact_id", BigIntPK, sa.ForeignKey("contacts.id"), nullable=False),
        sa.Column("from_number", sa.String(20), nullable=False),
        sa.Column("to_number", sa.String(20), nullable=False),
        sa.Column("status", sa.String(20), nullable=False, server_default="created"),
        sa.Column("direction", sa.String(10), nullable=False, server_default="outbound"),
        sa.Column("variables", sa.JSON()),
        sa.Column("started_at", sa.DateTime()),
        sa.Column("answered_at", sa.DateTime()),
        sa.Column("ended_at", sa.DateTime()),
        sa.Column("duration_seconds", sa.Integer()),
        sa.Column("outcome", sa.String(20)),
        sa.Column("summary", sa.Text()),
        sa.Column("hangup_cause", sa.String(100)),
        sa.Column("recording_url", sa.String(500)),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        **MYSQL_OPTS,
    )
    op.create_index("ix_calls_provider_call_id", "calls", ["provider_call_id"])
    op.create_index("ix_calls_provider_request_id", "calls", ["provider_request_id"])
    op.create_index("ix_calls_status", "calls", ["status"])

    op.create_table(
        "call_events",
        sa.Column("id", BigIntPK, primary_key=True, autoincrement=True),
        sa.Column("call_id", sa.String(32), sa.ForeignKey("calls.id"), nullable=False),
        sa.Column("event_type", sa.String(50), nullable=False),
        sa.Column("payload", sa.JSON()),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        **MYSQL_OPTS,
    )
    op.create_index("ix_call_events_call_id", "call_events", ["call_id"])
    op.create_index("ix_call_events_call_type", "call_events", ["call_id", "event_type"])

    op.create_table(
        "transcripts",
        sa.Column("id", BigIntPK, primary_key=True, autoincrement=True),
        sa.Column("call_id", sa.String(32), sa.ForeignKey("calls.id"), nullable=False),
        sa.Column("speaker", sa.String(10), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("interrupted", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("confidence", sa.Float()),
        sa.Column("timestamp", sa.DateTime(), nullable=False),
        **MYSQL_OPTS,
    )
    op.create_index("ix_transcripts_call_id", "transcripts", ["call_id"])

    op.create_table(
        "call_latency_metrics",
        sa.Column("id", BigIntPK, primary_key=True, autoincrement=True),
        sa.Column("call_id", sa.String(32), sa.ForeignKey("calls.id"), nullable=False),
        sa.Column("turn_index", sa.Integer(), nullable=False),
        sa.Column("stt_ms", sa.Integer()),
        sa.Column("llm_ms", sa.Integer()),
        sa.Column("llm_first_token_ms", sa.Integer()),
        sa.Column("tts_first_byte_ms", sa.Integer()),
        sa.Column("total_response_ms", sa.Integer()),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        **MYSQL_OPTS,
    )
    op.create_index("ix_call_latency_metrics_call_id", "call_latency_metrics", ["call_id"])

    op.create_table(
        "followups",
        sa.Column("id", BigIntPK, primary_key=True, autoincrement=True),
        sa.Column("call_id", sa.String(32), sa.ForeignKey("calls.id")),
        sa.Column("contact_id", BigIntPK, sa.ForeignKey("contacts.id"), nullable=False),
        sa.Column("scheduled_at", sa.DateTime()),
        sa.Column("notes", sa.Text()),
        sa.Column("status", sa.String(20), nullable=False, server_default="pending"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        **MYSQL_OPTS,
    )
    op.create_index("ix_followups_call_id", "followups", ["call_id"])
    op.create_index("ix_followups_contact_id", "followups", ["contact_id"])


def downgrade() -> None:
    for table in ("followups", "call_latency_metrics", "transcripts", "call_events", "calls", "contacts", "agents"):
        op.drop_table(table)
