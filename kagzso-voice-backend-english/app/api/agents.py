from __future__ import annotations

from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import require_api_key
from app.db import repositories as repo
from app.db.database import get_db
from app.schemas.agents import AgentCreate, AgentOut

router = APIRouter(prefix="/api/agents", tags=["agents"], dependencies=[Depends(require_api_key)])


@router.get("", response_model=List[AgentOut])
async def list_agents(db: AsyncSession = Depends(get_db)) -> List[AgentOut]:
    return [AgentOut.model_validate(a) for a in await repo.list_agents(db)]


@router.get("/{agent_id}", response_model=AgentOut)
async def get_agent(agent_id: int, db: AsyncSession = Depends(get_db)) -> AgentOut:
    agent = await repo.get_agent(db, agent_id)
    if agent is None:
        raise HTTPException(404, "Agent not found")
    return AgentOut.model_validate(agent)


@router.post("", response_model=AgentOut, status_code=201)
async def create_agent(body: AgentCreate, db: AsyncSession = Depends(get_db)) -> AgentOut:
    return AgentOut.model_validate(await repo.create_agent(db, **body.model_dump()))
