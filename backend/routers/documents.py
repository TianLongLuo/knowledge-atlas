"""Document CRUD router — PostgreSQL + ChromaDB unified view.

Full CRUD: create (via /notes), read, update, delete.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, time, timezone
import hashlib
import logging

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from auth import get_current_user
from database import get_chroma_collection, get_db
from models import Document, DocumentChunk, KnowledgeEdge, KnowledgeNode
from schemas import (
    DocumentDetailResponse,
    DocumentListResponse,
    DocumentResponse,
)

router = APIRouter(prefix="/api/documents", tags=["documents"])
logger = logging.getLogger(__name__)

# ── ChromaDB helpers ──────────────────────────────────────────────


def _pseudo_id(chroma_id: str) -> int:
    """Return a stable JavaScript-safe negative route ID for a Chroma record.

    JSON numbers are IEEE-754 doubles in browsers.  Keep the magnitude below
    2**52 so document IDs survive JSON parsing and client-side routing intact.
    """
    digest = hashlib.blake2b(chroma_id.encode(), digest_size=8).digest()
    return -(int.from_bytes(digest, "big") & ((1 << 52) - 1) or 1)


def _get_chroma_docs() -> list[dict]:
    """Get all ChromaDB documents as pseudo-document responses."""
    try:
        collection = get_chroma_collection()
        result = collection.get(include=["documents", "metadatas"])
        items = []
        if result["ids"]:
            for i, cid in enumerate(result["ids"]):
                meta = (result["metadatas"][i] or {}) if result["metadatas"] else {}
                text = (result["documents"][i] or "") if result["documents"] else ""
                items.append({
                    "id": _pseudo_id(cid),
                    "chroma_real_id": cid,
                    "source_type": meta.get("source", "chromadb"),
                    "source_id": cid,
                    "title": meta.get("title", "Untitled"),
                    "raw_content": text,
                    "normalized_content": text,
                    "metadata": meta,
                    "content_hash": None,
                    "created_at": meta.get("created_at") or meta.get("timestamp"),
                    "updated_at": meta.get("updated_at") or meta.get("created_at") or meta.get("timestamp"),
                })
        return items
    except Exception:
        logger.exception("Failed to read documents from ChromaDB")
        return []


def _find_chroma_by_neg_id(neg_id: int) -> tuple[str | None, dict | None]:
    """Given a negative pseudo-ID, return (chroma_real_id, doc_dict)."""
    docs = _get_chroma_docs()
    for d in docs:
        if d["id"] == neg_id:
            return d["chroma_real_id"], d
    return None, None


# ── Request schemas ───────────────────────────────────────────────


class UpdateDocumentRequest(BaseModel):
    title: str | None = None
    content: str | None = None


async def _reindex_postgres_document(doc: Document, db: AsyncSession) -> None:
    """Atomically rebuild SQL chunk rows and idempotently upsert Chroma chunks."""
    from sqlalchemy import delete as sa_delete
    from routers.notes import _get_model
    from services.chunking import ChunkingService

    content = doc.normalized_content or doc.raw_content or ""
    chunks = ChunkingService(chunk_size=500, chunk_overlap=50).chunk_text(content)
    model = await asyncio.to_thread(_get_model)
    vectors = await asyncio.to_thread(
        lambda: model.encode([chunk.text for chunk in chunks]).tolist()
    ) if chunks else []
    collection = get_chroma_collection()
    collection.delete(where={"document_id": str(doc.id)})

    await db.execute(sa_delete(DocumentChunk).where(DocumentChunk.document_id == doc.id))
    metadata = doc.metadata_ or {}
    for chunk, vector in zip(chunks, vectors):
        chroma_id = f"document_{doc.id}_chunk_{chunk.index}"
        collection.upsert(
            ids=[chroma_id],
            embeddings=[vector],
            documents=[chunk.text],
            metadatas=[{
                "source": doc.source_type,
                "title": doc.title,
                "document_id": str(doc.id),
                "chunk_index": chunk.index,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "url": str(metadata.get("url") or ""),
            }],
        )
        db.add(DocumentChunk(
            document_id=doc.id,
            chunk_index=chunk.index,
            chunk_text=chunk.text,
            chunk_hash=chunk.hash,
            chroma_id=chroma_id,
            token_count=chunk.token_count,
        ))
    doc.content_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()[:32]


# ── List ──────────────────────────────────────────────────────────


@router.get("", response_model=DocumentListResponse)
async def list_documents(
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    source_type: str | None = Query(default=None),
    search: str | None = Query(default=None),
    date_from: str | None = Query(default=None),
    date_to: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    _user: str = Depends(get_current_user),
):
    """List PostgreSQL and legacy Chroma documents with correct pagination."""
    base_query = select(Document)
    if source_type and source_type != "chromadb":
        base_query = base_query.where(Document.source_type == source_type)
    if search:
        base_query = base_query.where(
            or_(
                Document.title.ilike(f"%{search}%"),
                Document.normalized_content.ilike(f"%{search}%"),
            )
        )
    try:
        if date_from:
            start = datetime.combine(datetime.fromisoformat(date_from).date(), time.min)
            base_query = base_query.where(Document.created_at >= start)
        if date_to:
            end = datetime.combine(datetime.fromisoformat(date_to).date(), time.max)
            base_query = base_query.where(Document.created_at <= end)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="Invalid date filter; expected YYYY-MM-DD") from exc

    result = await db.execute(base_query.order_by(Document.updated_at.desc()))
    pg_docs = result.scalars().all()
    items = [DocumentResponse.model_validate(d) for d in pg_docs]

    if source_type is None or source_type == "chromadb":
        chroma_items = _get_chroma_docs()
        if search:
            s = search.lower()
            chroma_items = [
                c for c in chroma_items
                if s in c["title"].lower() or s in (c["normalized_content"] or "").lower()
            ]
        if date_from or date_to:
            start_date = datetime.fromisoformat(date_from).date() if date_from else None
            end_date = datetime.fromisoformat(date_to).date() if date_to else None
            dated_items = []
            for item in chroma_items:
                raw_date = item["created_at"]
                try:
                    item_date = datetime.fromisoformat(raw_date.replace("Z", "+00:00")).date() if raw_date else None
                except (TypeError, ValueError):
                    item_date = None
                if start_date and (item_date is None or item_date < start_date):
                    continue
                if end_date and (item_date is None or item_date > end_date):
                    continue
                dated_items.append(item)
            chroma_items = dated_items

        for ci in chroma_items:
            items.append(DocumentResponse(
                id=ci["id"],
                source_type=ci["source_type"],
                source_id=ci["source_id"],
                title=ci["title"],
                raw_content=ci["raw_content"][:500] if ci["raw_content"] else None,
                normalized_content=ci["normalized_content"][:500] if ci["normalized_content"] else None,
                metadata=ci["metadata"],
                content_hash=ci["content_hash"],
                created_at=ci["created_at"],
                updated_at=ci["updated_at"],
            ))

    total = len(items)
    start = (page - 1) * page_size
    items = items[start:start + page_size]

    return DocumentListResponse(items=items, total=total, page=page, page_size=page_size)


# ── Get detail ────────────────────────────────────────────────────


@router.get("/{document_id}", response_model=DocumentDetailResponse)
async def get_document(
    document_id: int,
    db: AsyncSession = Depends(get_db),
    _user: str = Depends(get_current_user),
):
    """Get document detail. Negative IDs → ChromaDB."""
    if document_id < 0:
        chroma_items = _get_chroma_docs()
        ci = next((item for item in chroma_items if item["id"] == document_id), None)
        if ci is None:
            raise HTTPException(status_code=404, detail="Document not found")
        return DocumentDetailResponse(
            id=ci["id"],
            source_type=ci["source_type"],
            source_id=ci["source_id"],
            title=ci["title"],
            raw_content=ci["raw_content"],
            normalized_content=ci["normalized_content"],
            metadata=ci["metadata"],
            content_hash=ci["content_hash"],
            created_at=ci["created_at"],
            updated_at=ci["updated_at"],
            chunks=[], nodes=[], edges=[],
        )

    doc = await db.get(Document, document_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")

    chunks_result = await db.execute(
        select(DocumentChunk).where(DocumentChunk.document_id == document_id).order_by(DocumentChunk.chunk_index)
    )
    chunks = chunks_result.scalars().all()

    nodes_result = await db.execute(
        select(KnowledgeNode).where(KnowledgeNode.source_document_id == document_id)
    )
    nodes = nodes_result.scalars().all()

    node_ids = [n.node_id for n in nodes]
    edges = []
    if node_ids:
        from sqlalchemy import or_
        edges_result = await db.execute(
            select(KnowledgeEdge).where(
                or_(KnowledgeEdge.source_node_id.in_(node_ids), KnowledgeEdge.target_node_id.in_(node_ids))
            )
        )
        edges = edges_result.scalars().all()

    from schemas import ChunkResponse, KnowledgeEdgeResponse, KnowledgeNodeResponse

    return DocumentDetailResponse(
        id=doc.id, source_type=doc.source_type, source_id=doc.source_id,
        title=doc.title, raw_content=doc.raw_content, normalized_content=doc.normalized_content,
        metadata=doc.metadata_, content_hash=doc.content_hash,
        created_at=doc.created_at, updated_at=doc.updated_at,
        chunks=[ChunkResponse.model_validate(c) for c in chunks],
        nodes=[KnowledgeNodeResponse.model_validate(n) for n in nodes],
        edges=[KnowledgeEdgeResponse.model_validate(e) for e in edges],
    )


# ── Update ────────────────────────────────────────────────────────


@router.put("/{document_id}", response_model=DocumentResponse)
async def update_document(
    document_id: int,
    body: UpdateDocumentRequest,
    db: AsyncSession = Depends(get_db),
    _user: str = Depends(get_current_user),
):
    """Update document title and/or content.

    For ChromaDB notes (negative IDs): update in vector store + re-embed.
    For PostgreSQL docs: update DB row.
    """
    # ── ChromaDB note update ────────────────────────────────────
    if document_id < 0:
        real_id, _ = _find_chroma_by_neg_id(document_id)
        if not real_id:
            raise HTTPException(status_code=404, detail="Note not found")

        collection = get_chroma_collection()
        existing = collection.get(ids=[real_id], include=["documents", "metadatas"])
        if not existing["ids"]:
            raise HTTPException(status_code=404, detail="Note not found")

        old_meta = (existing["metadatas"][0] or {}) if existing["metadatas"] else {}
        old_text = (existing["documents"][0] or "") if existing["documents"] else ""

        new_title = body.title if body.title is not None else old_meta.get("title", "Untitled")
        if not new_title.strip():
            raise HTTPException(status_code=422, detail="Title cannot be empty")
        new_title = new_title.strip()
        new_content = body.content if body.content is not None else old_text
        new_meta = {
            **old_meta,
            "title": new_title,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }

        # Re-embed if content changed
        if body.content is not None and body.content != old_text:
            from routers.notes import _get_model

            model = await asyncio.to_thread(_get_model)
            new_embedding = await asyncio.to_thread(lambda: model.encode(new_content).tolist())
            collection.update(ids=[real_id], documents=[new_content], metadatas=[new_meta], embeddings=[new_embedding])
        else:
            collection.update(ids=[real_id], documents=[new_content], metadatas=[new_meta])

        from services.search_service import invalidate_search_cache
        from routers.graph import invalidate_graph_cache

        invalidate_search_cache()
        invalidate_graph_cache()

        return DocumentResponse(
            id=document_id,
            source_type=old_meta.get("source", "web"),
            source_id=real_id,
            title=new_title,
            raw_content=new_content[:500],
            normalized_content=new_content[:500],
            metadata=new_meta,
            content_hash=None,
            created_at=old_meta.get("timestamp"),
            updated_at=new_meta.get("updated_at"),
        )

    # ── PostgreSQL document update ───────────────────────────────
    doc = await db.get(Document, document_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")

    if body.title is not None:
        if not body.title.strip():
            raise HTTPException(status_code=422, detail="Title cannot be empty")
        doc.title = body.title.strip()
    if body.content is not None:
        doc.raw_content = body.content
        doc.normalized_content = body.content

    await db.flush()
    if body.title is not None or body.content is not None:
        await _reindex_postgres_document(doc, db)
        from routers.graph import invalidate_graph_cache
        from services.search_service import invalidate_search_cache

        invalidate_graph_cache()
        invalidate_search_cache()
    await db.refresh(doc)
    return DocumentResponse.model_validate(doc)


# ── Delete ───────────────────────────────────────────────────────


@router.delete("/{document_id}", status_code=status.HTTP_200_OK)
async def delete_document(
    document_id: int,
    db: AsyncSession = Depends(get_db),
    _user: str = Depends(get_current_user),
):
    """Delete a document or ChromaDB note."""
    # ── ChromaDB note delete ────────────────────────────────────
    if document_id < 0:
        real_id, _ = _find_chroma_by_neg_id(document_id)
        if not real_id:
            raise HTTPException(status_code=404, detail="Note not found")

        collection = get_chroma_collection()
        try:
            collection.delete(ids=[real_id])
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to delete from ChromaDB: {e}")

        from services.search_service import invalidate_search_cache
        from routers.graph import invalidate_graph_cache

        invalidate_search_cache()
        invalidate_graph_cache()

        return {"message": "Note deleted", "id": document_id}

    # ── PostgreSQL document delete ───────────────────────────────
    doc = await db.get(Document, document_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")

    # Also delete associated ChromaDB chunks
    chunks_result = await db.execute(
        select(DocumentChunk).where(DocumentChunk.document_id == document_id)
    )
    chunks = chunks_result.scalars().all()
    chroma_ids = [c.chroma_id for c in chunks if c.chroma_id]
    if chroma_ids:
        try:
            collection = get_chroma_collection()
            collection.delete(ids=chroma_ids)
        except Exception as exc:
            logger.exception("Failed to remove vector chunks for document %s", document_id)
            raise HTTPException(status_code=503, detail="Vector index is temporarily unavailable") from exc

    await db.delete(doc)
    await db.flush()
    from routers.graph import invalidate_graph_cache
    from services.search_service import invalidate_search_cache

    invalidate_graph_cache()
    invalidate_search_cache()
    return {"message": "Document deleted", "id": document_id}
