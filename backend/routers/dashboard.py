"""Dashboard aggregates used by the web home page."""

from __future__ import annotations

from datetime import datetime, timezone
from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from auth import get_current_user
from database import get_db
from models import Document, DocumentChunk, SyncState
from routers.documents import (
    _deduplicate_postgres_documents,
    _get_canonical_document_ids,
    _get_chroma_docs,
    _get_legacy_chroma_docs,
)
from utils import content_fingerprint

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])


@router.get("/stats")
async def dashboard_stats(
    db: AsyncSession = Depends(get_db),
    _user: str = Depends(get_current_user),
):
    pg_documents = (
        await db.execute(select(Document).order_by(Document.updated_at.desc()))
    ).scalars().all()
    unique_pg_documents = _deduplicate_postgres_documents(pg_documents)
    pg_chunks = (await db.execute(select(func.count(DocumentChunk.id)))).scalar() or 0
    latest_sync = (
        await db.execute(select(SyncState).order_by(SyncState.updated_at.desc()).limit(1))
    ).scalar_one_or_none()
    try:
        canonical_ids = await _get_canonical_document_ids(db)
        canonical_fingerprints = {
            content_fingerprint(
                document.title,
                document.normalized_content or document.raw_content or "",
                document.source_type,
            )
            for document in unique_pg_documents
        }
        legacy_documents = _get_legacy_chroma_docs(
            canonical_ids, canonical_fingerprints
        )
    except Exception:
        legacy_documents = []
    status = "idle"
    if latest_sync:
        status = {"running": "syncing", "failed": "error"}.get(latest_sync.status, "idle")
    return {
        # Match /api/documents exactly: canonical PostgreSQL notes plus grouped,
        # deduplicated Chroma-only notes.
        "total_documents": len(unique_pg_documents) + len(legacy_documents),
        "total_chunks": pg_chunks + len(legacy_documents),
        "last_sync_time": latest_sync.last_synced_at if latest_sync else None,
        "sync_status": status,
    }


@router.get("/recent")
async def recent_documents(
    limit: int = 8,
    db: AsyncSession = Depends(get_db),
    _user: str = Depends(get_current_user),
):
    limit = max(1, min(limit, 20))
    pg_docs = (
        await db.execute(select(Document).order_by(Document.updated_at.desc()).limit(limit))
    ).scalars().all()
    items = [
        {
            "id": str(doc.id),
            "title": doc.title,
            "source_type": doc.source_type,
            "created_at": (doc.created_at or doc.updated_at or datetime.fromtimestamp(0, timezone.utc)),
        }
        for doc in pg_docs
    ]
    for doc in _get_chroma_docs()[:limit]:
        items.append({
            "id": str(doc["id"]),
            "title": doc["title"],
            "source_type": doc["source_type"],
            "created_at": doc["created_at"] or doc["updated_at"] or datetime.fromtimestamp(0, timezone.utc).isoformat(),
        })
    return items[:limit]
