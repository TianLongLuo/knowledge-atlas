"""Document CRUD router — PostgreSQL + ChromaDB unified view.

Full CRUD: create (via /notes), read, update, delete.
"""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import func, select
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

# ── ChromaDB helpers ──────────────────────────────────────────────


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
                    "id": -(i + 1),
                    "chroma_real_id": cid,
                    "source_type": meta.get("source", "chromadb"),
                    "source_id": cid,
                    "title": meta.get("title", "Untitled"),
                    "raw_content": text,
                    "normalized_content": text,
                    "metadata": meta,
                    "content_hash": None,
                    "created_at": meta.get("timestamp"),
                    "updated_at": meta.get("timestamp"),
                })
        return items
    except Exception:
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


class UpdateChromaNoteRequest(BaseModel):
    title: str | None = None
    content: str | None = None


# ── List ──────────────────────────────────────────────────────────


@router.get("", response_model=DocumentListResponse)
async def list_documents(
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    source_type: str | None = Query(default=None),
    search: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    _user: str = Depends(get_current_user),
):
    """List all documents (PostgreSQL + ChromaDB) with pagination."""
    base_query = select(Document)
    count_query = select(func.count(Document.id))
    if source_type and source_type != "chromadb":
        base_query = base_query.where(Document.source_type == source_type)
        count_query = count_query.where(Document.source_type == source_type)
    if search:
        base_query = base_query.where(
            Document.title.ilike(f"%{search}%")
            | Document.normalized_content.ilike(f"%{search}%")
        )
        count_query = count_query.where(
            Document.title.ilike(f"%{search}%")
            | Document.normalized_content.ilike(f"%{search}%")
        )

    total_result = await db.execute(count_query)
    pg_total = total_result.scalar() or 0

    offset = (page - 1) * page_size
    result = await db.execute(
        base_query.order_by(Document.updated_at.desc()).offset(offset).limit(page_size)
    )
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

        total = pg_total + len(chroma_items)
    else:
        total = pg_total

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
        chroma_idx = -document_id - 1
        chroma_items = _get_chroma_docs()
        if chroma_idx >= len(chroma_items):
            raise HTTPException(status_code=404, detail="Document not found")
        ci = chroma_items[chroma_idx]
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
        new_content = body.content if body.content is not None else old_text
        new_meta = {**old_meta, "title": new_title, "updated_at": datetime.utcnow().isoformat()}

        # Re-embed if content changed
        if body.content is not None and body.content != old_text:
            from sentence_transformers import SentenceTransformer
            from config import settings
            model = SentenceTransformer(settings.embedding_model)
            new_embedding = model.encode(new_content).tolist()
            collection.update(ids=[real_id], documents=[new_content], metadatas=[new_meta], embeddings=[new_embedding])
        else:
            collection.update(ids=[real_id], documents=[new_content], metadatas=[new_meta])

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
        doc.title = body.title
    if body.content is not None:
        doc.raw_content = body.content
        doc.normalized_content = body.content

    await db.flush()
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
        except Exception:
            pass

    await db.delete(doc)
    await db.flush()
    return {"message": "Document deleted", "id": document_id}
