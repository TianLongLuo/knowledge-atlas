"""Document CRUD router — PostgreSQL + ChromaDB unified view.

Full CRUD: canonical PostgreSQL documents with Chroma chunks, legacy
Chroma-only records for backward compatibility.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import logging
from typing import Literal

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
from services.note_service import note_service
from utils import (
    content_fingerprint,
    legacy_document_key,
    merge_chunk_texts,
    normalize_document_id,
    pseudo_id,
    normalized_tags,
)

router = APIRouter(prefix="/api/documents", tags=["documents"])
logger = logging.getLogger(__name__)

# ── ChromaDB helpers ──────────────────────────────────────────────


def _pseudo_id(chroma_id: str) -> int:
    return pseudo_id(chroma_id)


def _normalize_document_id(raw: object) -> int:
    return normalize_document_id(raw)


async def _get_canonical_document_ids(db: AsyncSession) -> set[int]:
    """Get all PostgreSQL document IDs that have Chroma chunk entries.

    Used for deduplication: Chroma records with a document_id matching
    a PostgreSQL canonical document are skipped in legacy listing.
    """
    try:
        result = await db.execute(select(Document.id))
        return {row[0] for row in result.all()}
    except Exception:
        return set()


def _get_legacy_chroma_docs(
    canonical_ids: set[int] | None = None,
    canonical_fingerprints: set[str] | None = None,
) -> list[dict]:
    """Get ChromaDB records that are NOT already represented in PostgreSQL.

    Skips Chroma chunks whose document_id metadata matches a known
    PostgreSQL canonical document. Reads the complete collection so pagination
    and duplicate grouping cannot silently omit older notes.
    """
    if canonical_ids is None:
        canonical_ids = set()
    if canonical_fingerprints is None:
        canonical_fingerprints = set()
    try:
        collection = get_chroma_collection()
        result = collection.get(include=["documents", "metadatas"])
        groups: dict[str, dict] = {}
        if result["ids"]:
            for i, cid in enumerate(result["ids"]):
                meta = (result["metadatas"][i] or {}) if result["metadatas"] else {}
                text = (result["documents"][i] or "") if result["documents"] else ""

                # Skip Chroma chunks that belong to PostgreSQL documents
                doc_id_meta = meta.get("document_id")
                if doc_id_meta is not None:
                    doc_id = _normalize_document_id(doc_id_meta)
                    if doc_id > 0 and doc_id in canonical_ids:
                        continue

                fingerprint = content_fingerprint(
                    str(meta.get("title") or "Untitled"), text, str(meta.get("source") or "chromadb")
                )
                if fingerprint in canonical_fingerprints:
                    continue

                logical_key = legacy_document_key(cid, meta, text)
                group = groups.setdefault(logical_key, {
                    "id": _pseudo_id(logical_key),
                    "logical_key": logical_key,
                    "chroma_real_id": cid,
                    "chroma_real_ids": [],
                    "source_type": meta.get("source", "chromadb"),
                    "source_id": cid,
                    "title": meta.get("title", "Untitled"),
                    "content_parts": [],
                    "metadata": meta,
                    "content_hash": None,
                    "created_at": meta.get("created_at") or meta.get("timestamp"),
                    "updated_at": meta.get("updated_at") or meta.get("created_at") or meta.get("timestamp"),
                })
                group["chroma_real_ids"].append(cid)
                group["content_parts"].append((int(meta.get("chunk_index") or 0), text))

        items = []
        for group in groups.values():
            ordered = [text for _, text in sorted(group.pop("content_parts"), key=lambda item: item[0])]
            full_content = merge_chunk_texts(ordered)
            group["raw_content"] = full_content
            group["normalized_content"] = full_content
            group["metadata"] = {**group["metadata"], "_chroma_ids": group["chroma_real_ids"]}
            items.append(group)
        return items
    except Exception:
        logger.exception("Failed to read documents from ChromaDB")
        return []


def _deduplicate_postgres_documents(documents: list[Document]) -> list[Document]:
    """Return the same canonical PostgreSQL notes shown in the document list."""
    unique_documents: list[Document] = []
    seen: set[str] = set()
    for document in documents:
        key = (
            f"external:{document.source_type}:{document.source_id}"
            if document.source_id
            else f"content:{document.content_hash or content_fingerprint(document.title, document.normalized_content or document.raw_content or '', document.source_type)}"
        )
        if key in seen:
            continue
        seen.add(key)
        unique_documents.append(document)
    return unique_documents


_NOTE_DATE_KEYS = (
    "note_created_at", "original_created_at", "created_time", "published_at",
    "note_date", "date", "timestamp",
)
_SYSTEM_DATE_KEYS = ("ingested_at", "imported_at", "synced_at")


def _parse_document_datetime(value: object) -> datetime | None:
    if isinstance(value, datetime):
        return value
    if isinstance(value, (int, float)):
        number = float(value)
        if number > 10_000_000_000:
            number /= 1000
        try:
            return datetime.fromtimestamp(number, timezone.utc)
        except (OSError, OverflowError, ValueError):
            return None
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None


def _document_datetime(item: DocumentResponse, field: str) -> datetime | None:
    metadata = item.metadata_ or {}
    keys = _NOTE_DATE_KEYS if field == "note_date" else _SYSTEM_DATE_KEYS
    for key in keys:
        parsed = _parse_document_datetime(metadata.get(key))
        if parsed is not None:
            return parsed
    return item.created_at if field in {"note_date", "system_created"} else item.updated_at


def _datetime_timestamp(value: datetime | None) -> float:
    if value is None:
        return 0.0
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.timestamp()


def _document_tags(item: DocumentResponse) -> list[str]:
    return normalized_tags(item.metadata_ or {})


def _find_chroma_by_neg_id(neg_id: int) -> tuple[list[str], dict | None]:
    """Given a negative pseudo-ID, return every backing Chroma row and document."""
    docs = _get_legacy_chroma_docs()
    for d in docs:
        if d["id"] == neg_id:
            return d["chroma_real_ids"], d
    return [], None


# ── Request schemas ───────────────────────────────────────────────


class UpdateDocumentRequest(BaseModel):
    title: str | None = None
    content: str | None = None


# ── List ──────────────────────────────────────────────────────────


@router.get("", response_model=DocumentListResponse)
async def list_documents(
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    source_type: str | None = Query(default=None),
    search: str | None = Query(default=None),
    date_from: str | None = Query(default=None),
    date_to: str | None = Query(default=None),
    date_field: Literal["note_date", "system_created"] = Query(default="note_date"),
    tag: str | None = Query(default=None),
    sort_by: Literal["note_date", "system_created", "updated_at", "title"] = Query(default="note_date"),
    sort_order: Literal["asc", "desc"] = Query(default="desc"),
    db: AsyncSession = Depends(get_db),
    _user: str = Depends(get_current_user),
):
    """List PostgreSQL documents, excluding legacy Chroma-only records that overlap."""
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
    result = await db.execute(base_query.order_by(Document.updated_at.desc()))
    pg_docs = result.scalars().all()
    # PostgreSQL can also contain historical duplicate imports. Keep the newest
    # canonical row for each external identity or exact content fingerprint.
    unique_pg_docs = _deduplicate_postgres_documents(pg_docs)
    items = [DocumentResponse.model_validate(d) for d in unique_pg_docs]

    # Add legacy Chroma-only records (not already in PostgreSQL)
    if source_type is None or source_type == "chromadb":
        canonical_ids = await _get_canonical_document_ids(db)
        canonical_fingerprints = {
            content_fingerprint(d.title, d.normalized_content or d.raw_content or "", d.source_type)
            for d in unique_pg_docs
        }
        chroma_items = _get_legacy_chroma_docs(canonical_ids, canonical_fingerprints)
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

    try:
        start_date = datetime.fromisoformat(date_from).date() if date_from else None
        end_date = datetime.fromisoformat(date_to).date() if date_to else None
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="Invalid date filter; expected YYYY-MM-DD") from exc

    if tag:
        normalized_tag = tag.casefold()
        items = [item for item in items if normalized_tag in {value.casefold() for value in _document_tags(item)}]
    if start_date or end_date:
        dated_items: list[DocumentResponse] = []
        for item in items:
            value = _document_datetime(item, date_field)
            item_date = value.date() if value else None
            if start_date and (item_date is None or item_date < start_date):
                continue
            if end_date and (item_date is None or item_date > end_date):
                continue
            dated_items.append(item)
        items = dated_items

    reverse = sort_order == "desc"
    if sort_by == "title":
        items.sort(key=lambda item: (item.title.casefold(), item.id), reverse=reverse)
    else:
        items.sort(
            key=lambda item: (_datetime_timestamp(_document_datetime(item, sort_by)), item.id),
            reverse=reverse,
        )

    total = len(items)
    start = (page - 1) * page_size
    items = items[start:start + page_size]

    return DocumentListResponse(items=items, total=total, page=page, page_size=page_size)


@router.get("/filter-options")
async def document_filter_options(
    db: AsyncSession = Depends(get_db),
    _user: str = Depends(get_current_user),
):
    pg_documents = (await db.execute(select(Document))).scalars().all()
    tags = {tag for document in pg_documents for tag in normalized_tags(document.metadata_ or {})}
    canonical_ids = {document.id for document in pg_documents}
    for document in _get_legacy_chroma_docs(canonical_ids):
        tags.update(normalized_tags(document.get("metadata") or {}))
    return {"tags": sorted(tags, key=str.casefold)}


# ── Get detail ────────────────────────────────────────────────────


@router.get("/{document_id}", response_model=DocumentDetailResponse)
async def get_document(
    document_id: int,
    db: AsyncSession = Depends(get_db),
    _user: str = Depends(get_current_user),
):
    """Get document detail. Negative IDs → legacy ChromaDB. Full content, no truncation."""
    if document_id < 0:
        chroma_items = _get_legacy_chroma_docs()
        ci = next((item for item in chroma_items if item["id"] == document_id), None)
        if ci is None:
            raise HTTPException(status_code=404, detail="Document not found")
        # Return full content for legacy Chroma records
        raw_content = ci["raw_content"] or ""
        normalized_content = ci["normalized_content"] or raw_content
        return DocumentDetailResponse(
            id=ci["id"],
            source_type=ci["source_type"],
            source_id=ci["source_id"],
            title=ci["title"],
            raw_content=raw_content,
            normalized_content=normalized_content,
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
    reconstructed = merge_chunk_texts([chunk.chunk_text for chunk in chunks])
    full_content = max(
        (doc.raw_content or "", doc.normalized_content or "", reconstructed),
        key=len,
    )

    nodes_result = await db.execute(
        select(KnowledgeNode).where(KnowledgeNode.source_document_id == document_id)
    )
    nodes = nodes_result.scalars().all()

    node_ids = [n.node_id for n in nodes]
    edges = []
    if node_ids:
        edges_result = await db.execute(
            select(KnowledgeEdge).where(
                or_(KnowledgeEdge.source_node_id.in_(node_ids), KnowledgeEdge.target_node_id.in_(node_ids))
            )
        )
        edges = edges_result.scalars().all()

    from schemas import ChunkResponse, KnowledgeEdgeResponse, KnowledgeNodeResponse

    # Return FULL content — no truncation in detail endpoint
    return DocumentDetailResponse(
        id=doc.id, source_type=doc.source_type, source_id=doc.source_id,
        title=doc.title,
        raw_content=full_content,
        normalized_content=full_content,
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

    PostgreSQL docs: canonical update via NoteService.
    Legacy Chroma notes (negative IDs): update in vector store.
    """
    # ── ChromaDB note update (legacy) ──────────────────────────────
    if document_id < 0:
        real_ids, legacy_doc = _find_chroma_by_neg_id(document_id)
        if not real_ids or not legacy_doc:
            raise HTTPException(status_code=404, detail="Note not found")

        collection = get_chroma_collection()
        existing = collection.get(ids=real_ids, include=["documents", "metadatas"])
        if not existing["ids"]:
            raise HTTPException(status_code=404, detail="Note not found")

        old_meta = (existing["metadatas"][0] or {}) if existing["metadatas"] else {}
        old_text = legacy_doc["normalized_content"] or ""

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
            from sentence_transformers import SentenceTransformer

            model = SentenceTransformer(settings.embedding_model)
            new_embedding = await asyncio.to_thread(lambda: model.encode(new_content).tolist())
            collection.update(ids=[real_ids[0]], documents=[new_content], metadatas=[new_meta], embeddings=[new_embedding])
        else:
            collection.update(ids=[real_ids[0]], documents=[new_content], metadatas=[new_meta])
        if len(real_ids) > 1:
            collection.delete(ids=real_ids[1:])

        from services.search_service import invalidate_search_cache
        from routers.graph import invalidate_graph_cache

        invalidate_search_cache()
        invalidate_graph_cache()

        return DocumentResponse(
            id=document_id,
            source_type=old_meta.get("source", "web"),
            source_id=real_ids[0],
            title=new_title,
            raw_content=new_content[:500],
            normalized_content=new_content[:500],
            metadata=new_meta,
            content_hash=None,
            created_at=old_meta.get("timestamp"),
            updated_at=new_meta.get("updated_at"),
        )

    # ── PostgreSQL document update (canonical via NoteService) ─────
    if body.title is not None and not body.title.strip():
        raise HTTPException(status_code=422, detail="Title cannot be empty")

    try:
        result = await note_service.update(
            document_id=document_id,
            title=body.title,
            content=body.content,
            db=db,
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Update failed: {exc}")

    from routers.notes import broadcast_note_updated

    broadcast_note_updated({
        "id": document_id,
        "title": body.title,
        "updated": True,
    })

    doc = await db.get(Document, document_id)
    return DocumentResponse.model_validate(doc)


# ── Delete ───────────────────────────────────────────────────────


@router.delete("/{document_id}", status_code=status.HTTP_200_OK)
async def delete_document(
    document_id: int,
    db: AsyncSession = Depends(get_db),
    _user: str = Depends(get_current_user),
):
    """Delete a document or legacy ChromaDB note."""
    # ── ChromaDB note delete (legacy) ──────────────────────────────
    if document_id < 0:
        real_ids, _ = _find_chroma_by_neg_id(document_id)
        if not real_ids:
            raise HTTPException(status_code=404, detail="Note not found")

        collection = get_chroma_collection()
        try:
            collection.delete(ids=real_ids)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to delete from ChromaDB: {e}")

        from services.search_service import invalidate_search_cache
        from routers.graph import invalidate_graph_cache

        invalidate_search_cache()
        invalidate_graph_cache()

        from routers.notes import broadcast_note_deleted
        broadcast_note_deleted({"id": document_id})

        return {"message": "Note deleted", "id": document_id}

    # ── PostgreSQL document delete (canonical) ─────────────────────
    try:
        result = await note_service.delete(document_id, db)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Delete failed: {exc}")

    from routers.notes import broadcast_note_deleted
    broadcast_note_deleted({"id": document_id})

    return {"message": "Document deleted", "id": document_id}
