"""Notes router — create and manage notes across ChromaDB."""

from __future__ import annotations

import asyncio
import json
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sentence_transformers import SentenceTransformer

from auth import get_current_user
from config import settings
from database import get_chroma_collection

router = APIRouter(prefix="/api/notes", tags=["notes"])

# Event queue for SSE
_event_queues: list[asyncio.Queue] = []
_embedding_model = None


def _get_model():
    global _embedding_model
    if _embedding_model is None:
        _embedding_model = SentenceTransformer(settings.embedding_model)
    return _embedding_model


class CreateNoteRequest(BaseModel):
    title: str = Field(min_length=1, max_length=1024)
    content: str = Field(min_length=1, max_length=2_000_000)
    source: str = Field(default="manual", min_length=1, max_length=64)
    tags: str = Field(default="", max_length=4000)


class NoteResponse(BaseModel):
    id: str
    title: str
    content: str
    source: str
    created_at: str


async def _broadcast_event(event_type: str, data: dict):
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


@router.post("", response_model=NoteResponse)
async def create_note(
    body: CreateNoteRequest,
    _user: str = Depends(get_current_user),
):
    """Create a new note and index it in ChromaDB."""
    note_id = str(uuid.uuid4())[:8]
    now = datetime.now(timezone.utc).isoformat()

    # Generate embedding
    model = await asyncio.to_thread(_get_model)
    embedding = await asyncio.to_thread(lambda: model.encode(body.content).tolist())

    # Store in ChromaDB
    collection = get_chroma_collection()
    collection.add(
        ids=[note_id],
        documents=[body.content],
        metadatas=[{
            "title": body.title,
            "source": body.source,
            "tags": body.tags,
            "timestamp": now,
            "created_by": _user,
        }],
        embeddings=[embedding],
    )
    from services.search_service import invalidate_search_cache
    from routers.graph import invalidate_graph_cache

    invalidate_search_cache()
    invalidate_graph_cache()

    # Broadcast to SSE listeners
    await _broadcast_event("note_created", {
        "id": note_id,
        "title": body.title,
        "source": body.source,
        "created_at": now,
    })

    return NoteResponse(
        id=note_id,
        title=body.title,
        content=body.content,
        source=body.source,
        created_at=now,
    )


@router.get("/stream")
async def note_stream(_user: str = Depends(get_current_user)):
    """SSE stream for real-time note updates."""

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
