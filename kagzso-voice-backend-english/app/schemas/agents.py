from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field


class AgentCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(..., min_length=1, max_length=100)
    description: Optional[str] = Field(None, max_length=500)
    system_prompt: str = Field(..., min_length=10, max_length=50000)
    first_message: Optional[str] = Field(None, max_length=500)
    language: str = Field("en", max_length=16)
    stt_provider: str = Field("sarvam", max_length=32)
    llm_provider: str = Field("gemini", max_length=32)
    tts_provider: str = Field("cartesia", max_length=32)
    voice_id: Optional[str] = Field(None, max_length=100)
    active: bool = True


class AgentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    description: Optional[str]
    system_prompt: str
    first_message: Optional[str]
    language: str
    stt_provider: str
    llm_provider: str
    tts_provider: str
    voice_id: Optional[str]
    active: bool
    created_at: datetime
    updated_at: datetime
