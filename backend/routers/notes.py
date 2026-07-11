"""Notes router — canonical create/update for notes via PostgreSQL+ChromaDB."""

from __future__ import annotations

import asyncio
import json
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from auth import get_current_user
from config import settings
from database import get_chroma_collection, get_db
from services.note_service import note_service

router = APIRouter(prefix="/api/notes", tags=["notes"])

# Event queue for SSE — extended to cover more event types
_event_queues: list[asyncio.Queue] = []


class CreateNoteRequest(BaseModel):
    title: str = Field(min_length=1, max_length=1024)
    content: str = Field(min_length=1, max_length=2_000_000)
    source: str = Field(default="manual", min_length=1, max_length=64)
    tags: str = Field(default="", max_length=4000)


class NoteResponse(BaseModel):
    id: int
    title: str
    source: str
    created_at: str
    chunk_count: int = 0


async def _broadcast_event(event_type: str, data: dict) -> None:
    """Send event to all SSE listeners."""
    msg = f"event: {event_type}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"
    dead = []
    for q in _event_queues:
        try:
            q.put_nowait(msg)
        except asyncio.QueueFull:
            dead.append(q)
    for q in dead:
        _event_queues.remove(q)


def broadcast_note_created(data: dict) -> None:
    """Non-async helper to schedule broadcast from any context."""
    import asyncio
    try:
        loop = asyncio.get_running_loop()
        loop.create_task(_broadcast_event("note_created", data))
    except RuntimeError:
        pass


def broadcast_note_updated(data: dict) -> None:
    try:
        loop = asyncio.get_running_loop()
        loop.create_task(_broadcast_event("note_updated", data))
    except RuntimeError:
        pass


def broadcast_note_deleted(data: dict) -> None:
    try:
        loop = asyncio.get_running_loop()
        loop.create_task(_broadcast_event("note_deleted", data))
    except RuntimeError:
        pass


def broadcast_sync_event(event_type: str, data: dict) -> None:
    """Broadcast sync-start/sync-complete/sync-failure events."""
    try:
        loop = asyncio.get_running_loop()
        loop.create_task(_broadcast_event(event_type, data))
    except RuntimeError:
        pass


@router.post("", response_model=NoteResponse)
async def create_note(
    body: CreateNoteRequest,
    db: AsyncSession = Depends(get_db),
    _user: str = Depends(get_current_user),
):
    """Create a new note — canonical PostgreSQL document with Chroma chunks."""
    try:
        result = await note_service.create(
            title=body.title,
            content=body.content,
            source=body.source,
            tags=body.tags,
            db=db,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to create note: {exc}")

    # Broadcast to SSE listeners
    await _broadcast_event("note_created", {
        "id": result["id"],
        "title": result["title"],
        "source": result["source"],
        "created_at": result["created_at"],
        "chunk_count": result["chunk_count"],
    })

    return NoteResponse(
        id=result["id"],
        title=result["title"],
        source=result["source"],
        created_at=result["created_at"],
        chunk_count=result["chunk_count"],
    )


@router.get("/stream")
async def note_stream(_user: str = Depends(get_current_user)):
    """SSE stream for real-time note and sync updates."""

    async def event_generator():
        queue: asyncio.Queue = asyncio.Queue(maxsize=100)
        _event_queues.append(queue)
        try:
            # Send initial connection event
            yield f"event: connected\ndata: {json.dumps({'status': 'ok'})}\n\n"
            while True:
                try:
                    msg = await asyncio.wait_for(queue.get(), timeout=30)
                    yield msg
                except asyncio.TimeoutError:
                    yield ": heartbeat\n\n"
        finally:
            if queue in _event_queues:
                _event_queues.remove(queue)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
