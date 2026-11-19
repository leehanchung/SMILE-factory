"""Session CRUD endpoints and lifecycle management."""

import uuid
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.api.deps import get_db, get_orchestrator
from src.api.models import (
    Agent,
    AgentRef,
    ListResponse,
    Session,
    SessionCreate,
    SessionResources,
    SessionStats,
    SessionStatus,
    SessionUsage,
)

router = APIRouter(prefix="/v1/sessions", tags=["sessions"])

# TODO: Replace with actual ORM models once database schema is defined
_sessions_store = {}  # In-memory store for demo
_agents_store = {}  # Mock agent store (shared with agents.py)


async def _generate_session_id() -> str:
    """Generate a unique session ID."""
    return f"session_{uuid.uuid4().hex[:12]}"


def _resolve_agent(agent_id: str) -> Optional[dict]:
    """Resolve agent ID to agent dict from store."""
    # TODO: Query from database
    return _agents_store.get(agent_id)


def _serialize_session(session_dict: dict) -> Session:
    """Convert stored session dict to Session model."""
    agent_id = session_dict["agent_id"]
    agent_data = _resolve_agent(agent_id)

    if not agent_data:
        raise ValueError(f"Agent {agent_id} not found")

    # Reconstruct Agent object
    from src.api.models import ModelConfig

    model = agent_data.get("model")
    if isinstance(model, dict):
        model = ModelConfig(**model)

    agent = Agent(
        id=agent_data["id"],
        version=agent_data.get("version", 1),
        name=agent_data["name"],
        model=model,
        system=agent_data["system"],
        tools=agent_data.get("tools", []),
        custom_tools=agent_data.get("custom_tools", []),
        mcp_servers=agent_data.get("mcp_servers", []),
        description=agent_data.get("description"),
        created_at=agent_data.get("created_at"),
        updated_at=agent_data.get("updated_at"),
    )

    return Session(
        id=session_dict["id"],
        type="agent",
        status=SessionStatus(session_dict.get("status", "idle")),
        agent=agent,
        environment_id=session_dict["environment_id"],
        title=session_dict.get("title"),
        metadata=session_dict.get("metadata"),
        resources=session_dict.get("resources"),
        created_at=session_dict.get("created_at"),
        updated_at=session_dict.get("updated_at"),
        archived_at=session_dict.get("archived_at"),
        stats=SessionStats(**session_dict.get("stats", {})),
        usage=SessionUsage(**session_dict.get("usage", {})),
    )


@router.post("", response_model=Session, status_code=status.HTTP_201_CREATED)
async def create_session(
    req: SessionCreate,
    db: AsyncSession = Depends(get_db),
    orchestrator=Depends(get_orchestrator),
) -> Session:
    """Create a new Session.

    Triggers Kubernetes Job creation via orchestrator.
    """
    session_id = await _generate_session_id()

    # Resolve agent ID
    if isinstance(req.agent, str):
        agent_id = req.agent
    else:
        agent_id = req.agent.id

    agent = _resolve_agent(agent_id)
    if not agent:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Agent {agent_id} not found",
        )

    # TODO: Launch via orchestrator.create_session(...)

    session_dict = {
        "id": session_id,
        "agent_id": agent_id,
        "environment_id": req.environment_id,
        "status": SessionStatus.RESCHEDULING,
        "title": req.title,
        "metadata": req.metadata or {},
        "resources": req.resources,
        "created_at": datetime.utcnow(),
        "updated_at": datetime.utcnow(),
        "archived_at": None,
        "stats": {},
        "usage": {},
    }

    # TODO: Store in database via ORM
    _sessions_store[session_id] = session_dict

    return _serialize_session(session_dict)


@router.get("", response_model=ListResponse)
async def list_sessions(
    agent_id: Optional[str] = Query(None),
    status_filter: Optional[SessionStatus] = Query(None, alias="status"),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    include_archived: bool = Query(False),
    db: AsyncSession = Depends(get_db),
) -> ListResponse:
    """List sessions with filtering and pagination."""
    sessions = list(_sessions_store.values())

    # Apply filters
    if agent_id:
        sessions = [s for s in sessions if s["agent_id"] == agent_id]

    if status_filter:
        sessions = [s for s in sessions if s.get("status") == status_filter]

    if not include_archived:
        sessions = [s for s in sessions if s.get("archived_at") is None]

    # Pagination
    sessions = sessions[offset : offset + limit]
    session_models = [_serialize_session(s) for s in sessions]

    return ListResponse(
        data=session_models,
        next_page=None,  # TODO: Calculate based on offset/limit
    )


@router.get("/{session_id}", response_model=Session)
async def get_session(
    session_id: str,
    db: AsyncSession = Depends(get_db),
) -> Session:
    """Retrieve a session by ID."""
    if session_id not in _sessions_store:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Session {session_id} not found",
        )

    return _serialize_session(_sessions_store[session_id])


@router.post("/{session_id}", response_model=Session)
async def update_session(
    session_id: str,
    req: dict,  # Partial update: title, metadata
    db: AsyncSession = Depends(get_db),
) -> Session:
    """Update session metadata (title, metadata)."""
    if session_id not in _sessions_store:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Session {session_id} not found",
        )

    session = _sessions_store[session_id]

    if "title" in req:
        session["title"] = req["title"]

    if "metadata" in req:
        session["metadata"] = req["metadata"]

    session["updated_at"] = datetime.utcnow()

    # TODO: Update in database
    return _serialize_session(session)


@router.post("/{session_id}/archive", response_model=Session)
async def archive_session(
    session_id: str,
    db: AsyncSession = Depends(get_db),
) -> Session:
    """Archive a session (soft delete)."""
    if session_id not in _sessions_store:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Session {session_id} not found",
        )

    session = _sessions_store[session_id]
    session["archived_at"] = datetime.utcnow()

    # TODO: Update in database
    return _serialize_session(session)


@router.delete("/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_session(
    session_id: str,
    db: AsyncSession = Depends(get_db),
    orchestrator=Depends(get_orchestrator),
) -> None:
    """Delete a session and its associated Kubernetes Job."""
    if session_id not in _sessions_store:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Session {session_id} not found",
        )

    # TODO: Tear down via orchestrator.terminate_session(session_id)
    # TODO: Hard delete from database

    del _sessions_store[session_id]
